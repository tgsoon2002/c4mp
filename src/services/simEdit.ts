/**
 * T4b (b700): the Simulation editing service behind `c4pm sim add|set|remove|step|stage|apply` (CLI, T5b) and the MCP
 * write tools `sim_apply` / `sim_remove` (T6b). Each write is the steps of runBoardOp: find the project, load the s-items
 * (loadSims), run one pure operation of src/sim/ops.ts on them, gate the result (every touched file must parse), and
 * write only with `yes` (planSimWrites + applySimWrites: changed-since-read per file, exclusive create of a new file).
 *
 * Refs (step targets, `call.from` / `call.to`, rows keys) are resolved here by ONE resolver (refResolver) and stored as the
 * **uid** of a plan element (b899, K Q6): an element without a uid gets one, and a code `path#name` the plan does not
 * hold yet is first added to it (addCodeEdit: under the owning component, done, an owner). The plan edit and the
 * s-items are ONE write (applySimWrites with the plan files as extra files). Files written before may hold an fqn or a
 * `path#name`: they still read; `c4pm sim upgrade` (upgradeSims) rewrites them.
 * `person`, stage `name`, `from` and `channel` are plain text, kept as typed (K 2026-11-15).
 * A refusal is returned as `{error, reasons}`; a load, concurrent-change or rollback error is thrown (SimWriteError), as
 * runBoardOp does. L3: imports src/sim, src/plan, src/scan, src/edit, src/util and the services; nothing from src/cli or
 * src/query.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { FileOutline, Plan, PlanElement, ProjectPaths, SimCall, SimItem, SimRows, SimStage, SimStep, ViewName } from '../types';
import { loadSims, simDirFor } from '../sim/load';
import type { LoadedSims } from '../sim/load';
import { addStage, addStep, expandSimApply, mintSimIds, moveStep, removeStage, removeStep, setStep } from '../sim/ops';
import type { SimOpError, SimStepPatch } from '../sim/ops';
import { normaliseView, parseSim } from '../sim/parse';
import { serializeSim } from '../sim/serialize';
import { applySimWrites, planSimWrites } from '../sim/write';
import type { SimWriteExtra } from '../sim/write';
import { resolvePlanTarget } from '../plan/planItems';
import { viewOfKind } from '../plan/kinds';
import { parseLink } from '../plan/links';
import { EditError } from '../edit/errors';
import { ensureInternalDirFor, requireProject } from '../outputs';
import { isObj } from '../util/obj';
import { UID_KEY } from '../util/uid';
import { readFileOutline } from './codeEdit';
import type { FileRead } from './codeEdit';
import { loadPlanState, reparsePlan, runWrite } from './planState';
import type { PlanState } from './planState';
import { linkCheckError, uidEdit, writeSpecOf } from './planOps';
import { PlanEditChain, addCodeEdit, codeElementOf } from './planEditChain';
import { CMD_NAME } from '../constants';

/**
 * The flag values of a sim command by commander's camelCase names (the flags of T5b): target (string | string[]), view,
 * state, caption, duration, rowsFile, callFrom, callTo, callLabel, reply, name, from, channel, flow, outside, goal, title,
 * description, person, kind, to, owner (b899: the owner of code a ref adds to the plan), and yes (addSim and setSim take `--yes` here, as their planned signatures have no
 * `yes` parameter). The word `none` clears an optional field (set commands). Keys not named are ignored.
 */
export type SimFlags = Record<string, unknown>;

/** The outcome of one sim write: refused (`error`, `reasons`, nothing written), or done / dry run with the change lines (the BoardOpOutcome shape). */
export type SimOpOutcome =
  | { error: string; reasons: string[] }
  | { result: { lines: string[]; minted?: string[] }; file: string; changed: boolean; written: boolean };

type Obj = Record<string, unknown>;

const refuse = (error: string, reasons: string[] = []): SimOpError => ({ error, reasons });
const isError = (v: unknown): v is SimOpError => isObj(v) && typeof v.error === 'string';
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isNone = (v: unknown): boolean => typeof v === 'string' && v.trim().toLowerCase() === 'none';

// ---------- refs: one resolver for targets, call ends and rows keys ----------

/** A resolved ref: what to store (always a uid), the plan kind and a label for the change lines. */
interface ResolvedRef {
  ref: string;
  kind: string;
  label: string;
}
type Resolve = (input: string, what: string) => ResolvedRef | SimOpError;

interface RefResolver {
  resolve: Resolve;
  /** The chain of plan edits the refs made (null until a ref read the plan, or with no plan). */
  chain(): PlanEditChain | null;
  /** One line per plan change, in order: `  plan: add ...` / `  plan: uid ...`. */
  lines: string[];
}

const planLabel = (el: PlanElement): string => `${el.kind} ${el.id} '${el.title}'`;
const lookupLine = (m: { uid?: string; id: string; fqn?: string; title: string }): string => `${m.uid ?? '(no uid)'}  ${m.fqn ?? m.id}  ${m.title}`;

