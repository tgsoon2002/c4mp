import { layoutTree } from '../src/view/layoutTree';
import { BEAN, HEAD, SLOT } from '../src/view/arrange';
import { ViewNode } from '../src/types';
import { buildView } from '../src/page/html';

// P14-I5a: saved overrides (bean slot, region extra room) and the stale guard, applied only with { saved: true }.
// Saved values are parent-local units. Helpers copied from layout-fit.test.ts.

type Saved = NonNullable<ViewNode['savedLayout']>;

const mk = (id: string, children: ViewNode[] = [], savedLayout?: Saved): ViewNode => ({
  id,
  kind: children.length > 0 ? 'container' : 'component',
  name: id,
  detail: '',
  weight: 1,
  children,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  callsAvailable: false,
  ...(savedLayout ? { savedLayout } : {}),
});
const leaves = (p: string, n: number): ViewNode[] => Array.from({ length: n }, (_, i) => mk(`${p}/l${i}`));
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const get = (root: ViewNode, id: string): ViewNode => all(root).find((n) => n.id === id)!;

/** sys > c0, c1 (carries c1 saved), a (4 leaves, carries a saved), c2. */
const scene = (c1?: Saved, a?: Saved): ViewNode =>
  mk('sys', [mk('c0'), mk('c1', [], c1), mk('a', leaves('a', 4), a), mk('c2')]);

const geom = (root: ViewNode) =>
  all(root).map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, bubble: n.bubble, headerH: n.headerH, scale: n.scale }));

// Bean top-left that puts the slot top-left at (sx, sy): slot centre = bean centre.
const beanFor = (sx: number, sy: number) => ({ bx: sx + (SLOT.w - BEAN.w) / 2, by: sy + (SLOT.h - BEAN.h) / 2 });

// b268: the saved slot top-left (rx,ry, parent-local) that puts a child exactly where the plain layout put it.
const slotOf = (root: ViewNode, n: ViewNode) => ({
  rx: (n.x + n.w / 2 - root.x) / root.scale! - SLOT.w / 2,
  ry: (n.y + n.h / 2 - root.y) / root.scale! - SLOT.h / 2,
});

