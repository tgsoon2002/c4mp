import { layoutView } from '../src/view/layout';
import { ViewModel, ViewNode } from '../src/types';

// P-LAYOUT-1: every region is sized to fit its OWN contents (no sibling max), bubbles stay standard.

const mk = (id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode => ({
  id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});
const files = (p: string, n: number) => Array.from({ length: n }, (_, i) => mk(`${p}/f${i}`, 'file'));
const model = (root: ViewNode): ViewModel => ({
  schemaVersion: 1, title: 't', subtitle: '', summary: '', repoPath: '/x', root, edges: [], drift: null, planFindings: [], files: [],
});
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const get = (m: ViewModel, id: string) => all(m.root).find((n) => n.id === id)!;

/** system > 3 containers (0, 1, 23 components) > components holding 1 / 4 / 75 files. */
const threeLevel = (): ViewModel => {
  const sizes = [1, 4, 75];
  const comps = (p: string, n: number) =>
    Array.from({ length: n }, (_, i) => mk(`${p}/c${i}`, 'component', files(`${p}/c${i}`, sizes[i % 3])));
  return model(mk('sys', 'system', [
    mk('k0', 'container'),
    mk('k1', 'container', comps('k1', 1)),
    mk('k23', 'container', comps('k23', 23)),
  ]));
};

const overlaps = (a: ViewNode, b: ViewNode) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + 0.01 &&
  Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + 0.01;

describe('layout fits each region to its own contents', () => {
  it('siblings never overlap and every child lies inside its parent body (below head, inside pad)', () => {
    const m = layoutView(threeLevel());
    for (const p of all(m.root)) {
      for (let i = 0; i < p.children.length; i++) {
        for (let j = i + 1; j < p.children.length; j++) expect(overlaps(p.children[i], p.children[j])).toBe(false);
      }
      for (const c of p.children) {
        expect(c.x).toBeGreaterThan(p.x);
        expect(c.y).toBeGreaterThanOrEqual(p.y + p.headerH! - 0.01);
        expect(c.x + c.w).toBeLessThan(p.x + p.w);
        expect(c.y + c.h).toBeLessThan(p.y + p.h);
      }
    }
  });

  it('is deterministic: two runs give identical output', () => {
    expect(layoutView(threeLevel())).toEqual(layoutView(threeLevel()));
  });

  it('a leaf region is 300x150 and its bubble 170x64 in the parent frame (scaled by the parent scale)', () => {
    const m = layoutView(threeLevel());
    const leaf = get(m, 'k1/c0/f0');
    const p = get(m, 'k1/c0');
    expect(leaf.w / p.scale!).toBeCloseTo(300, 6);
    expect(leaf.h / p.scale!).toBeCloseTo(150, 6);
    expect(leaf.bubble!.w / p.scale!).toBeCloseTo(170, 6);
    expect(leaf.bubble!.h / p.scale!).toBeCloseTo(64, 6);
    const empty = get(m, 'k0');
    expect(empty.w / m.root.scale!).toBeCloseTo(300, 6);
    expect(empty.h / m.root.scale!).toBeCloseTo(150, 6);
    expect(empty.bubble!.w / m.root.scale!).toBeCloseTo(170, 6);
    expect(empty.bubble!.h / m.root.scale!).toBeCloseTo(64, 6);
  });

  it('every bubble is 170 in its parent frame (bean size is constant: bubble.w / parentScale === 170)', () => {
    const m = layoutView(threeLevel());
    expect(m.root.bubble!.w).toBeCloseTo(170, 6);
    for (const p of all(m.root)) {
      for (const c of p.children) expect(c.bubble!.w / p.scale!).toBeCloseTo(170, 6);
    }
  });

  it('uniform 24 leaf children are packed near aspect 1.6 (local region w/scale over h/scale)', () => {
    const m = layoutView(model(mk('s', 'system', [mk('c', 'component', files('c', 24))])));
    const c = get(m, 'c');
    const dev = Math.abs(Math.log((c.w / c.scale!) / (c.h / c.scale!) / 1.6));
    expect(dev).toBeLessThan(0.35);
  });

  it('leaf siblings are identical (in the parent frame: w/parentScale === 300, h/parentScale === 150)', () => {
    for (const p of all(layoutView(threeLevel()).root)) {
      for (const n of p.children) {
        if (n.children.length === 0) {
          expect(n.w / p.scale!).toBeCloseTo(300, 6);
          expect(n.h / p.scale!).toBeCloseTo(150, 6);
        }
      }
    }
  });

  it('a saved slot lands at its parent-local position; a slot far outside the body is dropped; ancestors do not grow', () => {
    const base = layoutView(threeLevel());
    const k0 = get(base, 'k23'), c0 = get(base, 'k23/c1');
    const m = threeLevel();
    get(m, 'k23/c1').savedLayout = { rx: 300, ry: 60, rw: 1, rh: 1 };
    layoutView(m);
    const k = get(m, 'k23'), c = get(m, 'k23/c1');
    // slot centre (parent-local) = rx + SLOT.w/2, ry + SLOT.h/2: the region is centred in its slot
    expect((c.x + c.w / 2 - k.x) / k.scale!).toBeCloseTo(300 + 150, 6);
    expect((c.y + c.h / 2 - k.y) / k.scale!).toBeCloseTo(60 + 75, 6);
    // rw,rh = 1 is below the computed size: ignored, so the ancestor keeps its unsaved size
    expect(k.w).toBe(k0.w);
    expect(k.h).toBe(k0.h);
    expect(c.w).toBe(c0.w);

    // a slot more than one slot outside the body is stale: dropped, so the component stays where it was unsaved
    const far = threeLevel();
    get(far, 'k23/c1').savedLayout = { rx: 90000, ry: 10, rw: 1, rh: 1 };
    layoutView(far);
    const f = get(far, 'k23/c1');
    expect(f.x).toBe(c0.x);
    expect(f.y).toBe(c0.y);
  });

  it('saved rw,rh below the computed size are ignored; the bubble stays standard', () => {
    const base = layoutView(threeLevel());
    const c0 = get(base, 'k23/c1');
    const m = threeLevel();
    get(m, 'k23/c1').savedLayout = { rx: 10, ry: 10, rw: 300, rh: 150 };
    layoutView(m);
    const c = get(m, 'k23/c1');
    // precondition: this 4-file component is bigger than one 300x150 slot, so 300x150 is below its size
    expect(c0.w / c0.scale!).toBeGreaterThan(300);
    expect(c.w).toBe(c0.w);
    expect(c.h).toBe(c0.h);
    const b = c.bubble!;
    const kScale = get(m, 'k23').scale!;
    expect(b.w / kScale).toBeCloseTo(170, 6);
    expect(b.h / kScale).toBeCloseTo(64, 6);
    expect(b.x).toBeGreaterThanOrEqual(c.x);
    expect(b.y).toBeGreaterThanOrEqual(c.y);
    expect(b.x + b.w).toBeLessThanOrEqual(c.x + c.w + 0.01);
    expect(b.y + b.h).toBeLessThanOrEqual(c.y + c.h + 0.01);
  });

  it('deterministic with a saved layout', () => {
    const run = () => {
      const m = threeLevel();
      get(m, 'k23/c1').savedLayout = { rx: 300, ry: 60, rw: 300, rh: 150 };
      return layoutView(m);
    };
    expect(run()).toEqual(run());
  });
});
