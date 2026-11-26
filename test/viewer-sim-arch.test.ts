import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult, OpCall } from './helpers/viewer-harness';
import { simHtml, CREATE } from './helpers/sim-view';

// Phase 25 UI8 (b758): viewer/sim-map.js, the architecture overlay of the selected s-item (amber rings with step-number
// pills, numbered teal arrows, the dashed amber unverified arrow), the normal arrows dimmed while an s-item is selected
// (render.js drawEdges) and the early opening of the current step's components (sim.js map.openEarly, camera.js openness).
// The page is simHtml() (test/helpers/sim-view.ts): s-1 lights api (steps 3, 5, 6, 7 as call ends), api/routes (3, 4),
// OrderService.create (4) and api/payments (6); its one arch call is step 4 api/routes -> OrderService.create (unverified).

const BGLOW = '#FFB020';
const FLOW = '#0E9F01', UNVER = '#C77702', PANEL = '#F0F0F3', EDGE = '#E10004';
// The harness's fake colours (test/helpers/viewer-harness.ts) plus distinct flow / unver / panel, to tell the marks apart.
const COLORS: Record<string, string> = {
  '--accent': '#ACC0FF', '--findings': '#FE0001', '--bp': '#B10001', '--muted': '#B30003', '--edge': EDGE, '--c2': '#C20002',
  '--screen': '#5B4FC9', '--flow': FLOW, '--unver': UNVER, '--panel': PANEL,
};

