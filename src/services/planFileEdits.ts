/**
 * b472 (ARR-CL-P, rows P5, P6, P7 of Document/Roadmap/ARROWS_COMMAND_LINE.md): the Plan editing functions behind the
 * plan commands that write the .c4 files themselves: `plan apply-layout` (applyLayoutFile; since Phase 30 SV2 it goes
 * through runWrite like plan set: applyLayoutService), `plan ids` (backfillPlanIds, not through runWrite) and `plan remove` (removeElement, also for a box that exists only in the scan: it then
 * adds the folder to the project's ignore list through Project & scan ignoreFolder). Moved from bin/cli.ts with the
 * same steps in the same order. The edits that print a dry run first come back planned, with a `write()` the command
 * calls only with --yes; the Command Line only prints.
 * L3: imports nothing from src/cli/ (that would be an upward import).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parsePlan } from '../plan/parser';
import { readLayoutFile, planLayoutEdits, parseLayoutFile, formatApplyLayoutReport } from '../c4/applyLayout';
import type { ApplyLayoutReport, LayoutFile } from '../c4/applyLayout';
import { loadPlanState, runWrite, failedReport, cmdError } from './planState';
import type { WriteReport } from './planState';
import { textStamp } from '../util/stamp';
import { NO_PLAN_MESSAGE } from '../query/planShow';
import type { C4pmConfig } from '../types';
import { backfillUids } from '../c4/ids';
import { newUid } from '../util/uid';
import { writeAtomic } from '../util/fsAtomic';
import type { BackfillResult } from '../c4/ids';
import { planRemoval } from '../c4/removeElement';
import type { RemovalRelation } from '../c4/removeScope';
import { isAutoWritable } from '../c4/writeGuard';
import { log } from '../log';
import { lookupElement, pickOne, closestItems } from '../util/lookup';
import type { LookupItem } from '../util/lookup';
import { collectItems } from '../query/showElement';
import { loadQueryContext } from '../query/context';
import { getModel } from '../query/elements';
import { planItems } from '../plan/planItems';
import { findPlan } from '../scan/planScan';
import { ignoreFolder, openProject } from '../scan/project';
import type { IgnoreFolderEdit } from '../scan/project';
import type { ViewNode } from '../types';

// --- plan apply-layout ---------------------------------------------------------------------------------------

/**
 * `c4pm plan apply-layout`: write the layout file exported by the map page (version 2) into the plan as layout metadata;
 * `dryRun` writes nothing; `force` also writes plan files outside .c4pm/ and C4PM/. `file` is resolved from the working
 * folder. Returns the report, the gate's write report and the text; throws when the layout file is unusable.
 */
export function applyLayoutFile(
  repo: string,
  file: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): { report: ApplyLayoutReport; write: WriteReport; text: string } {
  const layout = readLayoutFile(path.resolve(file));
  const { report, write, text } = applyLayoutService(repo, layout, { yes: !opts.dryRun, force: !!opts.force });
  return { report, write, text };
}

/** Validate a layout object that came as parsed JSON (a page's request body); throws a clear Error when unusable. */
export function checkLayout(raw: unknown): LayoutFile {
  return parseLayoutFile(JSON.stringify(raw ?? null));
}

/**
 * Write a layout into the plan through the write gate (runWrite: new-findings check, write area unless `force`,
 * changed-since-read, rollback). `yes` false = dry run. `expectStamp` = the plan stamp a page loaded (refused as
 * `changed` when the plan differs). `stamp` = the stamp of the plan as it is after the call; null without a plan.
 */
export function applyLayoutService(
  repo: string,
  layout: LayoutFile,
  opts: { yes: boolean; force?: boolean; expectStamp?: string; cli?: Partial<C4pmConfig> },
): { report: ApplyLayoutReport; write: WriteReport; text: string; stamp: string | null } {
  const o = { yes: opts.yes, force: !!opts.force, ...(opts.expectStamp !== undefined ? { expectStamp: opts.expectStamp } : {}) };
  const state = loadPlanState(path.resolve(repo), opts.cli ?? {});
  if (!state) {
    const report: ApplyLayoutReport = { dryRun: !opts.yes, files: [], applied: 0, unchanged: 0, skipped: [], failed: [] };
    const write = failedReport('plan apply-layout', o, cmdError('no-plan', NO_PLAN_MESSAGE));
    return { report, write, text: formatApplyLayoutReport(report), stamp: null };
  }
  const { report, newTexts } = planLayoutEdits(state.plan, state.texts, layout);
  const write = runWrite({ command: 'plan apply-layout', opts: o, state, target: null, newTexts, notes: [], allowLayout: true, post: () => null });
  report.dryRun = !write.written && !(opts.yes && write.ok);   // a refused or dry run lists "would write"; "no change" is not a dry run
  const stamp = textStamp(write.written ? newTexts : state.texts);
  return { report, write, text: formatApplyLayoutReport(report), stamp };
}

