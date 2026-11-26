import type { Plan, Snapshot, PlanFinding, ResolvedLink, PlanElement, TestsConfig, Ownership } from '../types';
import * as path from 'path';
import { CMD_NAME, SEVERITY_ORDER } from '../constants';
import { TYPE_OUTLINE_EXTENSIONS } from '../languages/registry';
import { elementsNamed } from '../languages/treesitter';
import { log } from '../log';
import { resolveLinks, hasCode } from '../plan/resolve';
import { claimedFiles } from '../plan/resolve';
import { validateMetadata } from './validate';
import { extractClaims, resolveOwnership } from './ownership';
import { PLANNED_CODE_KINDS, extractPlannedCode } from '../plan/plannedElements';
import { needsCode, owningEntry } from '../plan/kinds';
import { matchPlanComponents, scannedContainerFor } from '../plan/standIn';
import { matchPlannedTest, plannedTestsUnder } from './planTests';
import { testIndexOf, testsOf, treeIdOfPlan } from './testAttach';
import { casesOfSnapshot, isTestRef } from '../util/testIds';

const TAG = 'check';

/** Repo-relative paths of the snapshot's source files that did not parse cleanly, sorted. */
export function parseFailures(snapshot: Snapshot): string[] {
  return snapshot.files.filter(f => f.parseError).map(f => f.file).sort();
}

/**
 * Checks a plan against a snapshot for drift.
 * Returns findings sorted by severity, rule, and id.
 */
