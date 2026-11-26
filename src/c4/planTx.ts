import * as fs from 'fs';
import * as path from 'path';
import type { ParseIssue, Plan, PlanElement, PlanFinding, ProjectPaths, Snapshot } from '../types';
import { log, timed } from '../log';
import { parsePlanTexts } from '../plan/parser';
import { validateMetadata, INVALID_META_HEADS } from './validate';
import { checkPlan } from './check';
import { isAutoWritable, isWireframeFile } from './writeGuard';
import type { WireframeEdit } from '../types';
import { unifiedDiff } from './textDiff';
import { lostTestBlocks, type TestBlockKey } from './planTests';
import { writeAtomic } from '../util/fsAtomic';

const TAG = 'planTx';

/** Keys the plan-edit commands must never change on an existing element (layout is written by apply-layout, uid by ids/add). */
const PROTECTED_LINE_RE = /^\s*(uid|layout)\b/;
/** With `allowLayout` (SV2, apply-layout): only the uid lines stay protected. */
const UID_LINE_RE = /^\s*uid\b/;

export interface PlanEditFile { file: string; oldText: string; newText: string; diff: string }

export interface EvaluateArgs {
  repoRoot: string;
  oldTexts: Map<string, string>;   // key = repo-relative plan file
  newTexts: Map<string, string>;
  /** Full mode (--check): builds the snapshot checkPlan needs for the plan it is given. Absent = fast mode. */
  scan?: (plan: Plan) => Snapshot;
  /** Element ids (fqn) the edit may remove (only `remove` ops). Any other element lost by the edit refuses it. */
  allowLost?: string[];
  /**
   * plan move / rename: old fqn -> new fqn of every moved element (each root and every descendant; FqnMap.map).
   * A mapped element must be found at its new fqn (same kind, same uid when it has one); findings are compared after
   * mapping the old ones. Absent = no move: the gate behaves as before.
   */
  moved?: Map<string, string>;
  /**
   * Phase 26 (T26-13, A8): test blocks (parent fqn + name) the edit may remove; only `plan remove --test` fills it. Any
   * other test block lost by the edit refuses it (a moved parent is followed through `moved`; a lost element is
   * judged as an element, its blocks go with it).
   */
  allowLostTests?: TestBlockKey[];
  /** SV2 (b678): the edit is a layout write (`plan apply-layout`): `layout` lines may change or go; uid lines stay protected. */
  allowLayout?: boolean;
}

/** A moved element found at its new fqn (uid null = the element has none, e.g. a planned function). */
export interface MovedElement { from: string; to: string; uid: string | null }

export interface EvaluateResult {
  before: Plan;
  after: Plan;
  findingsBefore: PlanFinding[];
  findingsAfter: PlanFinding[];
  newIssues: ParseIssue[];
  newFindings: PlanFinding[];
  fixedFindings: PlanFinding[];
  /** Why the edit is refused, one line each (new parse issue, new warning/critical finding, protected line changed, ...). */
  reasons: string[];
  refused: boolean;
  files: PlanEditFile[];   // only files whose text changed
  /** Elements of `moved` found at their new fqn, in plan order (report `moved <from> -> <to>`); [] without a map. */
  moved: MovedElement[];
}

const issueKey = (i: ParseIssue) => `${i.file}|${i.message}`;

// parse-error messages carry `file:line`; the line shifts when an edit inserts above, so it is not part of the key.
// invalid-metadata messages start with `<title>: ` + a head of INVALID_META_HEADS (validate.ts); a title edit must not make the same problem look new.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const INVALID_META_TITLE_RE = new RegExp(`^.*?: (?=(?:${INVALID_META_HEADS.map(escapeRe).join('|')}))`);

