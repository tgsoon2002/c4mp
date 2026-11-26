/**
 * b484: the parsed plan's elements as lookup rows (plan reading). Moved from query/showElement.ts so the Boards file
 * engine (board/check.ts, board/query.ts) reads them without calling up into the Query layer.
 */
import type { LookupItem, Plan, PlanElement, UnresolvedTarget } from '../types';
import { closestItems, lookupElement, pickOne } from '../util/lookup';
import { isElementKind } from './kinds';

/** P14-T21b: lookup items for the parsed plan (every element kind, kinds.ts isElementKind). Shared by `element` and later `remove`. */
export function planItems(plan: Plan): { item: LookupItem; el: PlanElement }[] {
  return plan.elements
    .filter((el) => isElementKind(el.kind))
    .map((el) => ({ item: { uid: el.metadata.uid, id: el.id, fqn: el.id, title: el.title, level: el.kind }, el }));
}

/**
 * T4a (b698): one plan element named by `target` the way `c4pm plan show` finds it (uid, id, fqn, local id or title),
 * with the ref to store: its uid when it has one, else its fqn. Otherwise why not: no match (the closest 5) or several.
 * Shared by `board link` (services/boardEdit.ts resolveUid) and sim targets (S2).
 */
export function resolvePlanTarget(plan: Plan, target: string): { ref: string; el: PlanElement } | UnresolvedTarget {
  const rows = planItems(plan);
  const items = rows.map((e) => e.item);
  const picked = pickOne(lookupElement(target, items));
  if (!picked.ok) {
    if (picked.reason === 'none') return { kind: 'unresolved', reason: 'none', closest: closestItems(target, items, 5) };
    return { kind: 'unresolved', reason: 'ambiguous', matches: picked.matches };
  }
  const { item, el } = rows.find((e) => e.item === picked.item)!;
  return { ref: item.uid ?? item.fqn ?? item.id, el };
}