export function checkPlan(
  plan: Plan,
  snapshot: Snapshot,
  repoRoot: string,
  opts?: {
    sprint?: string;
    /** Config `tests`: with `noTests` the opt-in rule no-tests runs; it attaches the tests, so the snapshot needs calls ('tests'). */
    tests?: TestsConfig;
  }
): PlanFinding[] {
  log(TAG, 'checkPlan', { elementCount: plan.elements.length, sourceFileCount: snapshot.files.length });

  const findings: PlanFinding[] = [];
  const currentSprint = opts?.sprint ? parseInt(opts.sprint.slice(1), 10) : null;

  // Get outlines from snapshot files
  const outlines = snapshot.files.map(f => ({
    file: f.file,
    lineCount: f.lineCount,
    parseError: f.parseError,
    elements: f.elements,
    nested: f.nested,
  }));

  // Resolve all links
  const resolved = resolveLinks(plan, repoRoot, outlines);
  log(TAG, 'resolved links', { count: resolved.length });

  // Get claimed files
  const sourceFiles = snapshot.files.map(f => f.file).sort();
  const claimed = claimedFiles(resolved, sourceFiles);
  log(TAG, 'claimed files', { count: claimed.size });

  // Add findings from validateMetadata
  const metadataFindings = validateMetadata(plan.elements);
  findings.push(...metadataFindings);
  log(TAG, 'metadata findings', { count: metadataFindings.length });

  // Add parse-error findings
  for (const issue of plan.issues) {
    findings.push({
      severity: 'warning',
      rule: 'parse-error',
      id: issue.file,
      message: `${issue.file}:${issue.line} ${issue.message}`,
    });
  }
  log(TAG, 'parse errors', { count: plan.issues.length });

  // Source files tree-sitter could not fully parse: their outlines and imports may be incomplete.
  for (const f of parseFailures(snapshot)) {
    findings.push({
      severity: 'warning',
      rule: 'code-parse-error',
      id: f,
      message: 'did not parse cleanly; its code elements and imports may be incomplete',
    });
  }

  // Create a map from elementId to element for quick lookup
  const elementMap = new Map<string, PlanElement>();
  for (const element of plan.elements) {
    elementMap.set(element.id, element);
  }

  // Planned code (function/class/method/type) by element id; the rules below read it.
  const planned = new Map(extractPlannedCode(plan).map(p => [p.element.id, p]));

  // duplicate-fqn: two elements with the same fqn make lookups, relations and uids ambiguous.
  const byFqn = new Map<string, PlanElement[]>();
  for (const element of plan.elements) byFqn.set(element.id, [...(byFqn.get(element.id) ?? []), element]);
  for (const [fqn, els] of byFqn) {
    if (els.length < 2) continue;
    findings.push({
      severity: 'warning',
      rule: 'duplicate-fqn',
      id: fqn,
      message: `${els.length} elements share this fqn: ${els.map(e => `${e.source.file}:${e.source.line}`).join(', ')}`,
    });
    log(TAG, 'duplicate-fqn', { fqn, count: els.length });
  }

  // Process each element for violations
  const elementIds = new Set<string>();
  for (const element of plan.elements) {
    elementIds.add(element.id);

    const status = element.metadata.status as string | undefined;
    const elementLinks = resolved.filter(r => r.elementId === element.id);
    const isPlannedCode = PLANNED_CODE_KINDS.includes(element.kind);
    const plannedCode = planned.get(element.id);
    // The function/class/type link of planned code, with its scanned CodeElement (if the file is scanned).
    const plannedFnLink = plannedCode?.link;
    const plannedFnFile = plannedFnLink ? snapshot.files.find(f => f.file === plannedFnLink.path) : undefined;
    const plannedLinkCode = plannedFnFile && plannedFnLink?.name ? elementsNamed(plannedFnFile, plannedFnLink.name)[0] : undefined;

    // missing-code: status done or in-progress AND no link exists
    if ((status === 'done' || status === 'in-progress') && elementLinks.length > 0) {
      const hasExisting = elementLinks.some(r => r.exists);
      if (!hasExisting) {
        const pathStr = elementLinks.length > 0 ? elementLinks[0].link.path : 'no link';
        findings.push({
          severity: 'critical',
          rule: 'missing-code',
          id: element.id,
          message: `${element.title} is ${status} but its code is missing: ${pathStr}`,
        });
        log(TAG, 'missing-code', { elementId: element.id, status });
      }
    } else if ((status === 'done' || status === 'in-progress') && elementLinks.length === 0 && !isPlannedCode && needsCode(element.kind)) {
      findings.push({
        severity: 'critical',
        rule: 'missing-code',
        id: element.id,
        message: `${element.title} is ${status} but its code is missing: no link`,
      });
      log(TAG, 'missing-code (no links)', { elementId: element.id, status });
    } else if ((status === 'done' || status === 'in-progress') && elementLinks.length === 0 && plannedCode) {
      // Link-less planned code: look for its name in the files claimed by the parent component.
      const parentFiles = [...claimed]
        .filter(([, claimers]) => claimers.includes(plannedCode.parentComponent))
        .map(([file]) => file);
      const nameFound = snapshot.files.some(
        f => parentFiles.includes(f.file) && f.elements.some(el => el.name === plannedCode.name)
      );
      if (!nameFound) {
        findings.push({
          severity: 'warning',
          rule: 'missing-code',
          id: element.id,
          message: `${element.title} is ${status} but no function ${element.title} was found in the files of ${plannedCode.parentComponent}; add a link`,
        });
        log(TAG, 'missing-code (planned, name not in parent files)', { elementId: element.id, status });
      }
    }

    // broken-function: function link where found === false.
    // Planned code is skipped when planned (not built yet) or a type linked into a file that has no types in
    // its outline (a language's descriptor says so with `outlineTypes`; Python and file-only list no types).
    const skipBrokenFunction = isPlannedCode && status === 'planned';
    for (const link of elementLinks) {
      const typeNotIndexed = element.kind === 'type' && !TYPE_OUTLINE_EXTENSIONS.includes(path.extname(link.link.path));
      if (!skipBrokenFunction && !typeNotIndexed && link.target === 'function' && !link.found && link.exists) {
        findings.push({
          severity: 'warning',
          rule: 'broken-function',
          id: element.id,
          message: `${element.title} links ${link.link.name} but no such function in ${link.link.path}`,
        });
        log(TAG, 'broken-function', { elementId: element.id, name: link.link.name });
      }
    }

    // broken-claim-link: folder link whose folder exists but holds no source file (found === false).
    // Missing targets are not repeated here: missing-code (done/in-progress) and broken-function cover them.
    // `found` comes from resolve.ts with default extensions only, so it misses file-only files (e.g. .java);
    // the scanned file list (languages, file-only extensions, ignore applied) is the real inventory.
    for (const link of elementLinks) {
      const prefix = link.link.path.endsWith('/') ? link.link.path : `${link.link.path}/`;
      if (link.target === 'folder' && link.exists && !link.found && !sourceFiles.some(f => f.startsWith(prefix))) {
        findings.push({
          severity: 'warning',
          rule: 'broken-claim-link',
          id: element.id,
          message: `${link.link.raw} points to nothing: ${link.link.path} has no source files`,
        });
        log(TAG, 'broken-claim-link', { elementId: element.id, path: link.link.path });
      }
    }

    // b178 part 2: a folder link written without the trailing '/' resolves (so no broken-claim-link) but claims no file (ownership.ts:30).
    for (const link of elementLinks) {
      if (link.target === 'folder' && link.exists && !link.link.path.endsWith('/')) {
        findings.push({
          severity: 'warning',
          rule: 'folder-link-no-slash',
          id: element.id,
          message: `${link.link.raw} is a folder but has no trailing '/': it claims no files; write it as ${link.link.raw}/`,
        });
        log(TAG, 'folder-link-no-slash', { elementId: element.id, path: link.link.path });
      }
    }

    // stub-in-done: status done AND a claimed file has stub
    if (status === 'done' && isPlannedCode) {
      // Planned code: only the CodeElement named by its function link, so other stubs in that file do not count.
      if (plannedLinkCode?.stub) {
        findings.push({
          severity: 'warning',
          rule: 'stub-in-done',
          id: element.id,
          message: `${element.title} is done but ${plannedLinkCode.name} is not implemented (${plannedLinkCode.stub}) in ${plannedFnLink?.path}`,
        });
        log(TAG, 'stub-in-done (planned)', { elementId: element.id, stub: plannedLinkCode.stub });
      }
    } else if (status === 'done') {
      // Get all files claimed by this element
      const claimedByThis: string[] = [];
      for (const [file, claimers] of claimed) {
        if (claimers.includes(element.id)) {
          claimedByThis.push(file);
        }
      }

      // For each claimed file, check for stubs
      for (const file of claimedByThis) {
        const fileOutline = snapshot.files.find(f => f.file === file);
        if (fileOutline) {
          for (const codeEl of fileOutline.elements) {
            if (codeEl.stub) {
              findings.push({
                severity: 'warning',
                rule: 'stub-in-done',
                id: element.id,
                message: `${element.title} is done but ${codeEl.name} is not implemented (${codeEl.stub}) in ${file}`,
              });
              log(TAG, 'stub-in-done', { elementId: element.id, stub: codeEl.stub, file });
            }
          }
        }
      }
    }

    // abandoned-but-present: status abandoned AND some link exists
    if (status === 'abandoned' && elementLinks.length > 0) {
      const existingLink = elementLinks.find(r => r.exists);
      if (existingLink) {
        findings.push({
          severity: 'warning',
          rule: 'abandoned-but-present',
          id: element.id,
          message: `${element.title} is abandoned but its code still exists: ${existingLink.link.path}`,
        });
        log(TAG, 'abandoned-but-present', { elementId: element.id });
      }
    }

    // late: sprint given AND status planned/in-progress AND sprint number < current
    if (currentSprint !== null && (status === 'planned' || status === 'in-progress')) {
      const sprint = element.metadata.sprint as string | undefined;
      if (sprint && /^S\d+$/.test(sprint)) {
        const sprintNum = parseInt(sprint.slice(1), 10);
        if (sprintNum < currentSprint) {
          findings.push({
            severity: 'warning',
            rule: 'late',
            id: element.id,
            message: `${element.title} is ${status} in sprint ${sprint} (current S${currentSprint})`,
          });
          log(TAG, 'late', { elementId: element.id, sprint, current: currentSprint });
        }
      }
    }

    // planned-but-built: status planned AND some link's target holds code (an empty module does not count)
    if (status === 'planned' && elementLinks.length > 0 && !isPlannedCode) {
      const existingLink = elementLinks.find(r => hasCode(r, snapshot, repoRoot));
      if (existingLink) {
        findings.push({
          severity: 'info',
          rule: 'planned-but-built',
          id: element.id,
          message: `${element.title} is planned but code exists: ${existingLink.link.path}; update the status?`,
        });
        log(TAG, 'planned-but-built', { elementId: element.id });
      }
    }

    // Planned code (P14-L4-3b): not-built, built-but-still-planned, and missing signature.
    if (isPlannedCode) {
      const linkFound = elementLinks.some(r => r.found);

      // planned-not-built: planned or in-progress, and no link resolves to code
      if ((status === 'planned' || status === 'in-progress') && !linkFound) {
        const reason = elementLinks.length === 0
          ? 'has no link to its code'
          : `links ${elementLinks[0].link.raw} but that code is not found`;
        findings.push({
          severity: 'info',
          rule: 'planned-not-built',
          id: element.id,
          message: `${element.title} is ${status} and not built yet: ${reason}`,
        });
        log(TAG, 'planned-not-built', { elementId: element.id, status });
      }

      // planned-built-update-status: code found, no stub, but status still planned
      if (status === 'planned' && linkFound && !plannedLinkCode?.stub) {
        findings.push({
          severity: 'info',
          rule: 'planned-built-update-status',
          id: element.id,
          message: `${element.title} is planned but its code exists; update the status?`,
        });
        log(TAG, 'planned-built-update-status', { elementId: element.id });
      }

      // missing-signature: planned function or method with no metadata.signature
      if (status === 'planned' && (plannedCode?.kind === 'function' || plannedCode?.kind === 'method') && !plannedCode.signature) {
        findings.push({
          severity: 'info',
          rule: 'missing-signature',
          id: element.id,
          message: `${element.title} is planned but has no signature in metadata`,
        });
        log(TAG, 'missing-signature', { elementId: element.id });
      }
    }

    // line-link: link uses #Lx-Ly
    for (const link of elementLinks) {
      if (link.link.lines !== null) {
        findings.push({
          severity: 'info',
          rule: 'line-link',
          id: element.id,
          message: `link uses line numbers (${link.link.raw}); they shift on every edit, so link a function name instead`,
        });
        log(TAG, 'line-link', { elementId: element.id, raw: link.link.raw });
      }
    }
  }

  // Claim-mode detection (P6-T8): extractClaims() turns *every* component link into a Claim
  // (folder/file/function, per its own classification), so a plan that only uses plain file or
  // folder links — exactly today's folder-mode `.c4` style, e.g. `link ./index.ts` — still yields
  // ≥1 Claim per extractClaims(). That can't be the real signal: it would reclassify every existing
  // folder-mode fixture as claim-mode and break the "unplanned-code stays unchanged" requirement.
  // The new four rules are only meaningful once a plan expresses genuine function-level ownership
  // (a `#functionName` link, with no line range, which is the only thing that produces a
  // ClaimKind === 'function' claim) — that's the real "this repo adopted claim-based ownership"
  // signal, so claim-mode is detected on that instead of on claims existing at all.
  const claims = extractClaims(plan);
  const isClaimMode = claims.some(c => c.kind === 'function');
  log(TAG, 'claim-mode detection', { claimCount: claims.length, isClaimMode });

  const hasComponents = plan.elements.some(el => el.kind === 'component');
  const ownership = isClaimMode ? resolveOwnership(claims, snapshot.files, snapshot.fileEdges) : null;

  findings.push(...checkTestBlocks(plan, snapshot, ownership, opts?.tests));

  // test-only-component (Phase 26, D9): a component or container of the plan that holds only tests. Reported on the
  // outermost one only (a test container, not also each of its components).
  const testOnly = testOnlyElements(plan, claimed, snapshot);
  const underTestOnly = (el: PlanElement): boolean => {
    for (let p = el.parent; p; p = elementMap.get(p)?.parent ?? null) if (testOnly.has(p)) return true;
    return false;
  };
  for (const id of [...testOnly].sort()) {
    const el = elementMap.get(id)!;
    if (underTestOnly(el)) continue;
    findings.push({
      severity: 'info',
      rule: 'test-only-component',
      id,
      message: `${el.title}: all its files are tests; tests now attach to the code they test (Phase 26), consider removing it`,
    });
    log(TAG, 'test-only-component', { id });
  }

  if (ownership) {
    // component-claim-conflict: one per OwnershipConflict
    for (const conflict of ownership.conflicts) {
      const id = conflict.fn !== null ? `${conflict.file}#${conflict.fn}` : conflict.file;
      findings.push({
        severity: 'warning',
        rule: 'component-claim-conflict',
        id,
        message: `${conflict.winner} wins ownership of ${id} over ${conflict.losers.join(', ')} (reason: ${conflict.reason})`,
      });
      log(TAG, 'component-claim-conflict', conflict);
    }

    // split-file: a file whose functions (per Ownership.owner) have ≥2 distinct owner elementIds
    // (real elementIds only — 'shared-auto'/'unassigned' sentinels don't count as "owners" here).
    // Role-test files are skipped (Phase 26): they neither give nor take ownership.
    const functionsByFile = new Map<string, string[]>();
    for (const file of snapshot.files) {
      if (file.role === 'test') continue;
      for (const el of file.elements) {
        if (!functionsByFile.has(file.file)) functionsByFile.set(file.file, []);
        functionsByFile.get(file.file)!.push(el.name);
      }
    }

    for (const [file, fnNames] of functionsByFile) {
      const ownerToFns = new Map<string, string[]>();
      for (const name of fnNames) {
        const owner = ownership.owner[`${file}#${name}`];
        if (!owner || owner === 'shared-auto' || owner === 'unassigned') continue;
        if (!ownerToFns.has(owner)) ownerToFns.set(owner, []);
        ownerToFns.get(owner)!.push(name);
      }

      if (ownerToFns.size >= 2) {
        const maxCount = Math.max(...Array.from(ownerToFns.values()).map(fns => fns.length));
        const owners = Array.from(ownerToFns.keys()).sort();
        const minority = owners.filter(o => ownerToFns.get(o)!.length < maxCount);
        const describeOwner = (o: string) => `${o} (${ownerToFns.get(o)!.sort().join(', ')})`;
        // Tie (no owner has fewer functions than the max): no minority, so list every owner instead.
        const tail = minority.length > 0
          ? `minority: ${minority.map(describeOwner).join('; ')}`
          : `split evenly: ${owners.map(describeOwner).join('; ')}`;
        findings.push({
          severity: 'info',
          rule: 'split-file',
          id: file,
          message: `${file} is split across owners ${owners.join(', ')}; ${tail}`,
        });
        log(TAG, 'split-file', { file, owners, minority });
      }
    }

    // shared-auto: one per SharedCode entry
    for (const shared of ownership.shared) {
      findings.push({
        severity: 'info',
        rule: 'shared-auto',
        id: shared.fn,
        message: `${shared.fn} is unclaimed but used by ${shared.users.join(', ')}; treated as shared code`,
      });
      log(TAG, 'shared-auto', shared);
    }

    // unassigned-code: one per entry in Ownership.unassigned. Wording follows what is known: no importer at
    // all, importers that are all unclaimed, or an importer that failed to parse (unverified, a warning).
    for (const id of ownership.unassigned) {
      const info = ownership.unassignedInfo?.[id];
      const unverified = info?.unverified ?? [];
      const message = unverified.length > 0
        ? `no component claims ${id}; unverified: ${unverified.join(', ')} failed to parse and imports it, so its use cannot be confirmed`
        : info
          ? `no component claims ${id}; it is imported only by unclaimed code (${info.importers.join(', ')})`
          : `no component claims ${id} and nothing calls it`;
      findings.push({ severity: unverified.length > 0 ? 'warning' : 'critical', rule: 'unassigned-code', id, message });
      log(TAG, 'unassigned-code', { id });
    }

    // test-only-code (Phase 26, D10): unclaimed, used by no component, reached by test files only.
    for (const id of ownership.testOnly ?? []) {
      findings.push({
        severity: 'info',
        rule: 'test-only-code',
        id,
        message: `${id} is used only by tests: dead code, or tested but not wired in yet`,
      });
      log(TAG, 'test-only-code', { id });
    }
  } else if (hasComponents) {
    // plan-unmatched (B14): a plan component that stands for no scanned node, so its title, status and
    // relations never reach the map. Same matching as the view model (matchPlanComponents). A component
    // with no link and no built status is a plan-only idea, not drift, so it is not counted.
    const containerIds = snapshot.containers.map(c => c.id);
    const taken = new Set<string>([snapshot.system.id, ...containerIds, ...snapshot.components.map(c => c.id)]);
    const unmatched = matchPlanComponents(
      plan,
      snapshot.components.map(c => ({ id: c.id, path: c.path })),
      taken,
      fqn => (fqn ? scannedContainerFor(fqn, containerIds) : null),
    ).unmatched.filter(el => {
      // A test-only component matches no node because folder mode makes none for tests; test-only-component says so.
      if (testOnly.has(el.id)) return false;
      const st = el.metadata.status;
      return el.links.length > 0 || st === 'done' || st === 'in-progress';
    });
    if (unmatched.length > 0) {
      // info, not warning: `link` writes a component's first link one file at a time, and the safe-write gate
      // refuses an edit that adds a warning, so a warning here would refuse `c4pm plan link <component> <file>`.
      findings.push({
        severity: 'info',
        rule: 'plan-unmatched',
        id: unmatched[0].id,
        message: `${unmatched.length} plan components match no scanned node (link a folder the scan finds): ${unmatched.map(e => e.id).join(', ')}`,
      });
      log(TAG, 'plan-unmatched', { count: unmatched.length });
    }

    // unplanned-code: plan has ≥1 component AND source file is claimed by no element
    // (folder-mode only; mutually exclusive with the claim-mode rules above). Role-test files are skipped (Phase 26).
    const testFiles = new Set(snapshot.files.filter(f => f.role === 'test').map(f => f.file));
    for (const file of sourceFiles) {
      if (!claimed.has(file) && !testFiles.has(file)) {
        findings.push({
          severity: 'critical',
          rule: 'unplanned-code',
          id: file,
          message: 'no .c4 element claims this file',
        });
        log(TAG, 'unplanned-code', { file });
      }
    }
  }

  // relation-target-missing (b130): a relation from a screen or one of its parts must end at a plan element
  for (const rel of plan.relations) {
    if (owningEntry(rel.from, elementMap) === null || elementMap.has(rel.to)) continue;
    findings.push({
      severity: 'warning',
      rule: 'relation-target-missing',
      id: rel.from,
      message: `${rel.from}: relation to '${rel.to}' (${rel.source.file}:${rel.source.line}) matches no plan element`,
    });
    log(TAG, 'relation-target-missing', { from: rel.from, to: rel.to });
  }

  findings.sort(compareFindings);

  log(TAG, 'checkPlan complete', { findingCount: findings.length });
  return findings;
}