/** An fqn-shaped word of a finding message. */
const FQN_WORD_RE = /[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*/g;

/** Prefix rule (PLAN_MOVE R1): `fqn` or its longest dotted head that `moved` maps, with the rest kept; else `fqn` as is. */
function mapFqn(moved: Map<string, string>, fqn: string): string {
  for (let cut = fqn.length; cut > 0; cut = fqn.lastIndexOf('.', cut - 1)) {
    const now = moved.get(fqn.slice(0, cut));
    if (now !== undefined) return now + fqn.slice(cut);
  }
  return fqn;
}

/** `moved` (only for findings of the plan BEFORE a move): the id and every fqn-shaped word of the message are mapped old -> new. */
function findingKey(f: PlanFinding, moved?: Map<string, string>): string {
  let message = f.message;
  if (f.rule === 'parse-error') message = message.replace(/^.*?:\d+ /, '');
  else if (f.rule === 'invalid-metadata') message = message.replace(INVALID_META_TITLE_RE, '');
  if (!moved) return `${f.rule}|${f.id}|${message}`;
  return `${f.rule}|${mapFqn(moved, f.id)}|${message.replace(FQN_WORD_RE, w => mapFqn(moved, w))}`;
}

function findingsOf(plan: Plan, repoRoot: string, scan?: (plan: Plan) => Snapshot): PlanFinding[] {
  if (scan) return timed('checkPlan', () => checkPlan(plan, scan(plan), repoRoot));   // includes parse-error + validateMetadata
  const out: PlanFinding[] = validateMetadata(plan.elements);
  for (const issue of plan.issues) {
    out.push({
      severity: 'warning',
      rule: 'parse-error',
      id: issue.file,
      message: `${issue.file}:${issue.line} ${issue.message}`,
    });
  }
  return out;
}

function protectedLines(text: string, lineRe: RegExp = PROTECTED_LINE_RE): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!lineRe.test(line)) continue;
    const k = line.trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Gate (D12): parse both sides from memory, compare findings, decide. Pure: nothing is written.
 * Refuses when: a new parse issue appears, a new warning/critical finding appears (info never refuses),
 * an existing `uid`/`layout` line is not still present, an element is lost (unless listed in `allowLost`; then its own uid/layout lines may go too), a file is dropped or added,
 * a `test` block is lost (unless listed in `allowLostTests`, or its element is an allowed removal).
 * With `moved` (plan move / rename): a mapped element is matched at its new fqn instead of its old one, its uid/layout
 * lines may change file (the plan as a whole keeps them), and an element of the map that is not found refuses the edit.
 */
export function evaluatePlanEdit(args: EvaluateArgs): EvaluateResult {
  const { repoRoot, oldTexts, newTexts, scan, moved } = args;
  const allowLost = new Set(args.allowLost ?? []);
  const reasons: string[] = [];

  const before = parsePlanTexts(repoRoot, oldTexts);
  const after = parsePlanTexts(repoRoot, newTexts);
  const findingsBefore = findingsOf(before, repoRoot, scan);
  const findingsAfter = findingsOf(after, repoRoot, scan);

  const oldIssues = new Set(before.issues.map(issueKey));
  const newIssues = after.issues.filter(i => !oldIssues.has(issueKey(i)));
  for (const i of newIssues) reasons.push(`new parse issue ${i.file}:${i.line} ${i.message}`);

  const keysBefore = new Set(findingsBefore.map(f => findingKey(f, moved)));
  const keysAfter = new Set(findingsAfter.map(f => findingKey(f)));
  const newFindings = findingsAfter.filter(f => !keysBefore.has(findingKey(f)));
  const fixedFindings = findingsBefore.filter(f => !keysAfter.has(findingKey(f, moved)));
  for (const f of newFindings) {
    if (f.severity === 'warning' || f.severity === 'critical') {
      reasons.push(`new ${f.severity} ${f.rule} ${f.id}: ${f.message}`);
    }
  }

  // moved elements: found at their new fqn (same kind; same uid when they have one), each `after` element taken once
  const taken = new Set<PlanElement>();
  const movedRows: MovedElement[] = [];
  const movedFound: PlanElement[] = [];
  const notFound: string[] = [];
  for (const e of before.elements) {
    const to = moved?.get(e.id);
    if (to === undefined) continue;
    const uid = e.metadata.uid ?? null;
    const hit = after.elements.find(a => a.id === to && !taken.has(a) && a.kind === e.kind && (uid === null || a.metadata.uid === uid));
    if (!hit) { notFound.push(`moved element not found: ${e.id} -> ${to}`); continue; }
    taken.add(hit);
    movedRows.push({ from: e.id, to, uid });
    movedFound.push(e);
  }

  // other elements of `before` with no counterpart in `after` (ids may repeat: each copy counts once)
  const afterIds = new Map<string, number>();
  for (const e of after.elements) if (!taken.has(e)) afterIds.set(e.id, (afterIds.get(e.id) ?? 0) + 1);
  const lostElements = before.elements.filter(e => {
    if (moved?.has(e.id)) return false;
    const left = afterIds.get(e.id) ?? 0;
    if (left > 0) afterIds.set(e.id, left - 1);
    return left === 0;
  });
  const valuesOf = (els: PlanElement[]) => els.flatMap(e => [e.metadata.uid, e.metadata.layout]).filter((v): v is string => !!v);
  // an allowed removal takes its own uid and layout lines with it
  const removedValues = valuesOf(lostElements.filter(e => allowLost.has(e.id)));
  // a moved element's uid and layout lines may change file: they are counted over the whole plan instead
  const movedValues = valuesOf(movedFound);
  const owned = (line: string, values: string[]) => values.some(v => line.includes(v));
  const lineRe = args.allowLayout ? UID_LINE_RE : PROTECTED_LINE_RE;

  const files: PlanEditFile[] = [];
  for (const [file, oldText] of oldTexts) {
    const newText = newTexts.get(file);
    if (newText === undefined) { reasons.push(`file dropped from the edit: ${file}`); continue; }
    if (newText === oldText) continue;
    files.push({ file, oldText, newText, diff: unifiedDiff(file, oldText, newText) });
    const was = protectedLines(oldText, lineRe);
    const now = protectedLines(newText, lineRe);
    for (const [line, n] of was) {
      if ((now.get(line) ?? 0) < n && !owned(line, removedValues) && !owned(line, movedValues)) reasons.push(`protected line changed in ${file}: ${line}`);
    }
  }
  if (movedValues.length > 0) {
    const was = protectedLines([...oldTexts.values()].join('\n'), lineRe);
    const now = protectedLines([...newTexts.values()].join('\n'), lineRe);
    for (const [line, n] of was) {
      if ((now.get(line) ?? 0) < n && owned(line, movedValues)) reasons.push(`protected line changed in the plan: ${line}`);
    }
  }
  for (const file of newTexts.keys()) {
    if (!oldTexts.has(file)) reasons.push(`edit would create a new file: ${file}`);
  }

  reasons.push(...notFound);
  const allowedTests = new Set((args.allowLostTests ?? []).map(t => `${t.parent}\0${t.name}`));
  const lostTests = lostTestBlocks(before, after, {
    ...(moved ? { mapFqn: (fqn: string) => mapFqn(moved, fqn) } : {}),
    skipParents: new Set(lostElements.map(e => e.id)),   // a lost element is refused (or allowed) above, with its blocks
  });
  for (const t of lostTests) {
    if (!allowedTests.has(`${t.parent}\0${t.name}`)) reasons.push(`test block lost by the edit: ${t.parent} test '${t.name}'`);
  }
  for (const e of lostElements) {
    if (allowLost.has(e.id)) continue;
    // with a move map, a uid that now sits on another fqn points at the command that keeps it
    const uid = e.metadata.uid;
    const now = moved && uid ? after.elements.find(a => a.metadata.uid === uid && a.id !== e.id) : undefined;
    reasons.push(`element lost by the edit: ${e.id}` + (now ? ` (its uid is now on ${now.id}; use c4pm plan move)` : ''));
  }

  log(TAG, 'evaluate', { files: files.length, moved: movedRows.length, reasons: reasons.length });
  return {
    before, after, findingsBefore, findingsAfter, newIssues, newFindings, fixedFindings,
    reasons, refused: reasons.length > 0, files, moved: movedRows,
  };
}