/** A code target `path#name`: the file inside the repo (a language c4pm reads) and the name in its outline (readFileOutline). */
function codeRef(repoRoot: string, text: string, what: string): { outline: FileOutline; name: string } | SimOpError {
  const link = parseLink(text, '_.c4');
  if (link.lines) return refuse(`${what} '${text}' names lines; a code target is path#name`);
  if (!link.name || link.path.trim() === '') return refuse(`${what} '${text}' is not a code target path#name`);
  let file: FileRead;
  try {
    file = readFileOutline(repoRoot, {}, link.path);
  } catch (e) {
    if (e instanceof EditError) return refuse(`${what} '${text}': ${e.message}`);
    throw e;
  }
  const el = file.outline.elements.find((e) => e.name === link.name);
  if (!el) {
    const names = file.outline.elements.map((e) => e.name);
    const near = names.filter((n) => n.toLowerCase().includes((link.name as string).toLowerCase()));
    return refuse(`${what} '${text}': no function, class or method '${link.name}' in ${file.rel}`, (near.length > 0 ? near : names).slice(0, 5));
  }
  const rel = path.relative(fs.realpathSync(repoRoot), file.absFile).split(path.sep).join('/');
  return { outline: { ...file.outline, file: rel }, name: link.name };
}

/**
 * The resolver of one command (b899: every ref is stored as a uid). Tiers: 1. a plan element as `plan show` finds it
 * (resolvePlanTarget: uid, id, fqn, local id, title), 2. the exact fqn or uid of ANY plan element (planned functions,
 * methods and classes too), 3. a code `path#name`: the plan element that links it, else one added now (addCodeEdit, status
 * done, `owner` or the component's owner). An element without a uid gets one (uidEdit). Plan edits run on one
 * PlanEditChain, so a ref to code added earlier in the same command finds it. The plan is read once, on the first ref
 * (a write without refs never needs a plan or a config).
 */
function refResolver(repoRoot: string, owner: string | undefined): RefResolver {
  let chain: PlanEditChain | null | undefined;
  const lines: string[] = [];
  const chainOf = (): PlanEditChain | null => {
    if (chain === undefined) {
      const state = loadPlanState(repoRoot);
      chain = state ? new PlanEditChain(state) : null;
    }
    return chain;
  };
  /** The uid of `el`: its own, or one minted by a uidEdit on the chain. */
  const stored = (c: PlanEditChain, el: PlanElement, text: string, what: string): ResolvedRef | SimOpError => {
    let uid = el.metadata[UID_KEY];
    if (uid === undefined) {
      const r = c.apply((s) => uidEdit(s, el.id));
      if (!r.ok) return refuse(`${what} '${text}': ${r.error.message}`);
      uid = r.edit.target.uid as string;
      lines.push(`  plan: uid ${uid} for ${el.kind} ${el.id}`);
    }
    return { ref: uid, kind: el.kind, label: planLabel(el) };
  };
  const resolve: Resolve = (input, what) => {
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '') return refuse(`${what} is empty: give a c-item uid, fqn, id or name, or a code target path#name`);
    const c = chainOf();
    let closest: string[] = [];
    if (c) {
      const p = c.state.plan;
      const hit = resolvePlanTarget(p, text);
      if (!('kind' in hit)) return stored(c, hit.el, text, what);
      if (hit.reason === 'ambiguous') {
        return refuse(`${what} '${text}' matches ${hit.matches.length} plan elements; give a uid or fqn`, hit.matches.map(lookupLine));
      }
      const byKey = p.elements.find((el) => el.id === text || el.metadata[UID_KEY] === text);
      if (byKey) return stored(c, byKey, text, what);
      if (hit.reason === 'none') closest = hit.closest.map(lookupLine);
    }
    if (text.includes('#')) {
      if (!c) return refuse(`${what} '${text}': no plan found (${CMD_NAME} plan generate starts one); a code target is added to the plan, so it needs one`);
      const code = codeRef(repoRoot, text, what);
      if (isError(code)) return code;
      let el = codeElementOf(c.state.plan, code.outline.file, code.name);
      if (!el) {
        const r = c.apply((s) => addCodeEdit(s, { outline: code.outline, name: code.name, owner }));
        if (!r.ok) return refuse(`${what} '${text}': ${r.error.message}`);
        el = c.state.plan.elements.find((e) => e.id === r.edit.target.fqn) ?? null;
        if (!el) return refuse(`${what} '${text}': the plan element just added was not found`);
        lines.push(`  plan: add ${el.kind} ${el.id} '${el.title}' (link ${code.outline.file}#${code.name}, status done, owner ${el.metadata.owner})`);
      }
      return stored(c, el, text, what);
    }
    if (!c) return refuse(`${what} '${text}': no plan found (${CMD_NAME} plan generate starts one); a code target is path#name`);
    return refuse(`${what} '${text}' matches no plan element (closest below; a code target is path#name)`, closest);
  };
  return { resolve, chain: () => chain ?? null, lines };
}

