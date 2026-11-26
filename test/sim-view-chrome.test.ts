import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { chromeInstalled, runChrome } from './helpers/chrome';
import type { ViewModel } from '../src/types';
import { CREDIT_URL, NO_URL_EXCEPT_CREDIT, URL_RULE_MISSES } from './helpers/creditUrl';

// Phase 25 UI16 (b766): the simulations look in real Chrome. The page is UI0's fixture (test/fixtures/sim-demo-shop, s-1 flow
// "Buy a product", 9 steps; s-2 journey) built with buildView on a tmp copy. Each measured hash of
// Document/Roadmap/Phase25/UI_TASKS.md section F is opened under --force-prefers-reduced-motion --virtual-time-budget=8000 and
// the page writes what it shows into <pre id="__m"> (storage-view-chrome.test.ts pattern). Measured: state (data, DOM, rects),
// never pixels: under virtual time the arch openness easing may stop early. The PNGs of every section F hash go to a tmp
// folder (printed, not committed) for the side-by-side check with Document/Roadmap/Phase25/shots/. Skipped without Chrome.

const chromeIt = chromeInstalled ? it : it.skip;
const FIXTURE = path.join(__dirname, 'fixtures', 'sim-demo-shop');
const SRH = 17, SHEAD = 20;   // viewer/storageView.js: a record's sample-rows area
const sampleH = (n: number) => (n ? SHEAD + (n + 1) * SRH + 8 : 0);
const CHROME_ARGS = ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-prefers-reduced-motion', '--virtual-time-budget=8000'];

const ERRS = `<script>window.__errs = [];
(function(){ var ce = console.error; console.error = function(){ window.__errs.push(Array.prototype.map.call(arguments, String).join(' ')); return ce.apply(console, arguments); };
window.addEventListener('error', function(e){ window.__errs.push('error: ' + (e.message || e.type)); }); })();</script>`;

interface Rect { x: number; y: number; w: number; h: number }
interface Measure {
  err: string | null; errs: string[]; remote: string[]; mode: string; sel: string | null;
  sims: { present: boolean; expanded: string | null; bodyHidden: boolean; title: string } | null;
  chips: number; lit: { view: string; ids: number } | null;
  css: { simbar: string; pres: string; presDisplay: string; seq: string };
  pres: { hidden: boolean; top: string[]; target: string; cap: string; state: string; tables: string[] };
  seq: { shown: boolean; rows: number; lanes: string[] };
  orders: { sim: Rect | null; clear: Rect | null };
}

// After load (virtual time): what the page shows. Storage: the orders rect with s-1 selected, then with nothing selected.
const measureScript = (ordersId: string) => `(function(){
var out = { err: null };
var finish = function(){ out.errs = window.__errs; var pre = document.createElement('pre'); pre.id = '__m'; pre.textContent = encodeURIComponent(JSON.stringify(out)); document.body.appendChild(pre); };
var $ = function(id){ return document.getElementById(id); };
var txt = function(e){ return e ? e.textContent.replace(/\\s+/g, ' ').trim() : ''; };
var pos = function(id){ var e = $(id); return e ? getComputedStyle(e).position : ''; };
setTimeout(function(){ try {
  var S = window.C4PM_SIM, st = window.C4PM_STATE, L = st.map.sim;
  out.mode = window.C4PM_MODE.get();
  out.sel = S.selected();
  out.remote = performance.getEntriesByType('resource').map(function(r){ return r.name; }).filter(function(n){ return !/^(file|data|blob):/.test(n); });
  var sims = $('sims'), body = $('sims-body'), head = $('sims-head');
  out.sims = sims ? { present: true, expanded: head && head.getAttribute('aria-expanded'), bodyHidden: !!(body && body.hidden), title: txt($('sims-title')) } : null;
  out.chips = document.querySelectorAll('#simbar .sb-step').length;
  out.lit = L ? { view: L.view, ids: L.ids.size } : null;
  out.css = { simbar: pos('simbar'), pres: pos('pres'), presDisplay: $('pres') ? getComputedStyle($('pres')).display : '', seq: pos('seq-drawer') };
  var card = document.querySelector('#pres .pres-card');
  var q = function(sel){ return txt(card && card.querySelector(sel)); };
  out.pres = { hidden: $('pres').hidden, top: card ? Array.prototype.map.call(card.querySelector('.pres-top').children, txt) : [],
    target: q('.pres-target'), cap: q('.pres-cap'), state: q('.pres-state'), tables: card ? Array.prototype.map.call(card.querySelectorAll('.pres-rows caption'), txt) : [] };
  out.seq = { shown: !$('seq-drawer').hidden, rows: document.querySelectorAll('#seq-body .sq-row').length,
    lanes: Array.prototype.map.call(document.querySelectorAll('#seq-body .sq-lane-name'), txt) };
  out.orders = { sim: null, clear: null };
  if (out.mode === 'storage') { var V = window.C4PM_STORAGEVIEW; out.orders.sim = V.rect('${ordersId}'); S.select(null); out.orders.clear = V.rect('${ordersId}'); }
} catch (e) { out.err = String(e && e.stack || e); } finish(); }, 3000);
})();`;

