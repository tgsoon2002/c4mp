/**
 * b462 (ARR-CL-3): the Plan editing service the plan commands load and look up through. It loads the plan state
 * (config, plan files, parsed plan, file texts, project paths), finds one element by a target string, scans the repo
 * with a given plan, re-reads the plan from disk, and gives the `plan add` rules. The Command Line calls these instead
 * of Plan reading (parser, kinds, planned elements) and the Scan pipeline directly.
 * b472 (ARR-CL-P, row P8): it also runs the write gate every plan write goes through (runWrite: evaluatePlanEdit ->
 * dry run -> commitPlanEdit with rollback, writeGuard), moved here from src/cli/common.ts with its report shape.
 * L3: imports nothing from src/cli/ (that would be an upward import); src/cli/common.ts re-exports the error shape,
 * the report shape, runWrite, Opts, targetInfoOf and withText (b477: the edit builders in planOps.ts use them).
 */
import * as fs from 'fs';
import * as path from 'path';
import { openProject } from '../scan/project';
import { findPlan, planScanSession } from '../scan/planScan';
import type { ScanSession } from '../scan/session';
import { parsePlan } from '../plan/parser';
import { addRuleOf, addableKinds, topLevelKinds } from '../plan/kinds';
import { PLANNED_CODE_KINDS } from '../plan/plannedElements';
import { evaluatePlanEdit, commitPlanEdit } from '../c4/planTx';
import type { MovedElement } from '../c4/planTx';
import { isAutoWritable } from '../c4/writeGuard';
import { timed } from '../log';
import { textStamp } from '../util/stamp';
import { closestItems, lookupElement, pickOne } from '../util/lookup';
import type { LookupItem } from '../util/lookup';
import { planItems } from '../plan/planItems';
import type { C4pmConfig, Plan, PlanElement, PlanFinding, ProjectPaths } from '../types';
import type { Mention, WireframeChange } from './planMove';
import { CMD_NAME } from '../constants';

// --- errors (the shape every plan command reports) ---------------------------------------------------------

export type ErrorCode =
  | 'no-plan' | 'not-found' | 'ambiguous' | 'invalid' | 'outside-c4pm' | 'new-findings' | 'rolled-back'
  // Phase 32 (ED-2): the code edit commands (src/services/codeEdit.ts)
  | 'parse-worse' | 'changed';

export interface Candidate { uid: string | null; fqn: string; title: string }
export interface CmdError { code: ErrorCode; message: string; candidates?: Candidate[]; hint?: string }

export const cmdError = (code: ErrorCode, message: string, extra: Partial<CmdError> = {}): CmdError => ({ code, message, ...extra });

// --- loading -------------------------------------------------------------------------------------------------

export interface PlanState {
  repoRoot: string;
  config: C4pmConfig;
  c4Files: string[];                // repo-relative
  plan: Plan;
  texts: Map<string, string>;       // file -> text as read from disk
  /** The project folders (Project & scan openProject); null without an anchor. */
  project: ProjectPaths | null;
  /** Absolute folder the plan files came from (its io/ holds the wireframes); null for the repo-wide fallback. */
  planDir: string | null;
  /** One scan per command (b320): lazy, shared by every step of a fold. */
  session: ScanSession;
}

/**
 * The ONE place the plan commands load a plan: config, plan files, parsed plan, the file texts and the project paths.
 * Returns null when the repo has no .c4 files. Throws when the repo is not a folder or a plan file cannot be read.
 * Writes nothing (no `.c4pm/` is created).
 */
export function loadPlanState(repoRoot: string, cli: Partial<C4pmConfig> = {}): PlanState | null {
  return timed('load plan', () => loadPlanStateUntimed(repoRoot, cli));
}

