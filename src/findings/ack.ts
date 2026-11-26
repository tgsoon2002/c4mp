import { createIgnoreMatcher } from '../ignoreMatch';
import type { PlanFinding } from '../types';
import { canonicalRule } from '../plan/renames';
import { fileOfId } from './group';
import type { AckEntry } from './types';

/** A test per ack: same rule, and the same id or a glob hit on the id or on its file. Throws on an ack with neither or both of id/glob. */
function ackTest(a: AckEntry): (f: PlanFinding) => boolean {
  const rule = canonicalRule(a.rule);   // b456: an ack written with an old rule id (layer-misplaced) matches the current id
  if ((a.id === undefined) === (a.glob === undefined)) {
    throw new Error(`ack for rule '${a.rule}' needs exactly one of id or glob`);
  }
  if (a.id !== undefined) { const id = a.id; return (f) => f.rule === rule && f.id === id; }
  const m = createIgnoreMatcher([a.glob as string]);
  return (f) => {
    if (f.rule !== rule) return false;
    const file = fileOfId(f.id);
    return m.matches(f.id) || (file !== null && m.matches(file));
  };
}

export interface AckResult {
  /** findings no ack covers, in input order */
  kept: PlanFinding[];
  /** findings hidden by an ack */
  acknowledged: PlanFinding[];
  /** acks that matched no finding of `findings` */
  stale: AckEntry[];
}

/** Split `findings` by acks. Run it on the RAW findings so stale acks do not depend on any severity filter. */
export function applyAcks(findings: PlanFinding[], acks: AckEntry[]): AckResult {
  const matchers = acks.map((a) => ({ a, test: ackTest(a), hit: false }));
  const kept: PlanFinding[] = [];
  const acknowledged: PlanFinding[] = [];
  for (const f of findings) {
    let acked = false;
    for (const m of matchers) if (m.test(f)) { m.hit = true; acked = true; }
    (acked ? acknowledged : kept).push(f);
  }
  return { kept, acknowledged, stale: matchers.filter((m) => !m.hit).map((m) => m.a) };
}
