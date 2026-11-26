import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderViewHtml } from '../src/page/html';
import { chromeInstalled, runChrome } from './helpers/chrome';
import { storageModel, CLASS_ID, CLASSES_ID } from './helpers/storage-view';

// STOR-6a (b339): the storage view in real Chrome, Drizzle fixture (test/fixtures/schema-drizzle) at '#storage&bare'. The page does not
// carry C4PM_DATA.storageView yet (STOR-5w, b609), so the test puts buildStorageView's tree into the sample ViewModel (helpers/storage-view).
// Every arrows() entry starts and ends on a side of its row; enrollments.class_id ends on the id row of classes; the canvas pixel at an
// arrow's start dot (just outside its record, which is drawn over the arrows) has the --edge colour. Skipped when Chrome is missing.

const chromeIt = chromeInstalled ? it : it.skip;
type Rect = { x: number; y: number; w: number; h: number };
interface Arrow { from: string; to: string; label: string | null; x1: number; y1: number; x2: number; y2: number }
interface Result { err: string | null; errs: string[]; mode: string; arrows: Arrow[]; rects: Record<string, Rect>; edge: number[]; dot: number[] }

const ERRS = `<script>window.__errs = [];
(function(){ var ce = console.error; console.error = function(){ window.__errs.push(Array.prototype.map.call(arguments, String).join(' ')); return ce.apply(console, arguments); };
window.addEventListener('error', function(e){ window.__errs.push('error: ' + (e.message || e.type)); }); })();</script>`;

// After load: the arrows and the rects of their ends; then the camera at zoom 2 on the start of the enrollments.class_id arrow, one draw,
// and the pixel 2 world units outside the record on the dot (the dot has radius 2.6).
const SCRIPT = `(function(){
var out = { err: null, rects: {} };
var finish = function(){ out.errs = window.__errs; var pre = document.createElement('pre'); pre.id = '__m'; pre.textContent = encodeURIComponent(JSON.stringify(out)); document.body.appendChild(pre); };
setTimeout(function(){ try {
  var st = window.C4PM_STATE, V = window.C4PM_STORAGEVIEW, m = st.map, cv = m.canvas, dpr = window.devicePixelRatio || 1;
  out.mode = window.C4PM_MODE.get();
  out.arrows = V.arrows();
  out.arrows.forEach(function(a){ out.rects[a.from] = V.rect(a.from); out.rects[a.to] = V.rect(a.to); });
  var col = getComputedStyle(document.documentElement).getPropertyValue('--edge').trim();
  var probe = document.createElement('canvas').getContext('2d'); probe.fillStyle = col; probe.fillRect(0, 0, 1, 1);
  out.edge = Array.prototype.slice.call(probe.getImageData(0, 0, 1, 1).data, 0, 3);
  var a = out.arrows.filter(function(x){ return x.from === '${CLASS_ID}'; })[0], r = V.rect(a.from);
  var outward = Math.abs(a.x1 - (r.x + r.w)) < 1.5 ? 1 : -1, s = 2;
  m.cam = { s: s, tx: m.cw / 2 - a.x1 * s, ty: m.ch / 2 - a.y1 * s };
  m.selectedId = null; m.hi = null;
  st.draw(performance.now());
  var px = (a.x1 + outward * 2) * s + m.cam.tx, py = a.y1 * s + m.cam.ty;
  out.dot = Array.prototype.slice.call(cv.getContext('2d').getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data, 0, 3);
} catch (e) { out.err = String(e && e.stack || e); } finish(); }, 1500);
})();`;

function run(): Result {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-storage-chrome-'));
  try {
    const html = renderViewHtml(storageModel());
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, html.replace('<head>', () => `<head>${ERRS}`).replace('</body>', () => `<script>${SCRIPT}</script></body>`));
    const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=8000', '--window-size=1400,900', `file://${file}#storage&bare`]);
    const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
    if (!m) throw new Error('measurement element not found in dumped DOM');
    return JSON.parse(decodeURIComponent(m[1]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const near = (a: number[], b: number[], tol: number) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;
const onSide = (x: number, y: number, r: Rect) => (Math.abs(x - r.x) <= 1.5 || Math.abs(x - (r.x + r.w)) <= 1.5) && y > r.y && y < r.y + r.h;

describe('storage view in real Chrome (Drizzle fixture)', () => {
  chromeIt('arrows start and end on the sides of their rows; class_id -> classes.id; the start dot has the --edge colour', () => {
    const r = run();
    expect(r.err).toBeNull();
    expect(r.errs).toEqual([]);
    expect(r.mode).toBe('storage');
    expect(r.arrows.length).toBeGreaterThan(0);
    const bad = r.arrows.filter(a => !onSide(a.x1, a.y1, r.rects[a.from]) || !onSide(a.x2, a.y2, r.rects[a.to]));
    expect(bad).toEqual([]);
    expect(r.arrows.find(a => a.from === CLASS_ID)!.to).toBe(CLASSES_ID);
    expect({ dot: r.dot, edge: r.edge, near: near(r.dot, r.edge, 24) }).toMatchObject({ near: true });
  }, 120000);
});
