import { layoutTree } from '../src/view/layoutTree';
import { ViewEdge, ViewNode } from '../src/types';
import { arrangeLayered } from '../src/view/arrangeLayered';
import { BEAN, FRAME_HEAD, GAP, HEAD, MAX_LAYER_ASPECT, MIN_LAYER_ASPECT, PAD, regionFromSlots, SLOT } from '../src/view/arrange';

// P14-I3: pure tree pass. Helpers copied from layout-fit.test.ts (not imported).

const mk = (id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode => ({
  id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});
const files = (p: string, n: number) => Array.from({ length: n }, (_, i) => mk(`${p}/f${i}`, 'file'));
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const EPS = 1e-6;

/** system > 3 containers > components > files (1 / 4 / 75 files per component). */
const fourLevel = (): ViewNode => {
  const sizes = [1, 4, 75];
  const comps = (p: string, n: number) =>
    Array.from({ length: n }, (_, i) => mk(`${p}/c${i}`, 'component', files(`${p}/c${i}`, sizes[i % 3])));
  return mk('sys', 'system', [
    mk('k0', 'container', comps('k0', 2)),
    mk('k1', 'container', comps('k1', 3)),
    mk('k2', 'container', comps('k2', 4)),
  ]);
};

const parentOf = (root: ViewNode): Map<ViewNode, ViewNode> => {
  const m = new Map<ViewNode, ViewNode>();
  for (const p of all(root)) for (const c of p.children) m.set(c, p);
  return m;
};

const overlaps = (a: ViewNode, b: ViewNode) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + EPS &&
  Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + EPS;

describe('layoutTree', () => {
  it('is deterministic: two runs give equal trees', () => {
    const a = fourLevel();
    const b = fourLevel();
    layoutTree(a);
    layoutTree(b);
    expect(a).toEqual(b);
  });

  it('bean size is constant at every level (bubble / parentScale = BEAN)', () => {
    const root = fourLevel();
    layoutTree(root);
    const parents = parentOf(root);
    for (const n of all(root)) {
      const parentScale = parents.has(n) ? parents.get(n)!.scale! : 1;
      expect(Math.abs(n.bubble!.w / parentScale - BEAN.w)).toBeLessThan(1e-9);
      expect(Math.abs(n.bubble!.h / parentScale - BEAN.h)).toBeLessThan(1e-9);
    }
  });

  it('region fits children plus padding, and siblings do not overlap', () => {
    const root = fourLevel();
    layoutTree(root);
    for (const p of all(root)) {
      const K = p.scale!;
      for (let i = 0; i < p.children.length; i++) {
        for (let j = i + 1; j < p.children.length; j++) {
          expect(overlaps(p.children[i], p.children[j])).toBe(false);
        }
      }
      for (const c of p.children) {
        expect(c.y).toBeGreaterThanOrEqual(p.y + p.headerH! - EPS);
        expect(c.x).toBeGreaterThanOrEqual(p.x + PAD * K - EPS);
        expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w - PAD * K + EPS);
        expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h - PAD * K + EPS);
      }
    }
  });

  it('region size is independent of siblings (local size of X is the same with 1 or 75 sibling children)', () => {
    const local = (sibling: number) => {
      const root = mk('sys', 'system', [
        mk('c', 'container', [
          mk('X', 'component', files('X', 4)),
          mk('S', 'component', files('S', sibling)),
        ]),
      ]);
      layoutTree(root);
      const x = all(root).find((n) => n.id === 'X')!;
      return { w: x.w / x.scale!, h: x.h / x.scale! };
    };
    expect(local(1)).toEqual(local(75));
  });

  it('381-child fan-out: beans stay BEAN-sized, component scale is small relative to its parent', () => {
    const comp = mk('big', 'component', files('big', 381));
    const root = mk('sys', 'system', [mk('c', 'container', [comp])]);
    layoutTree(root);
    const container = root.children[0];
    for (const f of comp.children) {
      expect(Math.abs(f.bubble!.w / comp.scale! - BEAN.w)).toBeLessThan(1e-9);
    }
    expect(comp.scale! / container.scale!).toBeLessThan(0.1);
    console.log(`381-fanout component: w=${comp.w} h=${comp.h} scale=${comp.scale}`);
  });

  it('empty region: a childless node is its slot (300 x 150 in parent-local units), no headerH, bubble centred', () => {
    const leaf = mk('leaf', 'file');
    const root = mk('sys', 'system', [mk('c', 'container', [leaf])]);
    layoutTree(root);
    const parentK = leaf.scale!;
    expect(leaf.w / parentK).toBeCloseTo(300, 9);
    expect(leaf.h / parentK).toBeCloseTo(150, 9);
    expect(leaf.headerH).toBeUndefined();
    expect(leaf.bubble!.x + leaf.bubble!.w / 2).toBeCloseTo(leaf.x + leaf.w / 2, 6);
    expect(leaf.bubble!.y + leaf.bubble!.h / 2).toBeCloseTo(leaf.y + leaf.h / 2, 6);
  });

  it('bubble lies inside its own region for every node', () => {
    const root = fourLevel();
    layoutTree(root);
    for (const n of all(root)) {
      expect(n.bubble!.x).toBeGreaterThanOrEqual(n.x - EPS);
      expect(n.bubble!.x + n.bubble!.w).toBeLessThanOrEqual(n.x + n.w + EPS);
      expect(n.bubble!.y).toBeGreaterThanOrEqual(n.y - EPS);
      expect(n.bubble!.y + n.bubble!.h).toBeLessThanOrEqual(n.y + n.h + EPS);
    }
  });

  it('root is at the origin with positive size and scale', () => {
    const root = fourLevel();
    layoutTree(root);
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
    expect(root.w).toBeGreaterThan(0);
    expect(root.h).toBeGreaterThan(0);
    expect(root.scale!).toBeGreaterThan(0);
  });

  it('no NaN, no negative or zero size anywhere', () => {
    const root = fourLevel();
    layoutTree(root);
    for (const n of all(root)) {
      for (const v of [n.x, n.y, n.w, n.h, n.scale!, n.bubble!.x, n.bubble!.y, n.bubble!.w, n.bubble!.h]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(n.w).toBeGreaterThan(0);
      expect(n.h).toBeGreaterThan(0);
      expect(n.scale!).toBeGreaterThan(0);
      expect(n.bubble!.w).toBeGreaterThan(0);
      expect(n.bubble!.h).toBeGreaterThan(0);
    }
  });

  // P14-I5d-ii: containment pinned on a hand-made tree (class with methods, plus loose functions in a file).
  it('every child region sits inside its parent region and scale never grows down the tree', () => {
    const root = mk('r', 'system', [
      mk('f', 'file', [
        mk('C', 'class', [mk('C.a', 'method'), mk('C.b', 'method'), mk('C.c', 'method')]),
        mk('g1', 'function'),
        mk('g2', 'function'),
      ]),
    ]);
    layoutTree(root);
    const parents = parentOf(root);
    for (const c of all(root)) {
      const p = parents.get(c);
      if (!p) continue;
      expect(c.x).toBeGreaterThanOrEqual(p.x - EPS);
      expect(c.y).toBeGreaterThanOrEqual(p.y - EPS);
      expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w + EPS);
      expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h + EPS);
      expect(c.scale!).toBeLessThanOrEqual(p.scale! + EPS);
    }
    const nodes = all(root);
    expect(new Set(nodes).size).toBe(nodes.length);
  });
});

