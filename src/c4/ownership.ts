import { UnassignedInfo, Claim, ClaimKind, Ownership, OwnershipConflict, SharedCode, Plan, SnapshotFile, FileEdge } from '../types';
import { log } from '../log';

const TAG = 'ownership';

export const SPECIFICITY: Record<ClaimKind, number> = { folder: 1, file: 2, function: 3 };

/** Does `claim` apply to function `name` in `file`? Shared by resolveOwnership and view/model.ts. */
export function claimMatches(claim: Claim, file: string, name: string): boolean {
  if (claim.kind === 'folder') return file.startsWith(claim.path);
  if (claim.kind === 'file') return file === claim.path;
  return file === claim.path && name === claim.fn;
}

/**
 * Walks every 'component' PlanElement's links[] in order and turns each link into a Claim.
 * Claim kind is derived purely from the link's shape (per P6-T4):
 *   - path ends with '/'  -> 'folder'
 *   - link.name is set    -> 'function'
 *   - otherwise           -> 'file'
 */
export function extractClaims(plan: Plan): Claim[] {
  const claims: Claim[] = [];

  for (const element of plan.elements) {
    if (element.kind !== 'component') continue;

    element.links.forEach((link, claimIndex) => {
      let kind: ClaimKind;
      if (link.path.endsWith('/')) {
        kind = 'folder';
      } else if (link.name) {
        kind = 'function';
      } else {
        kind = 'file';
      }

      const claim: Claim = {
        kind,
        path: link.path,
        fn: kind === 'function' ? link.name : null,
        elementId: element.id,
        claimIndex,
      };
      claims.push(claim);
      log(TAG, 'extracted claim', claim);
    });
  }

  log(TAG, 'extractClaims done', { elementCount: plan.elements.length, claimCount: claims.length });
  return claims;
}

/**
 * Claim-mode detection, factored out for P6-T9 (snapshot/build.ts, view/model.ts) so both call
 * sites agree with P6-T8's check.ts, which settled this rule but kept it inlined there (left as-is,
 * not refactored, since check.ts is already committed/verified and out of this task's scope):
 * a plan is claim-mode only when it has >=1 genuine function-level claim (a `#functionName` link),
 * not merely >=1 claim of any kind. Plain file/folder links are today's ordinary folder-mode `.c4`
 * style and must not flip a repo into claim-mode -- otherwise every existing folder-mode fixture
 * (e.g. PhoFast, whose links are all file/line-range, no `#fn`) would be reclassified and its
 * folder-mode-only behavior (unplanned-code, plain containers) would regress.
 */
export function isClaimModePlan(plan: Plan): boolean {
  return extractClaims(plan).some((c) => c.kind === 'function');
}

interface GroupMatch {
  elementId: string;
  specificity: number;
  claimIndex: number;
}

/**
 * Resolves per-function ownership from claims, against the real file outlines and file-level
 * import edges.
 *
 * NOTE (per P6-T4 spec / Phase 6 §4 open question 1): "shared" detection here is a file-level
 * approximation — it asks "does some file owned by a claimed component import this file?", not
 * "does some owned *function* call this function". A real call graph is Phase 8 scope; this is
 * the best signal available until then.
 */
