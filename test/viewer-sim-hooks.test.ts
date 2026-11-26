import * as fs from 'fs';
import * as path from 'path';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// Phase 25 UI4 (b754): the map hooks the simulation scripts build on. C4PM_STATE.post (post-draw functions), the pulse
// while map.sim is set, C4PM_CAM.fitCamIn (fit into a band of the map), map.openEarly (open at 20%), the sim colours
// of readColors / BGLOW_INK, the sim tokens in style.css and sim.css in the page. A page with no s-item looks as before.

const MARK = '#5EA1F0';   // the fill a test post fn paints, to find it in the opLog

function load(hash: string): HarnessResult {
  const loc = { href: 'file:///x.html' + hash, hash };
  return runViewerScripts(renderViewHtml(loadSample()), { extraIds: ['btn-gear', 'settings-pop'], globals: { location: loc } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
function settle(h: HarnessResult) {
  h.frames.runToCompletion();
  for (let i = 0; i < 60; i++) h.frames.flush();
}
// Pushes a post fn that paints MARK and records each call; returns the calls.
function pushMark(h: HarnessResult): Array<{ opsBefore: number; args: number }> {
  const calls: Array<{ opsBefore: number; args: number }> = [];
  win(h).C4PM_STATE.post.push((...a: any[]) => {
    const [map, C, now] = a;
    calls.push({ opsBefore: h.opLog.length, args: a.length });
    expect(map).toBe(win(h).C4PM_STATE.map);
    expect(typeof C.ink).toBe('string');
    expect(typeof now).toBe('number');
    map.ctx.fillStyle = MARK;
    map.ctx.fill();
  });
  return calls;
}

describe('state.js: the new fields start empty (no s-item, no visible change)', () => {
  // C4PM_STATE.post is shared: other features push their own hooks (viewState.js: the camera save). This page has no
  // s-item, so sim-map.js pushes nothing.
  it('map.sim, map.openEarly and map.openBand are null, C4PM_STATE.post is a list without the sim overlay', () => {
    const st = win(load('')).C4PM_STATE;
    expect(st.map.sim).toBeNull();
    expect(st.map.openEarly).toBeNull();
    expect(st.map.openBand).toBeNull();   // b786
    expect(Array.isArray(st.post)).toBe(true);
    expect(st.post.filter((f: { name: string }) => f.name === 'drawSimOverlay')).toEqual([]);
  });
});

describe('map.js draw: post-draw functions', () => {
  it.each([['arch', ''], ['io', '#io']])('%s: a pushed post fn runs once per frame, after the view drew', (mode, hash) => {
    const h = load(hash);
    expect(win(h).C4PM_MODE.get()).toBe(mode);
    settle(h);
    const calls = pushMark(h);
    h.opLog.length = 0;
    win(h).C4PM_STATE.requestDraw();
    h.frames.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBe(3);
    expect(calls[0].opsBefore).toBeGreaterThan(0);               // the view filled/stroked before the post fn ran
    expect(h.opLog[h.opLog.length - 1].style).toBe(MARK);       // nothing drawn on the canvas after it
    expect(h.opLog.filter(o => o.style === MARK)).toHaveLength(1);
    h.frames.flush();
    expect(calls).toHaveLength(1);                              // no frame, no call
  });

  it('the pulse keeps requesting frames while map.sim is set, and stops when it is cleared', () => {
    const h = load('');
    settle(h);
    const st = win(h).C4PM_STATE;
    const calls = pushMark(h);
    st.requestDraw();
    for (let i = 0; i < 6; i++) h.frames.flush();
    expect(calls).toHaveLength(1);                              // nothing lit: one frame only
    st.map.sim = { id: 's-1', step: null, view: 'arch', ids: new Map(), calls: [], list: [], cur: null };
    st.requestDraw();
    for (let i = 0; i < 6; i++) h.frames.flush();
    expect(calls.length).toBeGreaterThanOrEqual(3);             // draw -> pulse -> req -> draw ...
    st.map.sim = null;
    for (let i = 0; i < 4; i++) h.frames.flush();
    const n = calls.length;
    for (let i = 0; i < 6; i++) h.frames.flush();
    expect(calls).toHaveLength(n);
  });
});

describe('camera.js', () => {
  it('fitCamIn fits a rect into the band between top and bottom px', () => {
    const h = load('');
    const { map } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    map.cw = 1000; map.ch = 800;
    const r = { x: 0, y: 0, w: 100, h: 100 };
    expect(CAM.fitCamIn(r, 1, 100, 100)).toEqual({ s: 6, tx: 200, ty: 100 });    // band 600 px high, from y 100
    expect(CAM.fitCamIn(r, 1, 0, 0)).toEqual(CAM.fitCam(r, 1));                // no band = fitCam
    expect(CAM.fitCamIn({ x: 0, y: 0, w: 400, h: 100 }, 0.5, 50, 10)).toEqual({ s: 1.25, tx: 250, ty: 50 + 370 - 62.5 });
    map.ch = 200;
    expect(CAM.fitCamIn(r, 1, 100, 100)).toEqual({ s: 1.2, tx: 440, ty: 100 });  // the band is at least 120 px
  });

  it('openness: an id in map.openEarly opens at 20% of the screen and is full at 30%, the others at 45%', () => {
    const h = load('');
    const { map, data } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    const n = data.root.children.find((c: any) => c.children && c.children.length);
    const other = data.root.children.find((c: any) => c !== n && c.children && c.children.length) || data.root;
    map.autoLevel = true;
    map.cw = 1000; map.ch = 1000;
    const at = (f: number) => { map.cam = { s: f * 1000 / Math.max(n.w, n.h), tx: 0, ty: 0 }; return CAM.openness(n); };
    expect(at(0.3)).toBe(0);
    map.openEarly = new Set([n.id]);
    expect(at(0.25)).toBeCloseTo(0.5);    // b786-5: smooth((0.25 - 0.2) / 0.1)
    expect(at(0.3)).toBeCloseTo(1);       // b786-5: lit boxes fully open at 30% (was 0.5 with the 0.2 ramp)
    expect(at(0.45)).toBe(1);
    expect(at(0.15)).toBe(0);
    map.cam = { s: 0.3 * 1000 / Math.max(other.w, other.h), tx: 0, ty: 0 };
    expect(CAM.openness(other)).toBe(0);  // not in the set: still closed at 30%
    map.openEarly = null;
    expect(at(0.3)).toBe(0);
  });

  it('b786: a lit code box (file, class) inside a lit parent follows it (C4PM_CAM.follows) and opens as far as it', () => {
    const h = load('');
    const { map, nodeById } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    const comp = nodeById['api/services'];
    const file = nodeById['api/src/services/orderService.ts'];
    const cls = nodeById['api/src/services/orderService.ts#OrderService'];
    const fn = nodeById['api/src/services/orderService.ts#OrderService.create'];
    [comp, file, cls, fn].forEach(n => expect(n).toBeDefined());
    expect([comp.kind, file.kind, cls.kind]).toEqual(['component', 'file', 'class']);
    expect([file.parent, cls.parent, fn.parent]).toEqual([comp, file, cls]);
    map.autoLevel = true;
    map.cw = 1000; map.ch = 1000;
    map.cam = { s: 0.3 * Math.min(map.cw / comp.w, map.ch / comp.h), tx: 0, ty: 0 };   // the component's f = 0.3
    map.openEarly = new Set([comp.id, file.id, cls.id]);
    const o = CAM.openness(comp);
    expect(o).toBeGreaterThan(0.4);
    expect(CAM.openness(file)).toBeCloseTo(o);
    expect(CAM.openness(cls)).toBeCloseTo(o);
    expect(CAM.follows(file)).toBe(true);
    expect(CAM.follows(cls)).toBe(true);
    expect(CAM.follows(comp)).toBe(false);   // not a code box
    map.openEarly = new Set([file.id]);      // the parent is not lit
    expect(CAM.follows(file)).toBe(false);
    map.openEarly = null;
    expect(CAM.follows(file)).toBe(false);
    map.openEarly = new Set([comp.id, file.id, cls.id]);
    map.autoLevel = false;                   // Auto level off: the lockDepth rule, nothing follows
    expect(CAM.follows(file)).toBe(false);
    map.lockDepth = file.depth - 1;
    expect(CAM.openness(comp)).toBe(1);
    expect(CAM.openness(file)).toBe(0);
  });

  it('b858: followFill is null for a box whose parent has more than one child, and in edit mode', () => {
    const h = load('');
    const { map, nodeById } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    const all = Object.keys(nodeById).map(id => nodeById[id]);
    const twin = all.find((n: any) => n.children && n.children.length && n.parent && n.parent.children.length > 1);
    const only = all.find((n: any) => n.children && n.children.length && n.parent && n.parent.children.length === 1
      && CAM.followFill(n, null, 1));
    expect(twin).toBeDefined();
    expect(CAM.followFill(twin, null, 1)).toBeNull();
    expect(only).toBeDefined();                  // an only child with children: filled (the sample has one)
    const f = CAM.followFill(only, null, 1);
    expect(f.T.k).toBeGreaterThan(1);
    map.edit = true;
    expect(CAM.followFill(only, null, 1)).toBeNull();
    expect(CAM.xf(null, only)).toBe(only);
    expect(CAM.xf({ k: 2, dx: 1, dy: -1 }, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 3, y: 3, w: 6, h: 8 });
  });

  it('b858 S2: leafCard is the leaf box inset by GAP x parent scale, centred on the bubble, blended by the parent\'s _tv', () => {
    const h = load('');
    const { map, nodeById } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    const comp = nodeById['api/services'];
    const file = nodeById['api/src/services/orderService.ts'];
    const cls = nodeById['api/src/services/orderService.ts#OrderService'];
    const fn = nodeById['api/src/services/orderService.ts#OrderService.create'];
    map.autoLevel = true;
    map.openEarly = new Set([comp.id, file.id, cls.id]);
    cls._tv = 1;
    const m = 15 * cls.scale, b = fn.bubble, c = CAM.leafCard(fn);
    expect(c.w).toBeCloseTo(fn.w - 2 * m);
    expect(c.h).toBeCloseTo(fn.h - 2 * m);
    expect(c.x + c.w / 2).toBeCloseTo(b.x + b.w / 2);
    expect(c.y + c.h / 2).toBeCloseTo(b.y + b.h / 2);
    expect(c.w).toBeGreaterThan(b.w);
    cls._tv = 0.5;
    expect(CAM.leafCard(fn).w).toBeCloseTo((b.w + fn.w - 2 * m) / 2);   // half way from the bubble to the full card
    cls._tv = 0;
    expect(CAM.leafCard(fn)).toBeNull();     // no room to grow yet: the plain bubble
    cls._tv = 1;
    expect(CAM.leafCard(cls)).toBeNull();    // a box with children
    expect(CAM.leafCard(nodeById['api/src/routes/orders.ts#orderRoutes'])).toBeNull();   // its parent does not follow
    map.openEarly = new Set([comp.id, file.id]);
    expect(CAM.leafCard(fn)).toBeNull();     // the class is not lit: it does not follow
    map.openEarly = new Set([comp.id, file.id, cls.id]);
    map.edit = true;
    expect(CAM.leafCard(fn)).toBeNull();     // edit mode
  });

  it('b786: an early id measures against the visible band map.openBand (at least 120 px); the others against the map', () => {
    const h = load('');
    const { map, data } = win(h).C4PM_STATE, CAM = win(h).C4PM_CAM;
    const n = data.root.children.find((c: any) => c.children && c.children.length);
    const other = data.root.children.find((c: any) => c !== n && c.children && c.children.length) || data.root;
    map.autoLevel = true;
    map.cw = 100000; map.ch = 1000;           // the width never decides
    const tall = (m: any) => { map.cam = { s: 150 / m.h, tx: 0, ty: 0 }; return CAM.openness(m); };   // m.h on screen = 150 px
    expect(n.w * 150 / n.h).toBeLessThan(15000);
    map.openEarly = new Set([n.id]);
    map.openBand = null;
    expect(tall(n)).toBe(0);                  // 150 / 1000 = 0.15 < 0.2
    map.openBand = { top: 250, bottom: 250 };
    expect(tall(n)).toBeCloseTo(1);           // b786-5: 150 / 500 = 0.3: fully open at 30% (was 0.5)
    expect(tall(other)).toBe(0);              // not early: the whole map, 0.15 < 0.45
    map.openBand = { top: 200, bottom: 200 };
    expect(tall(n)).toBeCloseTo(0.5);         // b786-5: 150 / 600 = 0.25: smooth((0.25 - 0.2) / 0.1)
    map.openBand = { top: 500, bottom: 450 };
    expect(tall(n)).toBe(1);                  // band 50 px -> 120: 150 / 120 > 0.3 (b786-5: full at 30%)
  });
});

describe('render.js theme: the simulation colours', () => {
  it('readColors has flow, added, changed, unver; theme has BGLOW_INK', () => {
    const T = win(load('')).C4PM_RENDER.theme;
    const C = T.readColors();
    ['flow', 'added', 'changed', 'unver'].forEach(k => expect(typeof C[k]).toBe('string'));
    expect(T.BGLOW_INK).toBe('#2A1D00');
    expect(T.BGLOW).toBe('#FFB020');
  });
});

describe('style.css tokens and sim.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'style.css'), 'utf8');
  const block = (re: RegExp) => { const m = css.match(re); if (!m) throw new Error('token block not found: ' + re); return m[1]; };
  const blocks = {
    light: block(/^:root\s*\{([^}]*)\}/m),
    osDark: block(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
    dark: block(/^:root\[data-theme="dark"\]\s*\{([^}]*)\}/m),
  };
  const tok = (b: string, name: string) => { const m = b.match(new RegExp('\\s' + name + ':\\s*([^;]+);')); return m && m[1].trim(); };
  const want: Record<string, [string, string]> = {
    '--flow': ['#0E9F8E', '#36E2C9'], '--flow-ink': ['#FFFFFF', '#0F1514'], '--added': ['#2E9E5B', '#5FC596'],
    '--changed': ['#E0A100', '#FFC107'], '--unver': ['#C77700', '#FFB020'], '--lit': ['#FFB020', '#FFB020'],
  };
  it.each(Object.keys(want))('%s in all three token blocks (light / OS dark / dark)', (name) => {
    expect(tok(blocks.light, name)).toBe(want[name][0]);
    expect(tok(blocks.osDark, name)).toBe(want[name][1]);
    expect(tok(blocks.dark, name)).toBe(want[name][1]);
  });
  it.each(['--scrim', '--shadow-1', '--shadow-2'])('%s is the same in all three blocks', (name) => {
    const v = tok(blocks.light, name);
    expect(v).toBeTruthy();
    expect(tok(blocks.osDark, name)).toBe(v);
    expect(tok(blocks.dark, name)).toBe(v);
  });

  it('sim.css is in the page, after the board sheets and before panel.css, with the shared classes', () => {
    const html = renderViewHtml(loadSample());
    const at = (n: string) => html.indexOf(`/* ${n}:`);
    expect(at('sim.css')).toBeGreaterThan(at('board-dashboard.css'));
    expect(at('panel.css')).toBeGreaterThan(at('sim.css'));
    ['.vchip.io', '.vchip.arch', '.vchip.storage', '.vchip.out', '.vchip.unver', '.sim-ico', '.tbb.play', '.sim-rows tr.ins td', '.sim-rows td.chg']
      .forEach(sel => expect(html).toContain(sel + ' {'));
  });
});
