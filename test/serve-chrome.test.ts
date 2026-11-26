import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import { CLI_JS, SPAWN_TIMEOUT_MS } from './helpers/runCli';
import { CDP_CHROME as CHROME, cdpChromeInstalled as chromeInstalled } from './helpers/chrome';

// Phase 30 SV7/SV8/b901 slice 6: c4pm serve opened in real headless Chrome (live light, no key, stopped, IO view, live refresh).
// Skipped when Chrome is missing.
//
// Why Chrome is driven through the DevTools protocol and not `--dump-dom --virtual-time-budget`: a served page holds an api/wait
// long-poll open all the time, and Chrome's virtual time never advances while a request is pending (the run hangs until it is
// killed); `--dump-dom` without it dumps at the load event, before the boot fetch has answered. So the tests open the page in a
// headless Chrome, poll an expression in real time, and read the DOM / take the screenshot when it holds. A server that dies
// while a page is open (case 3) needs the same: a page cannot load from a server that is already gone.

const URL_LINE = /^c4mp serve: (http:\/\/127\.0\.0\.1:\d+\/)#t=([A-Za-z0-9_-]{43})$/;
const SAMPLE = path.resolve(__dirname, 'fixtures', 'sample');
const IO_SHOP = path.resolve(__dirname, 'fixtures', 'io-shop');
const SHOTS = process.env.C4PM_SERVE_SHOTS || '';   // case 6 writes its screenshots here when set (not asserted)
const chromeIt = chromeInstalled ? it : it.skip;
const WAIT_MS = 30_000;

const tmps: string[] = [];
const children: ChildProcess[] = [];
const pages: Page[] = [];
afterEach(() => {
  for (const p of pages.splice(0)) p.close();
  for (const c of children.splice(0)) { c.kill('SIGKILL'); c.stdout?.destroy(); c.stderr?.destroy(); }
});
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

/** Copy of a fixture in a temp folder (serve may write data/cache files), anchored and initialised as a c4pm project. */
function copyFixture(src: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-serve-chrome-')));
  tmps.push(repo);
  fs.cpSync(src, repo, { recursive: true });
  if (!fs.existsSync(path.join(repo, '.git'))) fs.mkdirSync(path.join(repo, '.git'));
  initProject(repo);
  return repo;
}

/** Small repo with one plan file whose system title is `App`. */
function planRepo(): { repo: string; plan: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-serve-chrome-')));
  tmps.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'serve-live' }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  initProject(repo);
  const project = tryResolveProject(repo)!;
  fs.mkdirSync(project.planDir, { recursive: true });
  const plan = path.join(project.planDir, 'arch.c4');
  fs.writeFileSync(plan, "model {\n  app = system 'App' {\n    web = container 'Web'\n  }\n}\n");
  return { repo, plan };
}

interface Served { proc: ChildProcess; base: string; token: string; exit: Promise<number | null> }