// P14-I16: layered mode. `edges` picks the layered arrangement for a parent with sibling pairs when its
// region aspect is inside [MIN_LAYER_ASPECT, MAX_LAYER_ASPECT]; otherwise the grid is used.
describe('layoutTree with edges (P14-I16)', () => {
  const e = (from: string, to: string): ViewEdge => ({ from, to, weight: 1 });
  const leaves = (...ids: string[]) => ids.map((id) => mk(id, 'component'));
  const under = (children: ViewNode[]) => mk('sys', 'system', [mk('p', 'container', children)]);
  const byId = (root: ViewNode, id: string) => all(root).find((n) => n.id === id)!;
  // Region aspect of the layered arrangement for `count` children and sibling index pairs.
  const aspectOf = (count: number, pairs: { from: number; to: number; weight: number }[]) => {
    const r = regionFromSlots(arrangeLayered(count, pairs)!.slots);
    return r.w / r.h;
  };
  const sameAsGrid = (build: () => ViewNode, edges: ViewEdge[]) => {
    const grid = build();
    layoutTree(grid);
    const layered = build();
    layoutTree(layered, { edges });
    expect(layered).toEqual(grid);
  };

  it('no edges, or edges that pair no siblings: identical to layoutTree without edges', () => {
    const plain = fourLevel();
    layoutTree(plain);
    const empty = fourLevel();
    layoutTree(empty, { edges: [] });
    expect(empty).toEqual(plain);
    const unknown = fourLevel();
    layoutTree(unknown, { edges: [e('nope', 'k0/c0')] });
    expect(unknown).toEqual(plain);
  });

  it('fork of 3 (a->b, a->c, aspect 1.63) is layered: b and c sit below a, bean size unchanged', () => {
    const root = under(leaves('a', 'b', 'c'));
    layoutTree(root, { edges: [e('a', 'b'), e('a', 'c')] });
    const a = byId(root, 'a');
    const b = byId(root, 'b');
    const c = byId(root, 'c');
    expect(b.y).toBeGreaterThan(a.y);
    expect(c.y).toBeGreaterThan(a.y);
    expect(b.y).toBe(c.y);
    const parentK = byId(root, 'p').scale!;
    for (const n of [b, c]) {
      expect(Math.abs(n.bubble!.w / parentK - BEAN.w)).toBeLessThan(1e-9);
      expect(Math.abs(n.bubble!.h / parentK - BEAN.h)).toBeLessThan(1e-9);
    }
  });

  it('a parent with `layers` stacks its children by layer in declared order, whatever its edges; each layer gets its label band (Phase 28 LK-G)', () => {
    const root = under(leaves('a', 'b', 'c', 'd'));
    const p = byId(root, 'p');
    p.subregions = [mk('top', 'subregion'), mk('mid', 'subregion')];
    byId(root, 'a').subregion = 'mid';
    byId(root, 'c').subregion = 'top';
    byId(root, 'd').subregion = 'top';   // b: no layer, below the layers
    layoutTree(root, { edges: [e('a', 'c'), e('b', 'a')] });   // ranked by edges, b would sit on top
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => byId(root, id));
    expect(Math.max(c.y, d.y)).toBeLessThan(a.y);
    expect(a.y).toBeLessThan(b.y);
    expect(p.subregions.map((l) => l.headerH)).toEqual([FRAME_HEAD * p.scale!, FRAME_HEAD * p.scale!]);
  });

  it('fork of 3 (a->b, a->c, a->d, aspect 2.38) stays layered', () => {
    const root = under(leaves('a', 'b', 'c', 'd'));
    layoutTree(root, { edges: [e('a', 'b'), e('a', 'c'), e('a', 'd')] });
    const a = byId(root, 'a');
    for (const id of ['b', 'c', 'd']) expect(byId(root, id).y).toBeGreaterThan(a.y);
  });

  it('fork of 4 leaves under a (aspect 3.12, over the cap): grid result', () => {
    const pairs = [1, 2, 3, 4].map((to) => ({ from: 0, to, weight: 1 }));
    expect(aspectOf(5, pairs)).toBeGreaterThan(MAX_LAYER_ASPECT);
    sameAsGrid(() => under(leaves('a', 'b', 'c', 'd', 'e')), [e('a', 'b'), e('a', 'c'), e('a', 'd'), e('a', 'e')]);
  });

  it('12 isolated children plus one edge (aspect 8.3, over the cap): grid result', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    expect(aspectOf(12, [{ from: 0, to: 1, weight: 1 }])).toBeGreaterThan(MAX_LAYER_ASPECT);
    sameAsGrid(() => under(leaves(...ids)), [e('n0', 'n1')]);
  });

  it('chain of 3 (a->b->c, aspect 0.65, under the floor): grid result', () => {
    const pairs = [{ from: 0, to: 1, weight: 1 }, { from: 1, to: 2, weight: 1 }];
    expect(aspectOf(3, pairs)).toBeLessThan(MIN_LAYER_ASPECT);
    sameAsGrid(() => under(leaves('a', 'b', 'c')), [e('a', 'b'), e('b', 'c')]);
  });

  it('chain of 2 (a->b, under the floor): grid result', () => {
    expect(aspectOf(2, [{ from: 0, to: 1, weight: 1 }])).toBeLessThan(MIN_LAYER_ASPECT);
    sameAsGrid(() => under(leaves('a', 'b')), [e('a', 'b')]);
  });

  it('bean size and fit tests hold with edges (fourLevel with a layered fork in k1)', () => {
    const root = fourLevel();
    layoutTree(root, { edges: [e('k1/c0', 'k1/c1'), e('k1/c0', 'k1/c2')] });
    expect(byId(root, 'k1/c1').y).toBeGreaterThan(byId(root, 'k1/c0').y);
    const parents = parentOf(root);
    for (const n of all(root)) {
      const parentScale = parents.has(n) ? parents.get(n)!.scale! : 1;
      expect(Math.abs(n.bubble!.w / parentScale - BEAN.w)).toBeLessThan(1e-9);
      expect(Math.abs(n.bubble!.h / parentScale - BEAN.h)).toBeLessThan(1e-9);
      expect(n.bubble!.x).toBeGreaterThanOrEqual(n.x - EPS);
      expect(n.bubble!.x + n.bubble!.w).toBeLessThanOrEqual(n.x + n.w + EPS);
      expect(n.bubble!.y).toBeGreaterThanOrEqual(n.y - EPS);
      expect(n.bubble!.y + n.bubble!.h).toBeLessThanOrEqual(n.y + n.h + EPS);
    }
    for (const p of all(root)) {
      for (const c of p.children) {
        expect(c.x).toBeGreaterThanOrEqual(p.x + PAD * p.scale! - EPS);
        expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w - PAD * p.scale! + EPS);
        expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h - PAD * p.scale! + EPS);
      }
    }
  });

  // P14-I19a: parent-local = world offset divided by the parent's scale (place() puts slot.x at slot.x * K).
  const local = (n: ViewNode, p: ViewNode) => ({
    x: (n.x - p.x) / p.scale!,
    y: (n.y - p.y) / p.scale!,
    w: n.w / p.scale!,
    h: n.h / p.scale!,
  });

  it('adjacent child regions are at least 2*GAP apart (parent-local)', () => {
    const region = (id: string) => mk(id, 'container', files(id, 2));
    const root = mk('sys', 'system', [region('a'), region('b'), region('c')]);
    layoutTree(root);
    const rects = root.children.map(c => local(c, root));
    let pairs = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        if (gapY < 0) {
          pairs++;
          expect(gapX).toBeGreaterThanOrEqual(2 * GAP - EPS);
        }
        if (gapX < 0) {
          pairs++;
          expect(gapY).toBeGreaterThanOrEqual(2 * GAP - EPS);
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('a tall region is never narrower than a bean', () => {
    const root = mk('sys', 'system', [mk('a', 'container', files('a', 5)), mk('b', 'container', files('b', 5))]);
    layoutTree(root);
    const K = root.scale!;
    for (const region of root.children) {
      const r = local(region, root);
      expect(r.w).toBeGreaterThanOrEqual(BEAN.w - 1e-6);
      expect(region.bubble!.x).toBeGreaterThanOrEqual(region.x - EPS);
      expect(region.bubble!.x + region.bubble!.w).toBeLessThanOrEqual(region.x + region.w + EPS);
      expect(region.bubble!.w / K).toBeCloseTo(BEAN.w, 6);
    }
  });

  it('a childless node never becomes a region', () => {
    const root = mk('sys', 'system', [mk('leaf', 'component'), mk('solo', 'component', files('solo', 1))]);
    layoutTree(root);
    const K = root.scale!;
    const [leaf, solo] = root.children;
    expect(leaf.scale).toBe(K);
    expect(leaf.w / K).toBeCloseTo(SLOT.w, 6);
    expect(leaf.h / K).toBeCloseTo(SLOT.h, 6);
    expect(leaf.bubble!.w / K).toBeCloseTo(BEAN.w, 6);
    expect(leaf.bubble!.h / K).toBeCloseTo(BEAN.h, 6);
    expect(solo.scale!).toBeCloseTo(K * 0.4724, 3);
  });
});

// SR2 (b457): a subregion with a saved layout is a hand-placed frame. Its members that have no saved slot of their own are
// laid out in a grid inside it (frameSlots); the container grows to cover it; no scale changes (b268).
describe('hand-placed subregion frames (SR2 b457)', () => {
  type Edit = (byId: (id: string) => ViewNode) => void;
  /** sys > api (subregion logic: a, b; data: c, d) and web (w); every component holds 2 files. Laid out with saved: true. */
  const build = (edit: Edit = () => undefined, saved = true): ViewNode => {
    const comp = (id: string, subregion: string): ViewNode => ({ ...mk(id, 'component', files(id, 2)), subregion });
    const api = mk('api', 'container', [comp('a', 'logic'), comp('b', 'logic'), comp('c', 'data'), comp('d', 'data')]);
    api.subregions = [mk('logic', 'subregion'), mk('data', 'subregion')];
    const root = mk('sys', 'system', [api, mk('web', 'container', [mk('w', 'component', files('w', 2))])]);
    edit((id) => [...all(root), ...api.subregions!].find((n) => n.id === id)!);
    layoutTree(root, { saved });
    return root;
  };
  const nodes = (root: ViewNode) => [...all(root), ...all(root).flatMap((n) => n.subregions ?? [])];
  const at = (root: ViewNode, id: string) => nodes(root).find((n) => n.id === id)!;
  const rects = (root: ViewNode) => nodes(root).map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, scale: n.scale, placed: n.placed }));
  const base = build();
  const K = at(base, 'api').scale!;
  const W = at(base, 'api').w / K;   // api's local body (no saved size)
  const H = at(base, 'api').h / K;
  // The data frame: one column wide (SLOT.w + PAD), in the bottom right corner of the body, too low for 2 rows (Q4: grows).
  const frame = { x: W - (SLOT.w + PAD), y: H - 200, w: SLOT.w + PAD, h: 200 };
  const placeData: Edit = (byId) => {
    byId('data').savedLayout = { rx: frame.x + frame.w / 2 - SLOT.w / 2, ry: frame.y + frame.h / 2 - SLOT.h / 2, rw: frame.w, rh: frame.h };
  };
  const expectRect = (n: ViewNode, r: { x: number; y: number; w: number; h: number }) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(n[k]).toBeCloseTo(r[k], 9);
  };
  const inside = (o: ViewNode, f: ViewNode) => o.x >= f.x - EPS && o.x + o.w <= f.x + f.w + EPS && o.y + o.h <= f.y + f.h + EPS;

  it('the saved frame is placed at its saved rect (grown to hold 2 rows), with the container scale; the other frame stays auto', () => {
    const root = build(placeData);
    const api = at(root, 'api');
    const [logic, data] = api.subregions!;
    expect(api.scale).toBe(K);
    expect([data.placed, data.scale, data.headerH]).toEqual([true, K, FRAME_HEAD * K]);
    expectRect(data, { x: api.x + frame.x * K, y: api.y + frame.y * K, w: frame.w * K, h: (FRAME_HEAD + 2 * SLOT.h + PAD / 2) * K });
    expect([logic.placed, logic.scale, logic.x, logic.y, logic.w, logic.h]).toEqual([undefined, K, 0, 0, 0, 0]);
  });

  it('its members lie inside it, below its label band; the container covers it plus PAD', () => {
    const root = build(placeData);
    const api = at(root, 'api');
    const data = api.subregions![1];
    for (const id of ['c', 'd']) {
      const c = at(root, id);
      expect(inside(c, data)).toBe(true);
      expect(c.y).toBeGreaterThanOrEqual(data.y + FRAME_HEAD * K - EPS);
    }
    expect(api.x + api.w).toBeGreaterThanOrEqual(data.x + data.w + PAD * K - EPS);
    expect(api.y + api.h).toBeCloseTo(data.y + data.h + PAD * K, 9);   // the frame grew past the auto body
  });

  it('every scale is the one of the layout without the saved frame', () => {
    const root = build(placeData);
    expect(nodes(root).map((n) => [n.id, n.scale])).toEqual(nodes(base).map((n) => [n.id, n.scale]));
  });

  it('a member with its own saved slot keeps it; the other member alone fills the frame', () => {
    const d0 = at(base, 'd');
    const ownSlot: Edit = (byId) => {
      byId('d').savedLayout = { rx: PAD, ry: HEAD + PAD, rw: d0.w / d0.scale!, rh: d0.h / d0.scale! };   // its own size kept
    };
    const root = build((byId) => { placeData(byId); ownSlot(byId); });
    const only = build(ownSlot);
    const rel = (r: ViewNode, id: string) => {
      const n = at(r, id);
      const api = at(r, 'api');
      return [n.x - api.x, n.y - api.y, n.w, n.h];
    };
    rel(root, 'd').forEach((v, i) => expect(v).toBeCloseTo(rel(only, 'd')[i], 9));
    const data = at(root, 'api').subregions![1];
    const c = at(root, 'c');
    expect(inside(c, data)).toBe(true);
    expect(c.x + c.w / 2).toBeCloseTo(data.x + data.w / 2, 9);   // one box, centred
    expect(data.h).toBeCloseTo((FRAME_HEAD + SLOT.h + PAD / 2) * K, 9);   // one row: grown less
  });

  it('a stale frame (more than one slot outside the body) is dropped: the same layout as with none', () => {
    const root = build((byId) => { byId('data').savedLayout = { rx: W + 2 * SLOT.w, ry: HEAD, rw: 330, rh: 200 }; });
    expect(rects(root)).toEqual(rects(base));
  });

  it('no saved frame: every frame is auto (x,y,w,h 0, not placed), the rects those of the layout without saved values', () => {
    expect(rects(base)).toEqual(rects(build(undefined, false)));
    expect(at(base, 'api').subregions!.map((l) => [l.placed, l.x, l.y, l.w, l.h, l.scale])).toEqual([[undefined, 0, 0, 0, 0, K], [undefined, 0, 0, 0, 0, K]]);
  });
});
