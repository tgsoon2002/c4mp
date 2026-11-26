import { renderViewHtml } from '../src/page/html';
import { buildNavView } from '../src/view/navLayout';
import { buildViewSims } from '../src/view/simModel';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { CREATE } from './helpers/sim-view';
import type { NavEntry, NavModel, NavPart, SimItem } from '../src/types';

// Phase 25 UI9 (b759): viewer/sim-map.js drawSimIo, the IO overlay of the selected s-item (amber rings, numbered circles,
// teal arcs between IO steps on different entries with "via" pills), and ioView.js while an s-item is selected: unlit
// entries fade to 0.3 (dc.hi = simHi), the navigation arrows dim to 0.16 (dc.simOn), entryEnd draws no second ring.
// The page: one web app (home with region hero > control go, cart with region list > control row, about) and a mobile
// app (start); s-9 = 1 io home, 2-3 arch, 4 io cart.list.row, 5 io cart, 6 arch, 7 io home again, 8 io home.hero.go; s-8 = two arch steps (nothing lit in io).

const BGLOW = '#FFB020';
const FLOW = '#0E9F01', PANEL = '#F0F0F3', EDGE = '#E10004', INK = '#111112';
const COLORS: Record<string, string> = {
  '--accent': '#ACC0FF', '--findings': '#FE0001', '--bp': '#B10001', '--muted': '#B30003', '--edge': EDGE, '--c2': '#C20002',
  '--screen': '#5B4FC9', '--flow': FLOW, '--unver': '#C77702', '--panel': PANEL, '--ink': INK,
};

const part = (fqn: string, kind: string, parts: NavPart[] = []): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts });
const screen = (fqn: string, rank: number, parts: NavPart[] = []): NavEntry => ({ kind: 'screen', fqn, uid: null, title: fqn.split('.').pop()!, status: null, rank, order: 0, parent: null, parts });
const NAV: NavModel = {
  groups: [
    { fqn: 'w', title: 'Web', technology: 'React', word: 'App', entries: [
      screen('w.home', 0, [part('w.home.hero', 'region', [part('w.home.hero.go', 'control')])]),
      screen('w.cart', 1, [part('w.cart.list', 'region', [part('w.cart.list.row', 'control')])]),
      screen('w.about', 2),
    ] },
    { fqn: 'm', title: 'Mobile', technology: 'React Native', word: 'App', entries: [screen('m.start', 0)] },
  ],
  edges: [
    { from: 'w.home', to: 'w.cart', label: 'Go on', labelled: true, via: 'w.home.hero.go' },
    { from: 'w.home', to: 'm.start', label: 'Open the app', labelled: true, via: null },
  ],
  calls: [],
};

const IO = (fqn: string) => ({ target: [fqn], view: 'io' as const });
const ARCH = (ref: string) => ({ target: [ref], view: 'arch' as const });
const SIMS: SimItem[] = [{
  schemaVersion: 1, id: 's-9', kind: 'flow', title: 'Shop around',
  steps: [IO('w.home'), ARCH('api/routes'), ARCH(CREATE), IO('w.cart.list.row'), IO('w.cart'), ARCH('api/routes'), IO('w.home'), IO('w.home.hero.go')],
}, {
  schemaVersion: 1, id: 's-8', kind: 'flow', title: 'Backend only',   // lights nothing in the io view
  steps: [ARCH('api/routes'), ARCH(CREATE)],
}];

