import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { runCli } from './helpers/runCli';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const E = require('../viewer/edit.js');

// b268 round trip without a browser: viewer edit math (viewer/edit.js applyDrag) -> exportLayout ->
// `c4pm plan apply-layout` into a temp .c4 plan -> rebuild the model (layoutTree with saved layouts) -> every rect
// of the rebuilt tree equals what the viewer showed. The format stores integers in parent-local units, so the
// allowed difference per node is the rounding of that node and its ancestors (half a local unit x scale each).

type N = any;
const PLAN = `specification {
  element system
  element container
  element component
}
model {
  shop = system 'Shop' {
    api = container 'API' {
      technology 'Node'
      auth = component 'Auth' { link ../../../../src/api/auth.ts#authA 'a'
        link ../../../../src/api/auth.ts#authB 'b' }
      orders = component 'Orders' { link ../../../../src/api/orders.ts#ordersA 'a'
        link ../../../../src/api/orders.ts#ordersB 'b' }
      menu = component 'Menu' { link ../../../../src/api/menu.ts#menuA 'a'
        link ../../../../src/api/menu.ts#menuB 'b' }
    }
    web = container 'Web' {
      technology 'React'
      cart = component 'Cart' { link ../../../../src/web/cart.ts#cartA 'a'
        link ../../../../src/web/cart.ts#cartB 'b' }
      page = component 'Page' { link ../../../../src/web/page.ts#pageA 'a'
        link ../../../../src/web/page.ts#pageB 'b' }
      nav = component 'Nav' { link ../../../../src/web/nav.ts#navA 'a'
        link ../../../../src/web/nav.ts#navB 'b' }
    }
  }
}
`;

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b268rt-'));
  fs.mkdirSync(path.join(dir, '.c4pm', 'projects', 'demo', 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.c4pm', 'projects', 'demo', 'plan', 'arch.c4'), PLAN);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}');
  for (const [d, names] of [['api', ['auth', 'orders', 'menu']], ['web', ['cart', 'page', 'nav']]] as const) {
    fs.mkdirSync(path.join(dir, 'src', d), { recursive: true });
    for (const n of names) {
      fs.writeFileSync(path.join(dir, 'src', d, `${n}.ts`),
        `export function ${n}A(x: number) { return x + 1; }\nexport function ${n}B(x: number) { return ${n}A(x) * 2; }\n`);
    }
  }
  return dir;
}

const flat = (n: N): N[] => [n, ...(n.children || []).flatMap(flat)];
const linkParents = (n: N) => (n.children || []).forEach((c: N) => { c.parent = n; linkParents(c); });
const byId = (root: N): Record<string, N> => Object.fromEntries(flat(root).map(n => [n.id, n]));
const rectOf = (n: N) => ({ x: n.x, y: n.y, w: n.w, h: n.h, bubble: n.bubble ? { ...n.bubble } : undefined, bubbleMoved: !!n.bubbleMoved });
const cam = { s: 1, tx: 0, ty: 0 };

/** One viewer drag of `id`'s right (rx) and/or bottom (ry) edge by world delta (dx, dy). */
function resize(root: N, id: string, dx: number, dy: number): void {
  const n = byId(root)[id];
  const op = { type: 'resize', n, rx: dx !== 0, ry: dy !== 0, start: { x: 0, y: 0 }, r0: { x: n.x, y: n.y, w: n.w, h: n.h } };
  E.applyDrag(op, { x: dx, y: dy }, cam);
}

/** Rounding allowance for a node: 1 local unit (rx,ry,rw,rh are integers, and w feeds the centre) of every rx/ry/rw/rh on its way down from the root. */
function tolerance(n: N): number {
  let t = 0.01;
  for (let a = n; a.parent; a = a.parent) t += a.parent.scale + a.scale;
  return t;
}

// No cap on a saved size: the last scenario grows a component far past 6x its auto size (about 30 world units wide).
const SCENARIOS: Array<[string, Array<[string, number, number]>]> = [
  ['grow a component right and down', [['shop.api.menu', 60, 25]]],
  ['shrink a container to its floor (and a component)', [['shop.web', -1e6, -1e6], ['shop.api.auth', -1e6, 0]]],
  ['grow a child past its parent, which pushes the parent (and the system)', [['shop.api.menu', 40, 0], ['shop.web.cart', 0, 20]]],
  ['grow a container only right, then shrink another only bottom', [['shop.api', 150, 0], ['shop.web', 0, -1e6]]],
  ['grow a component far past 6x its auto size (and its parents with it)', [['shop.api.menu', 120, 80]]],
];

