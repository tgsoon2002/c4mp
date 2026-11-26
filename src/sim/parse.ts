import type { SimFileIssue, SimItem, ViewName } from '../types';
import { VIEW_NAMES } from '../constants';
import { log } from '../log';
import { isObj } from '../util/obj';

/** s-item id: `s-<N>`, N >= 1 without leading zeros. The file is `sim/<id>.json`. */
export const SIM_ID_RE = /^s-([1-9][0-9]*)$/;

/**
 * Known keys in WRITE order (Document/Roadmap/PHASE_25_SIMULATIONS.md section 1). The parser takes them in any order;
 * serializeSim writes them in this order, then the unknown keys (`extra`). One source for both.
 */
export const SIM_KEYS = ['schemaVersion', 'id', 'kind', 'title', 'person', 'description', 'steps', 'stages'] as const;
export const STEP_KEYS = ['target', 'view', 'call', 'state', 'rows', 'caption', 'durationSec'] as const;
export const CALL_KEYS = ['from', 'to', 'label', 'reply'] as const;
export const STAGE_KEYS = ['name', 'flow', 'outside', 'target', 'goal', 'from', 'channel', 'view', 'call', 'state', 'rows', 'caption', 'durationSec'] as const;

/** The keys each stage form may hold (Q2, QF2). A known stage key outside its form is an issue; an unknown key is a note. */
const STAGE_FORM_KEYS: Record<'flow' | 'outside' | 'target', readonly string[]> = {
  flow: ['name', 'flow', 'goal'],
  outside: ['name', 'outside', 'goal', 'from', 'channel', 'state', 'caption', 'durationSec'],
  target: ['name', 'goal', ...STEP_KEYS],
};
const STAGE_FORMS = ['flow', 'outside', 'target'] as const;
const STAGE_FORM_LABEL: Record<'flow' | 'outside' | 'target', string> = { flow: 'a flow stage', outside: 'an outside stage', target: 'an inline step stage' };

/** Old view words (before K 2026-11-01) still read; the writer writes the new word (Q1). */
const OLD_VIEW_WORDS: Record<string, ViewName> = { architecture: 'arch', front: 'io', data: 'storage' };

/** `arch` / `io` / `storage`, or an old word (`architecture`, `front`, `data`) as its new word; anything else null. */
export function normaliseView(word: string): ViewName | null {
  if ((VIEW_NAMES as string[]).includes(word)) return word as ViewName;
  return Object.prototype.hasOwnProperty.call(OLD_VIEW_WORDS, word) ? OLD_VIEW_WORDS[word] : null;
}

type Obj = Record<string, unknown>;
interface Report { issue: (where: string, message: string) => void; note: (where: string, message: string) => void }
/** Reads one present value; returns undefined after reporting an issue. `where` = the JSON path of the value. */
type Reader = (v: unknown, where: string, r: Report) => unknown;

const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const at = (where: string, key: string): string => (where ? `${where}.${key}` : key);
/** defineProperty: a key named __proto__ stays an own key (as board/parse.ts parseItem). */
const keep = (o: Obj, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
};
const found = (v: unknown): string => `found ${JSON.stringify(v)}`;

/** Short words and refs: trimmed, non-empty. */
const word: Reader = (v, where, r) => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  r.issue(where, `must be a non-empty string (${found(v)})`);
  return undefined;
};
/** Free text: kept as written, must hold something. */
const freeText: Reader = (v, where, r) => {
  if (typeof v === 'string' && v.trim()) return v;
  r.issue(where, `must be a non-empty string (${found(v)})`);
  return undefined;
};
const bool: Reader = (v, where, r) => {
  if (typeof v === 'boolean') return v;
  r.issue(where, `must be true or false (${found(v)})`);
  return undefined;
};
const simRef: Reader = (v, where, r) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (SIM_ID_RE.test(s)) return s;
  r.issue(where, `must be an s-item id s-<N> (${found(v)})`);
  return undefined;
};
const kind: Reader = (v, where, r) => {
  if (v === 'flow' || v === 'journey') return v;
  r.issue(where, `must be flow or journey (${found(v)})`);
  return undefined;
};
const view: Reader = (v, where, r) => {
  const w = typeof v === 'string' ? normaliseView(v.trim()) : null;
  if (w) return w;
  r.issue(where, `must be ${VIEW_NAMES.join(', ')} (${found(v)})`);
  return undefined;
};
/** One ref or a non-empty list of refs; always a list in memory (serializeSim writes one ref as a string). */
const targets: Reader = (v, where, r) => {
  const refs = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (!refs || refs.length === 0 || refs.some((t) => typeof t !== 'string' || !t.trim())) {
    r.issue(where, `must be a ref (c-item uid, plan fqn or path#name) or a non-empty list of refs (${found(v)})`);
    return undefined;
  }
  return (refs as string[]).map((t) => t.trim());
};
const duration: Reader = (v, where, r) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  r.issue(where, `must be a number of seconds > 0 (${found(v)})`);
  return undefined;
};
/** `{ <record uid>: [ {row}, ... ] }`; rows are kept as written. */
const rows: Reader = (v, where, r) => {
  if (!isObj(v)) { r.issue(where, `must be an object { "<record uid>": [ {row}, ... ] } (${found(v)})`); return undefined; }
  const out: Obj = {};
  let ok = true;
  for (const [k, list] of Object.entries(v)) {
    if (!Array.isArray(list) || !list.every(isObj)) { r.issue(at(where, k), 'must be a list of row objects'); ok = false; continue; }
    keep(out, k, list);
  }
  return ok ? out : undefined;
};
const call: Reader = (v, where, r) => {
  if (!isObj(v)) { r.issue(where, `must be an object { from?, to?, label?, reply? } (${found(v)})`); return undefined; }
  return readObject(v, CALL_KEYS, CALL_KEYS, '', where, r);
};
const listOf = (one: (v: unknown, where: string, r: Report) => Obj | null): Reader => (v, where, r) => {
  if (!Array.isArray(v)) { r.issue(where, `must be a list (${found(v)})`); return undefined; }
  const out = v.map((e, i) => one(e, `${where}[${i}]`, r));
  return out.every((e) => e !== null) ? out : undefined;
};

