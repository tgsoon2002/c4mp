import type { SimItem } from '../types';
import { CALL_KEYS, SIM_KEYS, STAGE_KEYS, STEP_KEYS } from './parse';

type Obj = Record<string, unknown>;

/** The keys of `src` in `keys` order (absent ones skipped), then its unknown keys (`extra`) in their own order. */
function ordered(src: Obj, keys: readonly string[]): Obj {
  const o: Obj = {};
  for (const k of keys) if (src[k] !== undefined) o[k] = valueOut(k, src[k]);
  for (const [k, v] of Object.entries((src.extra as Obj | undefined) ?? {})) {
    // own-key test, not `in`: an unknown key named like an Object.prototype member (constructor, __proto__) must survive
    if (!Object.prototype.hasOwnProperty.call(o, k)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return o;
}

function valueOut(k: string, v: unknown): unknown {
  switch (k) {
    case 'target': return (v as string[]).length === 1 ? (v as string[])[0] : v;   // one target as a string, more as a list
    case 'steps': return (v as Obj[]).map((s) => ordered(s, STEP_KEYS));
    case 'stages': return (v as Obj[]).map((s) => ordered(s, STAGE_KEYS));
    case 'call': return ordered(v as Obj, CALL_KEYS);
    default: return v;
  }
}

/**
 * Deterministic text of one `sim/s-<N>.json`: 2-space JSON plus a final newline (as serializeBoard). Key order:
 * SIM_KEYS / STEP_KEYS / STAGE_KEYS / CALL_KEYS of parse.ts, then unknown keys. Steps and stages keep their order.
 */
export function serializeSim(item: SimItem): string {
  return JSON.stringify(ordered(item as unknown as Obj, SIM_KEYS), null, 2) + '\n';
}