describe('layoutTree saved overrides (P14-I5a)', () => {
  it('(a) a saved bean moves its own slot and nothing else', () => {
    const base = scene();
    layoutTree(base);
    const moved = scene({ ...beanFor(0, 44), rx: 0, ry: 0, rw: 300, rh: 150 });
    layoutTree(moved, { saved: true });

    for (const id of ['c0', 'a', 'c2']) {
      const b = get(base, id);
      const m = get(moved, id);
      expect({ x: m.x, y: m.y, w: m.w, h: m.h }).toEqual({ x: b.x, y: b.y, w: b.w, h: b.h });
    }
    expect(moved.w).toBe(base.w);
    expect(moved.h).toBe(base.h);

    const c1 = get(moved, 'c1');
    const c1Base = get(base, 'c1');
    expect(c1.x !== c1Base.x || c1.y !== c1Base.y).toBe(true);
    expect(c1.bubbleMoved).toBe(true);
    expect(get(moved, 'c0').bubbleMoved).toBeUndefined();
  });

  it('(b) a bigger saved rw,rh grows only w,h: scale, positions and top-left stay (b268)', () => {
    const base = scene();
    layoutTree(base);
    const a0 = get(base, 'a');
    const r0w = a0.w / a0.scale!;
    const r0h = a0.h / a0.scale!;

    const grown = scene(undefined, { ...slotOf(base, a0), rw: r0w * 1.5, rh: r0h * 1.5 });
    layoutTree(grown, { saved: true });
    const a = get(grown, 'a');
    expect(a.w / a.scale!).toBeCloseTo(r0w * 1.5, 6);
    expect(a.h / a.scale!).toBeCloseTo(r0h * 1.5, 6);
    expect(a.scale!).toBeCloseTo(a0.scale!, 9); // b268 G2: k from the auto size (was: smaller scale)
    expect(a.x + a.w / 2).toBeCloseTo(a0.x + a0.w / 2, 6); // b268: the slot centre stays (the export writes rx,ry from the centre)
    expect(a.y + a.h / 2).toBeCloseTo(a0.y + a0.h / 2, 6);
    for (const l of a.children) {
      const l0 = get(base, l.id);
      expect(l.x - a.x).toBeCloseTo(l0.x - a0.x, 6); // positions inside the region unchanged
      expect(l.y - a.y).toBeCloseTo(l0.y - a0.y, 6);
      expect(l.w).toBeCloseTo(l0.w, 6);
    }
  });

  it('(b2) a saved size below the auto size is honoured down to the floor; below the floor it clamps and logs (b268)', () => {
    const base = scene();
    layoutTree(base);
    const a0 = get(base, 'a');
    const r0w = a0.w / a0.scale!;
    const r0h = a0.h / a0.scale!;
    // All four leaves sit in the top-left slot (a saved slot each), so the floor falls below the auto size.
    const mkA = (sv: Saved): ViewNode => {
      const lv = leaves('a', 4);
      for (const l of lv) l.savedLayout ={ rx: 0, ry: HEAD, rw: SLOT.w, rh: SLOT.h };
      return mk('sys', [mk('c0'), mk('c1'), mk('a', lv, sv), mk('c2')]);
    };
    const prev = process.env.C4PM_DEBUG;
    process.env.C4PM_DEBUG = 'layout';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let floorW: number;
    let floorH: number;
    try {
      const probe = mkA({ rx: 0, ry: 0, rw: 1, rh: 1 });
      layoutTree(probe, { saved: true });
      const pa = get(probe, 'a');
      floorW = pa.w / pa.scale!;
      floorH = pa.h / pa.scale!;
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('clamped to floor'));
      expect(lines).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.C4PM_DEBUG;
      else process.env.C4PM_DEBUG = prev;
    }
    expect(floorW).toBeLessThan(r0w);
    expect(floorH).toBeLessThan(r0h);
    const mid = mkA({ rx: 0, ry: 0, rw: (floorW + r0w) / 2, rh: (floorH + r0h) / 2 });
    layoutTree(mid, { saved: true });
    const am = get(mid, 'a');
    expect(am.w / am.scale!).toBeCloseTo((floorW + r0w) / 2, 6);
    expect(am.h / am.scale!).toBeCloseTo((floorH + r0h) / 2, 6);
    expect(am.scale!).toBeCloseTo(a0.scale!, 9);
  });

  it('(b3) a saved size equal to the auto size reproduces the plain layout (b268)', () => {
    const base = scene();
    layoutTree(base);
    const a0 = get(base, 'a');
    const same = scene(undefined, { ...slotOf(base, a0), rw: a0.w / a0.scale!, rh: a0.h / a0.scale! });
    layoutTree(same, { saved: true });
    for (const n of all(base)) {
      const m = get(same, n.id);
      for (const f of ['x', 'y', 'w', 'h'] as const) expect(m[f]).toBeCloseTo(n[f], 6);
    }
  });

  it('(c) stale slots are dropped (not applied) and counted in one stale-layout log line', () => {
    const base = scene();
    layoutTree(base);

    const prev = process.env.C4PM_DEBUG;
    process.env.C4PM_DEBUG = 'layout';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const stale = scene(
        { bx: 100000, by: 0, rx: 0, ry: 0, rw: 300, rh: 150 }, // bean far outside the parent body
        { rx: 0, ry: 0, rw: 999999, rh: 999999 }, // far more than 6x the computed size: honoured, not stale (b268)
      );
      layoutTree(stale, { saved: true });

      expect(get(stale, 'c1').x).toBe(get(base, 'c1').x);
      expect(get(stale, 'c1').y).toBe(get(base, 'c1').y);
      expect(get(stale, 'c1').bubbleMoved).toBeUndefined();
      expect(get(stale, 'a').w / get(stale, 'a').scale!).toBeCloseTo(999999, 3);
      expect(get(stale, 'a').h / get(stale, 'a').scale!).toBeCloseTo(999999, 3);

      const lines = spy.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('[layout] stale-layout'));
      expect(lines).toHaveLength(1);
      const data = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
      expect(data.count).toBe(1); // only the bean slot is stale; a huge region size is not
      expect(data.ids).toEqual(['c1']);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.C4PM_DEBUG;
      else process.env.C4PM_DEBUG = prev;
    }
  });

  it('(d) is deterministic: two runs with saved overrides give identical output', () => {
    const make = () => scene({ ...beanFor(0, 44), rx: 0, ry: 0, rw: 300, rh: 150 }, { rx: 0, ry: 0, rw: 900, rh: 500 });
    const one = make();
    const two = make();
    layoutTree(one, { saved: true });
    layoutTree(two, { saved: true });
    expect(geom(one)).toEqual(geom(two));
  });

  it('(e) without saved, output equals the plain layout even when the tree carries savedLayout', () => {
    const plain = scene();
    layoutTree(plain);
    const carrying = scene({ ...beanFor(0, 44), rx: 0, ry: 0, rw: 300, rh: 150 }, { rx: 0, ry: 0, rw: 900, rh: 500 });
    layoutTree(carrying);
    expect(geom(carrying)).toEqual(geom(plain));

    const explicitOff = scene({ ...beanFor(0, 44), rx: 0, ry: 0, rw: 300, rh: 150 });
    layoutTree(explicitOff, { saved: false });
    expect(geom(explicitOff)).toEqual(geom(plain));
  });
});