const READERS: Record<string, Reader> = {
  schemaVersion: (v) => v, id: word, kind, title: word, person: word, description: freeText,
  steps: listOf((v, where, r) => parseStep(v, where, r)), stages: listOf((v, where, r) => parseStage(v, where, r)),
  target: targets, view, call, state: freeText, rows, caption: freeText, durationSec: duration,
  from: word, to: word, label: freeText, reply: bool,
  name: word, flow: simRef, outside: freeText, goal: freeText, channel: word,
};

/**
 * The keys of `raw` in `allowed` go through their READERS entry; a key of `known` that is not allowed here is an issue
 * (`stages[2].from: not allowed on a flow stage`); any other key is a note, kept in `extra` and written back after the known keys.
 */
function readObject(raw: Obj, allowed: readonly string[], known: readonly string[], place: string, where: string, r: Report): Obj {
  const out: Obj = {};
  const extra: Obj = {};
  for (const k of Object.keys(raw)) {
    if (allowed.includes(k)) {
      const v = READERS[k](raw[k], at(where, k), r);
      if (v !== undefined) out[k] = v;
    } else if (known.includes(k)) {
      r.issue(at(where, k), `not allowed on ${place}`);
    } else {
      r.note(where, `unknown key '${k}' (kept as written)`);
      keep(extra, k, raw[k]);
    }
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

function requireKeys(raw: Obj, keys: string[], where: string, r: Report): void {
  for (const k of keys) if (!has(raw, k)) r.issue(at(where, k), 'is required');
}

function parseStep(raw: unknown, where: string, r: Report): Obj | null {
  if (!isObj(raw)) { r.issue(where, 'a step must be an object'); return null; }
  requireKeys(raw, ['target', 'view'], where, r);
  return readObject(raw, STEP_KEYS, STAGE_KEYS, 'a step', where, r);
}

/** A stage is one of `{flow}`, `{outside}` or an inline step `{target, view, ...}`, each with an optional name and goal. */
function parseStage(raw: unknown, where: string, r: Report): Obj | null {
  if (!isObj(raw)) { r.issue(where, 'a stage must be an object'); return null; }
  const forms = STAGE_FORMS.filter((f) => has(raw, f));
  if (forms.length !== 1) {
    r.issue(where, `a stage needs exactly one of flow, outside or target (found ${forms.length ? forms.join(', ') : 'none'})`);
    return null;
  }
  const form = forms[0];
  if (form === 'target') requireKeys(raw, ['view'], where, r);
  return readObject(raw, STAGE_FORM_KEYS[form], STAGE_KEYS, STAGE_FORM_LABEL[form], where, r);
}

/**
 * Parse the text of one `sim/s-<N>.json` (`fileName` = its base name, e.g. 's-3.json'). Reports STRUCTURE only: bad JSON,
 * schemaVersion, id shape and id = file name, kind, title, types of every known key, steps only on a flow and stages only
 * on a journey, stage forms, view words. Unknown keys are notes: kept in `extra` and re-written, never block a write.
 * Any issue -> `data: null` (the item is not loaded and a writer refuses to rewrite the file). Never throws.
 * Meaning (does a target exist, is a flow stage's s-item there) belongs to the check rules (T7).
 */
export function parseSim(text: string, fileName: string): { data: SimItem | null; issues: SimFileIssue[]; notes: SimFileIssue[] } {
  const issues: SimFileIssue[] = [];
  const notes: SimFileIssue[] = [];
  const msg = (where: string, message: string): string => (where ? `${where}: ${message}` : message);
  const r: Report = {
    issue: (where, message) => { issues.push({ file: fileName, message: msg(where, message) }); },
    note: (where, message) => { notes.push({ file: fileName, message: msg(where, message) }); },
  };
  const done = (data: SimItem | null) => {
    log('sim', 'parseSim', { file: fileName, issues: issues.length, notes: notes.length });
    return { data: issues.length > 0 ? null : data, issues, notes };
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    r.issue('', `not valid JSON (${(err as Error).message})`);
    return done(null);
  }
  if (!isObj(raw)) {
    r.issue('', 'must be a JSON object {"schemaVersion": 1, "id": "s-<N>", "kind": "flow" | "journey", "title": "..."}');
    return done(null);
  }
  if (raw.schemaVersion !== 1) {
    r.issue('schemaVersion', `must be 1 (${found(raw.schemaVersion)})`);
    return done(null);
  }
  requireKeys(raw, ['id', 'kind', 'title'], '', r);
  const allowed = SIM_KEYS.filter((k) => !(raw.kind === 'flow' && k === 'stages') && !(raw.kind === 'journey' && k === 'steps'));
  const item = readObject(raw, allowed, SIM_KEYS, `a ${String(raw.kind)}`, '', r);
  if (typeof item.id === 'string' && !SIM_ID_RE.test(item.id)) r.issue('id', `must match s-<N> (${found(raw.id)})`);
  else if (typeof item.id === 'string' && `${item.id}.json` !== fileName) r.issue('id', `'${item.id}' does not match the file name '${fileName}' (the file must be <id>.json)`);
  return done(item as unknown as SimItem);
}