describe.each(SCENARIOS)('b268 round trip: %s', (_name, ops) => {
  test('rebuilt rects equal the edited ones', () => {
    const repo = makeRepo();
    const { model } = buildView({ repo });
    const root: N = model.root;
    linkParents(root);
    const nodes = flat(root);
    const orig: Record<string, N> = Object.fromEntries(nodes.map(n => [n.id, rectOf(n)]));

    for (const [id, dx, dy] of ops) resize(root, id, dx, dy);
    const edited = Object.fromEntries(nodes.map(n => [n.id, rectOf(n)]));
    const layout = E.exportLayout(nodes, orig);
    expect(Object.keys(layout.nodes).length).toBeGreaterThan(0);

    const file = path.join(repo, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(layout));
    const r = runCli(['plan', 'apply-layout', '--repo', repo, '--file', file]);
    expect(r.status).toBe(0);

    const rebuilt: N = buildView({ repo }).model.root;
    const after = byId(rebuilt);
    linkParents(rebuilt);
    let maxD = 0;
    for (const n of nodes) {
      if (!n.parent) continue; // the root frame has no saved unit (never exported); the viewer may grow it, the rebuild re-fits it
      const m = after[n.id];
      expect(m).toBeDefined();
      const tol = tolerance(m);
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        const d = Math.abs(m[k] - edited[n.id][k]);
        maxD = Math.max(maxD, d);
        if (d > tol) throw new Error(`${n.id}.${k}: viewer ${edited[n.id][k]} rebuilt ${m[k]} (diff ${d} > ${tol})`);
      }
    }
    if (process.env.B268_VERBOSE) process.stdout.write(`b268 round trip "${_name}": max abs diff ${maxD.toFixed(4)} world units\n`);
  });
});

// F4 (b937): the rebuild grows the ROOT to its resized children like the live page (growParents), and never below auto.
describe('b268 round trip: the root', () => {
  function roundTrip(ops: Array<[string, number, number]>) {
    const repo = makeRepo();
    const root: N = buildView({ repo }).model.root;
    linkParents(root);
    const nodes = flat(root);
    const orig: Record<string, N> = Object.fromEntries(nodes.map(n => [n.id, rectOf(n)]));
    for (const [id, dx, dy] of ops) resize(root, id, dx, dy);
    const edited = Object.fromEntries(nodes.map(n => [n.id, rectOf(n)]));
    const file = path.join(repo, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(E.exportLayout(nodes, orig)));
    expect(runCli(['plan', 'apply-layout', '--repo', repo, '--file', file]).status).toBe(0);
    const rebuilt: N = buildView({ repo }).model.root;
    return { orig, edited, rebuilt, after: byId(rebuilt), rootId: root.id };
  }

  test('children that fit: the root keeps its auto rect (shrink only)', () => {
    const t = roundTrip([['shop.api.auth', -1e6, 0], ['shop.web', -1e6, -1e6]]);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(t.rebuilt[k]).toBeCloseTo(t.orig[t.rootId][k], 6);
  });

  test('a child grown past the root bottom and right: the root covers it + padding, the child keeps its saved y/x', () => {
    const t = roundTrip([['shop.api.menu', 120, 80]]);
    const m = t.after['shop.api.menu'];
    const e = t.edited['shop.api.menu'];
    const root = t.rebuilt;
    expect(root.h).toBeGreaterThan(t.orig[t.rootId].h);
    expect(m.y).toBeCloseTo(e.y, 0);
    expect(m.x).toBeCloseTo(e.x, 0);
    // the child (via its top-level ancestor) lies inside the root rect
    for (const n of root.children) { expect(n.x + n.w).toBeLessThanOrEqual(root.x + root.w + 0.01); expect(n.y + n.h).toBeLessThanOrEqual(root.y + root.h + 0.01); }
  });

  test('the rebuilt root equals what the viewer (growParents) gives', () => {
    const t = roundTrip([['shop.api.menu', 120, 80]]);
    const ed = t.edited[t.rootId];
    for (const k of ['w', 'h'] as const) expect(Math.abs(t.rebuilt[k] - ed[k])).toBeLessThan(2);
  });
});
