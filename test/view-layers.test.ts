import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import { localId } from '../src/names';
import { FRAME_HEAD, PAD } from '../src/view/arrange';
import type { ViewModel, ViewNode } from '../src/types';
import { runViewerScripts, serializeText, type FakeEl, type HarnessResult } from './helpers/viewer-harness';
import { runCli } from './helpers/runCli';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const E = require('../viewer/edit.js');

// Phase 28 LK-G (b408): plan layers are notation on the architecture map, not a level. Container `api` of both
// fixtures has the layers logic and data (declared in that order); container `web` has none. Claim mode keys
// components by plan fqn, folder mode by scanned folder id (the plan component stands in).

const FIX = path.join(__dirname, 'fixtures');
const LAYERS: Array<[string, Array<[string, string[]]>]> = [
  ['layers-claim', [['shop.api.logic', ['shop.api.logic.orders']], ['shop.api.data', ['shop.api.data.store']]]],
  ['layers-folder', [['shop.api.logic', ['api/orders']], ['shop.api.data', ['api/billing']]]],
];

const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const find = (root: ViewNode, id: string): ViewNode => {
  const n = all(root).find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} not in the model`);
  return n;
};

/**
 * A temp copy of a fixture. `flatten` drops the layer blocks and the layer segment of every fqn (the same plan without
 * layers); `edit` changes the plan text after that.
 */
function copyFixture(name: string, flatten = false, edit: (text: string) => string = (t) => t): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c4pm-lkg-${name}-`));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  const file = path.join(dir, 'c4', 'plan.c4');
  let text = fs.readFileSync(file, 'utf8');
  if (flatten) {
    const layerIds: string[] = [];
    let skip = -1;
    const kept = text.split('\n').filter((line) => {
      const m = /^(\s*)(\w+) = layer '/.exec(line);
      if (m) { layerIds.push(m[2]); skip = m[1].length; return false; }
      if (skip >= 0 && line === `${' '.repeat(skip)}}`) { skip = -1; return false; }
      return true;
    });
    text = kept.join('\n').replace(/^\s*element layer\n/m, '');
    for (const id of layerIds) text = text.split(`.${id}.`).join('.');
  }
  fs.writeFileSync(file, edit(text));
  return dir;
}

const models = new Map<string, { layered: ViewModel; flat: ViewModel }>();
beforeAll(() => {
  for (const [name] of LAYERS) {
    models.set(name, { layered: buildView({ repo: path.join(FIX, name) }).model, flat: buildView({ repo: copyFixture(name, true) }).model });
  }
});

describe.each(LAYERS)('%s', (name, layers) => {
  const model = () => models.get(name)!.layered;
  const flat = () => models.get(name)!.flat;

  it('the container lists its layers in declared order and every component names its layer; the children are those of the plan without layers', () => {
    const api = find(model().root, 'api');
    expect((api.subregions ?? []).map((l) => [l.kind, l.id, l.children.length, l.origin?.kind])).toEqual(layers.map(([id]) => ['subregion', id, 0, 'plan']));
    expect(Object.fromEntries(api.children.map((c) => [c.id, c.subregion]))).toEqual(Object.fromEntries(layers.flatMap(([id, comps]) => comps.map((c) => [c, id]))));
    expect(api.children.map((c) => localId(c.id)).sort()).toEqual(find(flat().root, 'api').children.map((c) => localId(c.id)).sort());
    expect(all(model().root).some((n) => n.kind === 'subregion')).toBe(false);   // no layer is a child anywhere
    expect(find(model().root, 'web').subregions).toBeUndefined();
  });

  it('same edges and relations as the same plan without layers', () => {
    const ends = (m: ViewModel) => m.edges.map((e) => `${localId(e.from)}>${localId(e.to)}:${e.weight}`).sort();
    expect(ends(model())).toEqual(ends(flat()));
    expect(model().edges.length).toBeGreaterThan(0);
    expect((model().relations ?? []).map((r) => r.label)).toEqual((flat().relations ?? []).map((r) => r.label));
  });

  it('the components are stacked by layer, top to bottom in declared order, each layer with its label band', () => {
    const api = find(model().root, 'api');
    const comps = layers.map(([, ids]) => ids.map((id) => find(model().root, id)));
    for (let i = 1; i < comps.length; i++) {
      expect(Math.min(...comps[i].map((c) => c.y))).toBeGreaterThan(Math.max(...comps[i - 1].map((c) => c.y + c.h)));
    }
    for (const l of api.subregions ?? []) expect(l.headerH).toBeGreaterThan(0);
  });
});