export interface CommitArgs {
  repoRoot: string;
  project: ProjectPaths | null;
  files: { file: string; oldText: string; newText: string }[];
  force: boolean;
  /** Re-reads the plan from disk after the write (normally `() => parsePlan(repoRoot, planFiles)`). */
  reparse: () => Plan;
  /** Command postcondition on the re-read plan; a string is the failure reason. */
  post: (plan: Plan) => string | null;
  /**
   * plan move / rename: wireframe files to rename and/or rewrite (planWireframeMoves). Paths repo-relative, inside `ioDir`.
   * W9 (b305) plan wireframe: a `create` edit writes a new file (and `ioDir` when it is missing).
   */
  wireframes?: WireframeEdit[];
  /** Absolute `<plan folder>/io`: the only folder whose `.html` files a plan edit may write. */
  ioDir?: string;
}

export type CommitResult =
  | { ok: true }
  | { ok: false; reason: 'outside-c4pm' | 'rolled-back'; detail: string };

/**
 * Write the edit, re-read the plan from disk, run the postcondition; on any failure restore every old text.
 * Refuses BEFORE writing anything when a file is outside `.c4pm/` and `C4PM/` (unless force), is not a `.c4` file
 * (never forceable; the one exception is a wireframe edit: `<fqn>.html` directly in `ioDir`, see isWireframeFile),
 * when the file on disk no longer holds the text the edit was made from, or when a wireframe's new name is taken.
 * A `create` wireframe edit (W9, b305) is not read first: its file must not exist (refused, nothing written); `ioDir` is
 * made when missing, and rollback removes the new file and the `ioDir` it made (when empty).
 * Order: every `.c4`, then each wireframe (write `to`, remove `from`); rollback removes `to`, rewrites `from`, restores the `.c4`.
 */
