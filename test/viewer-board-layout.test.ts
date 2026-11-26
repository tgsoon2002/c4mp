import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';

// P16-B21b: real-Chrome layout checks for the Phase 16 page frame (skeleton from viewer-layout.test.ts).
// Skipped when headless Chrome is not installed. Later tasks (B19, B20, B28a, B35) append cases here.

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-board-layout-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'board-layout-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// `before` runs first (clicks); then after a short timeout the numbers go into <pre id="__m"> as JSON.
function measureScript(before: string): string {
  return `(function(){setTimeout(function(){${before}},100);
setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  var d=function(i){return getComputedStyle(q(i)).display};
  var mr=q('map-wrap').getBoundingClientRect(), mn=q('main').getBoundingClientRect(), pr=q('panel-col').getBoundingClientRect();
  var o={panelColDisplay:d('panel-col'),leftDisplay:d('left'),mapWrapW:mr.width,mapWrapH:mr.height,mapWrapLeft:mr.left,mapWrapTop:mr.top,
    mainW:mn.width,mainH:mn.height,mainTop:mn.top,panelColTop:pr.top,innerW:window.innerWidth,innerH:window.innerHeight,
    docScrollW:document.documentElement.scrollWidth,docScrollH:document.documentElement.scrollHeight};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},600)})();`;
}

