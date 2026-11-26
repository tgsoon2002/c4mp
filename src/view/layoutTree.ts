import { ViewEdge, ViewNode } from '../types';
import { log } from '../log';
import { Arrangement, arrangeSlots, arrangeStack, BEAN, fitScale, FRAME_HEAD, frameSlots, HEAD, MAX_LAYER_ASPECT, MIN_LAYER_ASPECT, PAD, regionFromSlots, regionScaleFor, SLOT, SlotSize } from './arrange';
import { arrangeLayered } from './arrangeLayered';
import { holderSystem, placeOutside } from './arrangeOutside';
import { SiblingPair, siblingEdges } from './siblingEdges';

// P14-I3: the two-phase tree pass. Not wired into layoutView yet (P14-I4 wires it).
// Region phase (bottom-up) sizes every region from its children's slots; bean phase (top-down) places
// each child's region in its parent's slot and gives it a running world scale. Sizes come only from
// regionFromSlots (sizing seam); this file never computes W/H itself.

// P14-I5a: saved overrides (opt-in). All saved values are PARENT-LOCAL units (see the I5 semantics box).
// Off by default: with no `saved` option the output is the same as before I5a.
// P14-I16: `edges` (opt-in) selects the layered arrangement for parents that have sibling pairs. With no
// `edges` (or none that pair siblings) the output is the same as before I16.
export interface LayoutOpts {
  saved?: boolean;
  edges?: ViewEdge[];
  slot?: SlotSize;   // b128: one child's slot for the whole call (default SLOT). The IO view passes a taller slot for its cards.
}

interface Sized {
  a: Arrangement; // slot positions of this node's children, in this node's local frame
  r: { w: number; h: number }; // this node's local region size (regionFromSlots, then a saved rw,rh down to the floor or up)
  k: number; // contain-fit scale of the AUTO size into one slot (b268: unchanged by a saved rw,rh)
  frames?: Map<ViewNode, Rect>; // SR2 (b457): this node's hand-placed subregion frames (savedFrame), local; absent when none
}

type Rect = { x: number; y: number; w: number; h: number };

// Stale overrides dropped during one call (null when `saved` is off).
interface Stale {
  count: number;
  ids: string[];
}

/** Assigns x, y, w, h, bubble, headerH and scale to every node of the tree (C1 B1: a C1 holder root gets the union rect). Mutates it. */
export function layoutTree(root: ViewNode, opts: LayoutOpts = {}): void {
  const sized = new Map<ViewNode, Sized>();
  const stale: Stale | null = opts.saved ? { count: 0, ids: [] } : null;
  const layer = opts.edges ? siblingEdges(root, opts.edges) : null;
  const slot = opts.slot ?? SLOT;
  // C1 B1 (b831): a C1 holder root is not laid out itself: its system is the layout root (the same layout as with no
  // actors), then placeOutside puts the persons above it and the externals below it, and gives the holder the union rect.
  const system = holderSystem(root);
  const top = system ?? root;
  if (stale && top.savedLayout) log('layout', 'root savedLayout ignored', { id: top.id });
  measure(top, sized, stale, layer, slot, true);
  if (stale && stale.count > 0) log('layout', 'stale-layout', { count: stale.count, ids: stale.ids });
  const rootSized = sized.get(top)!;
  const K = rootSized.k;
  top.x = 0;
  top.y = 0;
  top.w = rootSized.r.w * K;
  top.h = rootSized.r.h * K;
  place(top, K, 1, sized, slot);
  if (system) layoutOutside(root, system, opts.edges ?? [], sized, stale, layer, slot);
}

