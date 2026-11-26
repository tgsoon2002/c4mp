import type { Plan, PlanFinding, Snapshot } from '../types';
import { isSharedSubregion, layerIndex } from '../plan/layers';
import { layersBetween, routeHint, shortId } from './layerRoute';
import { CMD_NAME } from '../constants';

/**
 * b466: the layer direction rules of `c4pm check`, from the plan's own subregion order (declaration order, first = top;
 * no layers.json). One finding per code arrow (snapshot.componentEdges) between two components in subregions of the
 * SAME container; a loose component, an arrow between containers and an arrow inside one subregion are no layer matter.
 *  - `layer-upward` (warning): the target's subregion is above the source's. A shared subregion is never the target of a
 *    finding (usable from anywhere, b454); as the source it is checked by its declared position (K 2026-11-12).
 *  - `layer-skip` (warning, opt-in: config `"layers": {"skip": true}`): an entry point that skips the services (K
 *    2026-11-12): the source is in the TOP non-shared subregion of its stack and the target lies below the next
 *    non-shared one (it jumps over the second layer). A lower layer jumping over a layer (Services -> Readers past
 *    Engines) is no finding; shared subregions never count. Names a component in between that already calls the
 *    target when there is one.
 * Finding id `${from} -> ${to}` (the edge id style), so acks work per arrow. Folder-mode snapshots have no plan fqns as
 * component ids, so nothing is found there.
 */
export function checkLayerDirection(plan: Plan, snapshot: Snapshot, opts: { skip: boolean }): PlanFinding[] {
  const idx = layerIndex(plan);
  if (idx.stacks.size === 0) return [];
  const out: PlanFinding[] = [];
  for (const e of snapshot.componentEdges) {
    const a = idx.place(e.from);
    const b = idx.place(e.to);
    if (!a || !b || a.container !== b.container || a.layer.id === b.layer.id || b.shared) continue;
    const id = `${e.from} -> ${e.to}`;
    const from = shortId(a.container, e.from);
    const to = shortId(a.container, e.to);
    if (b.rank < a.rank) {
      out.push({
        severity: 'warning', rule: 'layer-upward', id,
        message: `${from} (${a.layer.title}) calls ${to} in ${b.layer.title}, a layer above it ` +
          `(${e.weight} import${e.weight === 1 ? '' : 's'}); call down, or move what both need into a lower or shared layer`,
      });
    } else if (opts.skip && a.layer.id === topOf(idx.stacks.get(a.container) ?? [])) {
      const between = layersBetween(idx, snapshot.componentEdges, e.from, e.to);
      if (between.length === 0) continue;
      const hint = routeHint(idx, snapshot.componentEdges, e.from, e.to);
      out.push({
        severity: 'warning', rule: 'layer-skip', id,
        message: `${from} (${a.layer.title}) calls ${to} in ${b.layer.title}, skipping ${between[0].layer.title}` + (hint
          ? `; go through ${shortId(a.container, hint.via)}, which already uses ${shortId(a.container, hint.viaUses)}`
          : `; plan a function in the layer between (${CMD_NAME} plan path shows where)`),
      });
    }
  }
  return out;
}

/** The top non-shared subregion of a stack (the entry layer), or null when every subregion is shared. */
function topOf(stack: Plan['elements']): string | null {
  return stack.find((l) => !isSharedSubregion(l))?.id ?? null;
}