/** `c4pm serve --no-open --port 0` as a child; resolves when its link line is printed. */
function serve(repo: string, extra: string[] = []): Promise<Served> {
  const proc = spawn(process.execPath, [CLI_JS, 'serve', '--repo', repo, '--no-open', '--port', '0', ...extra]);
  children.push(proc);
  const exit = new Promise<number | null>(r => proc.on('exit', code => r(code)));
  const lines: string[] = [];
  let buf = '';
  proc.stderr!.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no link line in ${SPAWN_TIMEOUT_MS / 2} ms: ${lines.join(' | ')}`)), SPAWN_TIMEOUT_MS / 2);
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => {
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const l of parts) {
        lines.push(l);
        const m = URL_LINE.exec(l);
        if (m) { clearTimeout(timer); resolve({ proc, base: m[1], token: m[2], exit }); }
      }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`serve exited ${code}: ${lines.join(' | ')}`)); });
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => { setTimeout(r, ms).unref(); });   // unref: a pending race timer never holds jest open

/** Minimal DevTools-protocol client over one WebSocket (RFC 6455: masked client frames, whole server messages). */
class Cdp {
  private id = 0;
  private waiting = new Map<number, (r: any) => void>();
  private buf = Buffer.alloc(0);
  private constructor(private socket: import('net').Socket) {
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    socket.on('error', () => { /* closed with the page */ });
  }
  static connect(wsUrl: string): Promise<Cdp> {
    const u = new URL(wsUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({ agent: false, host: u.hostname, port: u.port, path: u.pathname, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
      req.on('upgrade', (_res, socket, head) => { const c = new Cdp(socket); if (head.length) { c.buf = head; c.drain(); } resolve(c); });
      req.on('error', reject);
      req.end();
    });
  }
  private drain(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const text = b.subarray(off, off + len).toString('utf8');
      this.buf = b.subarray(off + len);
      if ((b[0] & 0x0f) !== 1) continue;   // only text frames carry protocol messages
      const msg = JSON.parse(text);
      const done = this.waiting.get(msg.id);
      if (done) { this.waiting.delete(msg.id); done(msg); }
    }
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = crypto.randomBytes(4);
    const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
      : payload.length < 65536 ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
    const body = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer in 20 s`)), 20_000);
      this.waiting.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      this.socket.write(Buffer.concat([head, mask, body]));
    });
  }
  end(): void { this.socket.destroy(); }
}

/** One headless Chrome with one page; closed by afterEach. */
class Page {
  private constructor(private proc: ChildProcess, private cdp: Cdp, private dir: string) {}

  static async open(url: string, opts: { dark?: boolean } = {}): Promise<Page> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-serve-chrome-ud-'));
    tmps.push(dir);
    const proc = spawn(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(proc);
    const wsBase = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`Chrome printed no DevTools address in 20 s: ${err.slice(0, 300)}`)), 20_000);
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (d: string) => {
        err += d;
        const m = /DevTools listening on ws:\/\/([\d.]+:\d+)\//.exec(err);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', () => { clearTimeout(timer); reject(new Error(`Chrome exited early: ${err.slice(0, 300)}`)); });
    });
    const target = await new Promise<any>((resolve, reject) => {
      const [host, port] = wsBase.split(':');
      const req = http.request({ agent: false, method: 'PUT', host, port, path: '/json/new?about:blank' }, res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end();
    });
    const page = new Page(proc, await Cdp.connect(target.webSocketDebuggerUrl), dir);
    pages.push(page);
    await page.cdp.send('Page.enable');
    await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    if (opts.dark !== undefined) await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }] });
    await page.cdp.send('Page.navigate', { url });
    return page;
  }

  /** Value of a JS expression in the page (undefined when it throws). */
  async eval(expr: string): Promise<any> {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.exceptionDetails ? undefined : r.result.value;
  }

  /** Polls the expression every 100 ms until it is truthy; throws with the DOM head when it never is. */
  async waitFor(expr: string, ms = WAIT_MS): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(expr)) return;
      await sleep(100);
    }
    throw new Error(`still false after ${ms} ms: ${expr}; header: ${await this.eval("(document.getElementById('header')||{outerHTML:'(none)'}).outerHTML.slice(0,200)")}; map-wrap: ${await this.eval("((document.getElementById('map-wrap')||{}).textContent||'').slice(0,200)")}`);
  }

  async shot(file: string): Promise<void> {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  close(): void { this.cdp.end(); this.proc.kill('SIGKILL'); this.proc.stderr?.destroy(); }   // the profile folder is in tmps: afterAll removes it
}

const LIVE = "document.getElementById('header').getAttribute('data-live') === 'live'";
const STATE = (s: string): string => `document.getElementById('header').getAttribute('data-live') === '${s}'`;
const BADGE = "(document.getElementById('live-badge')||{}).textContent";
const MAP_TEXT = "(document.getElementById('map-wrap')||{}).textContent || ''";

