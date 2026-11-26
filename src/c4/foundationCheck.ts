import type { Plan, PlanFinding, Snapshot } from '../types';
import { CMD_NAME, FOUNDATION_ROLE } from '../constants';
import { log } from '../log';

/**
 * b908: the share of the other components that must use a component for it to be suggested as a foundation: MORE than
 * half. One named constant, so a floor (open question 1: at least N users) is a one-line change in `isFoundationCandidate`.
 */
export const FOUNDATION_SHARE = 0.5;

/** `users` of `others` other components make a candidate: more than FOUNDATION_SHARE of them. */
function isFoundationCandidate(users: number, others: number): boolean {
  return users > others * FOUNDATION_SHARE;
}

/**
 * b908: `foundation-candidate` (info). A plan component (claim mode: snapshot component ids are plan fqns) used by MORE
 * than half of the other plan components, counted as distinct sources of snapshot.componentEdges (code imports, test
 * importers already left out), and not marked `role 'foundation'`. The finding only suggests; nothing writes the key.
 * Like the layer rules it runs in collectFindings, not in checkPlan, so the plan write gate never refuses an edit for
 * it. Folder mode (ids are folders) finds nothing.
 */
export function checkFoundation(plan: Plan, snapshot: Snapshot): PlanFinding[] {
  const byId = new Map(plan.elements.filter((e) => e.kind === 'component').map((e) => [e.id, e] as const));
  const ids = snapshot.components.map((c) => c.id).filter((id) => byId.has(id));
  const known = new Set(ids);
  const others = ids.length - 1;
  if (others < 1) return [];
  const users = new Map<string, Set<string>>();
  for (const e of snapshot.componentEdges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue;
    const set = users.get(e.to) ?? new Set<string>();
    set.add(e.from);
    users.set(e.to, set);
  }
  const out: PlanFinding[] = [];
  for (const id of ids) {
    const n = users.get(id)?.size ?? 0;
    const el = byId.get(id)!;
    if (!isFoundationCandidate(n, others) || el.metadata.role === FOUNDATION_ROLE) continue;
    out.push({
      severity: 'info', rule: 'foundation-candidate', id,
      message: `${el.title} is used by ${n} of the ${others} other components; mark it foundation and the map hides the arrows into it until it is hovered or selected: ${CMD_NAME} plan set ${id} role=foundation`,
    });
  }
  log('foundationCheck', 'done', { components: ids.length, findings: out.length });
  return out;
}