// --- plan ids ------------------------------------------------------------------------------------------------

/** backfillPlanIds' planned edit: what would be added, and the write. */
export interface PlanIdsEdit {
  /** Plan files left out: outside .c4pm/ and C4PM/ without `force`. */
  outside: string[];
  /** Files that get uids, with the count each. */
  files: { file: string; added: number }[];
  /** Elements that could not get a uid, with the reason. */
  skipped: BackfillResult['skipped'];
  /** Total uids added. */
  added: number;
  /** Write the files; re-reads the plan and puts the old texts back when it has new parse issues. False = rolled back. */
  write: () => boolean;
}

/**
 * `c4pm plan ids`: give every plan element without a uid a new random one. Null when the repo has no .c4 files.
 * Plans the edit (files outside .c4pm/ and C4PM/ only with `force`); nothing is written until `write()`.
 */
export function backfillPlanIds(repo: string, opts: { force?: boolean } = {}): PlanIdsEdit | null {
  const repoRoot = path.resolve(repo);
  const { config, project } = openProject(repoRoot);
  const { files: c4Files, plan } = findPlan(repoRoot, config);
  if (!plan) return null;
  const texts = new Map<string, string>();
  for (const f of c4Files) texts.set(f, fs.readFileSync(path.resolve(repoRoot, f), 'utf8'));

  const { files, skipped } = backfillUids(texts, plan, newUid);

  // Plan files outside .c4pm/ and C4PM/ are written only with --force.
  const outside: string[] = [];
  for (const f of [...files.keys()]) {
    if (opts.force || isAutoWritable(project, path.resolve(repoRoot, f))) continue;
    outside.push(f);
    files.delete(f);
  }

  let added = 0;
  for (const r of files.values()) added += r.added.length;

  // b724: each file goes through writeAtomic (temp + rename), so a kill never leaves a cut .c4 file.
  const write = (): boolean => {
    for (const [f, r] of files) writeAtomic(path.resolve(repoRoot, f), r.text);
    if (files.size > 0) {
      const after = parsePlan(repoRoot, c4Files);
      if (after.issues.length > plan.issues.length) {
        for (const f of files.keys()) writeAtomic(path.resolve(repoRoot, f), texts.get(f)!);
        return false;
      }
    }
    log('ids', 'written', { files: files.size, added });
    return true;
  };
  return { outside, files: [...files].map(([file, r]) => ({ file, added: r.added.length })), skipped, added, write };
}

// --- plan remove ---------------------------------------------------------------------------------------------

/** What `plan remove <target>` found and planned (nothing is written before `write()` of 'remove' or 'ignore'). */
export type RemoveOutcome =
  /** No plan element and no scanned box matches; `noPlan` = the repo has no .c4 files. */
  | { kind: 'none'; noPlan: boolean; closest: LookupItem[] }
  /** Several plan elements match, with where each is defined. */
  | { kind: 'ambiguous'; matches: { item: LookupItem; file: string; line: number }[] }
  /** Several scanned boxes match. */
  | { kind: 'scanned-ambiguous'; matches: LookupItem[] }
  /** Cannot remove: the reason, one line. */
  | { kind: 'refused'; message: string }
  /** The element has children in other files (extend blocks): remove them first. */
  | { kind: 'blocked'; children: { uid: string | null; fqn: string }[] }
  /** A box only the scan has: its folder goes into the project's ignore list (`box` = the box's name). */
  | { kind: 'ignore'; box: string; edit: IgnoreFolderEdit }
  /** The element removal, planned. */
  | {
      kind: 'remove';
      item: LookupItem;
      fqn: string;
      removedElements: string[];
      /** Every relation that mentions the element, removed or not. */
      relations: RemovalRelation[];
      /** Changed plan files with their unified diff. */
      files: { file: string; diff: string }[];
      /** Changed plan files outside .c4pm/ and C4PM/ (refused without `force`; write nothing when there is one). */
      outside: string[];
      /** Write the files; re-reads the plan and puts the old texts back when it has new parse issues or the element is still there. False = rolled back. */
      write: () => boolean;
    };

/**
 * `c4pm plan remove <target>`: find one plan element by uid, id or name and plan its removal (with `relations`, also the
 * relation lines that mention it). When no plan element matches, a box that exists only in the scan is looked up: its
 * folder can go into the ignore list (Project & scan ignoreFolder). Errors (config, scan, no anchor) are thrown.
 */