function load(): HarnessResult {
  const m = loadSample();
  m.nav = NAV;
  m.navView = buildNavView(NAV);
  m.sims = buildViewSims(m, { items: SIMS, findings: [], fileOf: id => `.c4pm/projects/x/sim/${id}.json`, keysOf: ref => ({ uid: null, ids: [ref] }) });
  const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
  const h = runViewerScripts(renderViewHtml(m), {
    extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'],
    globals: { getComputedStyle, location: { href: 'file:///x.html#io', hash: '#io' } },
  });
  h.frames.runToCompletion();
  const w = win(h);
  w.C4PM_STATE.map.cam = w.C4PM_CAM.fitCam(w.C4PM_MAP.nodeById('w'), 0.9);   // the web app fills the view
  return h;
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;

interface Circle { x: number; y: number; r: number; fill: string }
interface Curve { style: string; alpha: number; lineWidth: number }
/** One frame of the harness map; returns its fill/stroke ops, texts, the circles (ctx.arc) and the bezier curves drawn. */
function frame(h: HarnessResult) {
  const ctx = win(h).C4PM_STATE.map.ctx;
  const circles: Circle[] = [], curves: Curve[] = [];
  ctx.arc = (x: number, y: number, r: number) => { circles.push({ x, y, r, fill: String(ctx.fillStyle) }); };
  ctx.bezierCurveTo = () => { curves.push({ style: String(ctx.strokeStyle), alpha: Number(ctx.globalAlpha), lineWidth: Number(ctx.lineWidth) }); };
  h.opLog.length = 0;
  h.fillTextLog.length = 0;
  win(h).C4PM_MAP.draw();
  return { ops: h.opLog.slice(), text: h.fillTextLog.slice(), circles, curves };
}
/** The screen rect of an io id (C4PM_IOVIEW.rect through map.cam). */
function scr(h: HarnessResult, id: string) {
  const w = win(h), r = w.C4PM_IOVIEW.rect(id), c = w.C4PM_STATE.map.cam;
  return { x: r.x * c.s + c.tx, y: r.y * c.s + c.ty, w: r.w * c.s, h: r.h * c.s };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('drawSimIo: rings and numbered circles', () => {
  it('nothing sim is drawn without an s-item', () => {
    const h = load();
    const { ops, circles, text } = frame(h);
    expect(ops.filter(o => o.style === BGLOW)).toEqual([]);
    expect(circles.filter(c => c.fill === FLOW)).toEqual([]);
    expect(text.filter(t => t.startsWith('via '))).toEqual([]);
  });

  it('one amber ring (2.5) and one teal circle per lit target and step; entryEnd adds no ring of its own', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    const { ops, circles, text } = frame(h);
    const rings = ops.filter(o => o.op === 'stroke' && o.style === BGLOW);
    expect(rings).toHaveLength(5);   // home (1), cart.list.row (4), cart (5), home (7), home.hero.go (8)
    expect(rings.every(o => o.lineWidth === 2.5 && o.alpha === 1)).toBe(true);   // no width-3 entryEnd ring
    const nums = circles.filter(c => c.fill === FLOW);
    expect(nums).toHaveLength(5);
    expect(nums.every(c => c.r === 10.5)).toBe(true);
    expect(text).toEqual(expect.arrayContaining(['1', '4', '5', '7', '8']));
  });

  it('circle positions: an entry left of its frame (y + 10), a part on its corner, a repeated target 24 px right', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    const { circles } = frame(h);
    const at = (x: number, y: number) => circles.some(c => c.fill === FLOW && near(c.x, x) && near(c.y, y));
    const home = scr(h, 'w.home'), go = scr(h, 'w.home.hero.go'), row = scr(h, 'w.cart.list.row');
    expect(at(home.x - 6 - 14, home.y + 10)).toBe(true);        // step 1
    expect(at(home.x - 6 - 14 + 24, home.y + 10)).toBe(true);   // step 7: home again
    expect(at(go.x - 3 + 2, go.y - 3)).toBe(true);              // step 8: a control (pad 3)
    expect(at(row.x - 3 + 2, row.y - 3)).toBe(true);            // step 4
  });

  it('with a cursor: the current ring 4 wide and its circle amber (r 12); the others at 0.55', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    SIM(h).go(4);   // step 5: cart
    const { ops, circles } = frame(h);
    const rings = ops.filter(o => o.op === 'stroke' && o.style === BGLOW);
    expect(rings.filter(o => o.lineWidth === 4)).toEqual([expect.objectContaining({ alpha: 1 })]);
    expect(rings.filter(o => o.lineWidth === 2.5).every(o => o.alpha === 0.55)).toBe(true);
    const cart = scr(h, 'w.cart');
    expect(circles).toContainEqual({ x: cart.x - 20, y: cart.y + 10, r: 12, fill: BGLOW });
  });
});