// Screenshots only: force synchronous draws at a few virtual times (headless rAF stalls; ui7 settled.sh / ui12 mk.py). The
// openness eases 0.25 of the way per draw (render.js stepNode), so 25 draws settle it after a view switch or a fly.
const SETTLE = `<script>[2500,4500,7000].forEach(function(t){ setTimeout(function(){ var S = window.C4PM_STATE; if (S && S.draw) for (var i = 0; i < 25; i++) S.draw(performance.now()); }, t); });</script>`;
const DARK = `<script>try{var k='c4mp.settings',o=JSON.parse(localStorage.getItem(k)||'{}');o.theme='dark';localStorage.setItem(k,JSON.stringify(o));}catch(e){}</script>`;
// 19: the real page has no hash that selects a c-item (the demo's &sel=…&reveal=1): select and fly to Cart from a script.
const SELECT_CART = `<script>setTimeout(function(){ var M = window.C4PM_MAP; if (M && M.select('shop.api.cart')) M.flyTo('shop.api.cart'); }, 2000);</script>`;
const TYPE_BUY = `<script>setTimeout(function(){ var i = document.getElementById('search'); if (!i) return; i.focus(); i.value = 'buy'; i.dispatchEvent(new Event('input', { bubbles: true })); }, 2000);</script>`;

// Section F: file, hash on the real page (the demo-only &notes=0 / &theme=dark / &sel / &reveal dropped), window size, variant.
type Variant = 'plain' | 'dark' | 'search' | 'select';
const SHOTS: [string, string, string, Variant][] = [
  ['01-arch-notes', '#arch', '1600,1000', 'plain'],
  ['02-arch-sims-open', '#arch&sims=open', '1600,1000', 'plain'],
  ['03-arch-s1-whole', '#arch&sim=s-1', '1600,1000', 'plain'],
  ['04-arch-s1-step4', '#arch&sim=s-1&step=4', '1600,1000', 'plain'],
  ['05-arch-s1-step8-unver', '#arch&sim=s-1&step=8', '1600,1000', 'plain'],
  ['06-io-s1-whole', '#io&sim=s-1', '1600,1000', 'plain'],
  ['07-io-s1-step2', '#io&sim=s-1&step=2', '1600,1000', 'plain'],
  ['08-storage-s1-whole', '#storage&sim=s-1', '1600,1000', 'plain'],
  ['09-storage-s1-step5-new', '#storage&sim=s-1&step=5', '1600,1000', 'plain'],
  ['10-storage-s1-step8-changed', '#storage&sim=s-1&step=8&stay=1', '1600,1000', 'plain'],
  ['11-present-s1-step1', '#arch&sim=s-1&present=1', '1600,1000', 'plain'],
  ['12-present-s1-step5', '#arch&sim=s-1&present=5', '1600,1000', 'plain'],
  ['13-present-s1-step8-unver', '#arch&sim=s-1&present=8', '1600,1000', 'plain'],
  ['14-present-s2-outside', '#arch&sim=s-2&present=1', '1600,1000', 'plain'],
  // b853: the demo draws container lanes
  ['15-seq-s1', '#arch&sim=s-1&seq=1&depth=container', '1600,1000', 'plain'],
  ['16-seq-s1-step7', '#arch&sim=s-1&seq=1&step=7&stay=1&depth=container', '1600,1000', 'plain'],
  ['17-seq-s2-journey', '#arch&sim=s-2&seq=1&depth=container', '1600,1000', 'plain'],
  ['18-seqonly-window', '#arch&seqonly&sim=s-1', '1100,520', 'plain'],
  ['19-panel-citem-insims', '#arch', '1600,1000', 'select'],
  ['20-panel-s2-journey', '#arch&sim=s-2', '1600,1000', 'plain'],
  ['21-search-buy', '#arch', '1600,1000', 'search'],
  ['22-dark-s1-step5', '#storage&sim=s-1&step=5', '1600,1000', 'dark'],
  ['23-dark-present-step4', '#arch&sim=s-1&present=4', '1600,1000', 'dark'],
  ['24-phone-s1', '#arch&sim=s-1', '390,844', 'plain'],
  ['25-bare-io-s1-step6', '#io&bare&sim=s-1&step=6', '1600,1000', 'plain'],
];
const MEASURED = ['#arch', '#arch&sim=s-1', '#io&sim=s-1', '#storage&sim=s-1', '#arch&sim=s-1&present=5', '#arch&sim=s-1&seq=1&depth=container',
  '#arch&sim=s-1&seq=1'];

