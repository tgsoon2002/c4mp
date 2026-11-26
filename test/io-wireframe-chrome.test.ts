import * as fs from 'fs';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { wireframeRules } from '../src/c4/wireframeHtml';
import { chromeInstalled, runChrome } from './helpers/chrome';

// W4 (b300): viewer/ioWireframe.js in real headless Chrome (the vm harness has no layout engine; its half is viewer-io-wireframe.test.ts).
// The rule table is W1's wireframeRules() (the one the build injects); the Map page + site.css are copied under fixtures/io-wireframe
// together with a golden taken from the mock's measure() (Document/io-wireframe-mock.html) at 1280x800 and 1440x900.

const FX = path.resolve(__dirname, 'fixtures', 'io-wireframe');
const SCRIPT = path.resolve(__dirname, '..', 'viewer', 'ioWireframe.js');
const chromeIt = chromeInstalled ? it : it.skip;
const TEST_TIMEOUT = 120000;

const RULES = wireframeRules();

interface Box { ref: string; x: number; y: number; w: number; h: number; hidden: boolean; order: number }
interface Res { ok: boolean; reason?: string; reasons?: string[]; viewport?: { w: number; h: number }; boxes?: Box[] }
type Item = { fqn: string; html: string; viewport: { w: number; h: number } };

