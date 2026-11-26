import type { CallIndex } from '../callGraph/callResolve';
import type { Plan, PlanElement } from '../types';
import { UID_KEY } from '../util/uid';

/** The code elements of a scan by `file#name` (`callIndex(snapshot).elements`, src/callGraph/callResolve.ts). */
export type CodeIndex = CallIndex['elements'];

/**
 * What a stored s-item ref (a step target, a `call.from` / `call.to`, a rows key) names.
 * `plan`: a plan element; `code` = `link.path#link.name` of a function or method element with a function link, else null.
 * `code`: a code element of the scan, by its `file#name` key. `missing`: nothing.
 */
export type SimTargetHit =
  | { kind: 'plan'; el: PlanElement; code: string | null }
  | { kind: 'code'; key: string }
  | { kind: 'missing' };

/** Plan kinds whose function link (`#name`) is their code. */
const CODE_BACKED_KINDS = new Set(['function', 'method']);

/** `link.path#link.name` of the first function link of a function or method element, else null. */
function codeKeyOf(el: PlanElement): string | null {
  if (!CODE_BACKED_KINDS.has(el.kind)) return null;
  const link = el.links.find((l) => l.name !== null);
  return link ? `${link.path}#${link.name}` : null;
}

/**
 * A stored ref -> what it names, in three tiers (PHASE_25_SIMULATIONS.md T7): 1. the uid of any plan element (c-item
 * kinds and planned code: function, method, class, type; b899), 2. the exact fqn of any `plan.elements` entry, 3. a
 * `path#name` key of the scan's code. Exact matches only: a stored ref was resolved when it was written (the sim
 * commands store a uid, b899; files written before may hold an fqn or a `path#name`, read as before), so a title or a
 * local id here is a stale ref.
 */
export function resolveSimTarget(ref: string, plan: Plan | null, code: CodeIndex | null): SimTargetHit {
  if (plan) {
    const byUid = plan.elements.find((el) => el.metadata[UID_KEY] === ref);
    if (byUid) return { kind: 'plan', el: byUid, code: codeKeyOf(byUid) };
    const byFqn = plan.elements.find((el) => el.id === ref);
    if (byFqn) return { kind: 'plan', el: byFqn, code: codeKeyOf(byFqn) };
  }
  if (code?.has(ref)) return { kind: 'code', key: ref };
  return { kind: 'missing' };
}