// C1 B1 (b831): the holder's outside items around the system (placeOutside). An item with children (an external that holds
// containers) lays them out inside its rect with the normal measure + place, its region fitted into the rect and centred;
// its bubble stays its rect. A saved slot on an outside item is ignored (they are placed by rule only, PLAN Q7).
function layoutOutside(holder: ViewNode, system: ViewNode, edges: ViewEdge[], sized: Map<ViewNode, Sized>, stale: Stale | null, layer: Map<ViewNode, SiblingPair[]> | null, slot: SlotSize): void {
  placeOutside(holder, system, edges);
  for (const o of holder.children) {
    if (o === system) continue;
    if (stale && o.savedLayout) log('layout', 'outside savedLayout ignored', { id: o.id });
    if (o.children.length === 0) continue;
    measure(o, sized, stale, layer, slot);
    const r = sized.get(o)!.r;
    const box = { x: o.x, y: o.y, w: o.w, h: o.h };
    const K = Math.min(box.w / r.w, box.h / r.h);
    o.w = r.w * K;
    o.h = r.h * K;
    o.x = box.x + (box.w - o.w) / 2;
    o.y = box.y + (box.h - o.h) / 2;
    place(o, K, K, sized, slot);
    o.bubble = { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

// Region phase: children first, so a parent sees its children's sizes. With `stale` set, a parent applies
// its own saved region (rw,rh) and then its children's saved slots (bx,by or rx,ry), in that order.
function measure(node: ViewNode, sized: Map<ViewNode, Sized>, stale: Stale | null, layer: Map<ViewNode, SiblingPair[]> | null, slot: SlotSize, isRoot = false): void {
  for (const c of node.children) measure(c, sized, stale, layer, slot);
  const a = arrangeFor(node, layer, slot);
  const auto = regionFromSlots(a.slots, slot);
  // b268: k comes from the AUTO size so a saved rw,rh changes only w,h (children keep their scale).
  const k = isRoot ? fitScale(auto.w, auto.h, slot) : node.children.length > 0 ? regionScaleFor(auto.w, auto.h, slot) : 1;
  let r = auto;
  let frames: Map<ViewNode, Rect> | undefined;
  if (stale) {
    // b268: children's slot overrides are applied first, inside the larger of the saved and auto size; the
    // floor (their laid-out rects + PAD) then bounds how far the saved size may shrink.
    const want = isRoot ? null : savedRegion(node);
    const body = want ? { w: Math.max(auto.w, want.w), h: Math.max(auto.h, want.h) } : auto;
    // F4 (b937): the root has no saved size; its children's slots are not clamped to the auto body (`grow`), the root grows below.
    const own = node.children.map((c, i) => applySlotOverride(c, a, i, body, stale, slot, isRoot));
    // SR2 (b457): a hand-placed subregion (savedFrame) takes its members that have no saved slot of their own into a grid
    // inside its frame (frameSlots), which grows the frame downward when it is too small (Q4). These are overrides like
    // the slots above: `auto` and `k` are unchanged, so no scale changes (the stack keeps the space they left, R1).
    for (const l of node.subregions ?? []) {
      const f = savedFrame(l, body, stale, slot);
      if (!f) continue;
      const free = node.children.flatMap((c, i) => (c.subregion === l.id && !own[i] ? [i] : []));
      const grid = frameSlots(free.length, f, slot);
      free.forEach((i, j) => { a.slots[i] = grid.slots[j]; });
      f.h = grid.h;
      if (!frames) frames = new Map();
      frames.set(l, f);
    }
    if (want) r = growRegion(node, regionFloor(node, a, k, sized, slot), auto, want);
    // F4 (b937): the root grows to cover its resized children + PAD (the live page's growParents), never below auto.
    if (isRoot) r = growToChildren(node, a, sized, slot, r);
    if (frames) {
      // SR2 (b457): the region covers every placed frame plus PAD (a frame may lie past the auto size, or grow past it).
      const placed = [...frames.values()];
      const w = Math.max(r.w, ...placed.map((f) => f.x + f.w + PAD));
      const h = Math.max(r.h, ...placed.map((f) => f.y + f.h + PAD));
      if (w > r.w || h > r.h) {
        log('layout', 'region grown to hold placed subregions', { id: node.id, w: r.w, h: r.h, toW: w, toH: h });
        r = { w, h };
      }
    }
  }
  sized.set(node, frames ? { a, r, k, frames } : { a, r, k });
}

// P14-I16: layered arrangement for a parent with sibling pairs, accepted only when its region aspect is within
// [MIN_LAYER_ASPECT, MAX_LAYER_ASPECT]; otherwise the grid (arrangeSlots). `layer` null means no edges given.
// Phase 28 LK-G: a container with plan `subregions` is the stack (arrangeStack): its children grouped by subregion, the
// subregions in declaration order top to bottom, whatever its edges. b454: the first shared subregion (if any) is the side column.
function arrangeFor(node: ViewNode, layer: Map<ViewNode, SiblingPair[]> | null, slot: SlotSize): Arrangement {
  const subregions = node.subregions ?? [];
  if (subregions.length > 0) {
    const groupOf = node.children.map((c) => subregions.findIndex((l) => l.id === c.subregion));
    return arrangeStack(groupOf, subregions.length, slot, subregions.findIndex((l) => l.sharedColumn === true));
  }
  const pairs = layer?.get(node);
  if (pairs && pairs.length > 0) {
    const layered = arrangeLayered(node.children.length, pairs, slot);
    if (layered) {
      const r = regionFromSlots(layered.slots, slot);
      const aspect = r.w / r.h;
      if (aspect >= MIN_LAYER_ASPECT && aspect <= MAX_LAYER_ASPECT) return layered;
    }
  }
  return arrangeSlots(node.children.length, slot);
}

// b268: this node's saved rw,rh, or null when it has none. There is no upper cap: a region grows as big as the user
// made it (growRegion still holds the floor below). The 6x stale guard that used to drop big sizes is gone.
function savedRegion(node: ViewNode): { w: number; h: number } | null {
  const sv = node.savedLayout;
  return sv ? { w: sv.rw, h: sv.rh } : null;
}

// b268: the smallest local region a node may be saved at: its own bubble (BEAN / k + 20) and every child's laid-out
// region AND bubble, centred in the child's slot, plus PAD on the right/bottom. One definition with the viewer's
// minRegion (viewer/edit.js: bubble + 20*scale, children bounds + PAD*scale), here in this node's local units.
function regionFloor(node: ViewNode, a: Arrangement, k: number, sized: Map<ViewNode, Sized>, slot: SlotSize): { w: number; h: number } {
  let w = BEAN.w / k + 20;
  let h = BEAN.h / k + 20;
  node.children.forEach((c, i) => {
    const cs = sized.get(c)!;
    const cx = a.slots[i].x + slot.w / 2;
    const cy = a.slots[i].y + slot.h / 2;
    w = Math.max(w, cx + Math.max(cs.r.w * cs.k, BEAN.w) / 2 + PAD);
    h = Math.max(h, cy + Math.max(cs.r.h * cs.k, BEAN.h) / 2 + PAD);
  });
  return { w, h };
}

// b268: the saved size is honoured per axis: it may grow, or shrink down to `floor` (regionFloor). The region keeps
// its slot centre (place centres by the real size), which is what the viewer export (rx,ry from the region centre)
// assumes, so a rect round-trips. Below the floor it clamps to the floor and logs.
function growRegion(node: ViewNode, rectsFloor: { w: number; h: number }, auto: { w: number; h: number }, want: { w: number; h: number }): { w: number; h: number } {
  // The viewer never shrinks an axis it did not drag, and its minRegion can exceed the auto size (bubble term), so the
  // floor is never above the auto size: an unchanged axis (saved = auto) must come back as it was.
  const floor = { w: Math.min(rectsFloor.w, auto.w), h: Math.min(rectsFloor.h, auto.h) };
  if (want.w < floor.w || want.h < floor.h) log('layout', 'saved region smaller than content, clamped to floor', { id: node.id, rw: want.w, rh: want.h, w: floor.w, h: floor.h });
  return { w: Math.max(floor.w, want.w), h: Math.max(floor.h, want.h) };
}
// F4 (b937): grow a region to cover its children's laid-out rects + PAD (right and bottom only), never below `r`. The same
// terms as regionFloor's per-child part, without its bean floor, so children that already fit leave `r` unchanged.
function growToChildren(node: ViewNode, a: Arrangement, sized: Map<ViewNode, Sized>, slot: SlotSize, r: { w: number; h: number }): { w: number; h: number } {
  let w = r.w;
  let h = r.h;
  node.children.forEach((c, i) => {
    const cs = sized.get(c)!;
    w = Math.max(w, a.slots[i].x + slot.w / 2 + Math.max(cs.r.w * cs.k, BEAN.w) / 2 + PAD);
    h = Math.max(h, a.slots[i].y + slot.h / 2 + Math.max(cs.r.h * cs.k, BEAN.h) / 2 + PAD);
  });
  if (w > r.w || h > r.h) log('layout', 'root grown to hold its children', { id: node.id, w: r.w, h: r.h, toW: w, toH: h });
  return { w, h };
}

// P14-I5a: a child's saved slot. bx,by (bean top-left) moves the slot so its centre is the bean centre and sets
// bubbleMoved; otherwise rx,ry is the slot top-left. The slot is clamped inside the parent body `body`
// (x in [0, W - slot.w], y in [HEAD, H - slot.h]). A slot more than one slot outside the body is stale and dropped. SR2 (b457):
// true when the slot was applied (measure keeps such a member out of its placed subregion's grid).
function applySlotOverride(child: ViewNode, a: Arrangement, i: number, body: { w: number; h: number }, stale: Stale, slot: SlotSize, grow = false): boolean {
  const sv = child.savedLayout;
  if (!sv) return false;
  const moved = sv.bx !== undefined && sv.by !== undefined;
  const sx = moved ? sv.bx! + (BEAN.w - slot.w) / 2 : sv.rx;
  const sy = moved ? sv.by! + (BEAN.h - slot.h) / 2 : sv.ry;
  if (sx < -slot.w || sx > body.w + slot.w || sy < -slot.h || sy > body.h + slot.h) {
    dropOverride(child, stale);
    return false;
  }
  // F4 (b937): `grow` = the region grows to its children (the root, like the live page's growParents), so the slot is
  // not pushed back inside `body` on the right/bottom; the caller grows the region to cover it.
  a.slots[i] = {
    x: Math.max(0, grow ? sx : Math.min(body.w - slot.w, sx)),
    y: Math.max(HEAD, grow ? sy : Math.min(body.h - slot.h, sy)),
  };
  if (moved) child.bubbleMoved = true;
  return true;
}

// SR2 (b457): the local rect of subregion `l`'s hand-placed frame from its saved layout (rx,ry = top-left of the slot
// centred on the frame, rw,rh = the frame size; container-local), clamped inside the container body as a slot is
// (x in [0, W - w], y in [HEAD, H - h]). null when it has none, or when that slot lies more than one slot outside the
// body (stale: dropped, the same rule as applySlotOverride); the frame is then an auto frame.
function savedFrame(l: ViewNode, body: { w: number; h: number }, stale: Stale, slot: SlotSize): Rect | null {
  const sv = l.savedLayout;
  if (!sv) return null;
  if (sv.rx < -slot.w || sv.rx > body.w + slot.w || sv.ry < -slot.h || sv.ry > body.h + slot.h) {
    dropOverride(l, stale);
    return null;
  }
  const w = sv.rw;
  const h = sv.rh;
  return {
    x: Math.max(0, Math.min(body.w - w, sv.rx + slot.w / 2 - w / 2)),
    y: Math.max(HEAD, Math.min(body.h - h, sv.ry + slot.h / 2 - h / 2)),
    w,
    h,
  };
}

function dropOverride(node: ViewNode, stale: Stale): void {
  stale.count++;
  stale.ids.push(node.id);
}

// Bean phase: top-down. `K` is this node's world scale, `parentK` its parent's (1 for the root).
function place(node: ViewNode, K: number, parentK: number, sized: Map<ViewNode, Sized>, size: SlotSize): void {
  const s = sized.get(node)!;
  node.scale = K;

  const bw = BEAN.w * parentK;
  const bh = BEAN.h * parentK;
  node.bubble = { x: node.x + (node.w - bw) / 2, y: node.y + (node.h - bh) / 2, w: bw, h: bh };

  if (node.children.length > 0) node.headerH = HEAD * K;
  else delete node.headerH;
  // Phase 28 LK-G: a subregion's frame label band (arrangeStack keeps it free above the subregion's first row). SR2 (b457):
  // every subregion carries its container's scale. A placed frame (savedFrame) gets its rect here; an auto frame keeps
  // x,y,w,h 0 and the viewer draws it around the subregion's components (edit.js placeFrames).
  for (const l of node.subregions ?? []) {
    l.headerH = FRAME_HEAD * K;
    l.scale = K;
    const f = s.frames?.get(l);
    if (f) {
      l.x = node.x + f.x * K;
      l.y = node.y + f.y * K;
      l.w = f.w * K;
      l.h = f.h * K;
      l.placed = true;
    } else delete l.placed;
  }

  node.children.forEach((c, i) => {
    const cs = sized.get(c)!;
    const slot = s.a.slots[i];
    const Kc = cs.k * K;
    const slotX = node.x + slot.x * K;
    const slotY = node.y + slot.y * K;
    const slotW = size.w * K;
    const slotH = size.h * K;
    const w = cs.r.w * Kc;
    const h = cs.r.h * Kc;
    c.x = slotX + (slotW - w) / 2; // b268: centred by the real size (see growRegion)
    c.y = slotY + (slotH - h) / 2;
    c.w = w;
    c.h = h;
    place(c, Kc, K, sized, size);
  });
}