export function resolveOwnership(claims: Claim[], files: SnapshotFile[], fileEdges: FileEdge[]): Ownership {
  log(TAG, 'resolveOwnership start', { claimCount: claims.length, fileCount: files.length, edgeCount: fileEdges.length });

  // Claims are produced by extractClaims() walking plan.elements in plan order (plan.elements is
  // sorted by id), so the first time an elementId appears in `claims` reflects its position in
  // plan.elements. We rely on that ordering here (resolveOwnership only receives Claim[], not the
  // Plan, so this first-occurrence order is the only signal available for "plan.elements order").
  const planOrder = new Map<string, number>();
  claims.forEach((c) => {
    if (!planOrder.has(c.elementId)) planOrder.set(c.elementId, planOrder.size);
  });

  const owner: Record<string, string> = {};
  const conflicts: OwnershipConflict[] = [];
  const unassigned: string[] = [];
  const sharedList: SharedCode[] = [];

  // Which elementId(s) own at least one function in a given file (file-level "this file is claimed
  // by X" signal used later for the shared/unassigned check).
  const fileOwners = new Map<string, Set<string>>();

  // Functions with no matching claim at all; resolved in a second pass once fileOwners is complete.
  const unresolved: { file: string; name: string; id: string }[] = [];

  for (const file of files) {
    for (const elem of file.elements) {
      const id = `${file.file}#${elem.name}`;

      // Find every claim that applies to this function, grouped by elementId (an element may have
      // multiple matching claims, e.g. both a folder claim and a function claim; only its best
      // specificity among them matters for competing against other elements).
      const bestByElement = new Map<string, GroupMatch>();

      for (const claim of claims) {
        if (!claimMatches(claim, file.file, elem.name)) continue;

        const specificity = SPECIFICITY[claim.kind];
        log(TAG, 'claim match attempt', { id, claimKind: claim.kind, claimPath: claim.path, claimFn: claim.fn, elementId: claim.elementId, specificity });

        const existing = bestByElement.get(claim.elementId);
        if (!existing || specificity > existing.specificity) {
          bestByElement.set(claim.elementId, { elementId: claim.elementId, specificity, claimIndex: claim.claimIndex });
        }
      }

      if (bestByElement.size === 0) {
        unresolved.push({ file: file.file, name: elem.name, id });
        continue;
      }

      const groups = Array.from(bestByElement.values());
      const maxSpecificity = Math.max(...groups.map((g) => g.specificity));
      const topGroups = groups.filter((g) => g.specificity === maxSpecificity);

      // Tie among same-specificity claims from different elements: earliest in plan.elements order wins.
      topGroups.sort((a, b) => (planOrder.get(a.elementId) ?? 0) - (planOrder.get(b.elementId) ?? 0));
      const winner = topGroups[0];

      owner[id] = winner.elementId;
      if (!fileOwners.has(file.file)) fileOwners.set(file.file, new Set());
      fileOwners.get(file.file)!.add(winner.elementId);

      const losers = groups.filter((g) => g.elementId !== winner.elementId);
      if (losers.length > 0) {
        const anyTie = losers.some((l) => l.specificity === winner.specificity);
        const reason: OwnershipConflict['reason'] = anyTie ? 'plan-order' : 'specificity';
        const conflict: OwnershipConflict = {
          file: file.file,
          fn: elem.name,
          winner: winner.elementId,
          losers: losers.map((l) => l.elementId).sort(),
          reason,
        };
        conflicts.push(conflict);
        log(TAG, 'conflict', conflict);
      }

      log(TAG, 'owner assigned', { id, owner: winner.elementId, specificity: winner.specificity });
    }
  }

  // Files with no parsed functions: owner from file/folder claims only (function claims cannot match).
  const fileOwner: Record<string, string> = {};
  for (const file of files) {
    if (file.elements.length > 0) continue;
    const groups = matchPathClaims(claims, file.file);
    if (groups.length === 0) continue;
    const maxSpecificity = Math.max(...groups.map((g) => g.specificity));
    const topGroups = groups.filter((g) => g.specificity === maxSpecificity);
    topGroups.sort((a, b) => (planOrder.get(a.elementId) ?? 0) - (planOrder.get(b.elementId) ?? 0));
    const winner = topGroups[0];
    fileOwner[file.file] = winner.elementId;
    log(TAG, 'file owner', { file: file.file, owner: winner.elementId });

    const losers = groups.filter((g) => g.elementId !== winner.elementId);
    if (losers.length > 0) {
      const anyTie = losers.some((l) => l.specificity === winner.specificity);
      const conflict: OwnershipConflict = {
        file: file.file,
        fn: null,
        winner: winner.elementId,
        losers: losers.map((l) => l.elementId).sort(),
        reason: anyTie ? 'plan-order' : 'specificity',
      };
      conflicts.push(conflict);
      log(TAG, 'conflict', conflict);
    }
  }

  // Second pass: shared vs unassigned for every function with zero matching claims. A file counts as
  // used by an element when it is reachable from that element's claimed files through imports, where
  // the path may pass through unclaimed files (A claimed -> B unclaimed -> C unclaimed: C is used by A's owner).
  // Phase 26 (T26-2): role-test files neither give nor take ownership. A test file is no seed, so its
  // component is never a user; a function reached only from test files is test-only, not unassigned; an
  // unclaimed function inside a test file is in no list (its owner stays the 'unassigned' sentinel).
  const claimedOwners = new Map<string, Set<string>>(fileOwners);
  for (const [file, o] of Object.entries(fileOwner)) claimedOwners.set(file, new Set([o]));
  const testFiles = new Set(files.filter((f) => f.role === 'test').map((f) => f.file));
  const sourceSeeds = new Map([...claimedOwners].filter(([file]) => !testFiles.has(file)));
  const usersOf = transitiveUsers(sourceSeeds, claimedOwners, fileEdges);
  const testReached = transitiveUsers(new Map([...testFiles].map((f) => [f, new Set(['test'])])), claimedOwners, fileEdges);
  const importersOf = new Map<string, Set<string>>();
  for (const edge of fileEdges) {
    if (edge.from === edge.to) continue;
    if (!importersOf.has(edge.to)) importersOf.set(edge.to, new Set());
    importersOf.get(edge.to)!.add(edge.from);
  }
  const parseFailed = new Set(files.filter((f) => f.parseError).map((f) => f.file));
  const unassignedInfo: Record<string, UnassignedInfo> = {};
  const testOnly: string[] = [];

  for (const { file, name, id } of unresolved) {
    const users = usersOf.get(file);
    if (testFiles.has(file)) {
      owner[id] = 'unassigned';
      log(TAG, 'test file function, no owner', { id });
    } else if (users && users.size > 0) {
      owner[id] = 'shared-auto';
      const sorted = Array.from(users).sort();
      sharedList.push({ fn: id, users: sorted });
      log(TAG, 'shared', { id, users: sorted });
    } else if (testReached.has(file)) {
      // Reached by tests only. No unassignedInfo: any file a test imports lands here, so the importers of an
      // unassigned entry below are never test files.
      owner[id] = 'unassigned';
      testOnly.push(id);
      log(TAG, 'test-only', { id });
    } else {
      owner[id] = 'unassigned';
      unassigned.push(id);
      const importers = Array.from(importersOf.get(file) ?? []).sort();
      if (importers.length > 0) {
        unassignedInfo[id] = { importers, unverified: importers.filter((f) => parseFailed.has(f)) };
      }
      log(TAG, 'unassigned', { id, importers });
    }
  }

  sharedList.sort((a, b) => a.fn.localeCompare(b.fn));
  unassigned.sort();
  testOnly.sort();

  const ownership: Ownership = { owner, conflicts, shared: sharedList, unassigned, ...(Object.keys(fileOwner).length ? { fileOwner } : {}), ...(Object.keys(unassignedInfo).length ? { unassignedInfo } : {}), ...(testOnly.length ? { testOnly } : {}) };
  log(TAG, 'resolveOwnership done', {
    ownerCount: Object.keys(owner).length,
    conflictCount: conflicts.length,
    sharedCount: sharedList.length,
    unassignedCount: unassigned.length,
    testOnlyCount: testOnly.length,
  });
  return ownership;
}

