/**
 * T5b (b701): the read-only s-item questions (`c4pm sim list|show`, MCP `sim_list` / `sim_show` in T6) and the JSON
 * result of the sim writes (`simWriteJson`, CLI `--json` and MCP `sim_apply` / `sim_remove` in T6b), and the refusal of a
 * sim read (`simReadError`, b784: CLI and MCP print the same object).
 * Reads only: loadSims(tryResolveProject(repoRoot)), never creates a folder or a file. Names come from the `plan` the
 * caller hands in (CLI and MCP: planNoScan of src/scan/planScan.ts, no scan); a stored ref resolves exactly as `c4pm check` reads it
 * (resolveSimTarget: uid, then fqn); a code ref `path#name` is not scanned here: it shows as `code` when its file exists.
 * Text and JSON are both printed from these results. No import of src/services (services import query).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Plan, PlanElement, SimCall, SimFileIssue, SimKind, ViewName } from '../types';
import { loadSims, simFileFor } from '../sim/load';
import { resolveSimTarget } from '../sim/resolve';
import { resolvePlanTarget } from '../plan/planItems';
import { tryResolveProject } from '../outputs';
import { failureCode, guardedWriteJson } from './guardedWrite';
import type { FailureCode, GuardedWriteJson } from './guardedWrite';
import { CMD_NAME } from '../constants';

export type { GuardedWriteJson } from './guardedWrite';

/** What a stored ref names: a plan element (`kind` = its kind), a code target (`kind` 'code', `fqn` = the ref), or null (nothing). */
export interface SimRef {
  ref: string;
  resolved: { kind: string; fqn: string; title: string; uid?: string } | null;
}

/** One row of `sim list`. `steps` on a flow, `stages` on a journey (counts). `file` relative to the repo. */
export interface SimListRow {
  id: string;
  kind: SimKind;
  title: string;
  person?: SimRef;
  steps?: number;
  stages?: number;
  file: string;
}

/** `sim list`: the s-items that parse, plus the issues (files not loaded) and notes (unknown keys kept) of the folder. */
export type SimListResult = { sims: SimListRow[]; issues: SimFileIssue[]; notes: SimFileIssue[] } | { error: string };

/** A step with every ref resolved; `n` is 1-based. */
export interface SimStepShow {
  n: number;
  targets: SimRef[];
  view: ViewName;
  call?: { from?: SimRef; to?: SimRef; label?: string; reply?: boolean };
  state?: string;
  rows?: { record: SimRef; rows: Record<string, unknown>[] }[];
  caption?: string;
  durationSec?: number;
  extra?: Record<string, unknown>;
}

/** A journey stage: `form` says which of flow / outside / step (inline step: the step fields, targets resolved). */
export interface SimStageShow extends Partial<Omit<SimStepShow, 'n'>> {
  n: number;
  form: 'flow' | 'outside' | 'step';
  name?: string;
  goal?: string;
  flow?: { id: string; title: string | null };
  outside?: string;
  from?: string;
  channel?: string;
}

/** `sim show <id>`: the s-item with its refs resolved, the file, and the reader's notes for that file. */
export interface SimShow {
  id: string;
  kind: SimKind;
  title: string;
  person?: SimRef;
  description?: string;
  file: string;
  steps?: SimStepShow[];
  stages?: SimStageShow[];
  extra?: Record<string, unknown>;
  notes?: string[];
}

export type SimShowResult = SimShow | { error: string; reasons: string[] };

/** The outcome of a sim write (structurally SimOpOutcome of src/services/simEdit.ts, which query must not import). */
export type SimWriteOutcome =
  | { error: string; reasons: string[] }
  | { result: { lines: string[]; minted?: string[] }; file: string; changed: boolean; written: boolean };

const SIM_KINDS: SimKind[] = ['flow', 'journey'];

/** The JSON object of one sim write (`{ok, command, dryRun, written, file, changes, minted?, error}`): the same builder as every guarded write of the CLI, so MCP text === CLI `--json` text. */
export function simWriteJson(command: string, outcome: SimWriteOutcome, yes: boolean): GuardedWriteJson {
  return guardedWriteJson(command, outcome, yes);
}

/** The refusal object of a sim read, as `c4pm sim list|show --json` prints it and MCP `sim_list` / `sim_show` reply with isError. */
export interface SimReadErrorJson {
  ok: false;
  command: string;
  error: { code: FailureCode; message: string; hint?: string };
}

/**
 * b784: the ONE refusal object of a sim read (`{ok: false, command, error: {code, message, hint?}}`), for the CLI and
 * MCP. `err` = a listSims / showSim refusal: the code comes from the message (failureCode: `no ...` = not-found, else
 * invalid) unless `code` is given (an unexpected throw is always invalid); `reasons` become the hint lines `  - <reason>`.
 */
export function simReadError(command: string, err: { error: string; reasons?: string[] }, code: FailureCode = failureCode(err.error)): SimReadErrorJson {
  const reasons = err.reasons ?? [];
  const hint = reasons.length > 0 ? { hint: reasons.map((r) => `  - ${r}`).join('\n') } : {};
  return { ok: false, command, error: { code, message: err.error, ...hint } };
}

const relTo = (repoRoot: string, p: string): string => path.relative(repoRoot, p).split(path.sep).join('/');

function planRef(el: PlanElement): SimRef['resolved'] {
  const uid = el.metadata.uid;
  return { kind: el.kind, fqn: el.id, title: el.title, ...(uid ? { uid } : {}) };
}