it('a component outside the layers (L7) names no layer and sits below them', () => {
  const repo = copyFixture('layers-claim', false, (t) => t.replace("      data = layer 'Data' {", "      audit = component 'Audit'\n      data = layer 'Data' {"));
  const api = find(buildView({ repo }).model.root, 'api');
  const audit = api.children.find((c) => c.id === 'shop.api.audit');
  expect(audit?.subregion).toBeUndefined();
  for (const c of api.children.filter((k) => k.subregion)) expect(audit!.y).toBeGreaterThan(c.y + c.h);
});

// The page helpers: a click, settle the camera, and the page opened on api.
const click = (h: HarnessResult, x: number, y: number) => {
  h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y });
  h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y });
};
const settle = (h: HarnessResult) => {
  h.frames.runToCompletion();
  for (let i = 0; i < 60; i++) h.frames.flush();
};
type VN = ViewNode & { _R?: { x: number; y: number; w: number; h: number }; parent?: VN; _tv?: number };
/** The page of `model` (default: layers-claim) with the container `api` open (camera fitted to it). */
const openApi = (model: ViewModel = models.get('layers-claim')!.layered) => {
  const h = runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop'] });
  h.frames.flush();
  const map = h.sandbox.C4PM_MAP as {
    nodeById: (id: string) => VN; flyTo: (id: string) => void; selectedId: () => string | null; state: any;
    setEdit: (on: boolean) => void; exportLayout: () => { version: number; nodes: Record<string, unknown> };
  };
  const cam = h.sandbox.C4PM_CAM as { focusNode: () => VN | null; fitCam: (r: VN) => { s: number } };
  map.flyTo('api');
  settle(h);
  return { h, map, cam, api: map.nodeById('api'), layer: (id: string) => map.nodeById(id) };
};
const inside = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) =>
  o.x >= r.x && o.y >= r.y && o.x + o.w <= r.x + r.w && o.y + o.h <= r.y + r.h;