// P14-I5c: replay the saved layouts of the real LTS copy (report). Skipped unless C4PM_LTS_COPY is set.
const LTS_COPY = process.env.C4PM_LTS_COPY;
const ltsDescribe = LTS_COPY ? describe : describe.skip;

ltsDescribe('LTS replay (P14-I5c)', () => {
  it('LTS replay', () => {
    const prev = process.env.C4PM_DEBUG;
    process.env.C4PM_DEBUG = 'layout';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let run: { model: ReturnType<typeof buildView>['model']; lines: string[] };
    try {
      const { model } = buildView({ repo: LTS_COPY! });
      run = { model, lines: spy.mock.calls.map((c) => String(c[0])) };
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.C4PM_DEBUG;
      else process.env.C4PM_DEBUG = prev;
    }
    const { model, lines } = run;

    // Stale ids come from the single stale-layout log line (one per layoutTree call).
    const staleLine = lines.find((s) => s.startsWith('[layout] stale-layout'));
    const droppedIds = new Set<string>(
      staleLine ? JSON.parse(staleLine.slice(staleLine.indexOf('{'))).ids : [],
    );

    const withSaved = all(model.root).filter((n) => n.savedLayout);
    const rows = withSaved.map((n) => {
      const status = n === model.root ? 'ignored (root)' : droppedIds.has(n.id) ? 'DROPPED (stale)' : 'applied';
      return `${n.id.padEnd(60)} ${status}`;
    });
    const dropped = withSaved.filter((n) => n !== model.root && droppedIds.has(n.id)).length;
    const applied = withSaved.filter((n) => n !== model.root && !droppedIds.has(n.id)).length;
    console.log(
      [`saved layouts: ${withSaved.length} (applied ${applied}, dropped ${dropped}, root ignored ${withSaved.length - applied - dropped})`, ...rows].join('\n'),
    );

    // Nothing may sit outside its parent body (child region inside parent region; 1e-6 float slack).
    const EPS = 1e-6;
    const outside: string[] = [];
    for (const p of all(model.root)) {
      for (const c of p.children) {
        if (c.x < p.x - EPS || c.y < p.y - EPS || c.x + c.w > p.x + p.w + EPS || c.y + c.h > p.y + p.h + EPS) {
          outside.push(`${c.id} in ${p.id}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });
});