function load(): HarnessResult {
  const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
  return runViewerScripts(simHtml(), { extraIds: ['btn-gear', 'settings-pop'], globals: { getComputedStyle } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const MAP = (h: HarnessResult) => win(h).C4PM_MAP;
const state = (h: HarnessResult) => win(h).C4PM_STATE;
function settle(h: HarnessResult) {
  h.frames.runToCompletion();
  for (let i = 0; i < 60; i++) h.frames.flush();
}
/** One frame; returns its ops, the fillText calls and the setLineDash calls (with the stroke style at the time). */
function frame(h: HarnessResult): { ops: OpCall[]; text: string[]; dashes: Array<{ dash: number[]; style: string }> } {
  const ctx = state(h).map.ctx;
  const dashes: Array<{ dash: number[]; style: string }> = [];
  ctx.setLineDash = (d: number[]) => { dashes.push({ dash: d.slice(), style: String(ctx.strokeStyle) }); };
  h.opLog.length = 0;
  h.fillTextLog.length = 0;
  MAP(h).draw();
  return { ops: h.opLog.slice(), text: h.fillTextLog.slice(), dashes };
}
const strokes = (ops: OpCall[], style: string) => ops.filter(o => o.op === 'stroke' && o.style === style);
const fills = (ops: OpCall[], style: string) => ops.filter(o => o.op === 'fill' && o.style === style);
/** The page settled with the camera on the api container (its components open). */
function inApi(): HarnessResult {
  const h = load();
  settle(h);
  MAP(h).flyTo('api');
  settle(h);
  return h;
}

describe('the overlay is registered and quiet without an s-item', () => {
  it('sim-map.js pushes its post-draw function once; nothing sim is drawn while map.sim is null', () => {
    const h = inApi();
    // C4PM_STATE.post is shared (viewState.js pushes its camera save too): count only sim-map's drawSimOverlay.
    expect(state(h).post.filter((f: { name: string }) => f.name === 'drawSimOverlay')).toHaveLength(1);
    const { ops, text } = frame(h);
    expect(strokes(ops, BGLOW)).toEqual([]);
    expect(ops.filter(o => o.style === FLOW || o.style === UNVER)).toEqual([]);
    expect(text.filter(t => /^\d/.test(t))).toEqual([]);
    expect(strokes(ops, EDGE).every(o => o.alpha === 1)).toBe(true);   // normal arrows not dimmed
    SIM(h).select('s-1');
    SIM(h).select(null);
    expect(strokes(frame(h).ops, BGLOW)).toEqual([]);
  });
});

describe('architecture: rings and step pills', () => {
  it('whole path, zoomed out: every lit id rolls up to api; one ring (2.5) with the pill "3 · 4 · 5 · 6 · 7"; no arrow', () => {
    const h = load();
    settle(h);
    SIM(h).select('s-1');
    const { ops, text } = frame(h);
    const rings = strokes(ops, BGLOW);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ lineWidth: 2.5, alpha: 1 });
    expect(text).toContain('3 · 4 · 5 · 6 · 7');
    expect(strokes(ops, UNVER)).toEqual([]);   // both ends of step 4 inside api: the box pill carries the number
    expect(strokes(ops, FLOW)).toEqual([]);
    expect(fills(ops, FLOW).length).toBeGreaterThan(0);   // the teal pill
  });

  it('inside api: one ring per visible lit box; the pills sorted "1 · 2"; with a cursor the current ring is 4 wide, the others 0.55', () => {
    const h = inApi();
    SIM(h).select('s-1');
    const whole = frame(h);
    expect(strokes(whole.ops, BGLOW).length).toBeGreaterThanOrEqual(3);   // api, api/routes, api/payments, create's box
    expect(strokes(whole.ops, BGLOW).every(o => o.lineWidth === 2.5 && o.alpha === 1)).toBe(true);
    expect(whole.text).toEqual(expect.arrayContaining(['3 · 4', '6']));
    // a hand-set lit state: numbers are sorted and joined
    const sim = state(h).map.sim;
    state(h).map.sim = { ...sim, ids: new Map([['api/routes', { ns: [2, 1], cur: false }]]), calls: [] };
    expect(frame(h).text).toContain('1 · 2');
    state(h).map.sim = sim;
    SIM(h).go(5);   // step 6: api/payments current
    const { ops, text } = frame(h);
    const rings = strokes(ops, BGLOW);
    expect(rings.filter(o => o.lineWidth === 4 && o.alpha === 1).length).toBeGreaterThanOrEqual(1);
    expect(rings.filter(o => o.lineWidth === 2.5).every(o => o.alpha === 0.55)).toBe(true);
    expect(fills(ops, BGLOW).length).toBeGreaterThan(0);   // the current pill is amber
    expect(text).toContain('6');
  });
});

describe('architecture: numbered arrows', () => {
  it('the current unverified step: amber dashed [9, 6] line 4 wide + head, pill "4 ?" in amber', () => {
    const h = inApi();
    SIM(h).select('s-1');
    SIM(h).go(3);
    const { ops, text, dashes } = frame(h);
    const line = strokes(ops, UNVER);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ lineWidth: 4, alpha: 1 });
    expect(fills(ops, UNVER).length).toBeGreaterThanOrEqual(1);   // the head
    expect(dashes).toContainEqual({ dash: [9, 6], style: UNVER });
    expect(text).toContain('4 ?');
  });

  it('a verified call: a teal line 2.6 wide + head, no dash, pill "4"; with the cursor elsewhere the arrow is at alpha 0.45', () => {
    const h = inApi();
    SIM(h).select('s-1');
    const sim = state(h).map.sim;
    state(h).map.sim = { ...sim, calls: sim.calls.map((c: any) => ({ ...c, unverified: false })) };
    const { ops, text, dashes } = frame(h);
    const line = strokes(ops, FLOW);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ lineWidth: 2.6, alpha: 1 });
    expect(fills(ops, FLOW).length).toBeGreaterThanOrEqual(2);   // head + pills
    expect(dashes.filter(d => d.dash.length && d.style === FLOW)).toEqual([]);
    expect(text).toContain('4');
    expect(text).not.toContain('4 ?');
    SIM(h).go(5);   // the cursor on step 6: step 4's arrow is not current
    const later = frame(h);
    expect(strokes(later.ops, UNVER)).toEqual([expect.objectContaining({ lineWidth: 2.6, alpha: 0.45 })]);
  });

  it('both ends in one visible box (the camera on the whole map): no arrow', () => {
    const h = load();
    settle(h);
    SIM(h).select('s-1');
    SIM(h).go(3);
    const { ops } = frame(h);
    expect(strokes(ops, UNVER)).toEqual([]);
    expect(strokes(ops, BGLOW)).toEqual([expect.objectContaining({ lineWidth: 4 })]);   // api is the current box
  });
});