describe('viewer (layers-claim): frames, not a level', () => {
  it('the open container draws one labelled frame per layer around its components, in declared order', () => {
    const { h, api, layer } = openApi();
    const [logic, data] = ['shop.api.logic', 'shop.api.data'].map(layer);
    for (const [l, comp] of [[logic, 'shop.api.logic.orders'], [data, 'shop.api.data.store']] as const) {
      const c = api.children.find((k) => k.id === comp) as VN;
      expect(inside(l._R!, c._R!)).toBe(true);
    }
    expect(logic._R!.y + logic._R!.h).toBeLessThan(data._R!.y);
    expect(h.fillTextLog).toEqual(expect.arrayContaining(['Logic', 'SUBREGION  ·  1 component', 'Data']));
  });

  it('a click on a frame label selects the layer (panel: its plan block); elsewhere in the frame it selects the container', () => {
    const { h, map, layer } = openApi();
    const logic = layer('shop.api.logic');
    click(h, logic._R!.x + logic._R!.w / 2, logic._R!.y + 3);
    expect(map.selectedId()).toBe('shop.api.logic');
    expect(h.panel.querySelectorAll('.pn-label').map((l: FakeEl) => serializeText(l))).toEqual(expect.arrayContaining([expect.stringMatching(/^The plan/), 'Depends on', 'Used by']));
    click(h, logic._R!.x + 4, logic._R!.y + logic._R!.h - 4);
    expect(map.selectedId()).toBe('api');
  });

  it('a layer is not a level: Up from a component lands on the container; a double-click on a label zooms the frame, the focus stays the container', () => {
    const { h, map, cam, api, layer } = openApi();
    map.flyTo('shop.api.logic.orders');
    settle(h);
    expect(cam.focusNode()?.id).toBe('shop.api.logic.orders');
    expect(cam.focusNode()?.parent?.id).toBe('api');
    (h.sandbox.document as { getElementById: (id: string) => FakeEl & { onclick?: () => void } }).getElementById('btn-up').onclick!();
    settle(h);
    expect(cam.focusNode()?.id).toBe('api');
    expect(map.state.cam.s).toBeCloseTo(cam.fitCam(api).s, 6);

    const data = layer('shop.api.data');
    click(h, data._R!.x + data._R!.w / 2, data._R!.y + 3);
    click(h, data._R!.x + data._R!.w / 2, data._R!.y + 3);
    settle(h);
    expect(map.state.cam.s).toBeCloseTo(cam.fitCam(data).s, 6);
    expect(cam.focusNode()?.id).toBe('api');
    expect((h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('hud-level').textContent).toBe('C2 · Containers');
  });

  it('edges run component to component while the container is open, and roll up to it when closed', () => {
    const h = runViewerScripts(renderViewHtml(models.get('layers-claim')!.layered), { extraIds: ['btn-gear', 'settings-pop'] });
    const w = h.sandbox.window as any;
    const visible = (open: string[]): string[] => {
      const alpha = w.C4PM_STATE.map.alpha;
      for (const k of Object.keys(alpha)) delete alpha[k];
      for (const id of [models.get('layers-claim')!.layered.root.id, ...open]) alpha[id] = 1;
      return w.C4PM_RENDER.edges.visibleEdges().map((v: any) => `${v.A.id}>${v.B.id}`).sort();
    };
    expect(visible(['api', 'web', 'shop.api.logic.orders', 'shop.api.data.store'])).toEqual(['shop.api.logic.orders>shop.api.data.store', 'web>shop.api.logic.orders']);
    expect(visible(['api', 'web'])).toEqual(['web>api']);
  });

  it('left tree: each layer is a group row holding its components', () => {
    const { h, map } = openApi();
    (h.sandbox.C4PM_MAP as { select: (id: string) => void }).select('shop.api.data.store');
    const rows = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('left').querySelectorAll('.lt-row')
      .map((r: FakeEl) => r.dataset.id);
    expect(rows.indexOf('shop.api.logic')).toBeGreaterThan(rows.indexOf('api'));
    expect(rows.indexOf('shop.api.data')).toBeGreaterThan(rows.indexOf('shop.api.logic'));
    expect(rows.indexOf('shop.api.data.store')).toBe(rows.indexOf('shop.api.data') + 1);
    expect(map.selectedId()).toBe('shop.api.data.store');
  });
});

// b454: the data layer of layers-claim marked shared (plan key `shared`); `value` other than 'true' is invalid.
const sharedData = (value = 'true') => (t: string) => t.replace("      data = layer 'Data' {", `      data = layer 'Data' {\n        metadata { shared '${value}' }`);
type Rect = { x: number; y: number; w: number; h: number };
const rect = (n: Rect): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

describe('a shared layer (b454) is a side column', () => {
  it('the shared layer is marked; its component sits right of the stack, top aligned; the frames do not overlap and the shared frame is as tall as the stack', () => {
    const root = buildView({ repo: copyFixture('layers-claim', false, sharedData()) }).model.root;
    const api = find(root, 'api');
    expect((api.subregions ?? []).map((l) => [l.id, l.sharedColumn])).toEqual([['shop.api.logic', undefined], ['shop.api.data', true]]);
    const [orders, store] = ['shop.api.logic.orders', 'shop.api.data.store'].map((id) => find(root, id));
    expect(store.x).toBeGreaterThan(orders.x + orders.w);
    expect(store.y + store.h / 2).toBeCloseTo(orders.y + orders.h / 2, 6);   // same row: slot centres level

    E.placeFrames(api);
    const [logic, data] = api.subregions!;
    expect(logic.x + logic.w).toBeLessThan(data.x);
    expect(data.y).toBeCloseTo(logic.y, 6);
    expect(data.y + data.h).toBeGreaterThanOrEqual(logic.y + logic.h);
    for (const [l, c] of [[logic, orders], [data, store]]) {
      expect(c.x >= l.x && c.y >= l.y && c.x + c.w <= l.x + l.w && c.y + c.h <= l.y + l.h).toBe(true);
    }
  });

  it('an invalid value (shared \'yes\') is not a shared layer: the plain stack, same numbers', () => {
    const plain = models.get('layers-claim')!.layered.root;
    const root = buildView({ repo: copyFixture('layers-claim', false, sharedData('yes')) }).model.root;
    expect(find(root, 'api').subregions?.[1].sharedColumn).toBeUndefined();
    expect(all(root).map(rect)).toEqual(all(plain).map(rect));
  });
});

describe.each([
  ['no shared layer', undefined],
  ['the data layer shared', sharedData()],
])('apply-layout round-trips a component moved inside its frame (%s)', (_name, edit) => {
  it('the frame follows the component, only the component is exported, and the rebuilt component is where the viewer put it', () => {
    const repo = copyFixture('layers-claim', false, edit);
    const root: any = buildView({ repo }).model.root;
    const link = (n: any) => n.children.forEach((c: any) => { c.parent = n; link(c); });
    link(root);
    const api = find(root, 'api') as any;
    const nodes = [...all(root), ...api.subregions];
    const orig = Object.fromEntries(nodes.map((n: any) => [n.id, E.rectOf(n)]));   // the page's load rects (map.js rectsOf)
    const store = find(root, 'shop.api.data.store') as any;
    E.applyDrag({ type: 'move', n: store, start: { x: 0, y: 0 }, r0: { x: store.x, y: store.y, w: store.w, h: store.h } }, { x: 0, y: -api.h * 0.1 }, { s: 1, tx: 0, ty: 0 });   // up: the data layer is the bottom row (shared: its label band is above)
    const edited = { x: store.x, y: store.y, w: store.w, h: store.h };
    E.placeFrames(api);
    const data = api.subregions[1];
    expect(data.y).toBeLessThan(store.y);
    expect(data.y + data.h).toBeGreaterThan(store.y + store.h);
    const layout = E.exportLayout(nodes, orig);
    expect(Object.keys(layout.nodes)).toEqual(['shop.api.data.store']);

    const file = path.join(repo, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(layout));
    expect(runCli(['plan', 'apply-layout', '--repo', repo, '--file', file, '--force']).status).toBe(0);
    const again = find(buildView({ repo }).model.root, 'shop.api.data.store');
    expect(again.savedLayout).toBeDefined();
    const tol = api.scale * 2;   // integers in parent-local units
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(again[k] - edited[k])).toBeLessThanOrEqual(tol);
    expect(again.y).not.toBeCloseTo(orig['shop.api.data.store'].y);
  });
});

