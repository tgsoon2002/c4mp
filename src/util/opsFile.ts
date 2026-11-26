import { didYouMean } from './text';

/** One entry of a JSON ops file (plan apply, later board batch): its index, op name and the other keys. */
export interface OpEntry { index: number; op: string; fields: Record<string, unknown> }

/** The keys one op takes and their types, for checkOpKeys. */
export interface OpShape { required: readonly string[]; strings?: readonly string[]; lists?: readonly string[]; flags?: readonly string[] }

const ENVELOPE_KEYS = ['schemaVersion', 'ops'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse and check the envelope { schemaVersion: 1, ops: [...] }. `source` names the file in messages. */
export function readOpsText(
  text: string,
  source: string,
  opNames: readonly string[],
): { ok: true; ops: OpEntry[] } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `${source} is not valid JSON (${(e as Error).message})` };
  }
  if (!isObject(data)) return { ok: false, message: `${source}: schemaVersion must be 1` };
  if (data.schemaVersion !== 1) return { ok: false, message: `${source}: schemaVersion must be 1` };
  for (const k of Object.keys(data)) {
    if (!ENVELOPE_KEYS.includes(k)) {
      return { ok: false, message: `${source}: unknown key '${k}' (keys: ${ENVELOPE_KEYS.join(', ')})` };
    }
  }
  if (!Array.isArray(data.ops) || data.ops.length === 0) {
    return { ok: false, message: `${source}: ops must be a non-empty list` };
  }
  const ops: OpEntry[] = [];
  for (let i = 0; i < data.ops.length; i++) {
    const raw: unknown = data.ops[i];
    if (!isObject(raw) || typeof raw.op !== 'string') {
      return { ok: false, message: `ops[${i}] must be an object with a string "op"` };
    }
    const op = raw.op;
    if (!opNames.includes(op)) {
      const m = didYouMean(op, opNames);
      const list = `Ops: ${opNames.join(', ')}`;
      return {
        ok: false,
        message: m !== undefined
          ? `ops[${i}]: unknown op '${op}', did you mean '${m}'? ${list}`
          : `ops[${i}]: unknown op '${op}'. ${list}`,
      };
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (k !== 'op') fields[k] = v;
    ops.push({ index: i, op, fields });
  }
  return { ok: true, ops };
}

/** Keys of one entry against its shape: unknown key (with did-you-mean), missing required, wrong type. null = fine. */
export function checkOpKeys(entry: OpEntry, shape: OpShape): string | null {
  const strings = shape.strings ?? [];
  const lists = shape.lists ?? [];
  const flags = shape.flags ?? [];
  const known = [...shape.required, ...strings, ...lists, ...flags];
  for (const k of Object.keys(entry.fields)) {
    if (known.includes(k)) continue;
    const m = didYouMean(k, known);
    return m !== undefined
      ? `unknown key '${k}' for ${entry.op}, did you mean '${m}'? Keys: ${known.join(', ')}`
      : `unknown key '${k}' for ${entry.op}. Keys: ${known.join(', ')}`;
  }
  for (const k of shape.required) {
    if (!(k in entry.fields)) return `'${k}' is required for ${entry.op}`;
  }
  const isLine = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);
  for (const k of [...shape.required, ...strings]) {
    if (k in entry.fields && !isLine(entry.fields[k])) return `'${k}' must be a non-empty string`;
  }
  for (const k of lists) {
    const v = entry.fields[k];
    if (k in entry.fields && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      return `'${k}' must be a list of strings`;
    }
  }
  for (const k of flags) {
    if (k in entry.fields && typeof entry.fields[k] !== 'boolean') return `'${k}' must be true or false`;
  }
  return null;
}
