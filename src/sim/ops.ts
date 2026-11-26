/**
 * T2 (b696): pure s-item operations behind `sim add|step|stage|apply` (the service, T4, resolves targets and writes).
 * Each takes a SimItem and returns a NEW item (the input is never changed) plus the lines to print, or
 * `{error, reasons}` (the OpError shape of src/board/ops.ts, so the CLI prints both alike). No fs. Every result is
 * judged by parseSim on its serialized text (the one rule set of the file format): an op that would leave a file the
 * reader refuses is refused, with the reader's messages as reasons. Positions are 1-based.
 */
import type { SimCall, SimItem, SimRows, SimStage, SimStep, ViewName } from '../types';
import { parseSim, SIM_ID_RE, STEP_KEYS } from './parse';
import { serializeSim } from './serialize';
import { isObj } from '../util/obj';

export interface SimOpOk {
  item: SimItem;
  /** Human lines describing the change (printed before the dry-run notice). */
  lines: string[];
}
/** Same shape as OpError of src/board/ops.ts. */
export interface SimOpError {
  error: string;
  reasons: string[];
}
export type SimOpResult = SimOpOk | SimOpError;

/** Clears an optional field in a patch: null, or the word `none` (any case), as `board set --owner none`. */
export type SimClear = null | 'none';
/** Fields of one step to change; a key left out (or undefined) stays. `target` and `view` are required: they cannot be cleared. */
export interface SimStepPatch {
  target?: string[];
  view?: ViewName;
  call?: SimCall | SimClear;
  state?: string | SimClear;
  rows?: SimRows | SimClear;
  caption?: string | SimClear;
  durationSec?: number | SimClear;
}

type Obj = Record<string, unknown>;