/**
 * The finding order: severity (SEVERITY_ORDER), then rule, then id. checkPlan sorts with it, and collectFindings
 * (src/check/collect.ts) sorts its plan list (checkPlan + storage + wireframe rules) with it (b615).
 */
export function compareFindings(a: PlanFinding, b: PlanFinding): number {
  const severityCmp = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (severityCmp !== 0) return severityCmp;

  const ruleCmp = a.rule.localeCompare(b.rule);
  if (ruleCmp !== 0) return ruleCmp;

  return a.id.localeCompare(b.id);
}

/**
 * Phase 26 (T26-14b, D9): ids of the plan components and containers whose claimed files (by their own links or those of
 * the elements below them) are at least one and all role-test files. `claimed` = claimedFiles (file -> claimer ids).
 */
function testOnlyElements(plan: Plan, claimed: Map<string, string[]>, snapshot: Snapshot): Set<string> {
  const tests = new Set(snapshot.files.filter(f => f.role === 'test').map(f => f.file));
  const parentOf = new Map(plan.elements.map(el => [el.id, el.parent]));
  const testOnly = new Set<string>();
  const holdsSource = new Set<string>();
  for (const [file, claimers] of claimed) {
    const into = tests.has(file) ? testOnly : holdsSource;
    for (const id of claimers) {
      for (let cur: string | null | undefined = id; cur; cur = parentOf.get(cur)) into.add(cur);
    }
  }
  const kinds = new Set(['component', 'container']);
  const kindOf = new Map(plan.elements.map(el => [el.id, el.kind]));
  return new Set([...testOnly].filter(id => !holdsSource.has(id) && kinds.has(kindOf.get(id) ?? '')));
}

