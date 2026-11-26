'use strict';
// b917 S1: one headless Chrome with one DevTools-protocol page, for release media and screenshots.
// Plain Node 20 CommonJS, no dependency. Ported from test/serve-chrome.test.ts (classes Cdp and Page).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { findBrowser } = require('./find-browser.js');

const CHROME_DEFAULT = findBrowser();   // null when no Chrome-like browser is installed
const READY_DEFAULT = '!!(window.C4PM_MAP && window.C4PM_STATE && window.C4PM_STATE.map && window.C4PM_STATE.map.cw)';
const SEND_MS = 60000;

const sleep = ms => new Promise(r => { setTimeout(r, ms).unref(); });
/** Block the thread for ms (close() is synchronous). */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** SIGKILL the browser's whole process group (it was spawned detached), then wait up to 3 s until the process is gone. */
function killTree(proc) {
  const pid = proc.pid;
  if (!pid) return;
  for (const target of [-pid, pid]) { try { process.kill(target, 'SIGKILL'); } catch (e) { /* already gone */ } }
  const end = Date.now() + 3000;
  for (;;) {
    try { process.kill(pid, 0); } catch (e) { return; }   // ESRCH: gone
    if (Date.now() > end) return;
    sleepSync(50);
  }
}
/** Remove a profile folder; Brave may still write its cache (ENOTEMPTY / EBUSY): retry a few times, then log and go on. */
function removeDirSafe(dir, tries = 8, delayMs = 250) {
  for (let n = 1; n <= tries; n++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) {
      if (n === tries) { console.warn(`cdp-page: could not remove ${dir} (${e.code || e.message}); left in place`); return false; }
      sleepSync(delayMs);
    }
  }
  return false;
}

/** 'file://' + absolute path with every segment encoded (repo paths hold '#') + optional hash. */
function fileUrl(file, hash) {
  const abs = path.resolve(file);
  return 'file://' + abs.split(path.sep).map(encodeURIComponent).join('/') + (hash || '');
}

/** Minimal DevTools client over one WebSocket (RFC 6455: masked client frames, whole server messages). */
class Cdp {
  constructor(socket) {
    this.id = 0;
    this.waiting = new Map();
    this.buf = Buffer.alloc(0);
    this.socket = socket;
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    socket.on('error', () => { /* closed with the page */ });
  }

  static connect(wsUrl) {
    const u = new URL(wsUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({ agent: false, host: u.hostname, port: u.port, path: u.pathname, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
      req.on('upgrade', (_res, socket, head) => { const c = new Cdp(socket); if (head.length) { c.buf = head; c.drain(); } resolve(c); });
      req.on('error', reject);
      req.end();
    });
  }

  drain() {
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

  send(method, params = {}) {
    const id = ++this.id;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = crypto.randomBytes(4);
    const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
      : payload.length < 65536 ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
    const body = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method}: no answer in ${SEND_MS / 1000} s`)); }, SEND_MS);
      this.waiting.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      this.socket.write(Buffer.concat([head, mask, body]));
    });
  }

  end() { this.socket.destroy(); }
}

/** One headless Chrome with one page. */
class Page {
  constructor(proc, cdp, dir) {
    this.proc = proc;
    this.cdp = cdp;
    this.dir = dir;
    this.closed = false;
  }

  send(method, params) { return this.cdp.send(method, params); }

  /** Value of a JS expression in the page; a throw becomes an Error. */
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('page eval failed: ' + text + ' :: ' + expr.slice(0, 120));
    }
    return r.result.value;
  }

  /** Polls the expression every 100 ms until it is truthy. */
  async waitFor(expr, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      let ok = false;
      try { ok = await this.eval(expr); } catch (e) { ok = false; }   // not-ready pages may throw while loading
      if (ok) return;
      await sleep(100);
    }
    throw new Error(`still false after ${ms} ms: ${expr}`);
  }

  /** Navigate, wait for the ready expression, then 1.5 s for the first draw and any fly. */
  async goto(url, { ready = READY_DEFAULT, ms = 30000 } = {}) {
    await this.cdp.send('Page.navigate', { url });
    await this.waitFor(ready, ms);
    await sleep(1500);
  }

  /** prefers-color-scheme 'light' or 'dark'. */
  async theme(name) {
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }] });
  }

  /** PNG of the page; written to file when given. */
  async shot(file) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    if (file) fs.writeFileSync(file, buf);
    return buf;
  }

  /** Idempotent: end the socket, kill Chrome, remove the profile folder. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cdp.end();
    killTree(this.proc);
    if (this.proc.stderr) this.proc.stderr.destroy();
    removeDirSafe(this.dir);
  }
}

function devToolsAddress(proc) {
  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chrome printed no DevTools address in 20 s: ${err.slice(0, 300)}`)), 20000);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => {
      err += d;
      const m = /DevTools listening on ws:\/\/([\d.]+:\d+)\//.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', () => { clearTimeout(timer); reject(new Error(`Chrome exited early: ${err.slice(0, 300)}`)); });
  });
}

function newTarget(wsBase) {
  const [host, port] = wsBase.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, method: 'PUT', host, port, path: '/json/new?about:blank' }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Start headless Chrome and open one page of width x height. */
async function launch({ width, height, chrome } = {}) {
  const bin = chrome || CHROME_DEFAULT;
  if (!bin || !fs.existsSync(bin)) throw new Error(`no Chrome-like browser found${bin ? ': ' + bin : ''} (set CHROME=...)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-media-ud-'));
  const proc = spawn(bin, ['--headless', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });   // own process group, so killTree reaches the helpers
  const onExit = () => { killTree(proc); removeDirSafe(dir, 3, 150); };   // this run's own profile only
  process.on('exit', onExit);
  let page = null;
  try {
    const wsBase = await devToolsAddress(proc);
    const target = await newTarget(wsBase);
    page = new Page(proc, await Cdp.connect(target.webSocketDebuggerUrl), dir);
    await page.cdp.send('Page.enable');
    await page.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    proc.once('exit', () => process.removeListener('exit', onExit));
    return page;
  } catch (e) {
    if (page) page.close(); else onExit();
    throw e;
  }
}

module.exports = { launch, fileUrl, sleep, CHROME_DEFAULT };