function measure(size: string, before = ''): Record<string, any> {
  const file = path.join(tmp, 'page.html');
  fs.writeFileSync(file, html.replace('</body>', `<script>${measureScript(before)}</script></body>`));
  const dom = runChrome([
    '--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000',
    `--window-size=${size}`,
    `--user-data-dir=${path.join(tmp, 'profile-' + Math.random().toString(36).slice(2))}`,
    `file://${file}`,
  ]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

// P16-B19: top bar measurements; `before` runs first, then the numbers are written like measureScript.
function barScript(before: string): string {
  // `before` waits one tick: map.js wires the buttons on DOMContentLoaded, after this script text ran
  return `(function(){setTimeout(function(){${before}},100);
setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  var h=q('header').getBoundingClientRect(), t=q('title').getBoundingClientRect(), b=q('btn-details').getBoundingClientRect(), g=q('btn-gear').getBoundingClientRect();
  var o={headerH:h.height,headerW:h.width,titleTop:t.top,titleBottom:t.bottom,btnTop:b.top,btnBottom:b.bottom,btnRight:b.right,gearRight:g.right,gearTop:g.top,gearBottom:g.bottom,
    chips:q('bar-chips').textContent,titleAttr:q('title').title,popHidden:q('details-pop').hidden,
    popDisplay:getComputedStyle(q('details-pop')).display,expanded:q('btn-details').getAttribute('aria-expanded'),
    popInHeader:q('header').contains(q('details-pop')),subtitleInPop:q('details-pop').contains(q('subtitle')),
    summaryInPop:q('details-pop').contains(q('summary')),driftInPop:q('details-pop').contains(q('drift-summary')),
    popText:q('details-pop').textContent.length,mainTop:q('main').getBoundingClientRect().top,
    docScrollW:document.documentElement.scrollWidth,innerW:window.innerWidth};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},600)})();`;
}

function measureBar(size: string, before = ''): Record<string, any> {
  const file = path.join(tmp, 'bar.html');
  fs.writeFileSync(file, html.replace('</body>', `<script>${barScript(before)}</script></body>`));
  const dom = runChrome([
    '--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000',
    `--window-size=${size}`,
    `--user-data-dir=${path.join(tmp, 'profile-' + Math.random().toString(36).slice(2))}`,
    `file://${file}`,
  ]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P16-B19 slim top bar', () => {
  it('source: header holds the chips, the details button and the popover with the four old ids', () => {
    for (const id of ['bar-chips', 'board-chips', 'btn-details', 'btn-gear', 'settings-pop', 'details-pop', 'subtitle', 'summary', 'drift-summary']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  chromeIt('1400x900: one row of 44px, popover hidden, chips filled, details inside the popover', () => {
    const m = measureBar('1400,900');
    expect(Math.round(m.headerH)).toBe(44);
    expect(m.titleTop).toBeGreaterThanOrEqual(0);
    expect(m.titleBottom).toBeLessThanOrEqual(44);
    expect(m.btnBottom).toBeLessThanOrEqual(44);
    expect(m.btnRight).toBeGreaterThan(1400 - 80); // the (i) sits just left of the gear
    expect(m.gearRight).toBeGreaterThan(1400 - 40); // P20-T11: the gear is the right-most control
    expect(m.gearBottom).toBeLessThanOrEqual(44);
    expect(Math.round(m.mainTop)).toBe(44);
    expect(m.chips).toMatch(/^\d+ containers? · \d+ components? · 1 file$/);
    expect(m.titleAttr.length).toBeGreaterThan(0);
    expect(m.popHidden).toBe(true);
    expect(m.popDisplay).toBe('none');
    expect(m.expanded).toBe('false');
    expect(m.popInHeader && m.subtitleInPop && m.summaryInPop && m.driftInPop).toBe(true);
  });

  chromeIt('click on (i) opens the popover; second click closes it; Escape closes it', () => {
    const open = measureBar('1400,900', `document.getElementById('btn-details').click();`);
    expect(open.popHidden).toBe(false);
    expect(open.expanded).toBe('true');
    expect(open.popText).toBeGreaterThan(0);
    expect(Math.round(open.headerH)).toBe(44); // the popover floats, it does not grow the bar
    expect(Math.round(open.mainTop)).toBe(44);
    const twice = measureBar('1400,900', `var b=document.getElementById('btn-details');b.click();b.click();`);
    expect(twice.popHidden).toBe(true);
    const esc = measureBar('1400,900', `document.getElementById('btn-details').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));`);
    expect(esc.popHidden).toBe(true);
    expect(esc.expanded).toBe('false');
    const outside = measureBar('1400,900', `document.getElementById('btn-details').click();document.getElementById('main').click();`);
    expect(outside.popHidden).toBe(true);
  });

  chromeIt('600x700: still one 44px row, no sideways page scroll', () => {
    const m = measureBar('600,700');
    expect(Math.round(m.headerH)).toBe(44);
    expect(m.docScrollW).toBeLessThanOrEqual(m.innerW);
    expect(m.btnRight).toBeLessThanOrEqual(600);
  });
});

// P16-B28a: geometry of #center / #map-wrap / #board-drawer / #panel-col (drawer opened by removing `hidden`).
function measureDrawer(size: string, openDrawer: boolean, before = ''): Record<string, any> {
  const script = `(function(){setTimeout(function(){${openDrawer ? `document.getElementById('board-drawer').hidden=false;` : ''}${before}},100);
setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  var r=function(i){var b=q(i).getBoundingClientRect();return {t:b.top,l:b.left,w:b.width,h:b.height,b:b.bottom,r:b.right}};
  var o={center:r('center'),map:r('map-wrap'),drawer:r('board-drawer'),panelCol:r('panel-col'),main:r('main'),
    centerParentIsMain:q('center').parentNode===q('main'),mapParentIsCenter:q('map-wrap').parentNode===q('center'),
    drawerDisplay:getComputedStyle(q('board-drawer')).display,drawerHidden:q('board-drawer').hidden,
    edgeCursor:getComputedStyle(q('board-drawer-edge')).cursor,edgeH:r('board-drawer-edge').h,
    docScrollW:document.documentElement.scrollWidth,innerW:window.innerWidth};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},600)})();`;
  const file = path.join(tmp, 'drawer.html');
  fs.writeFileSync(file, html.replace('</body>', `<script>${script}</script></body>`));
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', `--window-size=${size}`,
    `--user-data-dir=${path.join(tmp, 'profile-' + Math.random().toString(36).slice(2))}`, `file://${file}`]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P16-B28a drawer shell', () => {
  it('source: #center wraps #map-wrap and the hidden drawer with edge, bar and body', () => {
    const c = html.slice(html.indexOf('id="center"'), html.indexOf('id="panel-col"'));
    expect(c).toContain('id="map-wrap"');
    expect(c).toMatch(/<section id="board-drawer" hidden[^>]*>/);
    for (const id of ['board-drawer-edge', 'board-drawer-bar', 'board-drawer-body']) expect(c).toContain(`id="${id}"`);
    expect(html.indexOf('id="panel-col"')).toBeGreaterThan(html.indexOf('id="board-drawer"')); // the panel is not inside #center
  });

  chromeIt('1400x900, drawer closed: #center fills the space #map-wrap had, no drawer box', () => {
    const m = measureDrawer('1400,900', false);
    expect(m.centerParentIsMain && m.mapParentIsCenter).toBe(true);
    expect(m.drawerDisplay).toBe('none');
    expect(Math.abs(m.map.h - m.center.h)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.map.w - m.center.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.center.h - m.main.h)).toBeLessThanOrEqual(1);
    expect(m.map.w).toBeGreaterThan(400);
  });

  chromeIt('1400x900, drawer open: sits under the map in #center, ~46% high, panel keeps full height', () => {
    const closed = measureDrawer('1400,900', false);
    const m = measureDrawer('1400,900', true);
    expect(m.drawer.t).toBeGreaterThanOrEqual(m.map.b - 1);
    expect(Math.abs(m.drawer.b - m.center.b)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.drawer.h / m.center.h - 0.46)).toBeLessThan(0.02);
    expect(Math.abs(m.map.h + m.drawer.h - m.center.h)).toBeLessThanOrEqual(1);
    expect(m.edgeCursor).toBe('ns-resize');
    expect(Math.round(m.edgeH)).toBe(7);
    expect(Math.round(m.panelCol.h)).toBe(Math.round(closed.panelCol.h)); // detail panel is not shortened
    expect(m.panelCol.l).toBeGreaterThanOrEqual(m.center.r - 1);          // still beside the centre
  });

  chromeIt('900x700 (narrow grid): #center sits in column 2 row 1 above the panel, drawer inside it', () => {
    const m = measureDrawer('900,700', true);
    expect(m.panelCol.t).toBeGreaterThanOrEqual(m.center.b - 1);
    expect(Math.abs(m.center.w - m.map.w)).toBeLessThanOrEqual(1);
    expect(m.drawer.b).toBeLessThanOrEqual(m.center.b + 1);
    expect(m.map.h).toBeGreaterThan(100);
    expect(m.docScrollW).toBeLessThanOrEqual(m.innerW);
    const closed = measureDrawer('900,700', false);
    expect(Math.abs(closed.map.h - closed.center.h)).toBeLessThanOrEqual(1);
    expect(closed.panelCol.t).toBeGreaterThanOrEqual(closed.center.b - 1);
  });

  chromeIt('600x700: drawer height is 34% of #center', () => {
    const m = measureDrawer('600,700', true);
    expect(Math.abs(m.drawer.h / m.center.h - 0.34)).toBeLessThan(0.02);
  });
});

describe('P16-B21 Board button', () => {
  it('source: btn-board is an edge tab in the map area (not in the HUD), hidden, not pressed, labelled', () => {
    const tag = html.match(/<button[^>]*id="btn-board"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).toMatch(/\shidden[\s>]/);
    expect(tag![0]).toContain('aria-pressed="false"');
    expect(tag![0]).toContain('class="edge-toggle"');
    expect(tag![0]).toContain('aria-label=');
    expect(tag![0]).toContain('title=');
    const at = html.indexOf('id="btn-board"');
    const hud = html.slice(html.indexOf('id="hud-tr"'), html.indexOf('id="hud-bl"'));
    expect(hud).not.toContain('btn-board');
    expect(at).toBeGreaterThan(html.indexOf('id="toggle-right"'));
    expect(at).toBeLessThan(html.indexOf('id="board-drawer"'));
  });

  chromeIt('real Chrome: a page without a board shows no Board button', () => {
    const file = path.join(tmp, 'btn.html');
    fs.writeFileSync(file, html.replace('</body>', `<script>setTimeout(function(){var b=document.getElementById('btn-board');var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify({display:getComputedStyle(b).display,w:b.getBoundingClientRect().width});document.body.appendChild(p);},300)</script></body>`));
    const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900',
      `--user-data-dir=${path.join(tmp, 'profile-btn')}`, `file://${file}`]);
    const r = JSON.parse(dom.match(/<pre id="__m">(.*?)<\/pre>/s)![1].replace(/&quot;/g, '"'));
    expect(r.display).toBe('none');
    expect(r.w).toBe(0);
  });
});

