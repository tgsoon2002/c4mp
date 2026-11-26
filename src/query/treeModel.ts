import type { Graph, GraphEdge, GraphNode, Plan, PlanElement } from '../types';
import { PLANNED_CODE_KINDS } from '../plan/plannedElements';
import { isFrontendKind, levelOf, viewOfKind } from '../plan/kinds';
import type { ViewName } from '../plan/kinds';
import { cmp } from '../util/text';
import { declaredOrder } from '../plan/layers';

export { levelOf } from '../plan/kinds';
export type { TreeLevel } from '../plan/kinds';

export interface TreeOptions {
  /** How many levels below the target to show: a number (0 = the target alone) or 'all'. */
  levels: number | 'all';
  /** Draw relations that leave the view as dashed edges to a stub node per outside element. */
  external: boolean;
  /** More nodes than this (stubs included) is refused. */
  maxNodes: number;
  /** b273: draw only children of this view's kinds (io, storage). Absent = as before (architecture tree). */
  view?: ViewName;
}

/** b273: with a view other than arch the tree starts at a container or at any element of that view. */
export function isViewTreeTarget(kind: string, view: ViewName): boolean {
  return viewOfKind(kind) === view || levelOf(kind) === 'c2';
}

export type TreeResult =
  | { graph: Graph; outside: number; truncated: boolean }
  | { error: 'too-many-nodes'; count: number };


/**
 * Graph of the plan below `target` (D16). Children are the plan elements whose `parent` is the element;
 * the children of a component are only planned code (function, class, method, type) and frontend kinds (screen, ...). Declared relations
 * (plan.relations) are drawn when both ends are shown; `outside` counts those with exactly one shown end
 * (relations to an id that is not an element are ignored, not counted). `truncated` = the level limit hid
 * deeper elements. Pure.
 */
export function buildTree(plan: Plan, target: PlanElement, opts: TreeOptions): TreeResult {
  const byId = new Map<string, PlanElement>();
  for (const el of plan.elements) if (!byId.has(el.id)) byId.set(el.id, el);

  // Q-5 (L8): the subregions of a container come first, in declaration order; everything else by id, as before.
  const byDeclaration = declaredOrder(plan);
  const sortKids = (a: PlanElement, b: PlanElement): number =>
    (a.kind === 'subregion' && b.kind === 'subregion' ? byDeclaration(a, b) : Number(b.kind === 'subregion') - Number(a.kind === 'subregion')) || cmp(a.id, b.id);

  const childrenOf = (el: PlanElement): PlanElement[] => {
    const seen = new Set<string>();
    return plan.elements
      .filter(c => c.parent === el.id && (el.kind !== 'component' || PLANNED_CODE_KINDS.includes(c.kind) || isFrontendKind(c.kind)))
      .filter(c => opts.view === undefined || viewOfKind(c.kind) === opts.view)
      .filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .sort(sortKids);
  };

  const nodes: GraphNode[] = [];
  const shown = new Set<string>();
  let truncated = false;
  const node = (el: PlanElement, parent: string | undefined): GraphNode => ({
    id: el.id,
    label: el.title,
    kind: el.kind,
    ...(el.metadata.status !== undefined ? { status: el.metadata.status } : {}),
    ...(el.metadata.owner !== undefined ? { owner: el.metadata.owner } : {}),
    ...(parent !== undefined ? { parent } : {}),
  });

  const visit = (el: PlanElement, parent: string | undefined, depth: number): void => {
    if (shown.has(el.id)) return;   // a parent cycle in a broken plan must not loop
    shown.add(el.id);
    nodes.push(node(el, parent));
    const kids = childrenOf(el);
    if (opts.levels !== 'all' && depth >= opts.levels) {
      if (kids.length > 0) truncated = true;
      return;
    }
    for (const k of kids) visit(k, el.id, depth + 1);
  };
  visit(target, undefined, 0);

  const edges: GraphEdge[] = [];
  const stubs = new Map<string, GraphNode>();
  let outside = 0;
  for (const r of plan.relations) {
    const fromIn = shown.has(r.from);
    const toIn = shown.has(r.to);
    if (fromIn && toIn) {
      edges.push({ from: r.from, to: r.to, ...(r.label !== null ? { label: r.label } : {}) });
      continue;
    }
    if (!fromIn && !toIn) continue;
    const other = fromIn ? r.to : r.from;
    const otherEl = byId.get(other);
    if (!otherEl) continue;   // relation to something that is not an element
    outside++;
    if (opts.external) {
      if (!stubs.has(other)) stubs.set(other, { id: other, label: otherEl.title, kind: otherEl.kind, outside: true });
      edges.push({ from: r.from, to: r.to, dashed: true, ...(r.label !== null ? { label: r.label } : {}) });
    }
  }

  const count = nodes.length + stubs.size;
  if (count > opts.maxNodes) return { error: 'too-many-nodes', count };
  return { graph: { nodes: [...nodes, ...[...stubs.values()].sort((a, b) => cmp(a.id, b.id))], edges }, outside, truncated };
}
