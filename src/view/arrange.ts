import { log } from '../log';

// Shared layout constants (P14-I2). The only place these numbers live; layout.ts and later arrangers import them.
export const SLOT = { w: 300, h: 150 }; // one child's slot in its parent's local frame
export const BEAN = { w: 170, h: 64 }; // the standard bean drawn inside a slot
export const PAD = 30; // margin between a region's border and its slots
export const GAP = 15; // free margin on each side of a region inside its slot
export const HEAD = 44; // header band at the top of a region
export const TARGET_ASPECT = 1.6; // preferred region width / height
export const MAX_LAYER_ASPECT = 2.5; // layered arrangement: widest allowed region aspect (Q48)
export const MIN_LAYER_ASPECT = 1.2; // layered arrangement: narrowest allowed region aspect (Q48)

// C1 B1 (b831): the outside items of the C1 holder (arrangeOutside.ts placeOutside), the demo's values. Units: the system's
// width is SLOT.w (the demo's system is one slot wide), so every value scales with the system's world width.
export const PERSON_BOX = { w: 76, h: 60 }; // a person, in the row above the system
export const EXT_BOX = { w: 150, h: 56 }; // an external (or any other outside item), in the row below the system
// Free band between the system and the nearest row. The demo's PERSON_GAP is 55; 30 keeps a 1-container system (C4PM:
// 212 x 150, taller than the demo's 300 x 96) open at Fit on a 1600 x 1000 page (PLAN.md section 6, Q2): about 69% of the map width.
export const OUT_GAP = 30;
export const OUT_ITEM_GAP = 20; // free space between two items of a row, and between two rows
export const OUT_MIN_W = 40; // a row narrows its items down to this width to stay as wide as the system, then wraps

export interface Slot { x: number; y: number }
export interface SlotSize { w: number; h: number }   // b128: a slot size; every function below defaults to SLOT

// Slot positions only (no W/H). Sizing is done by regionFromSlots.
export interface Arrangement { slots: Slot[] }

// The ONLY region-size formula in the code base. A leaf (no slots) is its own slot.
export function regionFromSlots(slots: Slot[], slot: SlotSize = SLOT): { w: number; h: number } {
  if (slots.length === 0) return { w: slot.w, h: slot.h };
  const w = Math.max(...slots.map(s => s.x + slot.w)) + PAD;
  const h = Math.max(...slots.map(s => s.y + slot.h)) + PAD;
  return { w, h };
}

// Contain-fit scale of a region into one slot.
export function fitScale(w: number, h: number, slot: SlotSize = SLOT): number {
  return Math.min(1, slot.w / w, slot.h / h);
}

// Contain-fit scale of a region into its slot minus GAP on each side (P14-I19a).
export function regionScale(w: number, h: number, slot: SlotSize = SLOT): number {
  return Math.min(1, (slot.w - 2 * GAP) / w, (slot.h - 2 * GAP) / h);
}

// Scale of a non-root region: keeps the GAP margin, but the region is never narrower than a bean
// (BEAN.w wins over the margin) and never larger than its slot (fitScale).
export function regionScaleFor(w: number, h: number, slot: SlotSize = SLOT): number {
  return Math.min(fitScale(w, h, slot), Math.max(regionScale(w, h, slot), BEAN.w / w));
}

// Grid of `count` slots. Tries every column count and keeps the one whose region aspect is closest to TARGET_ASPECT.
export function arrangeSlots(count: number, slot: SlotSize = SLOT): Arrangement {
  if (count <= 0) return { slots: [] };
  let best: { slots: Slot[]; w: number; h: number; score: number } | null = null;
  for (let cols = 1; cols <= count; cols++) {
    const slots = gridSlots(count, cols, slot);
    const { w, h } = regionFromSlots(slots, slot);
    const score = Math.abs(Math.log(w / h / TARGET_ASPECT));
    if (best === null || score < best.score - 1e-12) best = { slots, w, h, score };
  }
  const chosen = best!;
  log('layout', 'arrange', { count, w: chosen.w, h: chosen.h });
  return { slots: chosen.slots };
}

// Phase 28 LK-G: the "stack" of a container with plan subregions. FRAME_HEAD = the label band of a subregion's frame, free above
// its first row; FRAME_GAP = the free band between two groups. Parent-local units, like every number above.
export const FRAME_HEAD = 40;
export const FRAME_GAP = 30;