/** Fixture copy in a fresh tmp folder with a `.git` marker, as sim-demo-fixture.test.ts does. */
function copyRepo(dir: string): string {
  const root = path.join(dir, 'shop');
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

describe('simulations in real Chrome (UI16 b766, sim-demo-shop fixture)', () => {
  let dir: string;
  let model: ViewModel;
  let html: string;
  let ordersId: string;
  const got: Record<string, Measure> = {};

  beforeAll(() => {
    if (!chromeInstalled) return;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-chrome-')));
    ({ model, html } = buildView({ repo: copyRepo(dir) }));
    const s1 = model.sims!.find((s) => s.id === 's-1')!;
    ordersId = s1.steps.flatMap((st) => st.rows ?? []).find((r) => r.name === 'orders')!.recordId!;
    const page = path.join(dir, 'measure.html');
    fs.writeFileSync(page, html.replace('<head>', () => `<head>${ERRS}`).replace('</body>', () => `<script>${measureScript(ordersId)}</script></body>`));
    for (const hash of MEASURED) {
      const dom = runChrome([...CHROME_ARGS, '--dump-dom', '--window-size=1600,1000', `file://${page}${hash}`], { timeout: 30000 });
      const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
      if (!m) throw new Error(`measurement element not found in the dumped DOM of ${hash}`);
      got[hash] = JSON.parse(decodeURIComponent(m[1]));
    }
  }, 120000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('b168: the URL rule allows only the credit link; any other http(s) URL still fails it', () => {
    expect(`<a href="${CREDIT_URL}">`).not.toMatch(NO_URL_EXCEPT_CREDIT);
    for (const s of URL_RULE_MISSES) expect(s).toMatch(NO_URL_EXCEPT_CREDIT);
  });

  chromeIt('every measured page loads without a script error or a console error; the page is remote-free', () => {
    expect(html).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)
    expect(MEASURED.map((h) => [h, got[h].err, got[h].errs, got[h].remote])).toEqual(MEASURED.map((h) => [h, null, [], []]));
  });

  chromeIt('#arch: #sims present and closed, nothing selected, no strip', () => {
    const m = got['#arch'];
    expect([m.sims, m.sel, m.chips, m.lit]).toEqual([{ present: true, expanded: 'false', bodyHidden: true, title: 'Simulations (2)' }, null, 0, null]);
  });

  chromeIt('sim.css rules are applied: #simbar and #pres absolute, #pres flex while presenting, #seq-drawer relative', () => {
    expect(got['#arch&sim=s-1'].css).toMatchObject({ simbar: 'absolute', pres: 'absolute', seq: 'relative' });
    expect(got['#arch&sim=s-1&present=5'].css.presDisplay).toBe('flex');
  });

  chromeIt('#simbar holds one chip per step of s-1 (9)', () => {
    expect(got['#arch&sim=s-1'].chips).toBe(9);
  });

  chromeIt('C4PM_STATE.map.sim.ids size per view (arch, io, storage)', () => {
    const lit = ['#arch&sim=s-1', '#io&sim=s-1', '#storage&sim=s-1'].map((h) => got[h].lit);
    // arch (sim.js litFor): the arch targets and every call end that is an arch node, of the steps of every view (10: customer,
    // web, cart_store, router, Cart, addItem, getPrice, placeOrder, charge, Shop DB); io: the 4 screens; storage: orders, order_items.
    expect(lit).toEqual([{ view: 'arch', ids: 10 }, { view: 'io', ids: 4 }, { view: 'storage', ids: 2 }]);
  });

  chromeIt('present step 5: the caption card of the storage step with its rows tables', () => {
    const p = got['#arch&sim=s-1&present=5'].pres;
    expect(p).toEqual({
      hidden: false,
      top: ['Step 5/9', 'Storage view'],
      target: 'orders + order_items · Cart.addItem → Shop DB (INSERT orders, order_items)',
      cap: 'The cart is kept as an order with status "cart": one new orders row and one order_items row.',
      state: 'state: cart: 1 item',
      tables: ['orders', 'order_items'],
    });
  });

  chromeIt('#seq-body for s-1 at container depth: 6 rows, lanes Customer, Web app, API, Shop DB', () => {
    // b853: at container the steps that stay in one lane pair merge (S1 pins [[0,1],[2,3],[4],[5],[6,7],[8]]): 9 steps, 6 rows.
    const s = got['#arch&sim=s-1&seq=1&depth=container'].seq;
    expect(s).toEqual({ shown: true, rows: 6, lanes: ['Customer', 'Web app', 'API', 'Shop DB'] });
  });

  chromeIt('#seq-body for s-1 at code depth (the default): 9 rows, one lane per function / table', () => {
    const s = got['#arch&sim=s-1&seq=1'].seq;
    expect(s).toEqual({
      shown: true,
      rows: 9,
      lanes: ['Customer', 'Web app', 'Cart store', 'Cart', 'Cart.addItem', 'Catalog.getPrice', 'orders', 'order_items', 'Router',
        'Orders.placeOrder', 'Payments.charge'],
    });
  });

  chromeIt('storage: the orders record grew by sampleH(1) with s-1 selected', () => {
    const o = got['#storage&sim=s-1'].orders;
    expect(o.sim!.h - o.clear!.h).toBe(sampleH(1));
    expect([o.sim!.x, o.sim!.y, o.sim!.w]).toEqual([o.clear!.x, o.clear!.y, o.clear!.w]);
  });

  chromeIt('writes a PNG per section F hash into a tmp folder (not committed)', () => {
    // Outside the jest run's temp root (test/globalSetup.js sets TMPDIR to it and globalTeardown removes it), so the PNGs stay
    // for the eye check: C4PM_UI16_SHOTS (files overwritten), else the same tmp folder each run (emptied first).
    const base = process.env.C4PM_TEST_TMP_ROOT ? path.dirname(process.env.C4PM_TEST_TMP_ROOT) : os.tmpdir();
    const shots = process.env.C4PM_UI16_SHOTS || path.join(base, 'c4pm-ui16-shots');
    if (!process.env.C4PM_UI16_SHOTS) fs.rmSync(shots, { recursive: true, force: true });
    fs.mkdirSync(shots, { recursive: true });
    const variant = (v: Variant) => {
      const file = path.join(dir, `shot-${v}.html`);
      if (!fs.existsSync(file)) {
        const head = v === 'dark' ? DARK : '';
        const tail = SETTLE + (v === 'search' ? TYPE_BUY : v === 'select' ? SELECT_CART : '');
        fs.writeFileSync(file, html.replace('<head>', () => `<head>${head}`).replace('</body>', () => `${tail}</body>`));
      }
      return file;
    };
    for (const [name, hash, size, v] of SHOTS) {
      runChrome([...CHROME_ARGS, `--window-size=${size}`, `--screenshot=${path.join(shots, name + '.png')}`, `file://${variant(v)}${hash}`], { timeout: 30000 });
    }
    expect(fs.readdirSync(shots).filter((f) => f.endsWith('.png')).length).toBe(SHOTS.length);
    console.log(`UI16 PNGs (compare with Document/Roadmap/Phase25/shots/): ${shots}`);
  }, 120000);
});