describe('render.js drawEdges: the normal arrows dim while an s-item is selected', () => {
  it('alpha 0.25 with map.sim, 1 again after clearing', () => {
    const h = inApi();
    expect(strokes(frame(h).ops, EDGE).length).toBeGreaterThan(0);
    SIM(h).select('s-1');
    const on = strokes(frame(h).ops, EDGE);
    expect(on.length).toBeGreaterThan(0);
    expect(on.every(o => o.alpha === 0.25)).toBe(true);
    SIM(h).select(null);
    expect(strokes(frame(h).ops, EDGE).every(o => o.alpha === 1)).toBe(true);
  });
});

describe('sim.js map.openEarly and camera.js openness', () => {
  it('the current step\'s arch targets and call ends with their ancestors; with no cursor every step\'s; null without an s-item', () => {
    const h = load();
    settle(h);
    const S = SIM(h);
    // b786 (whole path): with no cursor every step's arch nodes open early (before: null). s-1's arch ids with their
    // ancestors (0-based steps): step 2 api/routes, step 3 the call api/routes -> OrderService.create, step 5
    // api/payments, and 'api' as a call end of steps 2, 4, 5, 6 (test/helpers/sim-view.ts).
    const WHOLE = ['sample-shop', 'api', 'api/routes', 'api/services', 'api/src/services/orderService.ts',
      'api/src/services/orderService.ts#OrderService', CREATE, 'api/payments'];
    S.select('s-1');
    expect([...state(h).map.openEarly].sort()).toEqual(WHOLE.slice().sort());
    S.go(3);
    const set = state(h).map.openEarly;
    ['sample-shop', 'api', 'api/services', 'api/src/services/orderService.ts', 'api/src/services/orderService.ts#OrderService', CREATE, 'api/routes']
      .forEach(id => expect(set.has(id)).toBe(true));
    expect(set.has('api/payments')).toBe(false);
    S.go(0);   // an IO step: its call ends (person -> shop.web) are not arch nodes
    expect([...state(h).map.openEarly]).toEqual([]);
    S.go(null);   // b786: the whole path again (before: null)
    expect([...state(h).map.openEarly].sort()).toEqual(WHOLE.slice().sort());
    S.go(3);
    S.select(null);
    expect(state(h).map.openEarly).toBeNull();
  });

  it('a component of the path opens at f = 0.3 with or without the cursor; closed without an s-item', () => {
    const h = load();
    settle(h);
    const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
    const n = nodeById['api/services'];
    map.autoLevel = true;
    map.cam = { s: 0.3 * Math.min(map.cw / n.w, map.ch / n.h), tx: 0, ty: 0 };
    expect(Math.max(n.w * map.cam.s / map.cw, n.h * map.cam.s / map.ch)).toBeCloseTo(0.3);
    expect(CAM.openness(n)).toBe(0);
    SIM(h).select('s-1');
    expect(CAM.openness(n)).toBeGreaterThan(0);   // b786: open with no cursor (before: 0)
    SIM(h).go(3);
    expect(CAM.openness(n)).toBeGreaterThan(0);
    SIM(h).go(null);
    expect(CAM.openness(n)).toBeGreaterThan(0);   // b786: still open (before: 0)
    SIM(h).select(null);
    expect(CAM.openness(n)).toBe(0);
  });

  it('select(null) clears map.openBand (b786)', () => {
    const h = load();
    settle(h);
    SIM(h).select('s-1');
    state(h).map.openBand = { top: 1, bottom: 1 };
    SIM(h).select(null);
    expect(state(h).map.openBand).toBeNull();
  });
});

describe('b786: a lit code box inside a lit component follows it (camera.js follows, render.js drawRegion)', () => {
  it('the file and class of the lit method are drawn without their own header; the method shows inside the component', () => {
    const h = load();
    settle(h);
    const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
    const fn = nodeById[CREATE], cls = fn.parent, file = cls.parent, comp = file.parent;
    expect([comp.id, file.id, cls.id]).toEqual(['api/services', 'api/src/services/orderService.ts', 'api/src/services/orderService.ts#OrderService']);
    const chain: string[] = [];
    for (let n = comp; n; n = n.parent) chain.push(n.id);   // the component and its ancestors, as sim.js lights them
    map.autoLevel = true;
    map.openEarly = new Set([...chain, file.id, cls.id]);
    map.cam = CAM.fitCam(comp, 0.3);                        // the component covers 30% of the map
    for (let i = 0; i < 60; i++) frame(h);                  // let the openness ease to its target
    const { text } = frame(h);
    expect(CAM.openness(comp)).toBeGreaterThan(0.4);
    expect(text.some(t => t.startsWith(comp.name))).toBe(true);          // the component's header is drawn
    expect(map.alpha[fn.id]).toBeGreaterThan(0);                    // before b786: 0 (the file box stays closed)
    expect(text.filter(t => t.startsWith(file.name) || t.startsWith(cls.name))).toEqual([]);
  });
});