function loadPlanStateUntimed(repoRoot: string, cli: Partial<C4pmConfig>): PlanState | null {
  const root = path.resolve(repoRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`repo is not a directory: ${root}`);
  // Project & scan opens the project (config, project folders) and finds and parses the plan.
  const { config, project } = openProject(root, cli);
  const { files: c4Files, dir: planDir, plan } = findPlan(root, config);
  if (!plan) return null;
  const texts = new Map<string, string>();
  for (const f of c4Files) texts.set(f, fs.readFileSync(path.resolve(root, f), 'utf-8'));
  return { repoRoot: root, config, c4Files, plan, texts, project, planDir, session: planScanSession(root, config) };
}

/** A copy of the plan texts with one file's text replaced (b477: moved from src/cli/common.ts). */
export function withText(state: PlanState, file: string, text: string): Map<string, string> {
  const next = new Map(state.texts);
  next.set(file, text);
  return next;
}

/** The plan parsed again from the state's plan files on disk (the write gate's re-read after a write). */
export function reparsePlan(state: PlanState): Plan {
  return parsePlan(state.repoRoot, state.c4Files);
}

/**
 * Snapshot of the repo with the given plan (what `check` builds); used by --check, link validation and --case.
 * A timed wrapper of the one plan-aware scan in Project & scan (src/scan/planScan.ts).
 */
export function scanWithPlan(state: PlanState, plan: Plan) {
  return timed('scan repo', () => state.session.snapshotFor(plan));
}

// --- targets -------------------------------------------------------------------------------------------------

export type Resolved = { ok: true; el: PlanElement; item: LookupItem } | { ok: false; error: CmdError };

const candidateOf = (m: LookupItem): Candidate => ({ uid: m.uid ?? null, fqn: m.fqn ?? m.id, title: m.title });

/**
 * Find ONE plan element by uid, fqn, id, local id or name (lookupElement tiers). system/container/component only;
 * `codeToo` also searches planned code (function/class/method/type). Wording of `c4pm plan show`.
 */
export function resolveTarget(state: PlanState, target: string, opts: { codeToo?: boolean } = {}): Resolved {
  const entries = planItems(state.plan);
  if (opts.codeToo) {
    for (const el of state.plan.elements) {
      if (PLANNED_CODE_KINDS.includes(el.kind)) {
        entries.push({ item: { uid: el.metadata.uid, id: el.id, fqn: el.id, title: el.title, level: el.kind }, el });
      }
    }
  }
  const items = entries.map(e => e.item);
  const picked = pickOne(lookupElement(target, items));
  if (picked.ok) return { ok: true, el: entries.find(e => e.item === picked.item)!.el, item: picked.item };
  if (picked.reason === 'none') {
    return {
      ok: false,
      error: cmdError('not-found', `no element matches '${target}'`, { candidates: closestItems(target, items, 5).map(candidateOf) }),
    };
  }
  return {
    ok: false,
    error: cmdError('ambiguous', `'${target}' matches ${picked.matches.length} elements, use a uid:`, {
      candidates: picked.matches.map(candidateOf),
      ...(picked.matches.some(m => !m.uid) ? { hint: 'run c4mp plan ids to give every element a uid' } : {}),
    }),
  };
}

// --- plan add rules ------------------------------------------------------------------------------------------

/** What `plan add` accepts: every addable kind word, the top-level kinds (`context --as`), and each kind's allowed parents ([] = top level). */
export interface AddRules { kinds: string[]; topLevel: string[]; parents: Record<string, string[]> }

/** The `plan add` rules from the one kind table (src/plan/kinds.ts), in table order. */
export function addRules(): AddRules {
  const kinds = addableKinds();
  return { kinds, topLevel: topLevelKinds(), parents: Object.fromEntries(kinds.map(k => [k, addRuleOf(k)!.parents])) };
}

// --- the write gate (b472, row P8: moved from src/cli/common.ts) ---------------------------------------------

/**
 * A command's parsed options, handed in whole; the write gate reads yes, force, check, expectStamp (b477: the one Opts type,
 * src/cli/common.ts re-exports it).
 */
export type Opts = Record<string, unknown>;

export interface TargetInfo { uid: string | null; fqn: string; kind: string }

