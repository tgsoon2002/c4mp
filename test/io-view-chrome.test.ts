import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { chromeInstalled, runChrome } from './helpers/chrome';
import { makeRepo } from './helpers/planEditHarness';
import { privatePlanDir } from './helpers/privateRepo';

// Real Chrome, Shop fixture (test/fixtures/io-shop): at Fit in #io the four frames are drawn (the --screen stroke is on each
// frame edge) and a double-click on the Products screen flies the camera so that screen fills most of the map.
// Skipped when Chrome is missing. The page is driven by synthetic pointer events on the canvas; the result comes back in the dumped DOM.

const FIXTURE = path.resolve(__dirname, 'fixtures', 'io-shop');
const PRODUCTS = 'shop.web.products';
const chromeIt = chromeInstalled ? it : it.skip;

interface Frame { id: string; rect: { x: number; y: number; w: number; h: number }; edge: number[][]; }
interface Result {
  err?: string; cw: number; ch: number; screen: string; stroke: number[];
  frames: Frame[];
  dbl: { hitId: string | null; s0: number; s1: number; rect: { x: number; y: number; w: number; h: number } | null; fill: number; inside: boolean } | null;
}

// Runs after load. Frame edge = the pixels around the middle of the frame's left edge (a stroke 2 px wide, anchored on the rect).
const SCRIPT = `(function(){
window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 50); };
window.cancelAnimationFrame = function(id){ clearTimeout(id); };
var out = { err: null, frames: [], dbl: null };
var finish = function(){ var pre = document.createElement('pre'); pre.id = '__m'; pre.textContent = encodeURIComponent(JSON.stringify(out)); document.body.appendChild(pre); };
// b840: wait for the camera and the first draw (map.cam is null until the first resize; V.hit reads lastHits, filled only by draw) instead of trusting the 1500 ms timer
var ready = function(go, n){ var s = window.C4PM_STATE; if ((s && s.map && s.map.cam && !s.map.raf) || n <= 0) go(); else setTimeout(function(){ ready(go, n - 1); }, 100); };
setTimeout(function(){ ready(function(){ try {
  var st = window.C4PM_STATE, V = window.C4PM_IOVIEW, d = window.C4PM_DATA, m = st.map, cv = m.canvas;
  var dpr = window.devicePixelRatio || 1, cx = cv.getContext('2d');
  out.cw = m.cw; out.ch = m.ch;
  var col = getComputedStyle(document.documentElement).getPropertyValue('--screen').trim();
  var probe = document.createElement('canvas').getContext('2d'); probe.fillStyle = col; probe.fillRect(0, 0, 1, 1);
  out.screen = col; out.stroke = Array.prototype.slice.call(probe.getImageData(0, 0, 1, 1).data, 0, 3);
  var px = function(x, y){ return Array.prototype.slice.call(cx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data, 0, 3); };
  d.nav.groups.forEach(function(g){
    var r = V.rect(g.fqn), x = r.x * m.cam.s + m.cam.tx, y = (r.y + r.h / 2) * m.cam.s + m.cam.ty, edge = [];
    for (var dx = -3; dx <= 3; dx++) edge.push(px(x + dx, y));
    out.frames.push({ id: g.fqn, rect: r, edge: edge });
  });
  // double-click on the Products screen: a point inside its rect that ioView.hit says belongs to it
  var s0 = m.cam.s, R = V.rect('${PRODUCTS}'), hit = null, at = null;
  for (var i = 1; i < 20 && !hit; i++) for (var j = 1; j < 20 && !hit; j++) {
    var sx = (R.x + R.w * i / 20) * m.cam.s + m.cam.tx, sy = (R.y + R.h * j / 20) * m.cam.s + m.cam.ty, h = V.hit(sx, sy);
    if (h && h.id === '${PRODUCTS}') { hit = h; at = { x: sx, y: sy }; }
  }
  if (!hit) { out.err = 'no point of the Products rect hits it'; finish(); return; }
  cv.setPointerCapture = function(){};
  var b = cv.getBoundingClientRect();
  var fire = function(t){ cv.dispatchEvent(new PointerEvent(t, { pointerId: 1, clientX: b.left + at.x, clientY: b.top + at.y, bubbles: true })); };
  fire('pointerdown'); fire('pointerup'); fire('pointerdown'); fire('pointerup');
  setTimeout(function(){ try {
    var s1 = m.cam.s, r = V.rect('${PRODUCTS}'), w = r.w * s1, h2 = r.h * s1;
    var l = r.x * s1 + m.cam.tx, t = r.y * s1 + m.cam.ty;
    out.dbl = { hitId: hit.id, s0: s0, s1: s1, rect: r, fill: Math.max(w / m.cw, h2 / m.ch),
      inside: l >= -1 && t >= -1 && l + w <= m.cw + 1 && t + h2 <= m.ch + 1 };
  } catch (e) { out.err = String(e); } finish(); }, 3000);
} catch (e) { out.err = String(e && e.stack || e); finish(); } }, 100); }, 1500);
})();`;