// C1 C1 (b833): on the demo fixture's page (test/fixtures/sim-demo-shop: persons Customer and Staff at C1) a lit person gets its
// ring around the figure (render.js shapePath, 5 px out): an arc around its head, not a rounded box around its rect.
describe('C1 C1 (b833): the ring around a lit person follows the figure', () => {
  let page: string;
  let tmp: string;
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-person-')));
    const repo = path.join(tmp, 'shop');
    fs.cpSync(path.join(__dirname, 'fixtures', 'sim-demo-shop'), repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    page = buildView({ repo }).html;
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a current lit person: one amber arc of radius head + 5 at its head, with the step pill', () => {
    const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
    const h = runViewerScripts(page, { extraIds: ['btn-gear', 'settings-pop'], globals: { getComputedStyle, location: { href: 'file:///x.html#arch', hash: '#arch' } } });
    settle(h);
    const map = state(h).map, ctx = map.ctx, n = state(h).nodeById.customer;
    map.sim = { view: 'arch', ids: new Map([['customer', { ns: [1], cur: true }]]), calls: [], cur: 0 };
    const arcs: Array<{ x: number; y: number; r: number; style: string }> = [];
    ctx.arc = (x: number, y: number, r: number) => { arcs.push({ x, y, r, style: String(ctx.strokeStyle) }); };
    const { text } = frame(h);
    const R = n._R, hr = R.h * 0.2;
    const ring = arcs.filter(a => a.style === BGLOW && Math.abs(a.r - (hr + 5)) < 1e-6);
    expect(ring).toHaveLength(1);
    expect(ring[0].x).toBeCloseTo(R.x + R.w / 2, 6);
    expect(ring[0].y).toBeCloseTo(R.y + hr, 6);
    expect(text).toContain('1');
  });
});

// b858 helpers (S1, S2)
type Rect = { x: number; y: number; w: number; h: number };
/** The b786 setup above: the component of CREATE and its ancestors lit with the file (and the class unless `lightClass` is
 * false), the camera fitting `on` (default the component) at `pad` of the map (default 0.3), eased. The fixture chain
 * component -> file -> class -> CREATE has one child per level, so the fill applies twice down the chain (file in the
 * component, class in the file). */
function followed(pad = 0.3, lightClass = true, on?: (fn: any) => any) {
  const h = load();
  settle(h);
  const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
  const fn = nodeById[CREATE], cls = fn.parent, file = cls.parent, comp = file.parent;
  const chain: string[] = [];
  for (let n = comp; n; n = n.parent) chain.push(n.id);
  map.autoLevel = true;
  map.openEarly = new Set([...chain, file.id, ...(lightClass ? [cls.id] : [])]);
  map.cam = CAM.fitCam(on ? on(fn) : comp, pad);
  for (let i = 0; i < 60; i++) frame(h);
  return { h, map, nodeById, CAM, fn, cls, file, comp };
}
const plain = (CAM: any, n: any): Rect => CAM.toScreen(n.bubble || n, n, n._tv);
const inside = (r: Rect, o: Rect) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
/** No s-item: every node drawn this frame keeps the plain rect toScreen(bubble || n, n, _tv). */
function expectPlainRects(h: HarnessResult) {
  const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
  frame(h);
  const drawn = Object.keys(map.alpha).map(id => nodeById[id]).filter((n: any) => n && map.alpha[n.id] > 0 && n._tv != null);
  expect(drawn.length).toBeGreaterThan(1);
  drawn.forEach((n: any) => expect([n.id, n._R]).toEqual([n.id, plain(CAM, n)]));
  return drawn;
}
/** One frame drawn with C4PM_CAM.leafCard switched off (b858 S2), everything else as it is. */
function frameNoCard(h: HarnessResult) {
  const CAM = win(h).C4PM_CAM, card = CAM.leafCard;
  CAM.leafCard = () => null;
  try { return frame(h); } finally { CAM.leafCard = card; }
}