/** The report's target of a plan element (b477: moved from src/cli/common.ts). */
export const targetInfoOf = (el: PlanElement): TargetInfo => ({ uid: el.metadata.uid ?? null, fqn: el.id, kind: el.kind });

export type { Mention, WireframeChange };

/** D15 write result. */
export interface WriteReport {
  ok: boolean;
  command: string;
  dryRun: boolean;
  written: boolean;
  target: TargetInfo | null;
  files: { file: string; diff: string }[];
  findings: { new: PlanFinding[]; fixed: PlanFinding[] };
  notes: string[];
  error: CmdError | null;
  // plan move / rename only (PLAN_MOVE.md 4); absent for every other command.
  /** First text line instead of `<command> <target>`. */
  headline?: string;
  /** Every moved element (roots and descendants) the gate found at its new fqn. */
  moved?: MovedElement[];
  /** Wireframe files renamed and/or rewritten; diff empty when only the name changes. */
  wireframes?: { from: string; to: string; diff: string }[];
  /** Reference tokens rewritten per plan file. */
  rewritten?: { file: string; count: number }[];
  /** Lines outside the references that still name an old fqn: listed, never edited (absent with --no-mentions). */
  mentions?: Mention[];
  mentionsTotal?: number;
}

/** Failed report with no files. */
export function failedReport(command: string, opts: Opts, error: CmdError, target: TargetInfo | null = null): WriteReport {
  return {
    ok: false, command, dryRun: opts.yes !== true, written: false, target, files: [],
    findings: { new: [], fixed: [] }, notes: [], error,
  };
}

/** Note added by `link` when a function link would switch the plan from folder mode to claim mode. */
export const CLAIM_SWITCH_NOTE = 'this function link switches the whole plan to claim mode (c4.md section 5)';
/** T10c: printed when a refusal follows CLAIM_SWITCH_NOTE. */
export const CLAIM_SWITCH_NEXT_STEP =
  `NEXT STEP: link the file or folder without #name to stay in folder mode, or claim every function of it (see: ${CMD_NAME} plan unplanned)`;

export interface WriteSpec {
  command: string;
  opts: Opts;                       // yes, force, check, json
  state: PlanState;
  target: TargetInfo | null;
  /** The whole edited plan: every plan file with its new text (unchanged files carry their old text). */
  newTexts: Map<string, string>;
  notes?: string[];
  /** Use the full checkPlan scan for the gate (--check, or the command needs it). */
  scan?: boolean;
  /** Element ids the edit removes on purpose (the gate's `allowLost`); only remove ops fill it. */
  allowLost?: string[];
  /** Test blocks (parent fqn + name) the edit removes on purpose (the gate's `allowLostTests`); only `plan remove --test`. */
  allowLostTests?: { parent: string; name: string }[];
  /** SV2 (b678): a layout write (`plan apply-layout`): the gate lets `layout` lines change or go (uid lines stay protected). */
  allowLayout?: boolean;
  /** Postcondition on the edited plan, checked in memory and again on the plan re-read from disk. String = failure reason. */
  post: (plan: Plan) => string | null;
  /** plan move / rename: old fqn -> new fqn of every moved element (the gate's `moved`). */
  moved?: Map<string, string>;
  /** plan move / rename: wireframe files to rename and/or rewrite inside `<planDir>/io` (written after the .c4 files). */
  wireframes?: WireframeChange[];
  /** plan move / rename: report fields that do not come from the gate (headline, rewritten counts). */
  report?: Pick<WriteReport, 'headline' | 'rewritten'>;
}

/**
 * D12 gate -> dry run output -> D13 write with rollback. Pure of process state: returns the report.
 * Never writes without `opts.yes === true`. A dry run that would be refused is a failed report (exit 1).
 */
