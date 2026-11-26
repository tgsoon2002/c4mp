import type { ViewEdge, ViewNode } from '../types';
import { log } from '../log';
import { EXT_BOX, OUT_GAP, OUT_ITEM_GAP, OUT_MIN_W, PERSON_BOX, SLOT } from './arrange';

// C1 B1 (b831): the C1 system context, laid out like the Phase 25 demo (demo-lines-ref.html 1665-1680). layoutTree lays the
// system out as the root (exactly as when it has no actors), then placeOutside puts the holder's other children around it:
//   - persons in a row ABOVE the system, each centred over the boxes it uses;
//   - externals (and any other outside item) in a row BELOW the system, each centred under the boxes it talks to;
//   - the holder's rect is the union of the system and every outside item, so Fit frames them all (no viewer change).
// Rules the demo does not have (real data, PLAN.md section 3):
//   - "the boxes it uses" are the C1 boxes: an edge end deep inside the system counts as its top box (the system's direct
//     child, a container), an edge on the system itself counts as the system; edges between two outside items are not used;
//   - an item with no such edge goes at the end of its row, in holder (plan) order; a row with none of them is centred;
//   - the items of a row are ordered by their wanted centre (ties: holder order); one that would overlap moves right, and
//     the row is pushed back left so overlaps never carry it past the system's right edge (an item may still stick out
//     past an edge by up to half its width, to sit centred on a box near that edge, as the demo's gateway under API);
//   - a row is never wider than the system: its items narrow down to OUT_MIN_W, then the row wraps (row 0 nearest the system);
//   - a second 'system' child (not ours: the model does not make one today) is an outside item, placed like an external.
// Units: arrange.ts's PERSON_BOX, EXT_BOX, OUT_GAP, OUT_ITEM_GAP, OUT_MIN_W are for a system SLOT.w wide (the demo's), times
// u = the system's world width / SLOT.w. Each item's bubble is its rect (closed at C1). Only the outside items and the holder
// are written; the system subtree is not touched.

type Rect = { x: number; y: number; w: number; h: number };

/** The system child of a C1 holder root (kind 'context', C1 A1), or null when `root` is no holder. */
export function holderSystem(root: ViewNode): ViewNode | null {
  if (root.kind !== 'context') return null;
  return root.children.find((c) => c.kind === 'system') ?? null;
}

/** Places the holder's outside items around `system` (already laid out) and sets the holder's rect. Mutates both. */
export function placeOutside(holder: ViewNode, system: ViewNode, edges: ViewEdge[]): void {
  const u = system.w / SLOT.w;
  const outside = holder.children.filter((c) => c !== system);
  const persons = outside.filter((c) => c.kind === 'person');
  const below = outside.filter((c) => c.kind !== 'person');
  const top = topBoxes(system);
  const gap = OUT_ITEM_GAP * u;
  const placeRows = (items: ViewNode[], box: { w: number; h: number }, yOf: (row: number, h: number) => number): number => {
    const want = items.map((n) => { const c = wantedCentre(n, top, edges); return c === null ? null : c - system.x; });
    const rows = packRows(items, want, { w: box.w * u, gap, min: OUT_MIN_W * u, span: system.w });
    const h = box.h * u;
    rows.forEach((row, r) => row.forEach(({ node, x, w }) => setRect(node, { x: system.x + x, y: yOf(r, h), w, h }, system.scale)));
    return rows.length;
  };
  const above = placeRows(persons, PERSON_BOX, (r, h) => system.y - OUT_GAP * u - h - r * (h + gap));
  const under = placeRows(below, EXT_BOX, (r, h) => system.y + system.h + OUT_GAP * u + r * (h + gap));
  const all = [system, ...outside].map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const x0 = Math.min(...all.map((r) => r.x));
  const y0 = Math.min(...all.map((r) => r.y));
  const x1 = Math.max(...all.map((r) => r.x + r.w));
  const y1 = Math.max(...all.map((r) => r.y + r.h));
  holder.x = x0;
  holder.y = y0;
  holder.w = x1 - x0;
  holder.h = y1 - y0;
  holder.bubble = { x: holder.x, y: holder.y, w: holder.w, h: holder.h };
  holder.scale = system.scale;
  delete holder.headerH;   // a holder is never drawn: no header band
  log('layout', 'outside', { holder: holder.id, system: system.id, persons: persons.length, below: below.length, personRows: above, belowRows: under, w: holder.w, h: holder.h });
}