/** A stored ref (target, call end, rows key): plan element by uid or fqn; else a `path#name` whose file is in the repo; else null. */
function refOf(repoRoot: string, plan: Plan | null, ref: string): SimRef {
  const hit = resolveSimTarget(ref, plan, null);
  if (hit.kind === 'plan') return { ref, resolved: planRef(hit.el) };
  const hash = ref.lastIndexOf('#');
  if (hash > 0 && hash < ref.length - 1 && fs.existsSync(path.join(repoRoot, ref.slice(0, hash)))) {
    return { ref, resolved: { kind: 'code', fqn: ref, title: ref.slice(hash + 1) } };
  }
  return { ref, resolved: null };
}

/** `person` is free text (Q7); it resolves when it names one plan `person` element (uid, fqn, id or name), as the page links it. */
function personOf(plan: Plan | null, person: string): SimRef {
  if (plan) {
    const hit = resolvePlanTarget(plan, person);
    if (!('kind' in hit) && hit.el.kind === 'person') return { ref: person, resolved: planRef(hit.el) };
  }
  return { ref: person, resolved: null };
}

type Obj = Record<string, unknown>;

/** The step fields of a step or an inline stage, refs resolved. */
function stepShow(repoRoot: string, plan: Plan | null, s: Obj): Omit<SimStepShow, 'n'> {
  const ref = (r: string): SimRef => refOf(repoRoot, plan, r);
  const out: Omit<SimStepShow, 'n'> = { targets: (s.target as string[]).map(ref), view: s.view as ViewName };
  const call = s.call as SimCall | undefined;
  if (call) {
    out.call = {
      ...(call.from !== undefined ? { from: ref(call.from) } : {}),
      ...(call.to !== undefined ? { to: ref(call.to) } : {}),
      ...(call.label !== undefined ? { label: call.label } : {}),
      ...(call.reply ? { reply: true } : {}),
    };
  }
  if (typeof s.state === 'string') out.state = s.state;
  if (s.rows && typeof s.rows === 'object') {
    out.rows = Object.entries(s.rows as Record<string, Record<string, unknown>[]>).map(([k, rows]) => ({ record: ref(k), rows }));
  }
  if (typeof s.caption === 'string') out.caption = s.caption;
  if (typeof s.durationSec === 'number') out.durationSec = s.durationSec;
  if (s.extra) out.extra = s.extra as Record<string, unknown>;
  return out;
}

/** `sim list [--kind flow|journey]`: every s-item that parses (by number), with the folder's issues and notes. Read-only. */
export function listSims(repoRoot: string, plan: Plan | null, filter: { kind?: string }): SimListResult {
  if (filter.kind !== undefined && !(SIM_KINDS as string[]).includes(filter.kind)) {
    return { error: `unknown --kind '${filter.kind}'; use ${SIM_KINDS.join(' or ')}` };
  }
  const project = tryResolveProject(repoRoot);
  const sims = loadSims(project);
  const rows = sims.items
    .filter((s) => filter.kind === undefined || s.kind === filter.kind)
    .map((s): SimListRow => ({
      id: s.id, kind: s.kind, title: s.title,
      ...(s.person !== undefined ? { person: personOf(plan, s.person) } : {}),
      ...(s.kind === 'flow' ? { steps: s.steps?.length ?? 0 } : { stages: s.stages?.length ?? 0 }),
      file: relTo(repoRoot, simFileFor(project!, s.id)),
    }));
  return { sims: rows, issues: sims.issues, notes: sims.notes };
}

/** `sim show <id>`: one s-item with every target, call end and rows key resolved (kind, fqn, title, uid). Read-only. */
export function showSim(repoRoot: string, plan: Plan | null, id: string): SimShowResult {
  const project = tryResolveProject(repoRoot);
  const sims = loadSims(project);
  const item = sims.items.find((s) => s.id === id);
  if (!item) {
    const file = `${id}.json`;
    if (sims.fileIds.includes(id)) return { error: `${file} does not parse (fix it by hand)`, reasons: sims.issues.filter((i) => i.file === file).map((i) => i.message) };
    const ids = sims.items.map((s) => s.id);
    return { error: `no s-item '${id}'${ids.length > 0 ? ` (s-items: ${ids.join(', ')})` : ` (the repo has none yet: ${CMD_NAME} sim add starts one)`}`, reasons: [] };
  }
  const out: SimShow = {
    id: item.id, kind: item.kind, title: item.title,
    ...(item.person !== undefined ? { person: personOf(plan, item.person) } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    file: relTo(repoRoot, simFileFor(project!, item.id)),
  };
  if (item.steps) out.steps = item.steps.map((s, k) => ({ n: k + 1, ...stepShow(repoRoot, plan, s as unknown as Obj) }));
  if (item.stages) {
    out.stages = item.stages.map((st, k): SimStageShow => {
      const s = st as unknown as Obj;
      const head = {
        n: k + 1,
        ...(typeof s.name === 'string' ? { name: s.name } : {}),
        ...(typeof s.goal === 'string' ? { goal: s.goal } : {}),
      };
      if (typeof s.flow === 'string') {
        const flow = sims.items.find((f) => f.id === s.flow);
        return { ...head, form: 'flow', flow: { id: s.flow, title: flow ? flow.title : null }, ...(s.extra ? { extra: s.extra as Obj } : {}) };
      }
      if (typeof s.outside === 'string') {
        const o: SimStageShow = { ...head, form: 'outside', outside: s.outside };
        for (const key of ['from', 'channel', 'state', 'caption'] as const) if (typeof s[key] === 'string') o[key] = s[key] as string;
        if (typeof s.durationSec === 'number') o.durationSec = s.durationSec;
        if (s.extra) o.extra = s.extra as Obj;
        return o;
      }
      return { ...head, form: 'step', ...stepShow(repoRoot, plan, s) };
    });
  }
  if (item.extra) out.extra = item.extra;
  out.notes = sims.notes.filter((n) => n.file === `${item.id}.json`).map((n) => n.message);
  return out;
}