/** Resolves many refs of one command and keeps every problem, so a command or an apply file reports them all at once. */
class RefCollector {
  readonly problems: SimOpError[] = [];
  readonly resolved: { input: string; what: string; hit: ResolvedRef }[] = [];
  constructor(private readonly resolve: Resolve) {}

  /** The ref to store, or null (the problem is kept). */
  one(input: string, what: string): ResolvedRef | null {
    const r = this.resolve(input, what);
    if (isError(r)) { this.problems.push(r); return null; }
    this.resolved.push({ input, what, hit: r });
    return r;
  }

  /** Rows `{ <record ref>: rows }` with every key resolved to a plan `record` (Q3: stored by uid); values kept as given. */
  rows(raw: unknown, what: string): SimRows | null {
    if (!isObj(raw)) { this.problems.push(refuse(`${what} must be a JSON object { "<record>": [ {row}, ... ] }`)); return null; }
    const out: Obj = {};
    const seen = new Map<string, string>();
    let ok = true;
    for (const [key, list] of Object.entries(raw)) {
      const hit = this.one(key, `${what} key`);
      if (!hit) { ok = false; continue; }
      if (hit.kind !== 'record') { this.problems.push(refuse(`${what} key '${key}' is ${hit.label}, not a record`)); ok = false; continue; }
      const twin = seen.get(hit.ref);
      if (twin !== undefined) { this.problems.push(refuse(`${what} keys '${twin}' and '${key}' name the same record ${hit.ref}`)); ok = false; continue; }
      seen.set(hit.ref, key);
      Object.defineProperty(out, hit.ref, { value: list, enumerable: true, writable: true, configurable: true });
    }
    return ok ? (out as SimRows) : null;
  }

  /** null when every ref resolved; one problem as it is; several as one refusal listing them. */
  refusal(): SimOpError | null {
    if (this.problems.length === 0) return null;
    if (this.problems.length === 1) return this.problems[0];
    return refuse(`${this.problems.length} refs do not resolve, nothing changed`, this.problems.flatMap((p) => [p.error, ...p.reasons.map((r) => `  ${r}`)]));
  }

  labelOf(ref: string): string | undefined {
    return this.resolved.find((r) => r.hit.ref === ref)?.hit.label;
  }
}

// ---------- flags ----------

/** A string flag: undefined when absent (or not a string). */
const flagText = (flags: SimFlags, key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);
/** `--target` given once (string) or repeated (string[]). */
function flagList(flags: SimFlags, key: string): string[] {
  const v = flags[key];
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}
function viewFlag(v: string): ViewName | SimOpError {
  return normaliseView(v.trim()) ?? refuse(`--view '${v}' must be arch, io or storage`);
}
function durationFlag(v: unknown): number | SimOpError {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : refuse(`--duration '${String(v)}' must be a number of seconds > 0`);
}
/** A whole-number flag (`--to`); positions are range-checked by the ops. */
function wholeFlag(v: unknown, flag: string): number | SimOpError {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : refuse(`${flag} '${String(v)}' must be a whole number`);
}
/** `--reply`: true / false, or the words true, false, none (false and none clear it). */
function replyFlag(v: unknown): boolean | SimOpError {
  if (typeof v === 'boolean') return v;
  const w = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (w === 'true') return true;
  if (w === 'false' || w === 'none') return false;
  return refuse(`--reply '${String(v)}' must be true, false or none`);
}
/** The JSON of `--rows-file` (a path from the working directory, as `board --description-file`). */
function readRowsFile(file: string): { raw: unknown } | SimOpError {
  try {
    return { raw: JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown };
  } catch (err) {
    return refuse(`--rows-file: cannot read ${file} (${(err as Error).message})`);
  }
}

const CALL_FLAGS = ['callFrom', 'callTo', 'callLabel', 'reply'] as const;

/**
 * The step fields named by the flags (target, view, call, state, rows, caption, durationSec). `add`: the word none
 * leaves a field out; the view defaults to viewOfKind of the first target (code: arch). `set`: none clears
 * (SimClear), the view changes only with --view, and the call flags change the step's call key by key (`existing`).
 */