describe('c4pm serve in real Chrome', () => {
  chromeIt('1: the page with the key loads, shows the tree and the green light', async () => {
    const s = await serve(copyFixture(SAMPLE));
    const p = await Page.open(`${s.base}#t=${s.token}`);
    await p.waitFor(LIVE);
    expect(await p.eval(BADGE)).toBe('Live: the map is up to date');
    expect(await p.eval("document.querySelectorAll('.lt-row').length")).toBeGreaterThan(0);
    expect(await p.eval(MAP_TEXT)).not.toContain('No data');
    expect(await p.eval(MAP_TEXT)).not.toContain('needs the link');
  }, SPAWN_TIMEOUT_MS);

  chromeIt('2: the page without the key says it needs the link, light failed', async () => {
    const s = await serve(copyFixture(SAMPLE));
    const p = await Page.open(s.base);
    await p.waitFor(STATE('failed'));
    expect(await p.eval(MAP_TEXT)).toContain('This page needs the link that c4mp serve printed');
  }, SPAWN_TIMEOUT_MS);

  // A page cannot load from a server that is already gone, so "stopped" is the open page that loses its server.
  chromeIt('3: after SIGINT the open page says serve is not running, light stopped', async () => {
    const s = await serve(copyFixture(SAMPLE));
    const p = await Page.open(`${s.base}#t=${s.token}`);
    await p.waitFor(LIVE);
    s.proc.kill('SIGINT');
    expect(await Promise.race([s.exit, sleep(10_000).then(() => 'timeout')])).toBe(0);
    await p.waitFor(STATE('stopped'));
    expect(await p.eval(BADGE)).toContain('serve');   // the SV8 stopped text; the exact words are asserted in test/viewer-live.test.ts
    // a fresh page for the same link finds nothing listening: Chrome shows its own error page, not the viewer
    const q = await Page.open(`${s.base}#t=${s.token}`);
    await sleep(1500);
    expect(await q.eval("document.getElementById('header') === null")).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  chromeIt('4: the IO view draws its boxes (the CSP does not block the wireframe measurer)', async () => {
    const s = await serve(copyFixture(IO_SHOP));
    const p = await Page.open(`${s.base}#io&t=${s.token}`);
    await p.waitFor(LIVE);
    // the camera exists and the first draw is done (see test/io-view-chrome.test.ts: the same readiness test), then the Products screen has a box
    await p.waitFor('(function(){ var s = window.C4PM_STATE; return !!(s && s.map && s.map.cam && !s.map.raf); })()');
    expect(await p.eval("(function(){ var r = window.C4PM_IOVIEW.rect('shop.web.products'); return !!r && r.w > 0 && r.h > 0; })()")).toBe(true);
    expect(await p.eval(MAP_TEXT)).not.toContain('No data');
  }, SPAWN_TIMEOUT_MS);

  // Best effort (plan SV8): the edit lands while the page is open; the page reloads itself and the new title shows.
  chromeIt('5: a plan title edited while the page is open shows after the live reload', async () => {
    const { repo, plan } = planRepo();
    const s = await serve(repo, ['--debounce', '100']);
    const p = await Page.open(`${s.base}#t=${s.token}`);
    await p.waitFor(LIVE);
    const names = "Array.prototype.map.call(document.querySelectorAll('.lt-name'), function(e){ return e.textContent; }).join('|')";
    expect(await p.eval(names)).toContain('Web');
    fs.writeFileSync(plan, "model {\n  app = system 'App' {\n    web = container 'Renamed Web'\n  }\n}\n");
    await p.waitFor(`${names}.indexOf('Renamed Web') >= 0`, 40_000);
  }, SPAWN_TIMEOUT_MS);

  // Screenshots for K (not asserted): only when C4PM_SERVE_SHOTS names a folder.
  chromeIt('6: screenshots of the live light (light and dark)', async () => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const s = await serve(copyFixture(SAMPLE));
    for (const [name, dark] of [['served-live.png', false], ['served-live-dark.png', true]] as const) {
      const p = await Page.open(`${s.base}#t=${s.token}`, { dark });
      await p.waitFor(LIVE);
      await sleep(500);   // the glow is a CSS transition
      await p.shot(path.join(SHOTS, name));
    }
  }, SPAWN_TIMEOUT_MS);
});