/**
 * Owner id of `file` (no `name`) or of function `name` in it: without ownership (folder mode) the file's componentId;
 * with it, `owner['file#name']` (undefined when the file has no such element), or for the file `fileOwner[file]`, else
 * its componentId (dominant owner). Ids are component ids or 'shared-auto' / 'unassigned'. One source for the query
 * layer's ownerOf and the test attachment (Phase 26 A2).
 */
export function ownerIdOf(ownership: Ownership | null, file: SnapshotFile, name?: string): string | undefined {
  if (!ownership) return file.componentId;
  if (name !== undefined) return ownership.owner[`${file.file}#${name}`];
  return ownership.fileOwner?.[file.file] ?? file.componentId;
}

/** Best folder/file claim specificity per element for a path; function claims are skipped. */
function matchPathClaims(claims: Claim[], filePath: string): GroupMatch[] {
  const best = new Map<string, GroupMatch>();
  for (const claim of claims) {
    if (claim.kind === 'function') continue;
    if (!claimMatches(claim, filePath, '')) continue;
    const specificity = SPECIFICITY[claim.kind];
    const existing = best.get(claim.elementId);
    if (!existing || specificity > existing.specificity) {
      best.set(claim.elementId, { elementId: claim.elementId, specificity, claimIndex: claim.claimIndex });
    }
  }
  return Array.from(best.values());
}

/**
 * For every file, the owners whose seed files reach it by imports. A walk starts at each seed file and
 * follows imports, continuing only through files absent from `claimedOwners` (a claimed file is its own
 * source, so it is not walked through). Seeds: the claimed source files (users of shared code), or the
 * test files under one pseudo-owner (what tests reach).
 */
function transitiveUsers(seeds: Map<string, Set<string>>, claimedOwners: Map<string, Set<string>>, fileEdges: FileEdge[]): Map<string, Set<string>> {
  const out = new Map<string, string[]>();
  for (const e of fileEdges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  const byOwner = new Map<string, string[]>();
  for (const [file, owners] of seeds) {
    for (const o of owners) {
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o)!.push(file);
    }
  }
  const users = new Map<string, Set<string>>();
  for (const [o, sources] of byOwner) {
    const queue = [...sources];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const from = queue.pop()!;
      for (const to of out.get(from) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        if (!users.has(to)) users.set(to, new Set());
        users.get(to)!.add(o);
        if (!claimedOwners.has(to)) queue.push(to);
      }
    }
  }
  return users;
}