/**
 * Phase 26 (T26-13, D11, A9): test blocks of the plan against the detected test cases. `planned-not-built` (info) for a
 * test to write (no `case`) that no detected case matches (full chain, or a leaf unique among every case of the repo);
 * id = the parent fqn. `test-link-dead` (warning, T26-8, ATTACH-DESIGN B.7): a hand link whose `case` names neither a
 * detected test case id nor a test file (renamed or deleted since): it attaches nothing. Opt-in `no-tests` (info, config `tests.noTests`): a plan component on the map with no attached
 * test (own or below it) and no test block on it or below it.
 */
export function checkTestBlocks(plan: Plan, snapshot: Snapshot, ownership: Ownership | null, tests: TestsConfig | undefined): PlanFinding[] {
  const out: PlanFinding[] = [];
  const cases = casesOfSnapshot(snapshot);
  for (const el of plan.elements) {
    for (const t of el.tests ?? []) {
      if (t.case !== null && !isTestRef(snapshot, t.case)) {
        out.push({
          severity: 'warning',
          rule: 'test-link-dead',
          id: el.id,
          message: `test '${t.name}' links '${t.case}', which is no test case id and no test file: renamed or deleted?`,
        });
        log(TAG, 'test-link-dead', { elementId: el.id, name: t.name, case: t.case });
      }
      if (t.case !== null || matchPlannedTest(t, cases)) continue;
      out.push({ severity: 'info', rule: 'planned-not-built', id: el.id, message: `test '${t.name}' not written` });
      log(TAG, 'planned-not-built (test)', { elementId: el.id, name: t.name });
    }
  }
  if (tests?.noTests !== true) return out;
  const ix = testIndexOf({ snapshot, plan, ownership, tests });
  for (const el of plan.elements) {
    if (el.kind !== 'component') continue;
    const treeId = treeIdOfPlan(ix, el);
    if (treeId === null) continue;   // not on the map (a plan-only idea): nothing to test yet
    const attached = testsOf(ix, treeId, { children: true });
    if (attached.own.length + attached.children.length > 0 || plannedTestsUnder(plan, el).length > 0) continue;
    out.push({
      severity: 'info',
      rule: 'no-tests',
      id: el.id,
      message: `${el.title} has no tests: none attached and none planned (${CMD_NAME} plan add test "<name>" --parent ${el.id})`,
    });
    log(TAG, 'no-tests', { elementId: el.id });
  }
  return out;
}