describe('drawSimIo: arcs and via pills', () => {
  it('an arc between IO steps on different screens, none on the same screen; the gaps get "via 2–3" and "via 6"', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    const { curves, text } = frame(h);
    expect(curves.filter(c => c.style === FLOW)).toHaveLength(2);   // 1 -> 4 (home -> cart), 5 -> 7 (cart -> home); 4 -> 5 and 7 -> 8 share a screen
    expect(curves.filter(c => c.style === FLOW).every(c => c.lineWidth === 2.6 && c.alpha === 1)).toBe(true);
    expect(text).toContain('via 2–3 (other views)');
    expect(text).toContain('via 6 (other views)');
    expect(text.filter(t => t.startsWith('via '))).toHaveLength(2);
  });

  it('with a cursor the arc into the current step is 4 wide, the others at 0.5', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    SIM(h).go(6);   // step 7: the arc 5 -> 7 is current
    const arcs = frame(h).curves.filter(c => c.style === FLOW);
    expect(arcs).toEqual([expect.objectContaining({ lineWidth: 2.6, alpha: 0.5 }), expect.objectContaining({ lineWidth: 4, alpha: 1 })]);
  });
});

describe('ioView while an s-item is selected', () => {
  it('the navigation arrows (drawNav inside the app, drawCross between apps) dim to 0.16, back to 1 after clearing', () => {
    const h = load();
    const edges = () => frame(h).ops.filter(o => o.op === 'stroke' && o.style === EDGE);
    expect(edges().length).toBeGreaterThanOrEqual(2);
    expect(edges().every(o => o.alpha === 1)).toBe(true);
    SIM(h).select('s-9', { fit: false });
    expect(edges().length).toBeGreaterThanOrEqual(2);
    expect(edges().every(o => o.alpha === 0.16)).toBe(true);
    SIM(h).select(null);
    expect(edges().every(o => o.alpha === 1)).toBe(true);
  });

  it('an unlit screen draws at alpha 0.3, a lit one (or the one holding a lit part) at 1', () => {
    const h = load();
    SIM(h).select('s-9', { fit: false });
    const io = ioDraw(h);
    io.draw();
    expect(io.title('about')).toMatchObject({ a: 0.3 });
    expect(io.title('home')).toMatchObject({ a: 1 });
    expect(io.title('cart')).toMatchObject({ a: 1 });   // lit itself (step 5) and holds the lit row (step 4)
    io.map.sim = null;
    io.draw();
    expect(io.title('about')).toMatchObject({ a: 1 });
  });

  it('an s-item that lights nothing in the io view (arch steps only): no entry fades, the arrows keep alpha 1', () => {
    const h = load();
    SIM(h).select('s-8', { fit: false });
    expect(win(h).C4PM_STATE.map.sim.ids.size).toBe(0);
    const io = ioDraw(h);
    io.draw();
    expect(io.said.length).toBeGreaterThan(0);
    expect(io.said.filter(x => x.a === 0.3)).toEqual([]);
    ['home', 'cart', 'about', 'start'].forEach(t => expect(io.title(t)).toMatchObject({ a: 1 }));
    const edges = frame(h).ops.filter(o => o.op === 'stroke' && o.style === EDGE);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.every(o => o.alpha === 1)).toBe(true);
  });
});

/** C4PM_IOVIEW.draw into a ctx that keeps save / restore (the harness canvas does not): the alpha each text is written with. */
function ioDraw(h: HarnessResult) {
  const w = win(h);
  const said: Array<{ t: string; a: number }> = [];
  const stack: number[] = [];
  let alpha = 1;
  const ctx: any = new Proxy({}, {
    get: (t: any, k: string) => {
      if (k === 'globalAlpha') return alpha;
      if (k === 'save') return () => stack.push(alpha);
      if (k === 'restore') return () => { alpha = stack.length ? stack.pop()! : 1; };
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 });
      if (k === 'fillText') return (s: string) => said.push({ t: String(s), a: alpha });
      return k in t ? t[k] : () => undefined;
    },
    set: (t: any, k: string, v: any) => { if (k === 'globalAlpha') alpha = v; else t[k] = v; return true; },
  });
  const map = { ...w.C4PM_STATE.map, ctx };
  return {
    map, said,
    draw: () => { said.length = 0; w.C4PM_IOVIEW.draw(map, w.C4PM_RENDER.theme.readColors(), 0); },
    title: (t: string) => said.find(x => x.t === t),
  };
}