const refuse = (error: string, reasons: string[] = []): SimOpError => ({ error, reasons });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `s-<N>` ids for `count` new s-items: N continues after the highest number over `existingIds` (the FILE names, broken files too; Q8, as mintItemIds). */
export function mintSimIds(existingIds: string[], count: number): string[] {
  let max = 0;
  for (const id of existingIds) {
    const m = SIM_ID_RE.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Array.from({ length: count }, (_, k) => `s-${max + 1 + k}`);
}

/** The gate: `item` as the reader would load it from its serialized text, or the reader's issues as reasons. */
function gated(item: SimItem, lines: string[]): SimOpResult {
  const parsed = parseSim(serializeSim(item), `${item.id}.json`);
  if (parsed.data === null) {
    return refuse(`this would make ${item.id} invalid (${plural(parsed.issues.length, 'problem')}), nothing changed`, parsed.issues.map((i) => i.message));
  }
  return { item: parsed.data, lines };
}

const targetsText = (t: unknown): string => (Array.isArray(t) ? t.join(', ') : String(t));
const describeStep = (s: SimStep): string => `${s.view}  ${targetsText(s.target)}`;
function describeStage(stage: SimStage): string {
  const s = stage as Obj;
  const what = 'flow' in s ? `flow ${String(s.flow)}` : 'outside' in s ? `outside: ${String(s.outside)}` : describeStep(stage as SimStep);
  return typeof s.name === 'string' ? `${s.name} (${what})` : what;
}
function show(v: unknown): string {
  if (v === undefined) return '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The list of a flow (`steps`) or a journey (`stages`); refused for the other kind. */
function listOf(item: SimItem, want: 'flow' | 'journey'): SimOpError | null {
  if (item.kind === want) return null;
  return want === 'flow'
    ? refuse(`${item.id} is a journey: it has stages, not steps (use the stage commands)`)
    : refuse(`${item.id} is a flow: it has steps, not stages (use the step commands)`);
}

/** A 1-based position in 1..max, or the refusal. `what` = 'step' | 'stage'; `count` = how many there are now. */
function badPosition(n: number, max: number, what: string, item: SimItem, count: number): SimOpError | null {
  if (Number.isInteger(n) && n >= 1 && n <= max) return null;
  return refuse(`${what} ${n} is out of range: ${item.id} has ${plural(count, what)}${max > 0 ? `, give 1..${max}` : ''}`);
}

// ---------- steps (flow) ----------

/** Insert `step` into flow `item` so it becomes step `at` (1-based; null = last). */
export function addStep(item: SimItem, step: SimStep, at: number | null): SimOpResult {
  const wrong = listOf(item, 'flow');
  if (wrong) return wrong;
  const next = clone(item);
  const steps = next.steps ?? (next.steps = []);
  const pos = at ?? steps.length + 1;
  const bad = badPosition(pos, steps.length + 1, 'step', item, steps.length);
  if (bad) return bad;
  steps.splice(pos - 1, 0, clone(step));
  return gated(next, [`add step ${pos} to ${item.id}: ${describeStep(step)}`]);
}

const isClear = (v: unknown): boolean => v === null || (typeof v === 'string' && v.trim().toLowerCase() === 'none');
const REQUIRED_STEP_KEYS: readonly string[] = ['target', 'view'];

/**
 * Change the fields of step `n` of flow `item` named in `patch` (keys of STEP_KEYS; `call` is set whole). A clear value
 * (null or `none`) removes an optional field; clearing `target` or `view` is refused. No field different = no change line.
 */
export function setStep(item: SimItem, n: number, patch: SimStepPatch): SimOpResult {
  const wrong = listOf(item, 'flow');
  if (wrong) return wrong;
  const count = item.steps?.length ?? 0;
  const bad = badPosition(n, count, 'step', item, count);
  if (bad) return bad;
  const p = patch as Obj;
  const unknown = Object.keys(p).filter((k) => !(STEP_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return refuse(`a step has no field ${unknown.map((k) => `'${k}'`).join(', ')} (fields: ${STEP_KEYS.join(', ')})`);

  const next = clone(item);
  const step = (next.steps as SimStep[])[n - 1] as unknown as Obj;
  const lines = [`set step ${n} of ${item.id}:`];
  const reasons: string[] = [];
  for (const k of STEP_KEYS) {
    const v = p[k];
    if (v === undefined) continue;
    const old = step[k];
    if (isClear(v)) {
      if (REQUIRED_STEP_KEYS.includes(k)) { reasons.push(`${k} is required: it can be changed, not cleared`); continue; }
      delete step[k];
    } else step[k] = clone(v);
    if (JSON.stringify(old) !== JSON.stringify(step[k])) lines.push(`  ${k}: ${show(old)} -> ${show(step[k])}`);
  }
  if (reasons.length > 0) return refuse(`cannot set step ${n} of ${item.id}, nothing changed`, reasons);
  if (lines.length === 1) lines.push('  nothing changes');
  return gated(next, lines);
}

/** Remove step `n` (1-based) of flow `item`. */
export function removeStep(item: SimItem, n: number): SimOpResult {
  const wrong = listOf(item, 'flow');
  if (wrong) return wrong;
  const count = item.steps?.length ?? 0;
  const bad = badPosition(n, count, 'step', item, count);
  if (bad) return bad;
  const next = clone(item);
  const [gone] = (next.steps as SimStep[]).splice(n - 1, 1);
  return gated(next, [`remove step ${n} of ${item.id}: ${describeStep(gone)}`]);
}

/** Move step `n` of flow `item` so it becomes step `to` (both 1-based, within the steps there are). */
export function moveStep(item: SimItem, n: number, to: number): SimOpResult {
  const wrong = listOf(item, 'flow');
  if (wrong) return wrong;
  const count = item.steps?.length ?? 0;
  const bad = badPosition(n, count, 'step', item, count) ?? badPosition(to, count, 'step', item, count);
  if (bad) return bad;
  const next = clone(item);
  const steps = next.steps as SimStep[];
  const [moved] = steps.splice(n - 1, 1);
  steps.splice(to - 1, 0, moved);
  return gated(next, [n === to ? `move step ${n} of ${item.id}: already there, nothing changes` : `move step ${n} of ${item.id} to ${to}: ${describeStep(moved)}`]);
}

// ---------- stages (journey) ----------

/** Insert `stage` (a flow, outside or inline step stage, with its name, goal, from, channel, ...) into journey `item` as stage `at` (null = last). */
export function addStage(item: SimItem, stage: SimStage, at: number | null): SimOpResult {
  const wrong = listOf(item, 'journey');
  if (wrong) return wrong;
  const next = clone(item);
  const stages = next.stages ?? (next.stages = []);
  const pos = at ?? stages.length + 1;
  const bad = badPosition(pos, stages.length + 1, 'stage', item, stages.length);
  if (bad) return bad;
  stages.splice(pos - 1, 0, clone(stage));
  return gated(next, [`add stage ${pos} to ${item.id}: ${describeStage(stage)}`]);
}

/** Remove stage `n` (1-based) of journey `item`. */
export function removeStage(item: SimItem, n: number): SimOpResult {
  const wrong = listOf(item, 'journey');
  if (wrong) return wrong;
  const count = item.stages?.length ?? 0;
  const bad = badPosition(n, count, 'stage', item, count);
  if (bad) return bad;
  const next = clone(item);
  const [gone] = (next.stages as SimStage[]).splice(n - 1, 1);
  return gated(next, [`remove stage ${n} of ${item.id}: ${describeStage(gone)}`]);
}

// ---------- apply (many s-items) ----------

export interface SimMinted { index: number; id: string; ref?: string }
export interface SimApplyOk {
  /** Every new or replaced s-item, in file order, as the reader would load it. */
  items: SimItem[];
  /** The new entries: their index in `sims`, the minted id and their ref. */
  minted: SimMinted[];
  lines: string[];
}

const REF_RE = /^[A-Za-z0-9_-]+$/;

/**
 * `sim apply`: several s-items in one write. `spec` = `{"sims": [entry, ...]}`; an entry is an s-item as in the file
 * (schemaVersion may be left out). An entry WITHOUT `id` is new: its id comes from `newIds(count)` (called once, in file
 * order) and it may carry a local `ref`; a journey stage `{"flowRef": "<ref>", ...}` names a new flow of the same file
 * (forward refs allowed, as parentRef in expandBulk). An entry WITH `id` replaces that s-item whole (it must be in
 * `existing`). Every entry must parse (parseSim); a `flow` stage must name a flow (existing or in this file). Unknown
 * keys inside an entry are kept, as the reader keeps them, and shown as notes. An unknown top key, an empty list or any
 * bad entry refuses the whole file. Targets are NOT resolved here (the service does).
 */
export function expandSimApply(existing: SimItem[], spec: unknown, newIds: (n: number) => string[]): SimApplyOk | SimOpError {
  if (!isObj(spec) || !Array.isArray(spec.sims)) return refuse('the file must be a JSON object {"sims": [ ... ]}');
  for (const k of Object.keys(spec)) if (k !== 'sims') return refuse(`unknown key '${k}' (only "sims" is allowed)`);
  const raws = spec.sims as unknown[];
  if (raws.length === 0) return refuse('"sims" is empty: nothing to write');

  const problems: string[] = [];
  const label = (i: number): string => {
    const r = raws[i];
    if (!isObj(r)) return `sims[${i}]`;
    return `sims[${i}]${typeof r.ref === 'string' ? ` (ref ${r.ref})` : typeof r.id === 'string' ? ` (${r.id})` : ''}`;
  };
  const bad = (i: number, msg: string): void => { problems.push(`${label(i)}: ${msg}`); };
  const byId = new Map(existing.map((s) => [s.id, s]));

  // pass 1: new or replace; ids for the new ones; local refs
  const newAt: number[] = [];
  const replaced = new Set<string>();
  raws.forEach((r, i) => {
    if (!isObj(r)) return bad(i, 'must be an object');
    if (r.id === undefined) { newAt.push(i); return; }
    if (typeof r.id !== 'string' || !SIM_ID_RE.test(r.id)) return bad(i, `'id' must be an s-item id s-<N> (leave it out for a new s-item)`);
    if (!byId.has(r.id)) return bad(i, `'${r.id}' is not an s-item (an entry with an id replaces an existing s-item; leave the id out for a new one)`);
    if (replaced.has(r.id)) return bad(i, `'${r.id}' is replaced by an earlier entry too`);
    replaced.add(r.id);
    if (r.ref !== undefined) bad(i, `'ref' names a new s-item; an entry with an id is named by its id`);
  });
  const ids = newAt.length > 0 ? newIds(newAt.length) : [];
  if (ids.length !== newAt.length) throw new Error(`expandSimApply: newIds gave ${ids.length} ids for ${newAt.length} new s-items`);
  const idAt = new Map<number, string>(newAt.map((i, k) => [i, ids[k]]));
  const idOfRef = new Map<string, string>();
  for (const i of newAt) {
    const ref = (raws[i] as Obj).ref;
    if (ref === undefined) continue;
    if (typeof ref !== 'string' || !REF_RE.test(ref)) bad(i, `'ref' must be letters, digits, '_' or '-'`);
    else if (idOfRef.has(ref)) bad(i, `'ref' '${ref}' is already used by an earlier entry`);
    else idOfRef.set(ref, idAt.get(i) as string);
  }
  // the kind of every s-item once the file is written: existing ones, then the entries of this file
  const kindOf = new Map<string, unknown>(existing.map((s) => [s.id, s.kind]));
  raws.forEach((r, i) => {
    const id = idAt.get(i) ?? (isObj(r) ? r.id : undefined);
    if (typeof id === 'string' && isObj(r)) kindOf.set(id, r.kind);
  });

  // pass 2: each entry as the file it becomes
  const items: SimItem[] = [];
  const notes: string[] = [];
  raws.forEach((r, i) => {
    if (!isObj(r)) return;
    const id = idAt.get(i) ?? r.id;
    if (typeof id !== 'string' || (!idAt.has(i) && !byId.has(id))) return;   // refused in pass 1
    const raw: Obj = { ...r };   // spread keeps an own key named __proto__ (data, not the prototype)
    delete raw.ref;
    if (raw.schemaVersion === undefined) raw.schemaVersion = 1;
    raw.id = id;
    const skip = new Set<string>();   // stages whose flowRef was already reported
    if (Array.isArray(raw.stages)) {
      raw.stages = raw.stages.map((st: unknown, k: number) => {
        if (!isObj(st) || !('flowRef' in st)) return st;
        const where = `stages[${k}]`;
        if ('flow' in st) { bad(i, `${where}: give 'flow' or 'flowRef', not both`); skip.add(where); return st; }
        const fid = typeof st.flowRef === 'string' ? idOfRef.get(st.flowRef) : undefined;
        if (fid === undefined) { bad(i, `${where}.flowRef '${String(st.flowRef)}' matches no "ref" in the file`); skip.add(where); return st; }
        const out: Obj = { ...st, flow: fid };
        delete out.flowRef;
        return out;
      });
    }
    if (raw.kind === 'journey' && Array.isArray(raw.stages)) {
      raw.stages.forEach((st: unknown, k: number) => {   // a flow stage names a flow (the reader checks the id shape)
        if (!isObj(st) || typeof st.flow !== 'string' || !SIM_ID_RE.test(st.flow) || skip.has(`stages[${k}]`)) return;
        const kind = kindOf.get(st.flow);
        if (kind === undefined) bad(i, `stages[${k}].flow: '${st.flow}' is not an s-item (existing or in this file)`);
        else if (kind !== 'flow') bad(i, `stages[${k}].flow: '${st.flow}' is a ${String(kind)}, not a flow`);
      });
    }
    const parsed = parseSim(JSON.stringify(raw), `${id}.json`);
    const reported = (m: string): boolean => [...skip].some((w) => m.startsWith(w));
    for (const issue of parsed.issues) if (!reported(issue.message)) bad(i, issue.message);
    for (const note of parsed.notes) if (!reported(note.message)) notes.push(`${label(i)}: ${note.message}`);
    if (parsed.data) items.push(parsed.data);
  });
  if (problems.length > 0) return refuse(`${plural(problems.length, 'problem')} in the file, nothing changed`, problems);

  const refOf = new Map<string, string>([...idOfRef].map(([ref, id]) => [id, ref]));
  const newIdSet = new Set(ids);
  const lines = [`write ${plural(items.length, 's-item')}: ${newAt.length} new, ${replaced.size} replaced`];
  for (const s of items) {
    const isNew = newIdSet.has(s.id);
    const count = s.kind === 'flow' ? plural(s.steps?.length ?? 0, 'step') : plural(s.stages?.length ?? 0, 'stage');
    const ref = refOf.get(s.id);
    lines.push(`  ${s.id}  ${isNew ? 'new' : 'replace'}  ${s.kind}  ${s.title}  (${count})${ref !== undefined ? `  (ref ${ref})` : ''}`);
  }
  for (const n of notes) lines.push(`  note: ${n}`);
  const minted = newAt.map((i, k) => {
    const ref = (raws[i] as Obj).ref;
    return typeof ref === 'string' ? { index: i, id: ids[k], ref } : { index: i, id: ids[k] };
  });
  return { items, minted, lines };
}