describe('b858 S1: a following file box fills its parent body (camera.js followFill, render.js drawRegion)', () => {
  it('the function lies inside its component and is more than 1.5 times wider than with the fill off (map.edit)', () => {
    const { h, map, CAM, fn, cls, file, comp } = followed();
    expect([comp.children.length, file.children.length]).toEqual([1, 1]);   // the file and the class are only children
    expect(cls.children).toContain(fn);
    frame(h);
    const on: Rect = { ...fn._R };
    const card = CAM.leafCard(fn) || fn.bubble;   // S2: the leaf is drawn as its card
    expect(inside(on, comp._R)).toBe(true);
    map.edit = true;
    frame(h);
    const off: Rect = { ...fn._R };
    map.edit = false;
    expect(on.w).toBeGreaterThan(1.5 * off.w);
    expect(on.h / on.w).toBeCloseTo(card.h / card.w);   // a uniform scale: the drawn box keeps its world shape
  });

  it('CAM.hitTest at the centre of the drawn function returns the function', () => {
    const { h, CAM, fn } = followed();
    frame(h);
    const R = fn._R;
    expect(CAM.hitTest(R.x + R.w / 2, R.y + R.h / 2)).toBe(fn);
  });

  it('no s-item: every drawn node keeps the plain rect toScreen(bubble || n, n, _tv) (nothing changes for unlit boxes)', () => {
    const h = load();
    settle(h);
    const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
    expectPlainRects(h);                         // the whole map
    map.autoLevel = true;
    map.cam = CAM.fitCam(nodeById['api/services'], 0.3);
    for (let i = 0; i < 60; i++) frame(h);
    expectPlainRects(h);                         // the component of CREATE at 30%, not lit: nothing follows
  });

  it('map.edit on: the fill is off, the function and its boxes get the plain rect', () => {
    const { h, map, CAM, fn, cls, file } = followed();
    map.edit = true;
    frame(h);
    [fn, cls, file].forEach((n: any) => expect([n.id, n._R]).toEqual([n.id, plain(CAM, n)]));
    expect(file._D).toBeNull();
  });

  it('the function name is drawn with the fill, and not with the fill off', () => {
    const { h, map, fn } = followed();
    expect(frame(h).text).toContain(fn.name);
    map.edit = true;
    expect(frame(h).text).not.toContain(fn.name);
  });
});

describe('b858 S2: a leaf of a following box is drawn as its slot-sized card (camera.js leafCard, render.js stepNode)', () => {
  it('the leaf is wider than with the card off and than in edit mode, by the card ratio, and stays inside its parent', () => {
    const { h, map, fn, cls, comp } = followed();
    expect(cls._tv).toBe(1);                                 // the class is fully open: the card has its full size
    frame(h);
    const on: Rect = { ...fn._R };
    expect(inside(on, cls._R)).toBe(true);                   // the parent's drawn (filled) rect
    expect(inside(on, comp._R)).toBe(true);
    frameNoCard(h);
    const noCard: Rect = { ...fn._R };
    map.edit = true;
    frame(h);
    const edit: Rect = { ...fn._R };
    map.edit = false;
    // the card is the leaf's layout box inset by GAP 15 (parent units): 270x120 against the 170x64 bean, both x parent scale
    const m = 15 * cls.scale;
    expect(on.w / noCard.w).toBeCloseTo((fn.w - 2 * m) / fn.bubble.w, 5);
    expect(on.h / noCard.h).toBeCloseTo((fn.h - 2 * m) / fn.bubble.h, 5);
    expect(on.w / noCard.w).toBeGreaterThan(1.5);
    expect(on.w).toBeGreaterThan(on.w / noCard.w * edit.w);   // the card on top of the S1 fill
  });

  it('the leaf name is drawn where the plain bubble under the fill is too small for it (component at 27%)', () => {
    const { h, fn, cls } = followed(0.27);
    expect(cls._tv).toBeGreaterThan(0.5);
    expect(cls._tv).toBeLessThan(1);                         // half open: the card is blended by the parent's openness
    expect(frame(h).text).toContain(fn.name);
    expect(frameNoCard(h).text).not.toContain(fn.name);
  });

  it('no s-item: no node has a card and every drawn node keeps the plain rect', () => {
    const h = load();
    settle(h);
    const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
    map.autoLevel = true;
    map.cam = CAM.fitCam(nodeById[CREATE].parent, 0.8);     // zoomed in on CREATE's class: its methods drawn
    for (let i = 0; i < 60; i++) frame(h);
    const drawn = expectPlainRects(h);
    expect(drawn.map((n: any) => n.id)).toContain(CREATE);
    expect(Object.keys(nodeById).filter(id => CAM.leafCard(nodeById[id]))).toEqual([]);
  });

  it('map.edit on: no card, the leaf gets the plain bubble rect', () => {
    const { h, map, CAM, fn } = followed();
    map.edit = true;
    frame(h);
    expect(CAM.leafCard(fn)).toBeNull();
    expect(fn._R).toEqual(plain(CAM, fn));
  });

  it('a leaf whose parent does not follow (the class not lit, inside a filled file): no card, its rect is unchanged', () => {
    const { h, map, CAM, fn, cls, file } = followed(0.8, false, f => f.parent);   // the class open on its own zoom
    frame(h);
    expect([CAM.follows(file), CAM.follows(cls)]).toEqual([true, false]);
    expect(map.alpha[fn.id]).toBeGreaterThan(0.5);
    expect(cls._tv).toBeGreaterThan(0.5);
    expect(CAM.leafCard(fn)).toBeNull();
    const W = fn._W, k = W.w / fn.w;                         // the file's fill transform, read back from the drawn world rect
    const T = { k, dx: W.x - fn.x * k, dy: W.y - fn.y * k };
    const want = CAM.toScreen(CAM.xf(T, fn.bubble), W, fn._tv);
    (['x', 'y', 'w', 'h'] as const).forEach(p => expect(fn._R[p]).toBeCloseTo(want[p], 6));
  });
});

