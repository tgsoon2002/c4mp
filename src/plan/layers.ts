import type { Plan, PlanElement } from '../types';

/**
 * Phase 28 (LK-A, b391): the one place that knows a `subregion` (b456: was `layer`; a layer when the project orders its
 * subregions as a stack) sits between a container and its components.
 * Every "the parent of a component is its container" assumption goes through containerOf. Frozen after LK-A:
 * later tasks (generate, snapshot, view model, deps) only call these helpers.
 */

const byIdCache = new WeakMap<PlanElement[], { size: number; byId: Map<string, PlanElement> }>();

/** fqn -> element of a plan. Cached per elements array (rebuilt when its length changes). */
export function planById(plan: Plan): Map<string, PlanElement> {
  const hit = byIdCache.get(plan.elements);
  if (hit && hit.size === plan.elements.length) return hit.byId;
  const byId = new Map(plan.elements.map((e) => [e.id, e] as const));
  byIdCache.set(plan.elements, { size: plan.elements.length, byId });
  return byId;
}

/**
 * Comparator in declaration order: position of the file in plan.files, then line (plan.elements is sorted by id).
 * Throws for an element whose file is not in plan.files (same rule as view/navModel.ts).
 */
export function declaredOrder(plan: Plan): (a: PlanElement, b: PlanElement) => number {
  const fileIndex = new Map(plan.files.map((f, i) => [f, i] as const));
  const rank = (el: PlanElement): number => {
    const idx = fileIndex.get(el.source.file);
    if (idx === undefined) throw new Error(`layers: ${el.id} is declared in '${el.source.file}', which is not in plan.files`);
    return idx;
  };
  return (a, b) => rank(a) - rank(b) || a.source.line - b.source.line;
}

/**
 * Q-1: the parent of `el` with subregions skipped. A parent that is no subregion comes back unchanged (null for a top-level
 * element), so a plan without subregions gives el.parent for every element. Through subregions (a subregion inside a
 * subregion is misplaced but still walked): null when the chain breaks (a parent missing from the plan, or a cycle).
 * Never a default; a caller that gets null for an element in a subregion passes el.parent explicitly and logs.
 */
export function containerOf(plan: Plan, el: PlanElement): string | null {
  const byId = planById(plan);
  const seen = new Set<string>([el.id]);
  let parent = el.parent;
  while (parent !== null) {
    const p = byId.get(parent);
    if (p && p.kind !== 'subregion') return parent;
    if (!p) return seen.size === 1 ? parent : null;   // el's own parent is missing from the plan: unchanged; after a subregion: broken chain
    if (seen.has(p.id)) return null;
    seen.add(p.id);
    parent = p.parent;
  }
  return null;
}

/** The nearest subregion above `el` (its direct parent when that is a subregion), or null. Stops on a missing parent or a cycle. */
export function subregionOf(plan: Plan, el: PlanElement): PlanElement | null {
  const byId = planById(plan);
  const seen = new Set<string>([el.id]);
  let cur = el.parent === null ? undefined : byId.get(el.parent);
  while (cur && !seen.has(cur.id)) {
    if (cur.kind === 'subregion') return cur;
    seen.add(cur.id);
    cur = cur.parent === null ? undefined : byId.get(cur.parent);
  }
  return null;
}

/**
 * b454: a shared subregion, one every other subregion of its container may use directly: a subregion with metadata
 * `shared 'true'` (the key is valid only there: validate.ts Rule 7). The map draws it as a side column (view/arrange.ts arrangeStack).
 */
export function isSharedSubregion(el: PlanElement): boolean {
  return el.kind === 'subregion' && el.metadata?.shared === 'true';
}

/** The subregions directly in one container, in declaration order (first = top). Throws for a subregion whose file is not in plan.files. */
export function subregionsOf(plan: Plan, containerFqn: string): PlanElement[] {
  return plan.elements.filter((e) => e.kind === 'subregion' && e.parent === containerFqn).sort(declaredOrder(plan));
}

/**
 * b465 (layer tools): a component's place in its container's stack of subregions. rank 0 = top (first declared);
 * `shared` = the subregion is shared (isSharedSubregion), usable from every other subregion of the container.
 */
export interface LayerPlace { container: string; layer: PlanElement; rank: number; shared: boolean }

export interface LayerIndex {
  /** Container fqn -> its subregions in declaration order (shared ones included). Only containers with subregions. */
  stacks: Map<string, PlanElement[]>;
  /** Place of a component fqn, or null (not a component, not in a subregion of its container, broken chain). */
  place(fqn: string): LayerPlace | null;
}

/**
 * b466/b469: one pass over plan.elements: each container with subregions -> its stack; each component in a subregion of
 * its container -> its place. Pure. Throws like declaredOrder for a subregion whose file is not in plan.files.
 */
export function layerIndex(plan: Plan): LayerIndex {
  const stacks = new Map<string, PlanElement[]>();
  for (const c of plan.elements) {
    if (c.kind !== 'container') continue;
    const s = subregionsOf(plan, c.id);
    if (s.length > 0) stacks.set(c.id, s);
  }
  const places = new Map<string, LayerPlace>();
  for (const el of plan.elements) {
    if (el.kind !== 'component') continue;
    const sub = subregionOf(plan, el);
    const cont = containerOf(plan, el);
    if (!sub || !cont) continue;
    const rank = stacks.get(cont)?.findIndex((s) => s.id === sub.id) ?? -1;
    if (rank >= 0) places.set(el.id, { container: cont, layer: sub, rank, shared: isSharedSubregion(sub) });
  }
  return { stacks, place: (fqn) => places.get(fqn) ?? null };
}