function stepFields(flags: SimFlags, refs: RefCollector, mode: 'add' | 'set', existing?: SimCall): SimStepPatch | SimOpError {
  const patch: SimStepPatch = {};
  const clearOrSkip = (v: unknown): boolean => isNone(v) && mode === 'add';

  const targets = flagList(flags, 'target');
  let firstKind: string | null = null;
  if (targets.length > 0) {
    const refsOut: string[] = [];
    targets.forEach((t, k) => {
      const hit = refs.one(t, `--target${targets.length > 1 ? ` ${k + 1}` : ''}`);
      if (hit) { refsOut.push(hit.ref); if (k === 0) firstKind = hit.kind; }
    });
    patch.target = refsOut;
  }
  const view = flagText(flags, 'view');
  if (view !== undefined) {
    const v = viewFlag(view);
    if (isError(v)) return v;
    patch.view = v;
  } else if (mode === 'add' && firstKind !== null) {
    patch.view = viewOfKind(firstKind);
  }

  if (CALL_FLAGS.some((k) => flags[k] !== undefined)) {
    const call: Obj = mode === 'set' && existing ? clone(existing) as Obj : {};
    for (const [flag, key] of [['callFrom', 'from'], ['callTo', 'to']] as const) {
      const v = flagText(flags, flag);
      if (v === undefined) continue;
      if (isNone(v)) { delete call[key]; continue; }
      const hit = refs.one(v, `--${flag === 'callFrom' ? 'call-from' : 'call-to'}`);
      if (hit) call[key] = hit.ref;
    }
    const label = flagText(flags, 'callLabel');
    if (label !== undefined) { if (isNone(label)) delete call.label; else call.label = label; }
    if (flags.reply !== undefined) {
      const r = replyFlag(flags.reply);
      if (isError(r)) return r;
      if (r) call.reply = true; else delete call.reply;
    }
    const empty = Object.keys(call).filter((k) => k !== 'extra').length === 0 && !(isObj(call.extra) && Object.keys(call.extra).length > 0);
    // a call with nothing left is no call (absent = derived, as `{}`); set clears it, add leaves it out
    if (!empty) patch.call = call as SimCall;
    else if (mode === 'set' && existing) patch.call = 'none';
  }

  for (const key of ['state', 'caption'] as const) {
    const v = flagText(flags, key);
    if (v === undefined || clearOrSkip(v)) continue;
    patch[key] = isNone(v) ? 'none' : v;
  }
  if (flags.duration !== undefined && !clearOrSkip(flags.duration)) {
    if (isNone(flags.duration)) patch.durationSec = 'none';
    else {
      const d = durationFlag(flags.duration);
      if (isError(d)) return d;
      patch.durationSec = d;
    }
  }
  const rowsFile = flagText(flags, 'rowsFile');
  if (rowsFile !== undefined && !clearOrSkip(rowsFile)) {
    if (isNone(rowsFile)) patch.rows = 'none';
    else {
      const read = readRowsFile(rowsFile);
      if (isError(read)) return read;
      const rows = refs.rows(read.raw, '--rows-file');
      if (rows) patch.rows = rows;
    }
  }
  return refs.refusal() ?? patch;
}

// ---------- change lines ----------

function refText(ref: string, refs: RefCollector): string {
  const label = refs.labelOf(ref);
  return label ? `${ref} (${label})` : ref;
}
/** The optional fields of a step or stage, one line each, indented under its head line. */
function fieldLines(o: Obj, refs: RefCollector, indent: string): string[] {
  const out: string[] = [];
  const call = o.call as SimCall | undefined;
  if (call) {
    const parts = [
      call.from !== undefined ? `from ${refText(call.from, refs)}` : '',
      call.to !== undefined ? `to ${refText(call.to, refs)}` : '',
      call.label !== undefined ? `label '${call.label}'` : '',
      call.reply ? 'reply' : '',
    ].filter(Boolean);
    out.push(`${indent}call: ${parts.join(', ') || '(derived)'}`);
  }
  for (const k of ['goal', 'from', 'channel', 'state', 'caption'] as const) if (typeof o[k] === 'string') out.push(`${indent}${k}: ${o[k] as string}`);
  if (isObj(o.rows)) for (const [k, list] of Object.entries(o.rows)) out.push(`${indent}rows ${refText(k, refs)}: ${plural((list as unknown[]).length, 'row')}`);
  if (typeof o.durationSec === 'number') out.push(`${indent}duration: ${o.durationSec} s`);
  return out;
}
/** `step 3: target u-cart (screen shop.web.cart 'Cart'), view io` plus its fields. */
function stepLines(head: string, step: Obj, refs: RefCollector): string[] {
  const targets = (step.target as string[]).map((t) => refText(t, refs)).join(', ');
  return [`  ${head}: target ${targets}, view ${String(step.view)}`, ...fieldLines(step, refs, '    ')];
}
/** One line per ref the command resolved: what was typed and what is stored. */
function resolvedLines(refs: RefCollector): string[] {
  return refs.resolved.map((r) => `  ${r.what} ${r.input === r.hit.ref ? r.hit.ref : `'${r.input}' -> ${r.hit.ref}`}: ${r.hit.label}`);
}
const itemHead = (item: SimItem): string => `${item.id} (${item.kind} '${item.title}')`;

// ---------- the runner ----------