// SR2 (b457): rects captured before SR2-b (buildView, then the viewer's placeFrames for the frames). With no subregion
// layout saved, every box, bubble, header band, scale and frame is the same number, and no frame is placed.
describe('no subregion layout saved: the page model is the one before SR2 (golden)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'subregion-frames.json'), 'utf8'));
  const r = (o?: Rect) => (o ? [o.x, o.y, o.w, o.h] : null);
  const dump = (root: ViewNode) => {
    const out: Record<string, unknown> = {};
    const walk = (n: ViewNode) => {
      out[n.id] = { rect: r(n), bubble: r(n.bubble), headerH: n.headerH ?? null, scale: n.scale ?? null };
      if (n.subregions) {
        expect(n.subregions.map((l) => l.placed)).toEqual(n.subregions.map(() => undefined));
        E.placeFrames(n);
        for (const l of n.subregions) out[`frame:${l.id}`] = { rect: r(l), headerH: l.headerH ?? null };
      }
      n.children.forEach(walk);
    };
    walk(root);
    return out;
  };
  it.each([
    ['layers-claim', () => path.join(FIX, 'layers-claim')],
    ['layers-claim-shared', () => copyFixture('layers-claim', false, sharedData())],
    ['layers-folder', () => path.join(FIX, 'layers-folder')],
  ])('%s', (name, repo) => {
    expect(dump(buildView({ repo: repo() }).model.root)).toEqual(golden[name]);
  });
});