// Runs measureAll in Chrome. `tail` is extra page JS that may add fields to the output object `o`.
function inChrome(items: Item[], tail = '', env: Record<string, unknown> = {}): { res: Record<string, Res>; extra: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-wire-chrome-'));
  try {
    const file = path.join(dir, 'page.html');
    const data = JSON.stringify({ items, rules: RULES, env }).replace(/</g, '\\u003c');
    fs.writeFileSync(file, `<!doctype html><html><body><script>${fs.readFileSync(SCRIPT, 'utf8')}</script><script>
var D = ${data}, o = { extra: {} };
o.res = window.C4PM_IO_WIREFRAME.measureAll(D.items, D.rules);
${tail}
var pre = document.createElement('pre'); pre.id = '__m'; pre.textContent = encodeURIComponent(JSON.stringify(o)); document.body.appendChild(pre);
</script></body></html>`);
    const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=5000', '--window-size=1400,900', pathToFileURL(file).href]);
    const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
    if (!m) throw new Error('measurement element not found in dumped DOM');
    const o = JSON.parse(decodeURIComponent(m[1]));
    return { res: o.res, extra: o.extra };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mapHtml = () => fs.readFileSync(path.join(FX, 'map_page.html'), 'utf8')
  .replace(/<link rel="stylesheet" href="site.css">/, () => `<style>${fs.readFileSync(path.join(FX, 'site.css'), 'utf8')}</style>`);
const golden = JSON.parse(fs.readFileSync(path.join(FX, 'map_page.golden.json'), 'utf8')) as Record<string, Box[]>;
const px = (b: Box) => [b.x, b.y, b.w, b.h].map(Math.round).join(',');

describe('ioWireframe in Chrome', () => {
  chromeIt('Map page: boxes equal the golden from the mock, at the device size and at 1440x900', () => {
    const { res } = inChrome([
      { fqn: 'map1280', html: mapHtml(), viewport: { w: 1280, h: 800 } },
      { fqn: 'map1440', html: mapHtml(), viewport: { w: 1440, h: 900 } },
    ]);
    for (const [fqn, key] of [['map1280', '1280x800'], ['map1440', '1440x900']]) {
      const r = res[fqn];
      expect({ fqn, ok: r.ok, reason: r.reason }).toEqual({ fqn, ok: true, reason: undefined });
      expect(r.boxes!.length).toBe(46);
      expect(r.boxes!.map(b => b.ref)).toEqual(golden[key].map(b => b.ref));
      r.boxes!.forEach((b, i) => {
        const g = golden[key][i];
        expect({ ref: b.ref, hidden: b.hidden, order: b.order }).toEqual({ ref: g.ref, hidden: g.hidden, order: g.order });
        for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(b[k] - g[k])).toBeLessThan(0.01);
      });
    }
    const drawer = res.map1440.boxes!.find(b => b.ref === 'board_drawer')!;
    expect(px(drawer)).toBe('270,506,750,394');
    expect(drawer.hidden).toBe(true);
  }, TEST_TIMEOUT);

  // Each case is one screen; all run in one measureAll call (one layout pass). Data-driven: [name, html, viewport, reason regex | null].
  const SQ = 'width:10px;height:10px';
  const CASES: Array<[string, string, string | null]> = [
    ['display:none', `<div data-c4="gone" style="display:none"></div><div data-c4="ok" style="${SQ}"></div>`, 'data-c4 "gone" has no size'],
    ['closed details', `<details><summary>s</summary><div data-c4="inner" style="${SQ}"></div></details>`, 'data-c4 "inner" is inside a closed <details>'],
    ['ref inside svg', `<svg width="10" height="10"><rect data-c4="in_svg" width="5" height="5"></rect></svg><div data-c4="ok" style="${SQ}"></div>`, 'data-c4 "in_svg" is inside <svg>'],
    ['ref inside object', `<object><div data-c4="in_obj" style="${SQ}"></div></object>`, 'data-c4 "in_obj" is inside <object>'],
    ['outside the viewport', `<div data-c4="far" style="position:absolute;left:5000px;top:0;${SQ}"></div>`, 'data-c4 "far" is outside the 300x200 viewport'],
    ['no data-c4', `<div style="${SQ}"></div>`, 'no data-c4 element'],
    ['ok: form unwrapped, author id=vp, hidden kept', `<form id="vp" style="width:50px"><div data-c4="a" style="${SQ}"></div></form><div data-c4="b" hidden style="${SQ}"></div>`, null],
  ];

  chromeIt('problems become reasons on their own screen only; other screens still measure', () => {
    const items = CASES.map(([name, html]) => ({ fqn: name, html, viewport: { w: 300, h: 200 } }));
    items.push({ fqn: 'bad viewport', html: '<div data-c4="x"></div>', viewport: { w: 0, h: 200 } });
    const { res } = inChrome(items);
    for (const [name, , want] of CASES) {
      const r = res[name];
      if (want === null) {
        expect({ name, ok: r.ok }).toEqual({ name, ok: true });
        expect(r.boxes!.map(b => [b.ref, b.hidden, b.order, Math.round(b.w), Math.round(b.h)])).toEqual([['a', false, 0, 10, 10], ['b', true, 1, 10, 10]]);
      } else {
        expect({ name, ok: r.ok }).toEqual({ name, ok: false });
        expect(r.reason).toContain(want);
        expect(r.reasons!.length).toBeGreaterThan(0);
      }
    }
    expect(res['bad viewport'].ok).toBe(false);
    expect(res['bad viewport'].reason).toMatch(/bad viewport/);
  }, TEST_TIMEOUT);

  chromeIt('only layout survives: colour/background/border/font are dropped, nested rules and @media rules are dropped, positions come from layout CSS', () => {
    const html = `<style>.a{width:40px;height:20px;background:red;border:9px solid;font-size:50px;color:blue}
      @media all{.a{width:999px}} .a{ &:hover{width:1px} } .x:host{width:7px}</style><div class="a" data-c4="a" style="margin-left:5px;transform:scale(9);padding:3px"></div>`;
    const { res } = inChrome([{ fqn: 's', html, viewport: { w: 300, h: 200 } }]);
    expect(res.s.ok).toBe(true);
    const b = res.s.boxes![0];
    expect([b.x, b.y, b.w, b.h]).toEqual([5, 0, 40, 20]);
  }, TEST_TIMEOUT);

  chromeIt('hostile fragment: no network request, nothing runs, the screen still measures', async () => {
    // The server is a separate process: runChrome blocks this one, so an in-process server could not answer (or count) in time.
    const logFile = path.join(os.tmpdir(), `c4pm-wire-hits-${process.pid}.log`);
    fs.writeFileSync(logFile, '');
    const server = spawn(process.execPath, ['-e', `const fs=require('fs');const s=require('http').createServer((q,r)=>{fs.appendFileSync(process.argv[1],q.url+'\\n');r.end('body{}')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`, logFile]);
    const port = await new Promise<number>((res, rej) => { server.stdout.once('data', d => res(Number(String(d).trim()))); server.once('error', rej); });
    const base = `http://127.0.0.1:${port}`;
    const html = `<style>@import url(${base}/import.css); @import "${base}/import2.css";
        @font-face{font-family:f;src:url(${base}/font.woff)} .a{width:30px;height:30px;list-style-image:url(${base}/list.png);background:url(${base}/css-bg.png);cursor:url(${base}/cur.png),auto}</style>
      <link rel="stylesheet" href="${base}/link.css">
      <script>window.__pwn = 1; fetch("${base}/script")</script>
      <img src="${base}/img.png" onerror="window.__pwn = 2" onload="window.__pwn = 3">
      <iframe src="${base}/iframe.html"></iframe><video src="${base}/v.mp4" poster="${base}/poster.png"></video>
      <svg onload="window.__pwn = 4"><image href="${base}/svg.png"/></svg>
      <table background="${base}/table-bg.png"><tr><td background="${base}/td-bg.png" data-c4="cell" style="width:20px;height:20px"></td></tr></table>
      <div data-c4="a" class="a" background="${base}/div-bg.png" onclick="window.__pwn = 5" onmouseover="window.__pwn = 6" style="background:url(${base}/inline-bg.png);background-image:image-set(url(${base}/set.png) 1x)">
        <a href="${base}/anchor" data-c4="link" style="display:block;width:10px;height:10px">x</a>
        <input type="image" src="${base}/input.png" data-c4="inp" style="width:10px;height:10px">
        <button formaction="${base}/fa" style="width:10px;height:10px" data-c4="btn" onfocus="window.__pwn = 7" autofocus>b</button>
      </div>`;
    try {
      const { res, extra } = inChrome(
        [{ fqn: 'hostile', html, viewport: { w: 300, h: 200 } }],
        'o.extra.pwn = window.__pwn === undefined ? null : window.__pwn;',
      );
      await new Promise(r => setTimeout(r, 300));   // let any late request arrive before we count
      const hits = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      expect({ hits }).toEqual({ hits: [] });
      expect(extra.pwn).toBeNull();
      expect(res.hostile.ok).toBe(true);
      expect(res.hostile.boxes!.map(b => b.ref)).toEqual(['cell', 'a', 'link', 'inp', 'btn']);
    } finally {
      server.kill();
      fs.rmSync(logFile, { force: true });
    }
  }, TEST_TIMEOUT);
});