describe('P16-B20 Top hide button', () => {
  // Runs the inline Top-button IIFE of the built page against a tiny fake document.
  function runTopScript(storage: any): { root: any; btn: any } {
    const vm = require('vm');
    const start = html.indexOf('// P16-B20');
    expect(start).toBeGreaterThan(0);
    const code = html.slice(start);
    const end = code.indexOf('})();') + 4;
    const classes = new Set<string>();
    const root = { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) }, classes };
    const attrs: Record<string, string> = {};
    let onClick: () => void = () => {};
    const btn = { setAttribute: (k: string, v: string) => { attrs[k] = v; }, addEventListener: (_: string, f: () => void) => { onClick = f; }, attrs, click: () => onClick() };
    const doc = { getElementById: (id: string) => (id === 'root' ? root : id === 'btn-top' ? btn : null) };
    // Phase 35 C (b945): the inline script reads and writes through window.C4PM_STORE (viewer/store.js, the page's prelude)
    const win: any = {};
    vm.runInNewContext(require('fs').readFileSync(require('path').join(__dirname, '..', 'viewer', 'store.js'), 'utf8'), { window: win, localStorage: storage });
    vm.runInNewContext(code.slice(0, end), { document: doc, localStorage: storage, window: win });
    return { root, btn };
  }

  it('source: the button is an edge tab in the map area (not in the HUD) and the CSS hides #header under .top-hidden', () => {
    const hud = html.slice(html.indexOf('id="hud-tr"'), html.indexOf('id="hud-bl"'));
    expect(hud).not.toContain('btn-top');
    expect(html).toMatch(/<button class="edge-toggle" id="btn-top" type="button" aria-pressed="true" aria-label="[^"]+" title="Show \/ hide the top bar">/);
    expect(html).toContain('#root.top-hidden #header');
  });

  it('click toggles the class and aria-pressed, and stores the state', () => {
    const store: Record<string, string> = {};
    const { root, btn } = runTopScript({ getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    expect(root.classes.has('top-hidden')).toBe(false);
    btn.click();
    expect(root.classes.has('top-hidden')).toBe(true);
    expect(btn.attrs['aria-pressed']).toBe('false');
    expect(btn.textContent).toBe('▼');   // hidden: arrow down = a click shows the bar
    expect(store['c4mp.topHidden']).toBe('1');
    btn.click();
    expect(root.classes.has('top-hidden')).toBe(false);
    expect(btn.attrs['aria-pressed']).toBe('true');
    expect(btn.textContent).toBe('▲');
  });

  it('a stored "1" starts hidden; storage that throws does not break the button', () => {
    const hidden = runTopScript({ getItem: () => '1', setItem: () => {} });
    expect(hidden.root.classes.has('top-hidden')).toBe(true);
    const boom = () => { throw new Error('blocked'); };
    const { root, btn } = runTopScript({ getItem: boom, setItem: boom });
    btn.click();
    expect(root.classes.has('top-hidden')).toBe(true);
  });

  chromeIt('real Chrome: Top hides the bar, the map gets 44px taller, a second click restores it', () => {
    const shown = measure('1400,900');
    const hidden = measure('1400,900', `document.getElementById('btn-top').click();`);
    expect(hidden.mapWrapTop).toBeLessThanOrEqual(1);
    expect(Math.round(hidden.mapWrapH - shown.mapWrapH)).toBe(44);
    expect(Math.round(hidden.mainH - shown.mainH)).toBe(44);
    const back = measure('1400,900', `var b=document.getElementById('btn-top');b.click();b.click();`);
    expect(Math.round(back.mapWrapH)).toBe(Math.round(shown.mapWrapH));
  });
});