export function commitPlanEdit(args: CommitArgs): CommitResult {
  const { repoRoot, project, files, force, reparse, post, ioDir } = args;
  const wireframes = args.wireframes ?? [];
  const abs = (file: string) => path.resolve(repoRoot, file);
  const writable = (file: string) => force || isAutoWritable(project, abs(file));

  const wirePaths = [...new Set(wireframes.flatMap(w => [w.from, w.to]))];
  const creates = new Set(wireframes.filter(w => w.create).map(w => w.to));
  const notWire = wirePaths.filter(f => ioDir === undefined || !isWireframeFile(ioDir, abs(f), { create: creates.has(f) }));
  const outside = [
    ...files.filter(f => path.extname(f.file) !== '.c4' || !writable(f.file)).map(f => f.file),
    ...wirePaths.filter(f => !notWire.includes(f) && !writable(f)),
  ];
  if (outside.length > 0 || notWire.length > 0) {
    const detail = [
      outside.length > 0 ? `outside .c4mp/ (use --force): ${outside.join(', ')}` : '',
      notWire.length > 0 ? `not a wireframe file of the plan io/ folder: ${notWire.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    log(TAG, 'refused outside', { detail });
    return { ok: false, reason: 'outside-c4pm', detail };
  }

  const exists = [...creates].filter(f => fs.existsSync(abs(f)));   // a symbolic link was refused above (isWireframeFile)
  if (exists.length > 0) {
    return { ok: false, reason: 'rolled-back', detail: `nothing written: ${exists.join(', ')} exists (a new wireframe file never overwrites)` };
  }

  const sources = [
    ...files.map(f => ({ file: f.file, oldText: f.oldText })),
    ...wireframes.filter(w => !w.create).map(w => ({ file: w.from, oldText: w.oldText })),
  ];
  for (const f of sources) {
    let onDisk: string;
    try {
      onDisk = fs.readFileSync(abs(f.file), 'utf-8');
    } catch (e) {
      return { ok: false, reason: 'rolled-back', detail: `nothing written: cannot read ${f.file}: ${(e as Error).message}` };
    }
    if (onDisk !== f.oldText) {
      return { ok: false, reason: 'rolled-back', detail: `nothing written: ${f.file} changed on disk since it was read` };
    }
  }
  const targets = wireframes.filter(w => w.to !== w.from).map(w => w.to);
  const taken = targets.filter((t, i) => fs.existsSync(abs(t)) || targets.indexOf(t) !== i);
  if (taken.length > 0) {
    return { ok: false, reason: 'rolled-back', detail: `nothing written: wireframe collision: ${taken.join(', ')} exists or is written twice` };
  }

  const holds = (file: string, text: string) => fs.existsSync(abs(file)) && fs.readFileSync(abs(file), 'utf-8') === text;
  const written: typeof files = [];
  const wired: WireframeEdit[] = [];
  let madeIo = false;   // this commit made ioDir (a create edit): rollback removes it again when empty
  const restore = (): string => {
    const failed: string[] = [];
    for (const w of [...wired].reverse()) {
      try {
        if (w.to !== w.from || w.create) fs.rmSync(abs(w.to), { force: true });   // `to` was absent before the commit
        if (!w.create && !holds(w.from, w.oldText)) writeAtomic(abs(w.from), w.oldText);
      } catch (e) {
        failed.push(`${w.from}: ${(e as Error).message}`);
      }
    }
    if (madeIo && ioDir !== undefined) {
      try {
        if (fs.readdirSync(ioDir).length === 0) fs.rmdirSync(ioDir);
      } catch (e) {
        failed.push(`${ioDir}: ${(e as Error).message}`);
      }
    }
    for (const f of written) {
      try {
        // a file whose write never started (or never changed it) is not rewritten
        if (fs.readFileSync(abs(f.file), 'utf-8') === f.oldText) continue;
        writeAtomic(abs(f.file), f.oldText);
      } catch (e) {
        failed.push(`${f.file}: ${(e as Error).message}`);
      }
    }
    return failed.length > 0 ? `; RESTORE FAILED for ${failed.join(', ')}` : '';
  };

  try {
    for (const f of files) {
      written.push(f);   // temp file + rename: a failed write leaves the old file whole; restore() then skips it
      fs.accessSync(abs(f.file), fs.constants.W_OK);   // rename would replace a read-only file; writeFileSync used to refuse it
      writeAtomic(abs(f.file), f.newText);
    }
    for (const w of wireframes) {
      if (w.create && ioDir !== undefined && !fs.existsSync(ioDir)) {
        fs.mkdirSync(ioDir);   // not recursive: the plan folder is there (its .c4 files were read)
        madeIo = true;
      }
      wired.push(w);
      writeAtomic(abs(w.to), w.newText);
      if (w.to !== w.from) fs.unlinkSync(abs(w.from));
    }
    const reason = post(reparse());
    if (reason !== null) return { ok: false, reason: 'rolled-back', detail: reason + restore() };
  } catch (e) {
    return { ok: false, reason: 'rolled-back', detail: (e as Error).message + restore() };
  }
  log(TAG, 'committed', { files: files.length, wireframes: wireframes.length });
  return { ok: true };
}
