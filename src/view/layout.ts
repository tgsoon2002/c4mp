import { ViewNode, ViewModel } from '../types';
import { timed } from '../log';
import { layoutTree } from './layoutTree';
import { holderSystem } from './arrangeOutside';
import { SLOT } from './arrange';
import { forEachNode } from './tree';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** SR3 (b693): a node's rect in the layout-metadata units (parent-local, not rounded); see localLayoutOf. */
export interface LocalLayout {
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

// ---------------------------------------------------------------------------------------------
// Blueprint-map layout (P14-I4). Two phases, both in layoutTree.ts:
//   region phase (bottom-up): each region is sized from its children's slots (arrangeSlots +
//     regionFromSlots), so a region holds only its own children;
//   bean phase (top-down): each child's region is placed in its parent's slot and gets a running
//     world scale `scale`; its bubble is BEAN units in the parent's frame, so beans keep one size
//     at every depth.
// Output per node: x/y/w/h = REGION (world units), bubble = the small closed shape centred inside,
// headerH = header band (nodes with children), scale = world units per local unit.
// Saved overrides (P10-T3, P14-I5a/I5b) are applied inside layoutTree (opts.saved).
// ---------------------------------------------------------------------------------------------

// SR3 (b693): the boxes that get an auto rect (the viewer's exported kinds, without the subregion: an auto frame is
// derived from its boxes by the viewer's placeFrames).
const AUTO_KINDS = new Set(['system', 'container', 'component']);

/**
 * Layout a ViewModel tree, assigning x/y/w/h, bubble, headerH and scale to all nodes, applying the
 * saved overrides (layoutTree with saved: true). `width`/`height` are unused: the result is
 * content-driven, and the viewer's camera frames whatever extent it produces.
 * SR3 (b693): when some node has a saved layout, a first pass without it records every box's auto rect, and each box
 * whose final rect differs gets `autoLayout` (attachAutoLayouts). With no saved layout: one pass, as before.
 * Mutates the model and returns it.
 */
export function layoutView(
  model: ViewModel,
  width: number = 1600,
  height: number = 1000
): ViewModel {
  void width;
  void height;
  let saved = false;
  forEachNode(model.root, (n) => { if (n.savedLayout) saved = true; });
  timed('layout', () => {
    let auto: Map<ViewNode, LocalLayout> | null = null;
    if (saved) {
      layoutTree(model.root, { edges: model.edges });
      auto = new Map();
      eachBox(model.root, (n, parent) => auto!.set(n, localLayoutOf(n, parent)));
    }
    layoutTree(model.root, { saved: true, edges: model.edges });
    if (auto) attachAutoLayouts(model.root, auto);
  }, () => (saved ? '2 passes (saved layout)' : '1 pass'));
  return model;
}

/**
 * SR3 (b693): node `n`'s rect in the layout-metadata units, relative to `parent` (P14-I5a, not rounded): rx,ry = top-left
 * of the SLOT centred on the region, in the parent's local units; rw,rh = the region in its own local units. The TS twin
 * of viewer/edit.js localOf (the viewer test checks that fromLocal of it gives the layout's rect).
 */
export function localLayoutOf(n: ViewNode, parent: ViewNode): LocalLayout {
  const Kp = parent.scale ?? 1;
  const s = n.scale ?? 1;
  return {
    rx: (n.x + n.w / 2 - (SLOT.w * Kp) / 2 - parent.x) / Kp,
    ry: (n.y + n.h / 2 - (SLOT.h * Kp) / 2 - parent.y) / Kp,
    rw: n.w / s,
    rh: n.h / s,
  };
}

// Every system/container/component node that has a parent, with its parent (subregions are not children: not visited).
function eachBox(root: ViewNode, fn: (n: ViewNode, parent: ViewNode) => void): void {
  const walk = (p: ViewNode): void => p.children.forEach((c) => {
    if (AUTO_KINDS.has(c.kind) && !holderSystem(p)) fn(c, p);   // C1 B1 (b831): a C1 holder's children are placed by rule, not boxes
    walk(c);
  });
  walk(root);
}

/**
 * SR3 (b693): put `autoLayout` (the rect of the pass without saved layout, `auto`) on every box whose final rect is
 * away from it by more than 1e-6 in any value; the others keep none (the load rect is then the auto rect). Mutates.
 */
function attachAutoLayouts(root: ViewNode, auto: Map<ViewNode, LocalLayout>): void {
  eachBox(root, (n, parent) => {
    const a = auto.get(n);
    if (!a) return;
    const now = localLayoutOf(n, parent);
    if ((['rx', 'ry', 'rw', 'rh'] as const).some((k) => Math.abs(now[k] - a[k]) > 1e-6)) n.autoLayout = a;
    else delete n.autoLayout;
  });
}

/**
 * Apply the saved overrides (each node's `savedLayout`, parent-local units) to the tree.
 * Idempotent: it re-runs layoutTree with saved: true, which recomputes every node from scratch.
 * Mutates the tree; returns nothing.
 */
export function applySavedLayout(root: ViewNode): void {
  layoutTree(root, { saved: true });
}