const CLICK_RIGHT = `document.getElementById('toggle-right').click();`;
const CLICK_LEFT = `document.getElementById('toggle-left').click();`;

describe('P16-B21b narrow window: hidden side panels free their space', () => {
  chromeIt('900x700, panel visible: panel sits under the map (unchanged)', () => {
    const m = measure('900,700');
    expect(m.panelColDisplay).not.toBe('none');
    expect(m.panelColTop).toBeGreaterThanOrEqual(m.mapWrapTop + m.mapWrapH - 1);
    expect(m.mapWrapH).toBeLessThan(m.mainH - 100);
  });

  chromeIt('900x700, right panel hidden: the map takes the whole height of #main', () => {
    const m = measure('900,700', CLICK_RIGHT);
    expect(m.panelColDisplay).toBe('none');
    expect(Math.abs(m.mapWrapH - m.mainH)).toBeLessThanOrEqual(1);
    expect(m.docScrollW).toBeLessThanOrEqual(m.innerW);
  });

  chromeIt('900x700, left panel hidden: the map takes the whole width of #main', () => {
    const m = measure('900,700', CLICK_LEFT);
    expect(m.leftDisplay).toBe('none');
    expect(Math.abs(m.mapWrapW - m.mainW)).toBeLessThanOrEqual(1);
    expect(m.mapWrapLeft).toBeLessThanOrEqual(1);
  });

  chromeIt('900x700, both hidden: the map fills #main', () => {
    const m = measure('900,700', CLICK_RIGHT + CLICK_LEFT);
    expect(Math.abs(m.mapWrapH - m.mainH)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.mapWrapW - m.mainW)).toBeLessThanOrEqual(1);
  });

  chromeIt('1400x900, right panel hidden: wide layout unchanged (map fills #main height)', () => {
    const m = measure('1400,900', CLICK_RIGHT);
    expect(m.panelColDisplay).toBe('none');
    expect(Math.abs(m.mapWrapH - m.mainH)).toBeLessThanOrEqual(1);
  });
});