// SR2 (b457) Q6: folder mode reads a subregion's saved layout (keyed by its plan fqn); a component's stays ignored.
describe('folder mode: a subregion with a saved layout is a placed frame (SR2 Q6)', () => {
  // api's local body in layers-folder is 360 x 514; the data frame 330 x 210 at local (0, 300): rx = 0 + 150 - 165,
  // ry = 300 + 75 - 105. Billing's own layout would move it to the top left of the body.
  const edit = (t: string) => t
    .replace("      data = layer 'Data' {", "      data = layer 'Data' {\n        metadata { layout ';15,330,330,210' }")
    .replace("        billing = component 'Billing' {\n          metadata { status 'done' }", "        billing = component 'Billing' {\n          metadata {\n            status 'done'\n            layout ';0,44,300,150'\n          }");
  it('the data frame is placed at its saved rect, its component inside below the label band; the component layout is not read; no scale changes', () => {
    const root = buildView({ repo: copyFixture('layers-folder', false, edit) }).model.root;
    const api = find(root, 'api');
    const K = api.scale!;
    const [logic, data] = api.subregions!;
    expect(data.savedLayout).toEqual({ rx: 15, ry: 330, rw: 330, rh: 210 });
    expect([data.placed, data.scale, logic.placed]).toEqual([true, K, undefined]);
    const want = { x: api.x, y: api.y + 300 * K, w: 330 * K, h: 210 * K };
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(data[k]).toBeCloseTo(want[k], 9);
    const billing = find(root, 'api/billing');
    expect(billing.savedLayout).toBeUndefined();
    expect(billing.x >= data.x && billing.x + billing.w <= data.x + data.w && billing.y + billing.h <= data.y + data.h).toBe(true);
    expect(billing.y).toBeGreaterThanOrEqual(data.y + FRAME_HEAD * K);
    expect(api.y + api.h).toBeCloseTo(data.y + data.h + PAD * K, 9);   // the container grew to cover the frame
    const plain = buildView({ repo: path.join(FIX, 'layers-folder') }).model.root;
    expect(all(root).map((n) => [n.id, n.scale])).toEqual(all(plain).map((n) => [n.id, n.scale]));
  });
});

