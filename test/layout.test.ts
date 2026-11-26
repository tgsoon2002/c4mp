import path from 'path';
import { layoutView, applySavedLayout, localLayoutOf, Rect } from '../src/view/layout';
import { layoutTree } from '../src/view/layoutTree';
import { BEAN, SLOT, GAP } from '../src/view/arrange';
import { ViewModel, ViewNode } from '../src/types';
import { runSnapshot } from '../src/index';
import { buildViewModel } from '../src/view/model';

describe('layoutView', () => {
  // Hand-built ViewModel based on sample fixture
  function buildSampleModel(): ViewModel {
    const orderServiceCreateFunc: ViewNode = {
      id: 'api/src/services/orderService.ts#OrderService.create',
      kind: 'function',
      name: 'create',
      detail: 'function · 7 lines',
      weight: 7,
      children: [],
      x: 0, y: 0, w: 0, h: 0,
      file: 'api/src/services/orderService.ts',
      line: 6,
      callsAvailable: false
    };

    const orderServiceFindFunc: ViewNode = {
      id: 'api/src/services/orderService.ts#OrderService.find',
      kind: 'method',
      name: 'find',
      detail: 'method · 3 lines',
      weight: 3,
      children: [],
      x: 0, y: 0, w: 0, h: 0,
      file: 'api/src/services/orderService.ts',
      line: 14,
      callsAvailable: false
    };

    const orderServiceConstructor: ViewNode = {
      id: 'api/src/services/orderService.ts#OrderService.constructor',
      kind: 'method',
      name: 'constructor',
      detail: 'method · 1 lines',
      weight: 1,
      children: [],
      x: 0, y: 0, w: 0, h: 0,
      file: 'api/src/services/orderService.ts',
      line: 4,
      callsAvailable: false
    };

    const orderServiceClass: ViewNode = {
      id: 'api/src/services/orderService.ts#OrderService',
      kind: 'class',
      name: 'OrderService',
      detail: 'class · 15 lines',
      weight: 15,
      children: [orderServiceCreateFunc, orderServiceFindFunc, orderServiceConstructor],
      x: 0, y: 0, w: 0, h: 0,
      file: 'api/src/services/orderService.ts',
      line: 3,
      callsAvailable: false
    };

    const orderServiceFile: ViewNode = {
      id: 'api/src/services/orderService.ts',
      kind: 'file',
      name: 'orderService.ts',
      detail: '17 lines',
      weight: 17,
      children: [orderServiceClass],
      x: 0, y: 0, w: 0, h: 0,
      file: 'api/src/services/orderService.ts',
      callsAvailable: false
    };

    const apiServicesComponent: ViewNode = {
      id: 'api/services',
      kind: 'component',
      name: 'services',
      detail: 'api/src/services',
      weight: 17,
      children: [orderServiceFile],
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false
    };

    const apiRoutesComponent: ViewNode = {
      id: 'api/routes',
      kind: 'component',
      name: 'routes',
      detail: 'api/src/routes',
      weight: 10,
      children: [],
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false
    };

    const apiContainer: ViewNode = {
      id: 'api',
      kind: 'container',
      name: 'Api',
      detail: 'Node.js / TypeScript',
      weight: 50,
      children: [apiServicesComponent, apiRoutesComponent],
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false
    };

    const root: ViewNode = {
      id: 'system',
      kind: 'system',
      name: 'sample-shop',
      detail: 'sample',
      weight: 70,
      children: [apiContainer],
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false
    };

    const model: ViewModel = {
      schemaVersion: 1,
      title: 'sample-shop',
      subtitle: 'no git · 2026-09-30',
      summary: 'sample-shop — 1 container',
      repoPath: '/path/to/repo',
      root,
      edges: [],
      drift: null,
      planFindings: [],
      files: []
    };

    return model;
  }

  // map.js drawHeader skips the header when its pixel height < ~13.3; a region fit to a ~700px
  // viewport at 85-90% gives a ratio of ~0.02 at that threshold.
  const MIN_HEADER_RATIO = 0.02;

  /** A node with defaults, for hand-built trees. */
  function mk(id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode {
    return { id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false };
  }

  /** system > container > 2 components, each holding one slice: one with 1 function, one with n. */
  function buildUnevenModel(n: number): ViewModel {
    const fns = (p: string, count: number) =>
      Array.from({ length: count }, (_, i) => mk(`${p}-f${i}`, 'function'));
    const small = mk('small', 'component', [mk('small-slice', 'slice', fns('s', 1))]);
    const big = mk('big', 'component', [mk('big-slice', 'slice', fns('b', n))]);
    const root = mk('system', 'system', [mk('c', 'container', [small, big])]);
    return { ...buildSampleModel(), root };
  }

  it('root is positioned at the origin with a real, positive size', () => {
    const model = layoutView(buildSampleModel());
    expect(model.root.x).toBe(0);
    expect(model.root.y).toBe(0);
    expect(model.root.w).toBeGreaterThan(0);
    expect(model.root.h).toBeGreaterThan(0);
  });

  it('every leaf is 300x150 in its parent frame (P-LAYOUT-1: siblings are sized individually, not uniformly)', () => {
    const model = layoutView(buildSampleModel());
    const check = (p: ViewNode) => {
      for (const c of p.children) {
        if (c.children.length === 0) {
          expect(c.w / p.scale!).toBeCloseTo(300, 6);
          expect(c.h / p.scale!).toBeCloseTo(150, 6);
        }
        check(c);
      }
    };
    check(model.root);
  });

  it('an empty component is a leaf slot with the 170x64 bubble; a component with files is as wide as an empty slot minus 2*GAP; a function in a leaf slot gets 170x64 (all in the parent frame)', () => {
    const fn = mk('f', 'function');
    const file = mk('file', 'file', [fn, mk('g', 'function')]);
    const full = mk('full', 'component', [file, mk('file2', 'file', [mk('h', 'function')])]);
    const empty = mk('empty', 'component');
    const full2 = mk('full2', 'component', [mk('file3', 'file', [mk('i', 'function')])]);
    const c = mk('c', 'container', [full, empty, full2]);
    const root = mk('system', 'system', [c]);
    layoutView({ ...buildSampleModel(), root });
    expect(empty.w / c.scale!).toBeCloseTo(300, 6);
    expect(empty.h / c.scale!).toBeCloseTo(150, 6);
    expect(empty.bubble!.w / c.scale!).toBeCloseTo(170, 6);
    expect(empty.bubble!.h / c.scale!).toBeCloseTo(64, 6);
    // I19b: a region keeps GAP on each side of its slot (was: expect(full.w).toBeCloseTo(empty.w, 6))
    expect(full.w / c.scale!).toBeCloseTo(SLOT.w - 2 * GAP, 6);
    expect(full.bubble!.w / c.scale!).toBeCloseTo(170, 6);
    expect(full2.bubble!.w / c.scale!).toBeCloseTo(170, 6);
    expect(fn.w / file.scale!).toBeCloseTo(300, 6);
    expect(fn.h / file.scale!).toBeCloseTo(150, 6);
    expect(fn.bubble!.w / file.scale!).toBeCloseTo(170, 6);
    expect(fn.bubble!.h / file.scale!).toBeCloseTo(64, 6);
  });

  it('headerH / region height >= 0.02 for every non-leaf node (1-function slice next to 50-function slice)', () => {
    const ratios: number[] = [];
    const check = (n: ViewNode) => {
      if (n.children.length > 0) {
        expect(n.headerH! / n.h).toBeGreaterThanOrEqual(MIN_HEADER_RATIO);
        ratios.push(n.headerH! / n.h);
      }
      n.children.forEach(check);
    };
    check(layoutView(buildUnevenModel(50)).root);
    expect(ratios.length).toBe(6); // system, container, 2 components, 2 slices
  });

  it("each level's box is bigger than the level nested inside it", () => {
    // Tree shape here: system > container > component > file > class > method/function
    const model = layoutView(buildSampleModel());
    const system = model.root;
    const container = system.children[0];
    const component = container.children.find(c => c.id === 'api/services')!;
    const file = component.children[0];
    const cls = file.children[0];
    const method = cls.children[0];

    const area = (n: ViewNode) => n.w * n.h;
    expect(area(system)).toBeGreaterThan(area(container));
    expect(area(container)).toBeGreaterThan(area(component));
    expect(area(component)).toBeGreaterThan(area(file));
    expect(area(file)).toBeGreaterThan(area(cls));
    expect(area(cls)).toBeGreaterThan(area(method));
  });

  it("every child box fits entirely inside its parent's inner area (below the header band)", () => {
    const model = layoutView(buildSampleModel());

    function checkNode(node: ViewNode) {
      if (node.children.length === 0) return;
      expect(node.headerH).toBeDefined();
      const innerTop = node.y + (node.headerH || 0);

      for (const child of node.children) {
        expect(child.x).toBeGreaterThanOrEqual(node.x - 0.01);
        expect(child.y).toBeGreaterThanOrEqual(innerTop - 0.01);
        expect(child.x + child.w).toBeLessThanOrEqual(node.x + node.w + 0.01);
        expect(child.y + child.h).toBeLessThanOrEqual(node.y + node.h + 0.01);
        checkNode(child);
      }
    }

    checkNode(model.root);
  });

  it('siblings do not overlap', () => {
    const model = layoutView(buildSampleModel());

    function intersects(a: Rect, b: Rect): boolean {
      const left = Math.max(a.x, b.x);
      const right = Math.min(a.x + a.w, b.x + b.w);
      const top = Math.max(a.y, b.y);
      const bottom = Math.min(a.y + a.h, b.y + b.h);
      return right > left + 0.01 && bottom > top + 0.01;
    }

    function checkNode(node: ViewNode) {
      for (let i = 0; i < node.children.length; i++) {
        for (let j = i + 1; j < node.children.length; j++) {
          expect(intersects(node.children[i], node.children[j])).toBe(false);
        }
      }
      for (const c of node.children) checkNode(c);
    }

    checkNode(model.root);
  });

  it('no NaN/negative/zero sizes on a real model built from the sample fixture', () => {
    const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
    const model = layoutView(buildViewModel(snapshot, 'sample summary'));

    function checkNode(node: ViewNode) {
      for (const v of [node.x, node.y, node.w, node.h]) {
        expect(Number.isNaN(v)).toBe(false);
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(node.w).toBeGreaterThan(0);
      expect(node.h).toBeGreaterThan(0);
      if (node.children.length > 0) {
        expect(node.headerH).toBeGreaterThan(0);
      }
      for (const c of node.children) checkNode(c);
    }

    checkNode(model.root);
  });

  it('headerH / region height >= 0.02 for every non-leaf node on the sample fixture', () => {
    const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
    const check = (n: ViewNode) => {
      if (n.children.length > 0) expect(n.headerH! / n.h).toBeGreaterThanOrEqual(MIN_HEADER_RATIO);
      n.children.forEach(check);
    };
    check(layoutView(buildViewModel(snapshot, 'sample summary')).root);
  });

  describe('region + bubble geometry', () => {
    const realModel = () => {
      const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
      return layoutView(buildViewModel(snapshot, 'sample summary'));
    };
    const all = (root: ViewNode): ViewNode[] => [root, ...root.children.flatMap(all)];

    it.each([
      ['hand-built', () => layoutView(buildSampleModel())],
      ['sample fixture', realModel],
    ])('every node has a finite bubble inside its own region (%s)', (_name, build) => {
      for (const n of all(build().root)) {
        const b = n.bubble!;
        expect(b).toBeDefined();
        for (const v of [b.x, b.y, b.w, b.h]) expect(Number.isFinite(v)).toBe(true);
        expect(b.w).toBeGreaterThan(0);
        expect(b.h).toBeGreaterThan(0);
        expect(b.x).toBeGreaterThanOrEqual(n.x - 0.01);
        expect(b.y).toBeGreaterThanOrEqual(n.y - 0.01);
        expect(b.x + b.w).toBeLessThanOrEqual(n.x + n.w + 0.01);
        expect(b.y + b.h).toBeLessThanOrEqual(n.y + n.h + 0.01);
      }
    });

    it('every bubble is 170x64 in its parent frame (BEAN*Kp) and centred in its region', () => {
      const root = realModel().root;
      expect(root.bubble!.w).toBeCloseTo(170, 6);
      expect(root.bubble!.h).toBeCloseTo(64, 6);
      for (const p of all(root)) {
        for (const n of p.children) {
          expect(n.bubble!.w / p.scale!).toBeCloseTo(170, 6);
          expect(n.bubble!.h / p.scale!).toBeCloseTo(64, 6);
        }
      }
      for (const n of all(root)) {
        const b = n.bubble!;
        expect(b.x + b.w / 2).toBeCloseTo(n.x + n.w / 2, 6);
        expect(b.y + b.h / 2).toBeCloseTo(n.y + n.h / 2, 6);
      }
    });

    it('sibling bubbles are at least one bubble-width apart (the "big gaps" rule)', () => {
      // Separation along the axis that separates the pair must be >= 0.4 * BEAN.w * Kp (Kp = parent
      // scale; the slot gap 300 - 170 = 130 is 0.76 bean widths). Separating axis from the REGION rects.
      let pairs = 0;
      for (const p of all(realModel().root)) {
        for (let i = 0; i < p.children.length; i++) {
          for (let j = i + 1; j < p.children.length; j++) {
            const a = p.children[i].bubble!;
            const b = p.children[j].bubble!;
            const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
            const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
            // Decide the separating axis from the REGION rects: regions overlapping in y are
            // row-mates (check dx); overlapping in x are column-mates (check dy); else one axis.
            const ra = p.children[i], rb = p.children[j];
            const yOverlap = Math.min(ra.y + ra.h, rb.y + rb.h) > Math.max(ra.y, rb.y) + 0.01;
            const xOverlap = Math.min(ra.x + ra.w, rb.x + rb.w) > Math.max(ra.x, rb.x) + 0.01;
            const gap = 0.4 * 170 * p.scale!;
            if (yOverlap) expect(dx).toBeGreaterThanOrEqual(gap - 0.01);
            else if (xOverlap) expect(dy).toBeGreaterThanOrEqual(gap - 0.01);
            else expect(dx >= gap - 0.01 || dy >= gap - 0.01).toBe(true);
            pairs++;
          }
        }
      }
      expect(pairs).toBeGreaterThan(0);
    });

    it('children sit below headerH and inside the region body', () => {
      for (const p of all(realModel().root)) {
        if (p.children.length === 0) continue;
        for (const c of p.children) expect(c.y).toBeGreaterThanOrEqual(p.y + p.headerH! - 0.01);
      }
    });

    it('child grid is centred horizontally in the region', () => {
      for (const p of all(realModel().root)) {
        if (p.children.length === 0) continue;
        const left = Math.min(...p.children.map((c) => c.x)) - p.x;
        const right = p.x + p.w - Math.max(...p.children.map((c) => c.x + c.w));
        // Mixed-kind children can be narrower than their cell, so only assert when sizes are uniform.
        if (new Set(p.children.map((c) => c.w)).size === 1) expect(left).toBeCloseTo(right, 6);
      }
    });
  });
});

describe('applySavedLayout (P10-T3)', () => {
  const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
  const leaf = (id: string, name = id): ViewNode => ({
    id, kind: 'function', name, detail: '', weight: 1, children: [], x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
  });
  const branch = (id: string, kind: ViewNode['kind'], children: ViewNode[]): ViewNode => ({
    id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
  });
  // system > container c > components a (2 leaves), b (1 leaf), d (1 leaf)
  const build = (): ViewModel => {
    const root = branch('sys', 'system', [
      branch('c', 'container', [
        branch('a', 'component', [leaf('a1'), leaf('a2')]),
        branch('b', 'component', [leaf('b1')]),
        branch('d', 'component', [leaf('d1')]),
      ]),
    ]);
    return {
      schemaVersion: 1, title: 't', subtitle: '', summary: '', repoPath: '/x', root, edges: [], drift: null, planFindings: [], files: [],
    };
  };
  const get = (m: ViewModel, id: string) => all(m.root).find((n) => n.id === id)!;
  const rect = (n: ViewNode) => [n.x, n.y, n.w, n.h];
  // float tolerance: region/bubble centres are derived (halves of scaled sums); diffs seen are ~1e-13
  const centred = (n: ViewNode) =>
    Math.abs(n.bubble!.x + n.bubble!.w / 2 - (n.x + n.w / 2)) < 1e-6 &&
    Math.abs(n.bubble!.y + n.bubble!.h / 2 - (n.y + n.h / 2)) < 1e-6;

  // P14-I5b: replaces 'a component lands at the saved offset/size, its children move with it, siblings are unchanged'
  // (saved values are now parent-local: the slot lands at rx,ry; rw,rh grow the region in its own local units).
  it('a component lands at its saved slot (parent-local rx,ry); rw,rh grow its region; its children move with it; siblings are unchanged', () => {
    const base = layoutView(build());
    const m2 = build();
    const a0 = get(base, 'a');
    const r0w = a0.w / a0.scale!;
    const r0h = a0.h / a0.scale!;
    get(m2, 'a').savedLayout = { rx: 60, ry: 60, rw: r0w + 100, rh: r0h + 100 };
    layoutView(m2);
    const c2 = get(m2, 'c'), a = get(m2, 'a');
    // b268: the region stays centred in its slot at any saved size, so its centre sits at rx + SLOT.w/2, ry + SLOT.h/2 (parent-local)
    expect((a.x + a.w / 2 - c2.x) / c2.scale!).toBeCloseTo(60 + SLOT.w / 2, 6);
    expect((a.y + a.h / 2 - c2.y) / c2.scale!).toBeCloseTo(60 + SLOT.h / 2, 6);
    // rw,rh grow the region in its own local units
    expect(a.w / a.scale!).toBeCloseTo(r0w + 100, 6);
    expect(a.h / a.scale!).toBeCloseTo(r0h + 100, 6);
    // b268 G1: children keep their slots inside the region (no shift by half the extra)
    for (const id of ['a1', 'a2']) {
      expect((get(m2, id).x - a.x) / a.scale! - (get(base, id).x - a0.x) / a0.scale!).toBeCloseTo(0, 6);
    }
    expect(rect(get(m2, 'b'))).toEqual(rect(get(base, 'b')));
    expect(rect(get(m2, 'b1'))).toEqual(rect(get(base, 'b1')));
    expect(centred(a)).toBe(true);
    expect(a.bubbleMoved).toBeUndefined();
  });

  // P14-I5b: replaces 'bx,by given: bubble placed relative to the parent and flagged bubbleMoved; empty: stays centred'.
  // bx,by move the SLOT so the bean centre lands at parent-local (bx + BEAN.w/2, by + BEAN.h/2); rx,ry are ignored then.
  it('bx,by given: bean centre lands at the saved point (parent-local) and is flagged bubbleMoved; a slot-only save stays centred', () => {
    const BX = 340, BY = 200; // inside the component body (no clamp): slot y = BY - (SLOT.h - BEAN.h)/2 must stay in [HEAD, H - SLOT.h]
    const base = layoutView(build());
    const b0 = get(base, 'b');
    const m = build();
    get(m, 'b').savedLayout = { bx: BX, by: BY, rx: 0, ry: 0, rw: b0.w / b0.scale!, rh: b0.h / b0.scale! };
    get(m, 'd').savedLayout = { rx: 60, ry: 60, rw: 1, rh: 1 };
    layoutView(m);
    const c = get(m, 'c'), b = get(m, 'b'), d = get(m, 'd');
    expect((b.bubble!.x + b.bubble!.w / 2 - c.x) / c.scale!).toBeCloseTo(BX + BEAN.w / 2, 6);
    expect((b.bubble!.y + b.bubble!.h / 2 - c.y) / c.scale!).toBeCloseTo(BY + BEAN.h / 2, 6);
    expect(b.bubbleMoved).toBe(true);
    expect(centred(d)).toBe(true);
    expect(d.bubbleMoved).toBeUndefined();
  });

  // P14-I5b: replaces 'a container saved layout moves its components with it' (moving a container moves its subtree).
  it('a container saved layout moves its subtree; its children keep their slots (parent-local offsets unchanged)', () => {
    const base = layoutView(build());
    const m = build();
    const c0 = get(base, 'c');
    get(m, 'c').savedLayout = { rx: 60, ry: 60, rw: c0.w / c0.scale!, rh: c0.h / c0.scale! };
    layoutView(m);
    const c = get(m, 'c'), sys = get(m, 'sys');
    expect((c.x + c.w / 2 - sys.x) / sys.scale!).toBeCloseTo(60 + SLOT.w / 2, 6);
    expect((c.y + c.h / 2 - sys.y) / sys.scale!).toBeCloseTo(60 + SLOT.h / 2, 6);
    for (const id of ['a', 'b', 'd', 'a1', 'b1']) {
      expect((get(m, id).x - c.x) / c.scale!).toBeCloseTo((get(base, id).x - c0.x) / c0.scale!, 6);
      expect((get(m, id).y - c.y) / c.scale!).toBeCloseTo((get(base, id).y - c0.y) / c0.scale!, 6);
      expect((get(m, id).bubble!.x - c.x) / c.scale!).toBeCloseTo((get(base, id).bubble!.x - c0.x) / c0.scale!, 6);
    }
  });

  // P14-I5b: replaces 'a parent grows (never shrinks) to contain a component moved outside it'.
  // A slot one slot outside the body is clamped inside (x in [0, W - SLOT.w]); the parent does not grow.
  it('a slot one slot outside the body is clamped inside it; the parent does not grow', () => {
    const base = layoutView(build());
    const c0 = get(base, 'c'), b0 = get(base, 'b'), sys0 = get(base, 'sys');
    const W = c0.w / c0.scale!;
    const m = build();
    get(m, 'b').savedLayout = { rx: W + SLOT.w / 2, ry: 10, rw: b0.w / b0.scale!, rh: b0.h / b0.scale! };
    layoutView(m);
    const c = get(m, 'c'), b = get(m, 'b'), sys = get(m, 'sys');
    // clamped slot x = W - SLOT.w, so its centre is at W - SLOT.w/2 (parent-local)
    expect((b.x + b.w / 2 - c.x) / c.scale!).toBeCloseTo(W - SLOT.w / 2, 6);
    expect(b.x + b.w).toBeLessThanOrEqual(c.x + c.w + 1e-9);
    expect(c.w).toBe(c0.w);
    expect(c.h).toBe(c0.h);
    expect(sys.w).toBe(sys0.w);
  });

  // P14-I5b: replaces 'a saved size below the content minimum is raised to it'.
  it('saved rw,rh below the computed size are ignored (region size unchanged); the bubble stays standard', () => {
    const base = layoutView(build());
    const a0 = get(base, 'a');
    const m = build();
    get(m, 'a').savedLayout = { rx: 0, ry: 0, rw: 10, rh: 10 };
    layoutView(m);
    const a = get(m, 'a');
    expect(a.w).toBe(a0.w);
    expect(a.h).toBe(a0.h);
    expect(a.bubble!.w / get(m, 'c').scale!).toBeCloseTo(BEAN.w, 6);
    for (const ch of a.children) {
      expect(a.x + a.w).toBeGreaterThanOrEqual(ch.x + ch.w);
      expect(a.y + a.h).toBeGreaterThanOrEqual(ch.y + ch.h);
    }
  });

  it('is a no-op without savedLayout (and does not throw)', () => {
    const base = layoutView(build());
    const m = build();
    expect(() => applySavedLayout(layoutView(m).root)).not.toThrow();
    for (const n of all(m.root)) expect(rect(n)).toEqual(rect(get(base, n.id)));
  });
});

// SR3 (b693): with some saved layout, layoutView records each box's auto rect (a pass without the saved layout) as
// `autoLayout`, parent-local and not rounded, on the boxes the saved layout moved or resized only.
describe('autoLayout (SR3 b693)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const E = require('../viewer/edit.js');
  const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
  const branch = (id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode => ({
    id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
  });
  // system > containers c (components a, b, d with one function each), e (component f)
  const build = (): ViewModel => ({
    schemaVersion: 1, title: 't', subtitle: '', summary: '', repoPath: '/x', edges: [], drift: null, planFindings: [], files: [],
    root: branch('sys', 'system', [
      branch('c', 'container', ['a', 'b', 'd'].map((k) => branch(k, 'component', [branch(`${k}1`, 'function')]))),
      branch('e', 'container', [branch('f', 'component')]),
    ]),
  });
  const get = (m: ViewModel, id: string) => all(m.root).find((n) => n.id === id)!;
  const parentOf = (m: ViewModel, id: string) => all(m.root).find((p) => p.children.some((k) => k.id === id))!;
  const rect = (n: ViewNode) => [n.x, n.y, n.w, n.h];

  it('none without saved layout: one pass, every rect as layoutTree alone gives', () => {
    const m = layoutView(build());
    expect(all(m.root).filter((n) => n.autoLayout)).toEqual([]);
    const plain = build();
    layoutTree(plain.root, { saved: true, edges: plain.edges });
    expect(all(m.root).map(rect)).toEqual(all(plain.root).map(rect));
  });

  it('only on the boxes away from auto; fromLocal(autoLayout) in the parent gives the rect of the build without saved layout', () => {
    const base = layoutView(build());
    const c0 = get(base, 'c');
    const m = build();
    get(m, 'a').savedLayout = { rx: 60, ry: 300, rw: 360, rh: 254 };   // moved
    get(m, 'c').savedLayout = { rx: 30, ry: 74, rw: c0.w / c0.scale! + 120, rh: c0.h / c0.scale! };   // resized (it stays centred: it moves)
    layoutView(m);
    expect(all(m.root).filter((n) => n.autoLayout).map((n) => n.id).sort()).toEqual(['a', 'c']);
    for (const id of ['a', 'c']) {
      const n = get(m, id), p = parentOf(m, id), n0 = get(base, id), p0 = get(base, p.id);
      const r = E.fromLocal(n.autoLayout, n.scale, p.scale, p);   // R2: the viewer's inverse of localLayoutOf
      expect(r.x - p.x).toBeCloseTo(n0.x - p0.x, 9);   // relative to the parent's top-left (c itself moved)
      expect(r.y - p.y).toBeCloseTo(n0.y - p0.y, 9);
      expect(r.w).toBeCloseTo(n0.w, 9);
      expect(r.h).toBeCloseTo(n0.h, 9);
    }
    for (const id of ['b', 'd', 'e', 'f']) {   // the others are at auto: localLayoutOf as in the build without saved layout
      const l = localLayoutOf(get(m, id), parentOf(m, id)), l0 = localLayoutOf(get(base, id), parentOf(base, id));
      for (const k of ['rx', 'ry', 'rw', 'rh'] as const) expect(l[k]).toBeCloseTo(l0[k], 9);
    }
  });
});
