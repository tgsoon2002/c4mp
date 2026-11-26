import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';

// P13-T1: the Phase 5-12 viewer tests use a fake DOM and cannot see layout, so the right panel
// stayed `display:none` for seven phases unnoticed. This test renders a real page and measures it
// in real headless Chrome (skipped when the binary is not installed).

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-layout-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'layout-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Runs after load, writes measurements into <pre id="__m"> as JSON.
const MEASURE = `(function(){setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  var r=q('panel').getBoundingClientRect();
  var col=getComputedStyle(q('panel-col'));
  var o={panelW:r.width,panelH:r.height,panelColDisplay:col.display,panelText:q('panel').textContent.length,
    mapW:q('map').getBoundingClientRect().width,mapAttrW:q('map').width,wrapW:q('map-wrap').clientWidth,
    leftDisplay:getComputedStyle(q('left')).display,leftW:q('left').getBoundingClientRect().width,
    leftRows:q('left').querySelectorAll('.lt-row').length,leftTabs:q('left').querySelectorAll('.lt-tab').length};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

// P13-T11: extra measurements. `before` runs first (e.g. clicks); a shared profile dir lets a
// second load see what the first stored in localStorage.
const MEASURE2 = `(function(){setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  var d=function(i){return getComputedStyle(q(i)).display};
  var pr=q('panel').getBoundingClientRect(), mr=q('map-wrap').getBoundingClientRect();
  var o={leftDisplay:d('left'),leftW:q('left').getBoundingClientRect().width,panelColDisplay:d('panel-col'),
    panelColTop:q('panel-col').getBoundingClientRect().top,panelColH:q('panel-col').getBoundingClientRect().height,
    mapWrapW:mr.width,mapWrapH:mr.height,mapWrapBottom:mr.bottom,wrapW:q('map-wrap').clientWidth,mapW:Math.round(q('map').getBoundingClientRect().width),
    innerW:window.innerWidth,innerH:window.innerHeight,docScrollW:document.documentElement.scrollWidth,
    toggleLeft:q('toggle-left').getAttribute('aria-expanded'),toggleRight:q('toggle-right').getAttribute('aria-expanded'),
    toggleLeftVisible:q('toggle-left').getBoundingClientRect().width>0,toggleRightVisible:q('toggle-right').getBoundingClientRect().width>0};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},600)})();`;

// P14-T33c: map and side-panel heights, panel overflow mode, and document size (no page-level scroll).
const MEASURE_T33C = `(function(){setTimeout(function(){
  var q=function(i){return document.getElementById(i)};
  // select the node with the most children so the side panel is taller than its slot (the cap only bites then)
  var best=null,bestN=-1;(function w(n){var c=n.children||[];if(c.length>bestN){best=n;bestN=c.length}c.forEach(w)})(window.C4PM_DATA.root);
  window.C4PM_MAP.select(best.id);
  var pc=q('panel-col'), mr=q('map-wrap').getBoundingClientRect(), pr=pc.getBoundingClientRect();
  var o={mapWrapH:mr.height,mapWrapBottom:mr.bottom,panelColTop:pr.top,panelColH:pr.height,
    panelColOverflowY:getComputedStyle(pc).overflowY,innerH:window.innerHeight,innerW:window.innerWidth,
    docScrollH:document.documentElement.scrollHeight,docScrollW:document.documentElement.scrollWidth};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},600)})();`;

function measure(opts: { size?: string; script?: string; profile?: string } = {}): Record<string, any> {
  const file = path.join(tmp, 'page.html');
  const script = opts.script ?? MEASURE;
  fs.writeFileSync(file, html.replace('</body>', `<script>${script}</script></body>`));
  const dom = runChrome([
    '--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000',
    `--window-size=${opts.size ?? '1400,900'}`,
    ...(opts.profile ? [`--user-data-dir=${opts.profile}`] : []),
    `file://${file}`,
  ]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P13-T1 viewer layout', () => {
  it('built HTML does not hide the right panel column', () => {
    expect(html).toContain('id="panel-col"');
    expect(html).not.toMatch(/id="panel-col"\s+style="display:\s*none/);
    // P13-T3a: the left panel is no longer a hidden placeholder.
    expect(html).toContain('<aside id="left"');
    expect(html).not.toMatch(/<aside id="left"[^>]*\shidden/);
    // b230: search markup moved from the left panel into the top bar (#header).
    const header = html.slice(html.indexOf('<header id="header"'), html.indexOf('</header>'));
    expect(header).toContain('id="search"');
    expect(header).toContain('id="search-results"');
    expect(header).toContain('id="search-mode"');
    expect(header).toContain('id="search-hint"');
    const left = html.slice(html.indexOf('<aside id="left"'), html.indexOf('</aside>'));
    expect(left).not.toContain('id="search"');
    expect(html.slice(html.indexOf('id="panel-col"'))).not.toContain('id="search"');
  });

  chromeIt('real browser: both side panels visible and filled, map narrower', () => {
    const m = measure();
    expect(m.panelColDisplay).not.toBe('none');
    expect(m.panelW).toBeGreaterThan(300);
    expect(m.panelH).toBeGreaterThan(20);
    expect(m.panelText).toBeGreaterThan(0);
    expect(m.mapW).toBeGreaterThan(400);
    expect(m.mapW).toBeLessThan(1400 - 420 - 250); // both panels take room from the map
    expect(m.mapAttrW).toBe(m.wrapW); // canvas backing size follows its container (dpr 1)
    expect(m.leftDisplay).not.toBe('none');
    expect(m.leftW).toBeGreaterThan(250);
    expect(m.leftW).toBeLessThanOrEqual(271);
    expect(m.leftTabs).toBe(2);
    expect(m.leftRows).toBeGreaterThan(0);
  });

  it('P13-T11: collapse buttons and narrow layout are in the source', () => {
    expect(html).toContain('id="toggle-left"');
    expect(html).toContain('id="toggle-right"');
    expect(html).toContain('c4mp.leftCollapsed');
    expect(html).toContain('c4mp.rightCollapsed');
    expect(html).not.toContain('max-width: 900px');
    expect(html).toContain('max-width: 1099px');
  });

  chromeIt('P13-T11 real browser: 1000x800 puts the right panel under the map, left is 220px', () => {
    const m = measure({ size: '1000,800', script: MEASURE2 });
    expect(m.leftW).toBeGreaterThan(215);
    expect(m.leftW).toBeLessThanOrEqual(221);
    expect(m.panelColTop).toBeGreaterThanOrEqual(m.mapWrapBottom - 1); // under the map, not beside it
    // P14-T33c: the old `panelColH <= 0.5 * innerH` cap is gone on purpose (the panel scrolls inside
    // itself); the map keeps a minimum height instead.
    expect(m.mapWrapH).toBeGreaterThanOrEqual(320);
    expect(m.mapWrapW).toBeGreaterThan(m.innerW - 221 - 2); // map takes the full remaining width
    expect(m.mapWrapH).toBeGreaterThan(150);
    // canvas CSS box fills its wrapper. (The backing-store width follows via map.js's ResizeObserver,
    // which headless virtual time delivers late, so it is not asserted after a layout change.)
    expect(m.mapW).toBe(m.wrapW);
    expect(m.docScrollW).toBeLessThanOrEqual(m.innerW);
  });

  chromeIt('P14-T33c real browser: 1000x800 map keeps >= 320px and the panel scrolls inside itself', () => {
    const m = measure({ size: '1000,800', script: MEASURE_T33C });
    expect(m.mapWrapH).toBeGreaterThanOrEqual(320);
    expect(m.panelColH).toBeGreaterThan(0);
    expect(m.panelColTop).toBeGreaterThanOrEqual(m.mapWrapBottom - 1); // still under the map
    expect(m.docScrollH).toBeLessThanOrEqual(m.innerH); // nothing pushed off the page
    expect(m.panelColOverflowY).toBe('auto'); // the panel scrolls inside itself
    expect(m.panelColH).toBeLessThanOrEqual(m.innerH - m.mapWrapH); // panel fits in the space the map leaves
    expect(m.panelColTop + m.panelColH).toBeLessThanOrEqual(m.innerH + 1); // panel bottom is on screen
    // wide layout unchanged: side by side, map still >= 320px
    const wide = measure({ size: '1400,900', script: MEASURE_T33C });
    expect(wide.mapWrapH).toBeGreaterThanOrEqual(320);
    expect(wide.panelColTop).toBeLessThan(wide.mapWrapBottom);
  });

  chromeIt('P13-T11 real browser: collapse hides panels, map grows, reload restores state', () => {
    const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
    const base = measure({ script: MEASURE2, profile });
    expect(base.leftDisplay).not.toBe('none');
    expect(base.panelColDisplay).not.toBe('none');

    const clicks = `setTimeout(function(){document.getElementById('toggle-left').click();document.getElementById('toggle-right').click();},100);` + MEASURE2;
    const collapsed = measure({ script: clicks, profile });
    expect(collapsed.leftDisplay).toBe('none');
    expect(collapsed.panelColDisplay).toBe('none');
    expect(collapsed.toggleLeft).toBe('false');
    expect(collapsed.toggleRight).toBe('false');
    expect(collapsed.toggleLeftVisible && collapsed.toggleRightVisible).toBe(true); // re-open handles stay
    expect(collapsed.mapWrapW).toBeGreaterThan(base.mapWrapW + 600);
    expect(collapsed.mapW).toBe(collapsed.wrapW); // canvas box grew with its wrapper

    // second load, same profile, no clicks: state restored from localStorage
    const restored = measure({ script: MEASURE2, profile });
    expect(restored.leftDisplay).toBe('none');
    expect(restored.panelColDisplay).toBe('none');

    // clicking again re-opens and persists
    const reopen = measure({
      script: `setTimeout(function(){document.getElementById('toggle-left').click();document.getElementById('toggle-right').click();},100);` + MEASURE2,
      profile,
    });
    expect(reopen.leftDisplay).not.toBe('none');
    expect(reopen.panelColDisplay).not.toBe('none');
    expect(measure({ script: MEASURE2, profile }).leftDisplay).not.toBe('none');
  });

  chromeIt('P13-T11 real browser: collapse still works when localStorage throws', () => {
    const blocked = `try{Object.defineProperty(window,'localStorage',{get:function(){throw new Error('blocked')}});}catch(e){}`;
    // the throwing getter must be installed before the inline script runs: inject at the top of <body>
    const file = path.join(tmp, 'page-blocked.html');
    fs.writeFileSync(file, html.replace('<body>', `<body><script>${blocked}</script>`).replace('</body>', `<script>setTimeout(function(){document.getElementById('toggle-left').click();},100);${MEASURE2}</script></body>`));
    const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
    const m = JSON.parse(dom.match(/<pre id="__m">(.*?)<\/pre>/s)![1].replace(/&quot;/g, '"'));
    expect(m.leftDisplay).toBe('none');
    expect(m.panelColDisplay).not.toBe('none');
  });
});

if (!fs.existsSync(CHROME)) {
  // eslint-disable-next-line no-console
  console.warn(`viewer-layout: chrome-headless-shell not found at ${CHROME}; real-browser test skipped`);
}