interface SimContext {
  repoRoot: string;
  sims: LoadedSims;
  refs: RefCollector;
}
/** What an operation wants written: the new content per s-item (null = remove the file), the lines, the minted ids. */
interface SimEdit {
  changes: { id: string; next: SimItem | null }[];
  lines: string[];
  minted?: string[];
}
type SimOp = (ctx: SimContext) => SimEdit | SimOpError;

/** The loaded s-item `id`; a file that does not parse refuses (only touched files must parse); no file refuses. */
function itemFor(sims: LoadedSims, id: string): SimItem | SimOpError {
  const item = sims.items.find((s) => s.id === id);
  if (item) return item;
  if (sims.fileIds.includes(id)) {
    const file = `${id}.json`;
    return refuse(`${file} does not parse: fix ${file} by hand first, nothing changed`, sims.issues.filter((i) => i.file === file).map((i) => i.message));
  }
  const ids = sims.items.map((s) => s.id);
  return refuse(`no s-item '${id}'${ids.length > 0 ? ` (s-items: ${ids.join(', ')})` : ` (the repo has none yet: ${CMD_NAME} sim add starts one)`}`);
}

const PLAN_REFUSED = 'the plan edit these refs need is refused, nothing changed';

/**
 * b899: the plan edit the refs made, checked as `plan add` / `plan link` check theirs (linkCheckError, then the gate:
 * runWrite as a dry run: parse, findings, protected lines, files outside .c4pm/), handed to the sim write as extra
 * files. Their verify re-reads the plan from disk once and runs the edit's postcondition.
 */