// W15 (b311): runs before the page's own scripts and keeps every console.error and uncaught error (window.__errs), so a case can
// require a page that loaded without one.
const ERRS = `<script>window.__errs = [];
(function(){ var ce = console.error; console.error = function(){ window.__errs.push(Array.prototype.map.call(arguments, String).join(' ')); return ce.apply(console, arguments); };
window.addEventListener('error', function(e){ window.__errs.push('error: ' + (e.message || e.type)); });
window.addEventListener('unhandledrejection', function(e){ window.__errs.push('unhandled: ' + String(e.reason)); }); })();</script>`;

// The built page of `repo` at #io with `script` added after the page scripts; the object the script dumped into <pre id="__m">.
function inChrome<T>(repo: string, script: string, size = '1400,900'): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-io-chrome-'));
  try {
    const html = buildView({ repo }).html;
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, html.replace('<head>', () => `<head>${ERRS}`).replace('</body>', () => `<script>${script}</script></body>`));
    const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=24000', `--window-size=${size}`, `file://${file}#io`]);
    const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
    if (!m) throw new Error('measurement element not found in dumped DOM');
    return JSON.parse(decodeURIComponent(m[1]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const run = (): Result => inChrome<Result>(FIXTURE, SCRIPT);

// ---- W15 (b311): the wireframes on the built page (plan rows C9, C10)
interface Rect { x: number; y: number; w: number; h: number }
interface Wire { state: string; reason?: string; viewport?: { w: number; h: number } }
interface Box { ref: string; x: number; y: number; w: number; h: number; hidden: boolean; order: number }

// Collects, after load: the wireframe state, frame rect and part rects of the given screens, ref -> fqn of each screen's wireframe
// (entry.wireframe.refs, the C1 resolver's output on the page), placed() of the given parts, the scale constants and the page errors.
const wireScript = (screens: string[], parts: string[]) => `(function(){
var out = { err: null };
var finish = function(){ out.errs = window.__errs; var pre = document.createElement('pre'); pre.id = '__m'; pre.textContent = encodeURIComponent(JSON.stringify(out)); document.body.appendChild(pre); };
setTimeout(function(){ try {
  var V = window.C4PM_IOVIEW, S = window.C4PM_IO_SCREENS, d = window.C4PM_DATA, screens = ${JSON.stringify(screens)};
  out.WORLD_PER_PX = S.WORLD_PER_PX; out.TB = S.TB; out.wire = {}; out.frame = {}; out.refs = {}; out.rect = {}; out.placed = {};
  var entries = {}; d.nav.groups.forEach(function(g){ g.entries.forEach(function(e){ entries[e.fqn] = e; }); });
  screens.forEach(function(s){
    out.wire[s] = V.wireOf(s); out.frame[s] = V.rect(s); out.refs[s] = {};
    var e = entries[s];
    if (e && e.wireframe && e.wireframe.refs) e.wireframe.refs.forEach(function(r){ out.refs[s][r.ref] = { fqn: r.fqn, problem: r.problem || null };
      if (r.fqn) out.rect[r.fqn] = V.rect(r.fqn); });
  });
  ${JSON.stringify(parts)}.forEach(function(p){ out.placed[p] = V.placed(p); out.rect[p] = V.rect(p); });
} catch (e) { out.err = String(e && e.stack || e); } finish(); }, 1500);
})();`;

const PLAN = privatePlanDir() ?? '';   // C4PM's own plan; none in the public tree, where its block below skips (b985)
const WFX = path.resolve(__dirname, 'fixtures', 'io-wireframe');
const MAP = 'c4mp.c4mp.map_page', IOV = 'c4mp.c4mp.io_view', OWN = 'c4mp.c4mp.own_window';

// A throw-away repo with only C4PM's plan (its .c4 files and io/): the IO view needs the plan only, so no source is scanned.
function c4pmPlanRepo(): string {
  const c4 = fs.readdirSync(PLAN).filter(n => n.endsWith('.c4')).sort();
  expect(c4).toEqual(['architecture.c4', 'c4pm.c4', 'io.c4', 'storage.c4']);
  const { root, planDir } = makeRepo('c4pm-w15-', Object.fromEntries(c4.map(n => [n, fs.readFileSync(path.join(PLAN, n), 'utf8')])));
  fs.cpSync(path.join(PLAN, 'io'), path.join(planDir, 'io'), { recursive: true });
  return root;
}

const TOL = 0.01;   // world units
const union = (bs: Rect[]): Rect => {
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
  return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
};
const off = (a: Rect, b: Rect) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

const near = (a: number[], b: number[], tol: number) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;

describe('IO view in real Chrome (Shop fixture)', () => {
  chromeIt('Fit draws the four frames; a double-click on Products makes that screen fill the map', () => {
    const r = run();
    expect(r.err).toBeNull();
    expect(r.frames.map(f => f.id)).toEqual(['shop.web', 'shop.cli', 'shop.api', 'shop.mcp']);
    for (const f of r.frames) {
      expect(f.rect.w).toBeGreaterThan(0);
      expect(f.edge.some(p => near(p, r.stroke, 20))).toBe(true);   // the --screen stroke is on the frame edge
      expect(near(f.edge[0], r.stroke, 20)).toBe(false);          // and not 3 px outside it
    }
    expect(r.dbl!.hitId).toBe(PRODUCTS);
    expect(r.dbl!.s1).toBeGreaterThan(r.dbl!.s0 * 2);
    expect(r.dbl!.fill).toBeGreaterThan(0.5);
    expect(r.dbl!.inside).toBe(true);
  }, 120000);

  chromeIt('W15: Home is drawn from its wireframe, Login / Products / Cart (no file) are not; the hero sits in the Home frame', () => {
    const HOME = 'shop.web.home', HERO = 'shop.web.home.hero';
    const r = inChrome<any>(FIXTURE, wireScript([HOME, 'shop.web.login', 'shop.web.products', 'shop.web.cart'], [HERO]));
    expect(r.err).toBeNull();
    expect(r.errs).toEqual([]);
    expect({ fqn: HOME, ...r.wire[HOME] }).toMatchObject({ fqn: HOME, state: 'ok' });   // the reason shows when it is not ok
    for (const s of ['shop.web.login', 'shop.web.products', 'shop.web.cart']) expect({ fqn: s, state: r.wire[s].state }).toEqual({ fqn: s, state: 'none' });
    const f: Rect = r.frame[HOME], h: Rect = r.rect[HERO];
    expect(r.placed[HERO]).toEqual({ boxes: 1, hidden: false });
    expect(h.x).toBeGreaterThanOrEqual(f.x);
    expect(h.y).toBeGreaterThanOrEqual(f.y + r.TB);                    // below the title row
    expect(h.x + h.w).toBeLessThanOrEqual(f.x + f.w + TOL);
    expect(h.y + h.h).toBeLessThanOrEqual(f.y + f.h + TOL);
  }, 120000);
});

// Private plan only: the public tree has no ../.c4mp, so the block is skipped there (b963, b985).
(PLAN ? describe : describe.skip)('IO view in real Chrome (C4PM plan, W15 b311)', () => {
  chromeIt('every box of the Map page golden (1280x800) is at frame + (TB + box x WORLD_PER_PX) x the row scale; columns; all three screens drawn', () => {
    // the wireframe files of the plan are the golden's sources, byte for byte
    expect(fs.readFileSync(path.join(PLAN, 'io', `${MAP}.html`)).equals(fs.readFileSync(path.join(WFX, 'map_page.html')))).toBe(true);
    expect(fs.readFileSync(path.join(PLAN, 'io', 'site.css')).equals(fs.readFileSync(path.join(WFX, 'site.css')))).toBe(true);
    const golden = (JSON.parse(fs.readFileSync(path.join(WFX, 'map_page.golden.json'), 'utf8')) as Record<string, Box[]>)['1280x800'];
    const root = c4pmPlanRepo();
    let r: any;
    try {
      r = inChrome<any>(root, wireScript([MAP, IOV, OWN], [`${MAP}.board_drawer`]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(r.err).toBeNull();
    expect(r.errs).toEqual([]);
    for (const s of [MAP, IOV, OWN]) expect({ fqn: s, ...r.wire[s] }).toMatchObject({ fqn: s, state: 'ok', viewport: { w: 1280, h: 800 } });
    expect(r.WORLD_PER_PX).toBe(0.25);
    expect(r.TB).toBe(24);

    // golden box -> rect of its part (a ref on several elements: the union of its boxes). b607: C4PM's app has commands, so its screens row
    // is scaled up by k (the same k for the frame and every box of it): the frame is 1280 x WORLD_PER_PX x k wide
    const W = r.WORLD_PER_PX, F: Rect = r.frame[MAP], k = F.w / (1280 * W);
    expect(k).toBeGreaterThan(1);
    const byRef = new Map<string, Box[]>();
    for (const b of golden) byRef.set(b.ref, [...(byRef.get(b.ref) ?? []), b]);
    expect(golden.length).toBe(46);
    expect(byRef.size).toBe(45);
    const bad: unknown[] = [];
    for (const [ref, bs] of byRef) {
      const res = r.refs[MAP][ref];
      if (!res || !res.fqn || res.problem) { bad.push({ ref, resolved: res ?? null }); continue; }
      expect(res.fqn.startsWith(`${MAP}.`) && res.fqn.endsWith(`.${ref}`)).toBe(true);
      const want = union(bs.map(b => ({ x: F.x + k * b.x * W, y: F.y + k * (r.TB + b.y * W), w: k * b.w * W, h: k * b.h * W })));
      const got: Rect = r.rect[res.fqn];
      if (!got || off(got, want) > TOL) bad.push({ ref, fqn: res.fqn, got, want });
    }
    expect(bad).toEqual([]);
    // the named example: board_drawer 270, 452.25, 590, 347.75 px, hidden
    const bd: Rect = r.rect[`${MAP}.board_drawer`];
    expect(off(bd, { x: F.x + k * 270 * W, y: F.y + k * (r.TB + 452.25 * W), w: k * 590 * W, h: k * 347.75 * W })).toBeLessThanOrEqual(TOL);
    expect(r.placed[`${MAP}.board_drawer`]).toEqual({ boxes: 1, hidden: true });

    // W14 columns: the Map page left of the IO view and the Own window
    for (const s of [IOV, OWN]) expect({ s, left: F.x + F.w <= r.frame[s].x }).toEqual({ s, left: true });
  }, 180000);
});