// Every id of the system subtree (and its subregions) -> its C1 box: the system's direct child it sits in, or the system itself.
function topBoxes(system: ViewNode): Map<string, ViewNode> {
  const out = new Map<string, ViewNode>([[system.id, system]]);
  const walk = (n: ViewNode, box: ViewNode): void => {
    out.set(n.id, box);
    (n.subregions ?? []).forEach((l) => out.set(l.id, box));
    n.children.forEach((c) => walk(c, box));
  };
  system.children.forEach((c) => walk(c, c));
  (system.subregions ?? []).forEach((l) => out.set(l.id, system));
  return out;
}

// The x centre (world) of the C1 boxes `item` has an edge with (either direction), or null when it has none.
function wantedCentre(item: ViewNode, top: Map<string, ViewNode>, edges: ViewEdge[]): number | null {
  const own = new Set<string>();
  const walk = (n: ViewNode): void => { own.add(n.id); n.children.forEach(walk); };
  walk(item);   // an external that holds containers: a relation on one of them counts for it
  const boxes = new Set<ViewNode>();
  for (const e of edges) {
    const other = own.has(e.from) ? e.to : own.has(e.to) ? e.from : null;
    const box = other !== null ? top.get(other) : undefined;
    if (box) boxes.add(box);
  }
  if (boxes.size === 0) return null;
  const xs = [...boxes];
  const x0 = Math.min(...xs.map((b) => b.x));
  const x1 = Math.max(...xs.map((b) => b.x + b.w));
  return (x0 + x1) / 2;
}

interface RowSpec {
  w: number;     // an item's width when the row has room
  gap: number;   // between two items, and between two rows
  min: number;   // the narrowest an item gets before the row wraps
  span: number;  // the row's width limit (the system's width); x is from the system's left edge
}

interface Placed { node: ViewNode; x: number; w: number }

// The rows of `items` (row 0 nearest the system), each item with its x from the system's left edge and its width.
// `want[i]` = item i's wanted centre (from the system's left edge; null = no edge). See the rules at the top of this file.
function packRows(items: ViewNode[], want: (number | null)[], spec: RowSpec): Placed[][] {
  if (items.length === 0) return [];
  const idx = items.map((_, i) => i);
  const related = idx.filter((i) => want[i] !== null).sort((a, b) => want[a]! - want[b]! || a - b);
  const order = [...related, ...idx.filter((i) => want[i] === null)];
  const fitW = (k: number): number => (spec.span - (k - 1) * spec.gap) / k;
  let perRow = order.length;
  let w = Math.min(spec.w, fitW(perRow));
  if (w < spec.min) {
    perRow = Math.max(1, Math.floor((spec.span + spec.gap) / (spec.min + spec.gap)));
    w = Math.min(spec.w, fitW(perRow));
  }
  w = Math.max(1e-6, Math.min(w, spec.span));
  const rows: Placed[][] = [];
  for (let s = 0; s < order.length; s += perRow) rows.push(packRow(order.slice(s, s + perRow), items, want, w, spec));
  return rows;
}

// One row: each item as near its wanted centre as it can be, in order, never overlapping, inside [0, span].
function packRow(row: number[], items: ViewNode[], want: (number | null)[], w: number, spec: RowSpec): Placed[] {
  const rowW = row.length * w + (row.length - 1) * spec.gap;
  const none = row.every((i) => want[i] === null);
  const wanted = row.map((i) => want[i]).filter((c): c is number => c !== null);
  // The row's bounds: the system's span, widened only to let an item sit centred on its box near an edge (demo: the
  // gateway under API); a row pushed right by overlaps is pushed back inside the span.
  const lo = Math.min(0, ...wanted.map((c) => c - w / 2));
  const hi = Math.max(spec.span, ...wanted.map((c) => c + w / 2));
  const xs: number[] = [];
  let end = -Infinity;
  row.forEach((i, k) => {
    const at = want[i] !== null ? want[i]! - w / 2 : k === 0 && none ? (spec.span - rowW) / 2 : end + spec.gap;
    const x = Math.max(at, end + spec.gap);
    xs.push(x);
    end = x + w;
  });
  let limit = hi;
  for (let k = xs.length - 1; k >= 0; k--) {
    xs[k] = Math.min(xs[k], limit - w);
    limit = xs[k] - spec.gap;
  }
  let from = lo;
  for (let k = 0; k < xs.length; k++) {
    xs[k] = Math.max(xs[k], from);
    from = xs[k] + w + spec.gap;
  }
  return row.map((i, k) => ({ node: items[i], x: xs[k], w }));
}

function setRect(n: ViewNode, r: Rect, scale: number | undefined): void {
  n.x = r.x;
  n.y = r.y;
  n.w = r.w;
  n.h = r.h;
  n.bubble = { ...r };
  if (scale !== undefined) n.scale = scale;
  delete n.headerH;
}