export function removeElement(repo: string, target: string, opts: { relations?: boolean; force?: boolean } = {}): RemoveOutcome {
  const repoRoot = path.resolve(repo);
  const { config, project } = openProject(repoRoot);
  const found = findPlan(repoRoot, config);
  const c4Files = found.files;
  // No plan files is fine here: an empty plan, a scanned-only box can still be removed (T22c).
  const plan = found.plan ?? parsePlan(repoRoot, c4Files);
  const entries = planItems(plan);
  const items = entries.map((e) => e.item);
  const picked = pickOne(lookupElement(target, items, { all: true }));
  if (!picked.ok) {
    if (picked.reason === 'none') {
      return findScannedBox(target, repoRoot) ?? { kind: 'none', noPlan: c4Files.length === 0, closest: closestItems(target, items, 5) };
    }
    return {
      kind: 'ambiguous',
      matches: picked.matches.map((m) => {
        const src = entries.find((e) => e.item === m)!.el.source;
        return { item: m, file: src.file, line: src.line };
      }),
    };
  }
  const fqn = picked.item.id;
  const texts = new Map<string, string>();
  for (const f of c4Files) texts.set(f, fs.readFileSync(path.resolve(repoRoot, f), 'utf8'));

  const withRelations = !!opts.relations;
  const result = planRemoval(texts, plan, fqn, { relations: withRelations });
  if (!result.ok) return { kind: 'refused', message: result.reason };
  if (result.blocked) {
    return {
      kind: 'blocked',
      children: result.otherFileChildren.map((c) => ({ uid: plan.elements.find((e) => e.id === c)?.metadata.uid ?? null, fqn: c })),
    };
  }

  // Plan files outside .c4pm/ and C4PM/ are written only with --force; nothing is written if one is refused.
  const outside = result.files
    .filter((f) => !(opts.force || isAutoWritable(project, path.resolve(repoRoot, f.file))))
    .map((f) => f.file);

  // b724: each file goes through writeAtomic (temp + rename), so a kill never leaves a cut .c4 file.
  const write = (): boolean => {
    for (const f of result.files) writeAtomic(path.resolve(repoRoot, f.file), f.newText);
    const after = parsePlan(repoRoot, c4Files);
    if (after.issues.length > plan.issues.length || after.elements.some((e) => e.id === fqn)) {
      for (const f of result.files) writeAtomic(path.resolve(repoRoot, f.file), f.oldText);
      log('remove', 'rolled back', { fqn });
      return false;
    }
    log('remove', 'written', { fqn, files: result.files.map((f) => f.file), relations: withRelations });
    return true;
  };
  return {
    kind: 'remove',
    item: picked.item,
    fqn,
    removedElements: result.removedElements,
    relations: result.relations,
    files: result.files.map((f) => ({ file: f.file, diff: f.diff })),
    outside,
    write,
  };
}

/**
 * P14-T22c: `remove` for a box that exists only in the scan. Null when no scanned box matches (the caller reports the
 * plan "no match"); otherwise the refusal, the several matches, or the ignore edit of the box's folder.
 */
function findScannedBox(target: string, repoRoot: string): RemoveOutcome | null {
  // Query's map model, scanned as the page build scans (calls of the test files): the boxes the page shows.
  // A scan error comes as QueryError('scan-failed') with the scan's own message (the CLI prints only the message).
  const model = getModel(loadQueryContext(repoRoot, { collectCalls: 'tests' }));
  const entries: { item: LookupItem; node: ViewNode }[] = collectItems(model.root).map((c) => ({ item: c.item, node: c.node }));
  // Shared / Unassigned are synthetic nodes (not system/container/component): add them so they get a clear refusal.
  const walk = (n: ViewNode): void => {
    if (n.origin?.kind === 'synthetic') entries.push({ item: { uid: n.uid, id: n.id, title: n.name, level: n.kind }, node: n });
    n.children.forEach(walk);
  };
  walk(model.root);
  const picked = pickOne(lookupElement(target, entries.map((e) => e.item), { all: true }));
  if (!picked.ok && picked.reason === 'none') return null;
  if (!picked.ok) return { kind: 'scanned-ambiguous', matches: picked.matches };
  const node = entries.find((e) => e.item === picked.item)!.node;
  const origin = node.origin;
  if (node.uid || origin?.kind === 'plan' || origin?.kind === 'both') {
    return { kind: 'refused', message: 'this element is in the plan, use its uid' };
  }
  if (origin?.kind === 'synthetic') {
    return { kind: 'refused', message: `cannot remove '${node.id}': it comes from rules, not from a folder (${origin.rule ?? 'synthetic box'})` };
  }
  const folder = origin?.folder;
  if (folder === undefined) {
    return { kind: 'refused', message: `cannot remove '${node.id}': it is a file-level box, ignore works on whole folders only` };
  }
  const edit = ignoreFolder(repoRoot, folder);
  if (edit.status === 'refused') return { kind: 'refused', message: `cannot remove '${node.id}': ${edit.reason}` };
  return { kind: 'ignore', box: node.name, edit };
}
