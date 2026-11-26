import { layoutTree } from '../src/view/layoutTree';
import { layoutView } from '../src/view/layout';
import { holderSystem } from '../src/view/arrangeOutside';
import { EXT_BOX, OUT_GAP, OUT_ITEM_GAP, OUT_MIN_W, PERSON_BOX, SLOT } from '../src/view/arrange';
import { buildViewModel } from '../src/view/model';
import type { Plan, PlanElement, Snapshot, ViewEdge, ViewNode } from '../src/types';

// C1 B1 (b831): a C1 holder root (kind 'context') is laid out like the demo: the system as the layout root, persons in a row
// above it, externals in a row below it, the holder's rect the union (src/view/arrangeOutside.ts placeOutside).

const mk = (id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode => ({
  id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const edge = (from: string, to: string): ViewEdge => ({ from, to, weight: 1 });
const EPS = 1e-6;
const cx = (r: { x: number; w: number }) => r.x + r.w / 2;
const right = (r: { x: number; w: number }) => r.x + r.w;
const bottom = (r: { y: number; h: number }) => r.y + r.h;
const overlap = (a: ViewNode, b: ViewNode) =>
  Math.min(right(a), right(b)) > Math.max(a.x, b.x) + EPS && Math.min(bottom(a), bottom(b)) > Math.max(a.y, b.y) + EPS;

/** sys > k0 (k0.a > k0.a.f), k1 (k1.a), k2 (k2.a): 3 containers, laid out 2 + 1 (k2 centred in the second row). */
const system = (): ViewNode => mk('sys', 'system', [
  mk('k0', 'container', [mk('k0.a', 'component', [mk('k0.a.f', 'function')])]),
  mk('k1', 'container', [mk('k1.a', 'component')]),
  mk('k2', 'container', [mk('k2.a', 'component')]),
]);
const holder = (persons: string[], below: string[], belowKind: ViewNode['kind'] = 'external'): ViewNode =>
  mk('__c1__', 'context', [...persons.map((p) => mk(p, 'person')), system(), ...below.map((e) => mk(e, belowKind))]);
const node = (root: ViewNode, id: string): ViewNode => all(root).find((n) => n.id === id)!;
const sysOf = (root: ViewNode): ViewNode => holderSystem(root)!;
const unit = (root: ViewNode): number => sysOf(root).w / SLOT.w;

function laidOut(persons: string[], below: string[], edges: ViewEdge[], belowKind?: ViewNode['kind']): ViewNode {
  const root = holder(persons, below, belowKind);
  layoutTree(root, { edges });
  return root;
}

describe('C1 B1 (b831): placeOutside, the demo rules', () => {
  it('a person sits above the system, centred over the container it uses; its bubble is its rect', () => {
    const root = laidOut(['p'], [], [edge('p', 'k1')]);
    const p = node(root, 'p');
    const sys = sysOf(root);
    const u = unit(root);
    expect(cx(p)).toBeCloseTo(cx(node(root, 'k1')), 6);
    expect(p.w).toBeCloseTo(PERSON_BOX.w * u, 6);
    expect(p.h).toBeCloseTo(PERSON_BOX.h * u, 6);
    expect(bottom(p)).toBeCloseTo(sys.y - OUT_GAP * u, 6);
    expect(p.bubble).toEqual({ x: p.x, y: p.y, w: p.w, h: p.h });
    expect(p.scale).toBe(sys.scale);
  });

  it('a relation to a deep component or function counts as its container; one on the system centres over the system', () => {
    const deep = laidOut(['deep'], [], [edge('deep', 'k0.a.f')]);
    expect(cx(node(deep, 'deep'))).toBeCloseTo(cx(node(deep, 'k0')), 6);
    const whole = laidOut(['whole'], [], [edge('whole', 'sys')]);
    expect(cx(node(whole, 'whole'))).toBeCloseTo(cx(sysOf(whole)), 6);
  });

  it('a person using two containers is centred over both (the union of their boxes)', () => {
    const root = laidOut(['p'], [], [edge('p', 'k0'), edge('p', 'k1')]);
    const k0 = node(root, 'k0');
    const k1 = node(root, 'k1');
    expect(cx(node(root, 'p'))).toBeCloseTo((k0.x + right(k1)) / 2, 6);
  });

  it('two persons on one container do not overlap: the later one moves right, both stay in the row', () => {
    const root = laidOut(['a', 'b'], [], [edge('a', 'k2'), edge('b', 'k2')]);
    const a = node(root, 'a');
    const b = node(root, 'b');
    expect(overlap(a, b)).toBe(false);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x - right(a)).toBeGreaterThanOrEqual(OUT_ITEM_GAP * unit(root) - EPS);
    expect(a.y).toBe(b.y);
  });

  it('the row order follows the wanted centres, not the plan order', () => {
    const root = laidOut(['right', 'left'], [], [edge('right', 'k1'), edge('left', 'k0')]);
    expect(node(root, 'left').x).toBeLessThan(node(root, 'right').x);
  });

  it('a person or external with no relation goes at the end of its row, in plan order', () => {
    const root = laidOut(['lone1', 'p', 'lone2'], ['x', 'e'], [edge('p', 'k0'), edge('k1', 'e')]);
    const xs = (ids: string[]) => ids.map((id) => node(root, id).x);
    const [p, l1, l2] = xs(['p', 'lone1', 'lone2']);
    expect(p).toBeLessThan(l1);
    expect(l1).toBeLessThan(l2);
    const [e, x] = xs(['e', 'x']);
    expect(e).toBeLessThan(x);
  });

  it('a row with no relation at all is centred on the system; an edge between two outside items is not used', () => {
    const root = laidOut(['p'], ['e'], [edge('p', 'e')]);
    const sys = sysOf(root);
    expect(cx(node(root, 'p'))).toBeCloseTo(cx(sys), 6);
    expect(cx(node(root, 'e'))).toBeCloseTo(cx(sys), 6);
  });

  it('an external sits below the system, centred under the container that talks to it (either direction)', () => {
    const root = laidOut([], ['e'], [edge('k0.a', 'e')]);
    const sys = sysOf(root);
    const u = unit(root);
    const e = node(root, 'e');
    expect(cx(e)).toBeCloseTo(cx(node(root, 'k0')), 6);
    const back = laidOut([], ['f'], [edge('f', 'k1')]);
    expect(cx(node(back, 'f'))).toBeCloseTo(cx(node(back, 'k1')), 6);
    expect(e.y).toBeCloseTo(bottom(sys) + OUT_GAP * u, 6);
    expect(e.w).toBeCloseTo(EXT_BOX.w * u, 6);
    expect(e.h).toBeCloseTo(EXT_BOX.h * u, 6);
  });

  it('many externals under one container: the row narrows to the system width, then wraps below; never inside the system', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `e${i}`);
    const root = laidOut([], ids, ids.map((id) => edge('k2', id)));
    const sys = sysOf(root);
    const u = unit(root);
    const items = ids.map((id) => node(root, id));
    const rows = [...new Set(items.map((n) => n.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThan(1);
    for (const n of items) {
      expect(n.w).toBeGreaterThanOrEqual(OUT_MIN_W * u - EPS);
      expect(n.w).toBeLessThan(EXT_BOX.w * u);
      expect(n.y).toBeGreaterThanOrEqual(bottom(sys) + OUT_GAP * u - EPS);
      expect(n.x).toBeGreaterThanOrEqual(sys.x - EPS);
      expect(right(n)).toBeLessThanOrEqual(right(sys) + EPS);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(overlap(items[i], items[j])).toBe(false);
    // row 0 is nearest the system; rows are one item height + the gap apart
    expect(rows[1] - rows[0]).toBeCloseTo(EXT_BOX.h * u + OUT_ITEM_GAP * u, 6);
    // a row that fits keeps the full width (3 persons: 3 x 76 + 2 x 20 <= 300); 2 externals (2 x 150 + 20 > 300) narrow to fit
    const three = laidOut(['a', 'b', 'c'], [], []);
    expect(node(three, 'a').w).toBeCloseTo(PERSON_BOX.w * unit(three), 6);
    const two = laidOut([], ['a', 'b'], [edge('k2', 'a'), edge('k2', 'b')]);
    expect(node(two, 'a').w).toBeCloseTo((SLOT.w - OUT_ITEM_GAP) / 2 * unit(two), 6);
    expect(node(two, 'a').y).toBe(node(two, 'b').y);
  });

  it('a row pushed right by overlaps is pushed back so it never passes the system right edge', () => {
    const root = laidOut(['a', 'b', 'c'], [], [edge('a', 'k1'), edge('b', 'k1'), edge('c', 'k1')]);
    const sys = sysOf(root);
    expect(right(node(root, 'c'))).toBeLessThanOrEqual(right(sys) + EPS);
    expect(node(root, 'a').x).toBeLessThan(node(root, 'b').x);
  });

  it('a second system among the holder children is an outside item, placed below like an external', () => {
    const root = holder([], []);
    root.children.push(mk('other', 'system'));
    layoutTree(root, { edges: [edge('k0', 'other')] });
    expect(holderSystem(root)!.id).toBe('sys');
    const other = node(root, 'other');
    expect(other.y).toBeGreaterThan(bottom(sysOf(root)));
    expect(cx(other)).toBeCloseTo(cx(node(root, 'k0')), 6);
  });

  it('an external that holds containers lays them out inside its rect; its bubble is its rect', () => {
    const root = holder([], []);
    const cloud = mk('cloud', 'external', [mk('cloud.db', 'container', [mk('cloud.db.t', 'component')]), mk('cloud.q', 'container')]);
    root.children.push(cloud);
    layoutTree(root, { edges: [edge('k1', 'cloud.db')] });
    const u = unit(root);
    expect(cloud.w).toBeLessThanOrEqual(EXT_BOX.w * u + EPS);
    expect(cloud.h).toBeLessThanOrEqual(EXT_BOX.h * u + EPS);
    expect(cloud.bubble).toEqual({ x: cloud.x, y: cloud.y, w: cloud.w, h: cloud.h });
    expect(cloud.headerH).toBeGreaterThan(0);
    for (const c of all(cloud).slice(1)) {
      expect(c.x).toBeGreaterThanOrEqual(cloud.x - EPS);
      expect(c.y).toBeGreaterThanOrEqual(cloud.y - EPS);
      expect(right(c)).toBeLessThanOrEqual(right(cloud) + EPS);
      expect(bottom(c)).toBeLessThanOrEqual(bottom(cloud) + EPS);
    }
    expect(cx(cloud)).toBeCloseTo(cx(node(root, 'k1')), 6);   // the relation to its inner container counts for it
  });

  it('the holder rect is the union of the system and every outside item; nothing overlaps the system', () => {
    const root = laidOut(['p', 'q'], ['e', 'f', 'g'], [edge('p', 'k0'), edge('q', 'k2'), edge('k0', 'e'), edge('k1', 'f')]);
    const items = root.children;
    expect(root.x).toBeCloseTo(Math.min(...items.map((n) => n.x)), 9);
    expect(root.y).toBeCloseTo(Math.min(...items.map((n) => n.y)), 9);
    expect(right(root)).toBeCloseTo(Math.max(...items.map(right)), 9);
    expect(bottom(root)).toBeCloseTo(Math.max(...items.map(bottom)), 9);
    expect(root.headerH).toBeUndefined();
    const sys = sysOf(root);
    for (const n of items) if (n !== sys) expect(overlap(n, sys)).toBe(false);
  });

  it('without edges (applySavedLayout path) every row is centred and nothing throws', () => {
    const root = holder(['p'], ['e']);
    layoutTree(root, { saved: true });
    expect(cx(node(root, 'p'))).toBeCloseTo(cx(sysOf(root)), 6);
    expect(cx(node(root, 'e'))).toBeCloseTo(cx(sysOf(root)), 6);
  });

  it('a root that is not a holder is laid out as before (holderSystem is null)', () => {
    const plain = system();
    expect(holderSystem(plain)).toBeNull();
    expect(holderSystem(mk('__c1__', 'context'))).toBeNull();   // a context with no system child: laid out as a plain root
  });
});

describe('C1 B1 (b831): the system subtree is the same as with no actors (C2/C3 unchanged)', () => {
  it('layoutTree: every rect, bubble, header and scale of the system subtree equals the plain system layout', () => {
    const edges = [edge('k0.a', 'k1.a'), edge('k1.a', 'k2.a'), edge('p', 'k0'), edge('k1', 'e')];
    const withActors = laidOut(['p'], ['e'], edges);
    const alone = system();
    layoutTree(alone, { edges });
    const shape = (n: ViewNode) => all(n).map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, bubble: c.bubble, headerH: c.headerH, scale: c.scale }));
    expect(shape(sysOf(withActors))).toEqual(shape(alone));
  });

  const el = (id: string, kind: string, over: Partial<PlanElement> = {}): PlanElement => ({
    id, kind, title: id, description: null, technology: null, links: [], metadata: {}, parent: null,
    source: { file: 'arch.c4', line: 1 }, ...over,
  });
  const rel = (s: string) => {
    const [from, to] = s.split('>');
    return { from, to, label: null, source: { file: 'arch.c4', line: 9 } };
  };
  const link = (fn: string) => [{ raw: `./h.ts#${fn}`, path: 'h.ts', name: fn, lines: null, title: null }];
  const claimComp = (id: string, containerId: string, fn: string) => ({
    id, name: id, containerId, path: 'h.ts', files: [], mode: 'claim' as const,
    claims: [{ kind: 'function' as const, path: 'h.ts', fn, elementId: id, claimIndex: 0 }], source: 'arch.c4', meta: {},
  });
  const snapshot = (): Snapshot => ({
    schemaVersion: 2,
    meta: { tool: 'c4pm@test', repoPath: '/test/repo', repoName: 'app', createdAt: '2026-01-01T00:00:00.000Z', git: null },
    system: { id: 'app', name: 'app' },
    containers: [
      { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: null },
      { id: 'api', name: 'Api', path: 'api', tech: 'Node.js', manifest: null },
    ],
    components: [claimComp('app.web.handler', 'web', 'on'), claimComp('app.api.store', 'api', 'put')],
    files: [], componentEdges: [{ from: 'app.web.handler', to: 'app.api.store', weight: 3 }], fileEdges: [], externals: [],
    stats: { containers: 2, components: 2, files: 0, codeElements: 0, componentEdges: 1, unresolvedImports: 0 },
  });
  const SYSTEM = [
    el('app', 'system'),
    el('app.web', 'container', { parent: 'app' }),
    el('app.api', 'container', { parent: 'app' }),
    el('app.web.handler', 'component', { parent: 'app.web', links: link('on') }),
    el('app.api.store', 'component', { parent: 'app.api', links: link('put') }),
  ];
  const planOf = (withActors: boolean): Plan => ({
    files: ['arch.c4'],
    elements: withActors ? [el('buyer', 'person'), ...SYSTEM, el('mail', 'external')] : SYSTEM,
    relations: (withActors ? ['app.web.handler>app.api.store', 'buyer>app.web.handler', 'app.api.store>mail'] : ['app.web.handler>app.api.store']).map(rel),
    issues: [],
  });

  it('layoutView on a real model: the system subtree is equal in world units (not only relative), the system at the origin', () => {
    const withActors = layoutView(buildViewModel(snapshot(), 's', planOf(true)));
    const alone = layoutView(buildViewModel(snapshot(), 's', planOf(false)));
    expect(withActors.root.kind).toBe('context');
    expect(alone.root.kind).toBe('system');
    const sys = holderSystem(withActors.root)!;
    const shape = (n: ViewNode) => all(n).map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, bubble: c.bubble, headerH: c.headerH, scale: c.scale }));
    expect(shape(sys)).toEqual(shape(alone.root));
    expect(sys.x).toBe(0);
    expect(sys.y).toBe(0);
    // the persons above, the external below, the holder their union
    const buyer = withActors.root.children.find((n) => n.id === 'buyer')!;
    const mail = withActors.root.children.find((n) => n.id === 'mail')!;
    expect(bottom(buyer)).toBeLessThan(sys.y);
    expect(mail.y).toBeGreaterThan(bottom(sys));
    expect(withActors.root.y).toBe(buyer.y);
    expect(bottom(withActors.root)).toBe(bottom(mail));
  });

  it('saved layouts: a saved container slot inside the system still applies; a saved slot on the system or a person is ignored (logged), no autoLayout on them', () => {
    const run = (saved: boolean) => {
      const m = buildViewModel(snapshot(), 's', planOf(true));
      if (saved) {
        const sys = holderSystem(m.root)!;
        sys.savedLayout = { rx: 10, ry: 10, rw: 300, rh: 150 };   // an export from when the context was a laid-out root (B2)
        m.root.children.find((n) => n.id === 'buyer')!.savedLayout = { rx: 5, ry: 5, rw: 300, rh: 150 };
        sys.children[0].savedLayout = { rx: 400, ry: 200, rw: 300, rh: 150 };
      }
      return m;
    };
    const prev = process.env.C4PM_DEBUG;
    process.env.C4PM_DEBUG = 'layout';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const plain = layoutView(run(false));
      const saved = layoutView(run(true));
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((s) => s.startsWith('[layout] root savedLayout ignored') && s.includes('"app"'))).toBe(true);
      expect(lines.some((s) => s.startsWith('[layout] outside savedLayout ignored') && s.includes('"buyer"'))).toBe(true);
      const sysP = holderSystem(plain.root)!;
      const sysS = holderSystem(saved.root)!;
      const moved = sysS.children[0];
      expect({ x: moved.x, y: moved.y }).not.toEqual({ x: sysP.children[0].x, y: sysP.children[0].y });   // the saved slot applied
      expect(moved.autoLayout).toBeDefined();
      expect(sysS.autoLayout).toBeUndefined();
      expect(saved.root.children.find((n) => n.id === 'buyer')!.autoLayout).toBeUndefined();
      expect({ x: sysS.x, y: sysS.y }).toEqual({ x: 0, y: 0 });
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.C4PM_DEBUG;
      else process.env.C4PM_DEBUG = prev;
    }
  });

  // b837: another plan system (bank, holding bank.ledger) is an outside item below ours, like an external
  it('another plan system: below ours, overlapping no box; its container inside it; our system subtree unchanged', () => {
    const withBank = (): Plan => {
      const p = planOf(true);
      return {
        ...p,
        elements: [...p.elements, el('bank', 'system', { title: 'Bank' }), el('bank.ledger', 'container', { parent: 'bank', title: 'Ledger' })],
        relations: [...p.relations, rel('app.api.store>bank'), rel('app.web.handler>bank.ledger')],
      };
    };
    const banked = layoutView(buildViewModel(snapshot(), 's', withBank()));
    const plain = layoutView(buildViewModel(snapshot(), 's', planOf(true)));
    expect(banked.root.children.map((n) => n.id)).toEqual(['buyer', 'app', 'bank', 'mail']);
    const sys = holderSystem(banked.root)!;
    expect(sys.id).toBe('app');
    const shape = (n: ViewNode) => all(n).map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, bubble: c.bubble, headerH: c.headerH, scale: c.scale }));
    expect(shape(sys)).toEqual(shape(holderSystem(plain.root)!));
    const bank = node(banked.root, 'bank');
    expect(bank.y).toBeGreaterThan(bottom(sys));
    for (const other of banked.root.children) if (other !== bank) expect(overlap(bank, other)).toBe(false);
    const ledger = node(banked.root, 'bank.ledger');
    expect(ledger.x).toBeGreaterThanOrEqual(bank.x - EPS);
    expect(ledger.y).toBeGreaterThanOrEqual(bank.y - EPS);
    expect(right(ledger)).toBeLessThanOrEqual(right(bank) + EPS);
    expect(bottom(ledger)).toBeLessThanOrEqual(bottom(bank) + EPS);
    expect(bottom(banked.root)).toBeCloseTo(Math.max(...banked.root.children.map(bottom)), 9);   // the holder still frames them all
  });
});