/** C4PM_MAP.flyTo(id) with CAM.fitCam spied: the rects it was asked to fit (flyTo itself is stubbed, no animation). */
function flownRects(h: HarnessResult, id: string): Rect[] {
  const CAM = win(h).C4PM_CAM, fit = CAM.fitCam, fly = CAM.flyTo, got: Rect[] = [];
  CAM.fitCam = (r: Rect, ...a: any[]) => { got.push({ x: r.x, y: r.y, w: r.w, h: r.h }); return fit(r, ...a); };
  CAM.flyTo = () => {};
  try { MAP(h).flyTo(id); } finally { CAM.fitCam = fit; CAM.flyTo = fly; }
  return got;
}

describe('b858 S3: dive and fly go to where a box is drawn (camera.js worldOf, map.js flyTo, controls.js dive)', () => {
  it('with the fill on, C4PM_MAP.flyTo fits the drawn world rect fn._W, not the function own rect', () => {
    const { h, map, CAM, fn } = followed();
    frame(h);
    expect(map.alpha[fn.id]).toBeGreaterThan(0);
    expect(fn._W).toBeTruthy();
    expect(CAM.worldOf(fn)).toBe(fn._W);
    const got = flownRects(h, fn.id);
    expect(got).toEqual([{ x: fn._W.x, y: fn._W.y, w: fn._W.w, h: fn._W.h }]);
    expect(got[0]).not.toEqual({ x: fn.x, y: fn.y, w: fn.w, h: fn.h });
  });

  it('no s-item: worldOf(n) is n for every node (no _W) and flyTo fits the own rect', () => {
    const h = load();
    settle(h);
    const { map, nodeById } = state(h), CAM = win(h).C4PM_CAM;
    map.autoLevel = true;
    map.cam = CAM.fitCam(nodeById['api/services'], 0.3);
    for (let i = 0; i < 60; i++) frame(h);
    Object.values(nodeById).forEach((n: any) => { expect([n.id, CAM.worldOf(n) === n]).toEqual([n.id, true]); });
    const fn = nodeById[CREATE];
    expect(flownRects(h, CREATE)).toEqual([{ x: fn.x, y: fn.y, w: fn.w, h: fn.h }]);
  });

  it('map.edit on: worldOf(fn) is fn', () => {
    const { h, map, CAM, fn } = followed();
    map.edit = true;
    frame(h);
    expect(CAM.worldOf(fn)).toBe(fn);
  });
});