function planWrite(r: RefResolver): { extra?: SimWriteExtra; lines: string[] } | SimOpError {
  const chain = r.chain();
  const edit = chain?.edit() ?? null;
  if (!chain || !edit) return { lines: [] };
  const state: PlanState = chain.start;
  const bad = linkCheckError(state, edit);
  if (bad) return refuse(PLAN_REFUSED, bad.message.split('\n'));
  const report = runWrite(writeSpecOf('sim', { yes: false }, state, edit));
  if (!report.ok) return refuse(PLAN_REFUSED, (report.error?.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
  const files = [...edit.newTexts]
    .filter(([f, t]) => state.texts.get(f) !== t)
    .map(([f, t]) => ({ path: path.resolve(state.repoRoot, f), before: state.texts.get(f) as string, after: t }));
  let checked = false;
  const verify = (): string | null => {
    if (checked) return null;
    checked = true;
    const now = reparsePlan(state);
    if (now.issues.length > edit.after.issues.length) return 'the plan on disk has more parse issues than the edit was checked with';
    return edit.post(now);
  };
  return { extra: { files, verify }, lines: [...r.lines, ...report.files.map((f) => `  plan file: ${f.file}`)] };
}

/**
 * Load the s-items, run `op`, gate every new content (it must parse without an issue: the reader's messages are the
 * reasons), gate the plan edit the refs made (planWrite; `owner` = the owner of code they add), and write only with `yes` and only when a file changes (`.c4pm/` made ready first). `file` = the one changed
 * file relative to the repo, or the sim folder when several change. Load, concurrent-change and rollback errors throw.
 */
function runSimOp(repoRoot: string, yes: boolean, op: SimOp, owner?: string): SimOpOutcome {
  const project: ProjectPaths = requireProject(repoRoot);
  const sims = loadSims(project);
  const resolver = refResolver(repoRoot, owner);
  const edit = op({ repoRoot, sims, refs: new RefCollector(resolver.resolve) });
  if (isError(edit)) return { error: edit.error, reasons: edit.reasons };

  const reasons: string[] = [];
  const changes = edit.changes.map((c) => {
    let next = c.next;
    if (next) {
      const parsed = parseSim(serializeSim(next), `${c.id}.json`);
      for (const i of parsed.issues) reasons.push(`${i.file}: ${i.message}`);
      next = parsed.data;
    }
    return { id: c.id, next, loadedText: sims.texts.get(c.id) ?? null };
  });
  if (reasons.length > 0) return { error: 'the result would not be a valid s-item file, nothing changed', reasons };

  const plan = planWrite(resolver);
  if (isError(plan)) return plan;
  const write = planSimWrites(project, changes);
  const changedFiles = write.files.filter((f) => f.changed);
  const changed = changedFiles.length > 0 || (plan.extra?.files.length ?? 0) > 0;
  if (changed && yes) {
    ensureInternalDirFor(project, (changedFiles[0] ?? write.files[0]).path);
    applySimWrites(project, write, plan.extra);
  }
  const one = changedFiles.length === 1 || write.files.length === 1 ? (changedFiles[0] ?? write.files[0]).path : null;
  const rel = (p: string): string => path.relative(repoRoot, p).split(path.sep).join('/') || p;
  const file = one !== null ? rel(one) : `${rel(simDirFor(project))}/`;
  return { result: { lines: [...edit.lines, ...plan.lines], ...(edit.minted ? { minted: edit.minted } : {}) }, file, changed, written: changed && yes };
}

// ---------- the commands ----------

/** `sim add --kind flow|journey --title <t> [--description <t>] [--person <t>]`: a new s-item with the next id (max + 1 over the file names), no steps or stages yet. */
export function addSim(repoRoot: string, flags: SimFlags): SimOpOutcome {
  return runSimOp(repoRoot, flags.yes === true, ({ sims }) => {
    const kind = flagText(flags, 'kind')?.trim();
    if (kind !== 'flow' && kind !== 'journey') return refuse(`--kind must be flow or journey${kind ? ` (found '${kind}')` : ''}`);
    const title = flagText(flags, 'title');
    if (title === undefined || title.trim() === '' || isNone(title)) return refuse('--title is required');
    const [id] = mintSimIds(sims.fileIds, 1);
    const item: SimItem = { schemaVersion: 1, id, kind, title: title.trim() };
    for (const key of ['person', 'description'] as const) {
      const v = flagText(flags, key);
      if (v !== undefined && !isNone(v)) item[key] = v;
    }
    if (kind === 'flow') item.steps = []; else item.stages = [];
    const lines = [`add ${itemHead(item)}:`];
    if (item.person !== undefined) lines.push(`  person: ${item.person}`);
    if (item.description !== undefined) lines.push(`  description: ${item.description}`);
    lines.push(`  ${kind === 'flow' ? 'steps' : 'stages'}: none yet (${CMD_NAME} sim ${kind === 'flow' ? 'step' : 'stage'} add ${id} ...)`);
    return { changes: [{ id, next: item }], lines, minted: [id] };
  });
}

/** `sim set <id> [--title <t>] [--description <t>] [--person <t>]`: none clears description and person; the title can change, not be cleared. */
export function setSim(repoRoot: string, id: string, flags: SimFlags): SimOpOutcome {
  return runSimOp(repoRoot, flags.yes === true, ({ sims }) => {
    const item = itemFor(sims, id);
    if (isError(item)) return item;
    const next = clone(item);
    const lines = [`set ${itemHead(item)}:`];
    const title = flagText(flags, 'title');
    if (title !== undefined && isNone(title)) return refuse('the title is required: it can be changed, not cleared');
    for (const key of ['title', 'person', 'description'] as const) {
      const v = flagText(flags, key);
      if (v === undefined) continue;
      const old = next[key];
      if (isNone(v)) delete next[key];
      else next[key] = key === 'description' ? v : v.trim();
      if (old !== next[key]) lines.push(`  ${key}: ${old ?? '(none)'} -> ${next[key] ?? '(none)'}`);
    }
    if (lines.length === 1) lines.push('  nothing changes');
    return { changes: [{ id, next }], lines };
  });
}

/** `sim remove <id>`: the s-item's file goes; refused while a journey stage names it (the reasons list those stages). */
export function removeSim(repoRoot: string, id: string, yes: boolean): SimOpOutcome {
  return runSimOp(repoRoot, yes, ({ sims }) => {
    const item = itemFor(sims, id);
    if (isError(item)) return item;
    const users: string[] = [];
    for (const j of sims.items) {
      if (j.kind !== 'journey') continue;
      (j.stages ?? []).forEach((st, k) => {
        const s = st as Obj;
        if (s.flow === id) users.push(`${j.id} stage ${k + 1}${typeof s.name === 'string' ? ` '${s.name}'` : ''} (journey '${j.title}')`);
      });
    }
    if (users.length > 0) {
      return refuse(`${id} is named by ${plural(users.length, 'journey stage')}; remove ${users.length === 1 ? 'that stage' : 'those stages'} first, nothing changed`, users);
    }
    const count = item.kind === 'flow' ? plural(item.steps?.length ?? 0, 'step') : plural(item.stages?.length ?? 0, 'stage');
    return { changes: [{ id, next: null }], lines: [`remove ${itemHead(item)}, ${count}`] };
  });
}

/**
 * `sim step add|set|remove|move <id> ...` on a flow. `at`: add = the new position (null = last), set / remove / move =
 * the step number. Flags as stepFields; move takes `--to`. Targets, call ends and rows keys are resolved and stored as
 * uids (b899); the change lines name what each ref resolved to and each plan change.
 */
export function editSimStep(
  repoRoot: string, id: string, op: 'add' | 'set' | 'remove' | 'move', at: number | null, flags: SimFlags, yes: boolean,
): SimOpOutcome {
  return runSimOp(repoRoot, yes, ({ sims, refs }) => {
    const item = itemFor(sims, id);
    if (isError(item)) return item;
    if (op !== 'add' && at === null) return refuse(`give the step number: ${CMD_NAME} sim step ${op} ${id} <n>`);
    const n = at as number;

    if (op === 'remove' || op === 'move') {
      let r;
      if (op === 'remove') r = removeStep(item, n);
      else {
        if (flags.to === undefined) return refuse(`--to is required: ${CMD_NAME} sim step move ${id} ${n} --to <m>`);
        const to = wholeFlag(flags.to, '--to');
        if (isError(to)) return to;
        r = moveStep(item, n, to);
      }
      return isError(r) ? r : { changes: [{ id, next: r.item }], lines: r.lines };
    }

    if (op === 'add') {
      if (flagList(flags, 'target').length === 0) return refuse(`--target is required: ${CMD_NAME} sim step add ${id} --target <ref>`);
      const fields = stepFields(flags, refs, 'add');
      if (isError(fields)) return fields;
      const r = addStep(item, fields as SimStep, at);
      if (isError(r)) return r;
      const pos = at ?? r.item.steps?.length ?? 0;
      return { changes: [{ id, next: r.item }], lines: [`add step ${pos} to ${itemHead(item)}:`, ...stepLines(`step ${pos}`, (r.item.steps as SimStep[])[pos - 1] as unknown as Obj, refs)] };
    }

    const current = item.kind === 'flow' ? item.steps?.[n - 1] : undefined;
    const fields = stepFields(flags, refs, 'set', current?.call);
    if (isError(fields)) return fields;
    const r = setStep(item, n, fields);
    if (isError(r)) return r;
    return { changes: [{ id, next: r.item }], lines: [...r.lines, ...resolvedLines(refs)] };
  }, flagText(flags, 'owner'));
}

/**
 * `sim stage add|remove <id> ...` on a journey. add: exactly one of `--flow <s-id>` (an existing flow), `--outside <t>`
 * or `--target <ref>...` (an inline step: the step flags apply), with `--name`, `--goal`, and for an outside stage
 * `--from`, `--channel`, `--state`, `--caption`, `--duration`; `at` = the new position (null = last). remove: `at` = the
 * stage number. A flag that does not fit the stage form is refused by the reader's rules.
 */
export function editSimStage(repoRoot: string, id: string, op: 'add' | 'remove', at: number | null, flags: SimFlags, yes: boolean): SimOpOutcome {
  return runSimOp(repoRoot, yes, ({ sims, refs }) => {
    const item = itemFor(sims, id);
    if (isError(item)) return item;
    if (op === 'remove') {
      if (at === null) return refuse(`give the stage number: ${CMD_NAME} sim stage remove ${id} <n>`);
      const r = removeStage(item, at);
      return isError(r) ? r : { changes: [{ id, next: r.item }], lines: r.lines };
    }

    const flow = flagText(flags, 'flow');
    const outside = flagText(flags, 'outside');
    const hasTarget = flagList(flags, 'target').length > 0;
    const forms = [flow !== undefined ? '--flow' : '', outside !== undefined ? '--outside' : '', hasTarget ? '--target' : ''].filter(Boolean);
    if (forms.length !== 1) return refuse(`give exactly one of --flow <s-id>, --outside <text> or --target <ref>${forms.length > 1 ? ` (found ${forms.join(', ')})` : ''}`);

    const stage: Obj = {};
    for (const key of ['name', 'goal', 'from', 'channel'] as const) {
      const v = flagText(flags, key);
      if (v !== undefined && !isNone(v)) stage[key] = v;
    }
    if (flow !== undefined) {
      const f = flow.trim();
      const named = sims.items.find((s) => s.id === f);
      if (!named) return refuse(`--flow '${f}' is not an s-item${sims.fileIds.includes(f) ? ` (${f}.json does not parse)` : ''}`);
      if (named.kind !== 'flow') return refuse(`--flow '${f}' is a ${named.kind}, not a flow`);
      stage.flow = f;
    }
    if (outside !== undefined) stage.outside = outside;
    const fields = stepFields(flags, refs, 'add');
    if (isError(fields)) return fields;
    Object.assign(stage, fields);

    const r = addStage(item, stage as unknown as SimStage, at);
    if (isError(r)) return r;
    const pos = at ?? r.item.stages?.length ?? 0;
    const added = (r.item.stages as SimStage[])[pos - 1] as unknown as Obj;
    const name = typeof added.name === 'string' ? ` '${added.name}'` : '';
    const lines = [`add stage ${pos} to ${itemHead(item)}:`];
    if (typeof added.flow === 'string') lines.push(`  stage ${pos}${name}: flow ${added.flow} ('${(sims.items.find((s) => s.id === added.flow) as SimItem).title}')`, ...fieldLines(added, refs, '    '));
    else if (typeof added.outside === 'string') lines.push(`  stage ${pos}${name}: outside: ${added.outside}`, ...fieldLines(added, refs, '    '));
    else lines.push(...stepLines(`stage ${pos}${name}`, added, refs));
    return { changes: [{ id, next: r.item }], lines };
  }, flagText(flags, 'owner'));
}

/** Resolve every ref of one apply entry in place (targets, call ends, rows keys of its steps and inline stages). */
function resolveItemRefs(item: SimItem, label: string, refs: RefCollector): SimItem {
  const next = clone(item);
  const fix = (s: Obj, where: string): void => {
    if (Array.isArray(s.target)) {
      const list = s.target as string[];
      s.target = list.map((t, k) => refs.one(t, `${label} ${where}.target${list.length > 1 ? `[${k}]` : ''}`)?.ref ?? t);
    }
    if (isObj(s.call)) {
      for (const end of ['from', 'to'] as const) {
        const v = s.call[end];
        if (typeof v === 'string') s.call[end] = refs.one(v, `${label} ${where}.call.${end}`)?.ref ?? v;
      }
    }
    if (isObj(s.rows)) s.rows = refs.rows(s.rows, `${label} ${where}.rows`) ?? s.rows;
  };
  (next.steps ?? []).forEach((s, k) => fix(s as unknown as Obj, `steps[${k}]`));
  (next.stages ?? []).forEach((s, k) => fix(s as unknown as Obj, `stages[${k}]`));
  return next;
}

/** One line per ref whose stored value differs from what was typed: `  <what>: '<typed>' -> <uid> (<label>)`. */
function refChangeLines(refs: RefCollector): string[] {
  return refs.resolved.filter((x) => x.input.trim() !== x.hit.ref).map((x) => `  ${x.what}: '${x.input}' -> ${x.hit.ref} (${x.hit.label})`);
}

/**
 * `sim apply <file.json>` (and MCP `sim_apply`): many s-items in ONE guarded write. `spec` = `{"sims": [ ... ]}` as
 * expandSimApply takes it (new entries get the next ids in file order, local `ref` / `flowRef`; an entry with an id
 * replaces that s-item whole). Every ref of every entry is resolved and stored as a uid (b899; `owner` = the owner of code added to the plan);
 * one bad entry or ref refuses the whole file. An entry naming an s-item whose file does not parse is refused (fix it by hand).
 */
export function applySimFile(repoRoot: string, spec: unknown, yes: boolean, owner?: string): SimOpOutcome {
  return runSimOp(repoRoot, yes, ({ sims, refs }) => {
    if (isObj(spec) && Array.isArray(spec.sims)) {
      const broken = (spec.sims as unknown[])
        .map((e) => (isObj(e) && typeof e.id === 'string' ? e.id : null))
        .filter((eid): eid is string => eid !== null && sims.fileIds.includes(eid) && !sims.items.some((s) => s.id === eid));
      if (broken.length > 0) {
        return refuse(`${broken.map((b) => `${b}.json`).join(', ')} ${broken.length === 1 ? 'does' : 'do'} not parse: fix by hand first, nothing changed`,
          sims.issues.filter((i) => broken.some((b) => i.file === `${b}.json`)).map((i) => `${i.file}: ${i.message}`));
      }
    }
    const r = expandSimApply(sims.items, spec, (n) => mintSimIds(sims.fileIds, n));
    if (isError(r)) return r;
    const refOf = new Map(r.minted.map((m) => [m.id, m.ref]));
    const items = r.items.map((item) => {
      const ref = refOf.get(item.id);
      return resolveItemRefs(item, `${item.id}${ref !== undefined ? ` (ref ${ref})` : ''}`, refs);
    });
    const refused = refs.refusal();
    if (refused) return refused;
    return { changes: items.map((item) => ({ id: item.id, next: item })), lines: [...r.lines, ...refChangeLines(refs)], minted: r.minted.map((m) => m.id) };
  }, owner);
}

/**
 * `sim upgrade` (b899): every stored ref of every s-item that parses becomes a uid (an fqn or a code path#name: the
 * resolver adds the code to the plan and mints uids as for any write); one write of the plan and every changed
 * s-item. A ref that resolves to nothing refuses the whole upgrade (fix it first). Files that do not parse are left
 * as they are (one line each). `flags`: owner, yes.
 */
export function upgradeSims(repoRoot: string, flags: SimFlags): SimOpOutcome {
  return runSimOp(repoRoot, flags.yes === true, ({ sims, refs }) => {
    const items = sims.items.map((item) => resolveItemRefs(item, item.id, refs));
    const refused = refs.refusal();
    if (refused) return refused;
    const changed = refChangeLines(refs);
    const broken = sims.fileIds.filter((fid) => !sims.items.some((s) => s.id === fid));
    return {
      changes: items.map((item) => ({ id: item.id, next: item })),
      lines: [
        `upgrade ${plural(items.length, 's-item')}: every ref stored as a uid`,
        ...(changed.length > 0 ? changed : ['  every ref is a uid already']),
        ...broken.map((fid) => `  ${fid}.json does not parse: left as is`),
      ],
    };
  }, flagText(flags, 'owner'));
}