// SR2 (b457, b692): in edit mode a subregion frame moves by its label band and resizes by its right/bottom edge, through
// the page's pointer path (controls.js editTargetAt: render.js puts the drawn frames in map.opens after their container).
describe('SR2: subregion editing', () => {
  const drag = (h: HarnessResult, x0: number, y0: number, x1: number, y1: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x0, clientY: y0 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: x1, clientY: y1 });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x1, clientY: y1 });
    h.frames.flush();   // one more draw: placeFrames must leave a placed frame alone
  };
  const button = (h: HarnessResult, id: string) =>
    (h.sandbox.document as { getElementById: (id: string) => FakeEl & { onclick?: () => void } }).getElementById(id);
  /** The page in edit mode, api open; data, logic and their components. */
  const editPage = (model?: ViewModel) => {
    const o = openApi(model);
    o.map.setEdit(true);
    const [logic, data, orders, store] = ['shop.api.logic', 'shop.api.data', 'shop.api.logic.orders', 'shop.api.data.store'].map(o.layer);
    return { ...o, s: o.map.state.cam.s as number, logic, data, orders, store };
  };
  /** Screen points: the middle of a frame's label band, and the middle of its right edge. */
  const labelOf = (l: VN, s: number) => ({ x: l._R!.x + l._R!.w / 2, y: l._R!.y + ((l.headerH ?? 0) * s) / 2 });
  const rightEdgeOf = (l: VN) => ({ x: l._R!.x + l._R!.w, y: l._R!.y + l._R!.h / 2 });
  const placedOf = (n: VN) => !!n.placed;

  it('dragging the data label moves the frame and its component by one delta; logic and orders stay', () => {
    const { h, s, logic, data, orders, store } = editPage();
    const [d0, st0, l0, o0] = [data, store, logic, orders].map(rect);
    const p = labelOf(data, s);
    drag(h, p.x, p.y, p.x, p.y - 40);
    expect(placedOf(data)).toBe(true);
    for (const [n, r0] of [[data, d0], [store, st0]] as const) {
      expect(n.x).toBeCloseTo(r0.x, 6);
      expect(n.y - r0.y).toBeCloseTo(-40 / s, 6);
      expect([n.w, n.h]).toEqual([r0.w, r0.h]);
    }
    expect([rect(logic), rect(orders)]).toEqual([l0, o0]);
    expect(placedOf(logic)).toBe(false);
  });

  it('btn-undo restores the frame, its component and placed', () => {
    const { h, s, data, store } = editPage();
    const [d0, st0] = [data, store].map(rect);
    const p = labelOf(data, s);
    drag(h, p.x, p.y, p.x, p.y - 40);
    expect(rect(data)).not.toEqual(d0);
    button(h, 'btn-undo').onclick!();
    h.frames.flush();
    expect([rect(data), rect(store), placedOf(data)]).toEqual([d0, st0, false]);
  });

  it('btn-reset (R5) puts the frame back to auto: load rect, not placed, so it follows its component again', () => {
    const { h, s, data, store } = editPage();
    const [d0, st0] = [data, store].map(rect);
    const e = rightEdgeOf(data);
    drag(h, e.x, e.y, e.x - 60, e.y);
    expect(placedOf(data)).toBe(true);
    button(h, 'btn-reset').onclick!();
    h.frames.flush();
    expect([rect(data), rect(store), placedOf(data)]).toEqual([d0, st0, false]);
    const c = { x: store._R!.x + store._R!.w / 2, y: store._R!.y + store._R!.h / 2 };
    drag(h, c.x, c.y, c.x, c.y - 20);
    expect(data.y - d0.y).toBeCloseTo(-20 / s, 6);   // auto again: placeFrames fits it around the moved store
  });

  it('dragging the right edge of the data frame widens it only; the store stays; the frame is placed', () => {
    const { h, s, data, store } = editPage();
    const [d0, st0] = [data, store].map(rect);
    const p = rightEdgeOf(data);
    drag(h, p.x, p.y, p.x + 30, p.y);
    expect(data.w - d0.w).toBeCloseTo(30 / s, 6);
    expect([data.x, data.y, data.h]).toEqual([d0.x, d0.y, d0.h]);
    expect(rect(store)).toEqual(st0);
    expect(placedOf(data)).toBe(true);
  });

  it('dragging a component out of a placed frame leaves the frame where it is', () => {
    const { h, s, data, store } = editPage();
    const e = rightEdgeOf(data);
    drag(h, e.x, e.y, e.x - 60, e.y);   // placed, and narrower than the container
    const d1 = rect(data), st1 = rect(store);
    const c = { x: store._R!.x + store._R!.w / 2, y: store._R!.y + store._R!.h / 2 };
    drag(h, c.x, c.y, c.x, c.y - 60);
    expect(store.y - st1.y).toBeCloseTo(-60 / s, 6);
    expect(rect(data)).toEqual(d1);
    expect(placedOf(data)).toBe(true);
  });

  it('round trip: drag + resize data, export, apply-layout, rebuild: the frame is placed where the page put it', () => {
    const repo = copyFixture('layers-claim');
    const { h, s, map, api, data } = editPage(buildView({ repo }).model);
    const p = labelOf(data, s);
    drag(h, p.x, p.y, p.x, p.y - 40);
    const e = rightEdgeOf(data);
    drag(h, e.x, e.y, e.x - 60, e.y);
    const local = (n: Rect, o: Rect) => ({ x: n.x - o.x, y: n.y - o.y, w: n.w, h: n.h });
    const edited = local(data, api);
    const out = map.exportLayout();
    expect(Object.keys(out.nodes).sort()).toEqual(['shop.api.data', 'shop.api.data.store']);

    const file = path.join(repo, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(out));
    expect(runCli(['plan', 'apply-layout', '--repo', repo, '--file', file, '--force']).status).toBe(0);
    const api2 = find(buildView({ repo }).model.root, 'api');
    const data2 = api2.subregions!.find((l) => l.id === 'shop.api.data')!;
    expect(data2.placed).toBe(true);
    const again = local(data2, api2), tol = api2.scale! * 2;   // integers in container-local units
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(again[k] - edited[k])).toBeLessThanOrEqual(tol);
  });

  it('a plan with a layout only on the data subregion: the page keeps the placed frame and draws the store inside it', () => {
    const repo = copyFixture('layers-claim', false, (t) => t.replace("      data = layer 'Data' {", "      data = layer 'Data' {\n        metadata { layout ';15,330,330,210' }"));
    const model = buildView({ repo }).model;
    const server = find(model.root, 'api').subregions!.find((l) => l.id === 'shop.api.data')!;
    expect(server.placed).toBe(true);
    const { data, store } = editPage(model);
    expect(placedOf(data)).toBe(true);
    expect(rect(data)).toEqual(rect(server));
    expect(inside(data._R!, store._R!)).toBe(true);
  });
});