export function runWrite(spec: WriteSpec): WriteReport {
  const { command, opts, state, target, newTexts, post } = spec;
  const notes = [...(spec.notes ?? [])];
  const yes = opts.yes === true;
  const force = opts.force === true;
  const wireframes = spec.wireframes ?? [];
  // move / rename fields; `moved` is filled from the gate below
  let extra: Partial<WriteReport> = {
    ...spec.report,
    ...(spec.wireframes ? { wireframes: wireframes.map(w => ({ from: w.from, to: w.to, diff: w.diff })) } : {}),
  };
  const fail = (error: CmdError, files: WriteReport['files'] = [], findings: WriteReport['findings'] = { new: [], fixed: [] }): WriteReport => ({
    ok: false, command, dryRun: !yes, written: false, target, files, findings, notes, error, ...extra,
  });

  // SV2 (b678): a page sends the stamp of the plan it loaded; another plan on disk is refused before the gate.
  if (typeof opts.expectStamp === 'string' && opts.expectStamp !== textStamp(state.texts)) {
    return fail(cmdError('changed', 'the plan changed since this page loaded; nothing written. Reload the page and try again'));
  }

  let evaluated: ReturnType<typeof evaluatePlanEdit>;
  try {
    evaluated = evaluatePlanEdit({
      repoRoot: state.repoRoot,
      oldTexts: state.texts,
      newTexts,
      ...(spec.allowLost && spec.allowLost.length > 0 ? { allowLost: spec.allowLost } : {}),
      ...(spec.allowLostTests && spec.allowLostTests.length > 0 ? { allowLostTests: spec.allowLostTests } : {}),
      ...(spec.scan || opts.check ? { scan: (plan: Plan) => scanWithPlan(state, plan) } : {}),
      ...(spec.moved ? { moved: spec.moved } : {}),
      ...(spec.allowLayout ? { allowLayout: true } : {}),
    });
  } catch (err) {
    return fail(cmdError('invalid', `the plan check could not run, nothing written: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (spec.moved) extra = { ...extra, moved: evaluated.moved };

  const files = evaluated.files.map(f => ({ file: f.file, diff: f.diff }));
  const findings = { new: evaluated.newFindings, fixed: evaluated.fixedFindings };
  if (evaluated.refused) {
    return fail(cmdError(
      'new-findings',
      `the edit would make the plan worse, nothing written:\n  - ${evaluated.reasons.join('\n  - ')}`,
      notes.includes(CLAIM_SWITCH_NOTE) ? { hint: CLAIM_SWITCH_NEXT_STEP } : {},
    ), files, findings);
  }
  if (files.length === 0 && wireframes.length === 0) {
    notes.push('no change');
    return { ok: true, command, dryRun: !yes, written: false, target, files, findings, notes, error: null, ...extra };
  }

  const postReason = post(evaluated.after);
  if (postReason !== null) return fail(cmdError('invalid', postReason), files, findings);

  const writable = (file: string) => force || isAutoWritable(state.project, path.resolve(state.repoRoot, file));
  const outside = [
    ...evaluated.files.filter(f => path.extname(f.file) !== '.c4' || !writable(f.file)).map(f => f.file),
    ...[...new Set(wireframes.flatMap(w => [w.from, w.to]))].filter(f => !writable(f)),
  ];
  if (outside.length > 0) {
    return fail(cmdError('outside-c4pm', `outside .c4mp/ (use --force): ${outside.join(', ')}`), files, findings);
  }

  if (!yes) return { ok: true, command, dryRun: true, written: false, target, files, findings, notes, error: null, ...extra };

  const committed = timed('write plan', () => commitPlanEdit({
    repoRoot: state.repoRoot,
    project: state.project,
    files: evaluated.files,
    force,
    reparse: () => reparsePlan(state),
    post: plan => {
      if (plan.issues.length > evaluated.after.issues.length) return 'the plan on disk has more parse issues than the edit was checked with';
      return post(plan);
    },
    ...(wireframes.length > 0 ? { wireframes, ...(state.planDir !== null ? { ioDir: path.join(state.planDir, 'io') } : {}) } : {}),
  }));
  if (!committed.ok) {
    return fail(
      cmdError(committed.reason, committed.detail),   // the code already says rolled-back
      files, findings,
    );
  }
  return { ok: true, command, dryRun: false, written: true, target, files, findings, notes, error: null, ...extra };
}
