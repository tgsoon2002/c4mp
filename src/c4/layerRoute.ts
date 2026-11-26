import type { ComponentEdge, PlanElement } from '../types';
import { isSharedSubregion, type LayerIndex } from '../plan/layers';

/**
 * b465 (layer tools): routes through a container's stack of subregions, shared by the check rules (c4/layerCheck.ts,
 * b466) and `c4pm plan path` (query/planPath.ts, b469). Pure: plan order from layerIndex, arrows from snapshot.componentEdges.
 */

/** One non-shared layer between two components, with the components of that layer that already call the target. */
export interface RouteStep { layer: PlanElement; rank: number; callers: string[] }

/** Short id inside the container: `c4pm.c4pm.services.query` -> `services.query`. */
export const shortId = (container: string, fqn: string): string =>
  fqn.startsWith(container + '.') ? fqn.slice(container.length + 1) : fqn;

/**
 * Non-shared layers strictly between the layers of `from` and `to` in their container, top to bottom, each with the
 * components there that have an arrow to `to` (sorted by id). [] when either end is not placed, the ends are in two
 * containers, or no layer lies between them.
 */
export function layersBetween(idx: LayerIndex, edges: ComponentEdge[], from: string, to: string): RouteStep[] {
  const a = idx.place(from);
  const b = idx.place(to);
  if (!a || !b || a.container !== b.container) return [];
  const lo = Math.min(a.rank, b.rank);
  const hi = Math.max(a.rank, b.rank);
  const stack = idx.stacks.get(a.container) ?? [];
  const callersOfTo = edges.filter((e) => e.to === to && e.from !== to).map((e) => e.from);
  const steps: RouteStep[] = [];
  for (let rank = lo + 1; rank < hi; rank++) {
    const layer = stack[rank];
    if (!layer || isSharedSubregion(layer)) continue;
    const callers = [...new Set(callersOfTo.filter((c) => idx.place(c)?.layer.id === layer.id))].sort();
    steps.push({ layer, rank, callers });
  }
  return steps;
}

/**
 * Route hint for one arrow `from -> to`: a component in a layer between that already calls `to`. Preference: one `from`
 * already calls, then the layer nearest to `from`, then id order. null when no layer between has such a component.
 */
export function routeHint(idx: LayerIndex, edges: ComponentEdge[], from: string, to: string): { via: string; viaUses: string } | null {
  const steps = layersBetween(idx, edges, from, to);
  const fromRank = idx.place(from)?.rank ?? 0;
  const calledByFrom = new Set(edges.filter((e) => e.from === from).map((e) => e.to));
  const options = steps.flatMap((s) => s.callers.map((c) => ({ c, dist: Math.abs(s.rank - fromRank) })));
  options.sort((x, y) =>
    Number(calledByFrom.has(y.c)) - Number(calledByFrom.has(x.c)) || x.dist - y.dist || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return options.length > 0 ? { via: options[0].c, viaUses: to } : null;
}