// Phase 28 LK-G (L7, L8): `groupOf[i]` = the group of child i (0 .. framed-1: the subregions in declaration order; any
// other value: no subregion). The groups are stacked top to bottom (subregions in order, the children with no subregion last),
// each a block of whole rows with one column count for all, children in child order inside their block; a framed
// block has FRAME_HEAD free above it, blocks are FRAME_GAP apart. The column count is the one whose region aspect
// is closest to TARGET_ASPECT (as arrangeSlots). Standard slot size, so the viewer's edit math (edit.js SLOT) holds.
// b454: `shared` = the group of the shared subregion (plan key `shared 'true'`; -1 = none). When it has members and some
// other child exists, it leaves the stack: its members fill a side column (sideSlots) FRAME_GAP right of the stack,
// from the top of the stack with FRAME_HEAD free above them; the column count is scored on the whole region.
// Otherwise (no shared group, an empty one, or nothing else) the result is the plain stack.
export function arrangeStack(groupOf: number[], framed: number, slot: SlotSize = SLOT, shared = -1): Arrangement {
  const groupIdx = (g: number): number => (g >= 0 && g < framed ? g : framed);
  const groups: number[][] = Array.from({ length: framed + 1 }, () => []);
  groupOf.forEach((g, i) => groups[groupIdx(g)].push(i));
  const side = shared >= 0 && shared < framed && groups[shared].length < groupOf.length ? groups[shared] : [];
  const stack = side.length > 0 ? groups.map((g, i) => (i === shared ? [] : g)) : groups;
  const largest = Math.max(0, ...stack.map((g) => g.length));
  let best: { slots: Slot[]; score: number } | null = null;
  for (let cols = 1; cols <= largest; cols++) {
    const slots: Slot[] = new Array(groupOf.length);
    let dy = 0;   // top of the next block, below the usual first row (HEAD + PAD)
    let first = true;
    stack.forEach((members, g) => {
      if (members.length === 0) return;
      dy += (first ? 0 : FRAME_GAP) + (g < framed ? FRAME_HEAD : 0);
      first = false;
      gridSlots(members.length, cols, slot, dy).forEach((s, k) => { slots[members[k]] = s; });
      dy += Math.ceil(members.length / cols) * slot.h;
    });
    if (side.length > 0) sideSlots(side.length, cols * slot.w + FRAME_GAP, dy, slot).forEach((s, k) => { slots[side[k]] = s; });
    const { w, h } = regionFromSlots(slots, slot);
    const score = Math.abs(Math.log(w / h / TARGET_ASPECT));
    if (best === null || score < best.score - 1e-12) best = { slots, score };
  }
  log('layout', 'arrange stack', { count: groupOf.length, framed, groups: groups.map((g) => g.length), side: side.length });
  return { slots: best ? best.slots : [] };
}

// b454: the side column of `count` slots, `dx` right of the stack's left edge, FRAME_HEAD below the stack's top. Its
// column count is the smallest that keeps it no taller than the stack (`stackH`, measured from the same top); when even
// one row is taller, all in one row.
function sideSlots(count: number, dx: number, stackH: number, slot: SlotSize): Slot[] {
  let cols = 1;
  while (cols < count && FRAME_HEAD + Math.ceil(count / cols) * slot.h > stackH) cols++;
  return gridSlots(count, cols, slot, FRAME_HEAD, dx);
}

// Row-major slots for `cols` columns, `dy` below the usual top and `dx` right of the usual left. The last row is centred
// (half a slot per missing column).
function gridSlots(count: number, cols: number, slot: SlotSize, dy = 0, dx = 0): Slot[] {
  const rows = Math.ceil(count / cols);
  const inLastRow = count - (rows - 1) * cols;
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const centre = row === rows - 1 ? ((cols - inLastRow) * slot.w) / 2 : 0;
    slots.push({ x: PAD + dx + col * slot.w + centre, y: HEAD + PAD + dy + row * slot.h });
  }
  return slots;
}

// SR2 (b457): the slots of `count` boxes inside a hand-placed subregion frame (parent-local units): a grid under the label
// band, as many columns as fit the frame width (at least 1, at most `count`), row-major, centred across the frame (gridSlots,
// last row centred too); the first row FRAME_HEAD below the frame top. `h` = the frame height the grid needs: never less
// than frame.h (Q4: a frame too small for its boxes grows downward, it never shrinks).
export function frameSlots(count: number, frame: { x: number; y: number; w: number; h: number }, slot: SlotSize = SLOT): { slots: Slot[]; h: number } {
  if (count <= 0) return { slots: [], h: frame.h };
  const cols = Math.max(1, Math.min(count, Math.floor((frame.w - PAD) / slot.w)));
  const rows = Math.ceil(count / cols);
  const dx = frame.x + (frame.w - cols * slot.w) / 2 - PAD;   // gridSlots starts at PAD + dx
  const dy = frame.y + FRAME_HEAD - HEAD - PAD;               // gridSlots starts at HEAD + PAD + dy
  const h = Math.max(frame.h, FRAME_HEAD + rows * slot.h + PAD / 2);
  if (h > frame.h) log('layout', 'placed subregion grown to hold its boxes', { count, cols, h: frame.h, need: h });
  return { slots: gridSlots(count, cols, slot, dy, dx), h };
}
