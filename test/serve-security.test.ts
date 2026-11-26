import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createServeServer, SERVE_ROUTES, type ServeOptions, type ServeServer } from '../src/serve/server';
import { newToken, securityHeaders } from '../src/serve/security';
import { createLiveModel, type LiveModel, type PageBuild } from '../src/page/liveModel';
import type { ViewModel } from '../src/types';
import { CREDIT_URL, NO_URL_EXCEPT_CREDIT, URL_RULE_MISSES } from './helpers/creditUrl';

// Phase 30 SV6 (b793, b57, b60): the server core of c4pm serve (src/serve/). Every server here runs in this process on
// port 0 and is called with http.request. One test per attack of plan section 4.5 that a request can show, plus the
// checks of 4.3, the security headers, the long-poll and close().

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

/** A live model on a tmp folder with injected seams (as test/live-model.test.ts): `change(v)` makes the next build `{ v }`. */
function fakeLive(): { live: LiveModel; change: (v: string) => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-serve-')));
  tmps.push(dir);
  let v = 'one';
  let fp = 0;
  let onChange: ((files: string[]) => void) | null = null;
  const build = (): PageBuild => ({ model: { v } as unknown as ViewModel, inputs: { planTexts: new Map([['p.c4', `plan ${v}`]]), boardText: 'board' } });
  const live = createLiveModel(dir, {}, {
    debounceMs: 10,
    build,
    fingerprint: () => `fp${fp}`,
    watch: (_r, _c, o) => { onChange = o.onChange; return () => { onChange = null; }; },
  });
  return { live, change: (next: string) => { v = next; fp++; onChange?.(['src/a.ts']); } };
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; text: string }
interface Call { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean }

/** One request to 127.0.0.1:<port>; Host is ours unless headers.Host says otherwise. No keep-alive. */
function call(port: number, c: Call = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...c.headers };
    if (c.body !== undefined && !c.chunked) headers['Content-Length'] = String(Buffer.byteLength(c.body));
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port, method: c.method ?? 'GET', path: c.path ?? '/', headers, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => { if (!answered) reject(err); });   // a refused body may reset the socket after the answer
    if (c.body !== undefined) req.write(c.body);
    req.end();
  });
}

const HTTP_URL = /https?:\/\//;

describe('c4pm serve server (SV6)', () => {
  const token = newToken();
  let fake: ReturnType<typeof fakeLive>;
  let server: ServeServer;
  let port: number;
  let host: string;
  let url: string;
  /** The headers of a good API call: our token (and, for a write, our Origin and JSON). */
  const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ 'X-C4PM-Token': token, ...extra });
  const write = (extra: Record<string, string> = {}): Record<string, string> =>
    auth({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...extra });

  beforeAll(async () => {
    fake = fakeLive();
    server = createServeServer({ live: fake.live, token, port: 0, waitMs: 300 });
    ({ host, port, url } = await server.listen());
  });
  afterAll(() => server.close());

  describe('bind (4.1)', () => {
    it('listens on 127.0.0.1 only, on a free port; the URL carries the token in the fragment', () => {
      expect(host).toBe('127.0.0.1');
      expect(port).toBeGreaterThan(0);
      expect(url).toBe(`http://127.0.0.1:${port}/#t=${token}`);
    });

    it('another computer: a connection to this machine\'s network address is refused', async () => {
      const outside = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
      if (!outside) return;   // no network address on this machine: nothing else can reach it
      const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        const s = net.connect({ host: outside.address, port }, () => { s.destroy(); resolve(null); });
        s.on('error', resolve);
      });
      expect(err?.code).toBe('ECONNREFUSED');
    });

    it('a busy port is refused, never another one instead', async () => {
      const other = createServeServer({ live: fakeLive().live, token, port });
      await expect(other.listen()).rejects.toThrow(`port ${port} is in use`);
      await other.close();
    });

    it('newToken: 32 random bytes in base64url, new each time', () => {
      const a = newToken();
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(a, 'base64url')).toHaveLength(32);
      expect(newToken()).not.toBe(a);
    });
  });

  describe('the read routes', () => {
    it('b168: the URL rule allows only the credit link; any other http(s) URL still fails it', () => {
      expect(`<a href="${CREDIT_URL}">`).not.toMatch(NO_URL_EXCEPT_CREDIT);
      for (const s of URL_RULE_MISSES) expect(s).toMatch(NO_URL_EXCEPT_CREDIT);
    });

    it('GET / is the page shell, without a token, with no http(s) URL and no data', async () => {
      const a = await call(port, { path: '/', headers: { 'Sec-Fetch-Site': 'none' } });
      expect(a.status).toBe(200);
      expect(a.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(a.text).toContain('window.C4PM_DATA = null');
      expect(a.text).toContain('X-C4PM-Token');
      expect(a.text).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)
    });

    it('GET /viewer.js is the viewer script, without a token, with no http(s) URL', async () => {
      const a = await call(port, { path: '/viewer.js', headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(a.status).toBe(200);
      expect(a.headers['content-type']).toBe('application/javascript; charset=utf-8');
      expect(a.text.length).toBeGreaterThan(1000);
      expect(a.text).not.toMatch(HTTP_URL);
    });

    it('GET /api/boot: the page data as the live model holds it, the generation, the stamps, settings, error', async () => {
      const a = await call(port, { path: '/api/boot', headers: auth({ 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}` }) });
      expect(a.status).toBe(200);
      expect(a.headers['content-type']).toBe('application/json; charset=utf-8');
      const s = fake.live.current();
      expect(a.text.startsWith(`{"data":${s.dataJson},`)).toBe(true);
      expect(JSON.parse(a.text)).toEqual({ data: JSON.parse(s.dataJson), generation: s.generation, stamps: s.stamps, settings: {}, error: null });
    });

    it('localhost:<port> is our Host too', async () => {
      expect((await call(port, { path: '/api/boot', headers: auth({ Host: `localhost:${port}` }) })).status).toBe(200);
    });

    it('the write routes are checked and read, then answer 501 and write nothing', async () => {
      for (const r of SERVE_ROUTES.filter(x => x.method !== 'GET')) {
        const a = await call(port, { method: r.method, path: r.path, headers: write(), body: '{}' });
        expect([r.path, a.status]).toEqual([r.path, 501]);
        expect(JSON.parse(a.text).message).toMatch(/not built yet.*nothing was written/);
      }
    });
  });

  describe('attacks (4.5) and request checks (4.3)', () => {
    it('DNS rebinding: a foreign Host is 403 even with the right token', async () => {
      for (const h of ['evil.test', `evil.test:${port}`, `127.0.0.1:${port + 1}`, `localhost.evil.test:${port}`, '127.0.0.1']) {
        const a = await call(port, { path: '/api/boot', headers: auth({ Host: h }) });
        expect([h, a.status]).toEqual([h, 403]);
        expect(a.text).not.toContain('"data"');
      }
      expect((await call(port, { path: '/', headers: { Host: `evil.test:${port}` } })).status).toBe(403);
    });

    it('a foreign Origin is 403: another site, another local port, on a read and on a write', async () => {
      for (const origin of ['http://evil.test', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, 'null']) {
        expect([origin, (await call(port, { path: '/api/boot', headers: auth({ Origin: origin }) })).status]).toEqual([origin, 403]);
        expect([origin, (await call(port, { method: 'POST', path: '/api/board', headers: write({ Origin: origin }), body: '{}' })).status]).toEqual([origin, 403]);
      }
    });

    it('a write without an Origin is 403 (a non-browser client must say where it comes from)', async () => {
      const headers = write();
      delete headers.Origin;
      expect((await call(port, { method: 'POST', path: '/api/board', headers, body: '{}' })).status).toBe(403);
    });

    it('Sec-Fetch-Site cross-site or same-site is 403; none only for the page itself', async () => {
      for (const site of ['cross-site', 'same-site']) {
        for (const p of ['/', '/viewer.js', '/api/boot']) {
          expect([site, p, (await call(port, { path: p, headers: auth({ 'Sec-Fetch-Site': site }) })).status]).toEqual([site, p, 403]);
        }
      }
      expect((await call(port, { path: '/api/boot', headers: auth({ 'Sec-Fetch-Site': 'none' }) })).status).toBe(403);
      expect((await call(port, { path: '/viewer.js', headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(403);
    });

    it('no token, a wrong token, a shorter token: 401, no data', async () => {
      const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      for (const headers of [{} as Record<string, string>, { 'X-C4PM-Token': wrong }, { 'X-C4PM-Token': token.slice(0, 10) }, { 'X-C4PM-Token': '' }]) {
        for (const p of ['/api/boot', '/api/wait?since=1']) {
          const a = await call(port, { path: p, headers });
          expect([p, a.status]).toEqual([p, 401]);
          expect(a.text).not.toContain('"data"');
        }
      }
      expect((await call(port, { method: 'POST', path: '/api/board', headers: write({ 'X-C4PM-Token': wrong }), body: '{}' })).status).toBe(401);
    });

    it('the token in the query string is never taken: 401', async () => {
      for (const q of [`t=${token}`, `token=${token}`, `X-C4PM-Token=${encodeURIComponent(token)}`]) {
        expect([q, (await call(port, { path: `/api/boot?${q}` })).status]).toEqual([q, 401]);
      }
    });

    it('a wrong method is 405; OPTIONS (a CORS preflight) is 403 with no Access-Control-* header', async () => {
      const ours = `http://127.0.0.1:${port}`;
      expect((await call(port, { method: 'POST', path: '/api/boot', headers: write(), body: '{}' })).status).toBe(405);
      expect((await call(port, { method: 'GET', path: '/api/board', headers: auth() })).status).toBe(405);
      expect((await call(port, { method: 'HEAD', path: '/api/boot', headers: auth() })).status).toBe(405);
      expect((await call(port, { method: 'DELETE', path: '/', headers: { Origin: ours } })).status).toBe(405);
      const pre = await call(port, {
        method: 'OPTIONS', path: '/api/board',
        headers: { Origin: 'http://evil.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-c4pm-token' },
      });
      expect(pre.status).toBe(403);
      expect(Object.keys(pre.headers).filter(h => h.startsWith('access-control-'))).toEqual([]);
      expect((await call(port, { method: 'OPTIONS', path: '/api/boot', headers: { Origin: ours } })).status).toBe(403);
    });

    it('a wrong content type is 415: a form post, text/plain, none', async () => {
      for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', '']) {
        const headers = write({ 'Content-Type': ct });
        if (!ct) delete headers['Content-Type'];
        expect([ct, (await call(port, { method: 'POST', path: '/api/board', headers, body: '{}' })).status]).toEqual([ct, 415]);
      }
      expect((await call(port, { method: 'PUT', path: '/api/settings', headers: write({ 'Content-Type': 'application/json; charset=utf-8' }), body: '{}' })).status).toBe(501);
    });

    it('a body over the route limit is 413, by Content-Length and when sent chunked; a body that is not JSON is 400', async () => {
      const big = JSON.stringify({ x: 'a'.repeat(17 * 1024) });   // api/settings takes 16 KB
      expect((await call(port, { method: 'PUT', path: '/api/settings', headers: write(), body: big })).status).toBe(413);
      expect((await call(port, { method: 'PUT', path: '/api/settings', headers: write(), body: big, chunked: true })).status).toBe(413);
      expect((await call(port, { method: 'POST', path: '/api/board', headers: write(), body: JSON.stringify({ x: 'a'.repeat(257 * 1024) }) })).status).toBe(413);
      expect((await call(port, { method: 'POST', path: '/api/board', headers: write(), body: '{not json' })).status).toBe(400);
      expect((await call(port, { method: 'POST', path: '/api/board', headers: write(), body: '' })).status).toBe(400);
    });

    it('a path with .., an encoded .., a repo file name or an unknown path is 404: only fixed routes', async () => {
      const paths = ['/api/../api/boot', '/../viewer.js', '/%2e%2e/viewer.js', '/viewer.js/..', '/./viewer.js', '//api/boot',
        '/api/boot/', '/API/BOOT', '/index.html', '/package.json', '/viewer/map.js', '/api/', '/nope'];
      for (const p of paths) {
        const a = await call(port, { path: p, headers: auth() });
        expect([p, a.status]).toEqual([p, 404]);
        expect(a.text).toBe('{"message":"not found"}');
      }
    });

    it('a slow request is cut after the request time-out', async () => {
      const slow = createServeServer({ live: fakeLive().live, token, port: 0, requestTimeoutMs: 300 });
      const { port: p } = await slow.listen();
      const startedAt = Date.now();
      const ended = await new Promise<string>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: p }, () => {
          s.write(`PUT /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nOrigin: http://127.0.0.1:${p}\r\nX-C4PM-Token: ${token}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":');
        });
        let got = '';
        s.on('data', (d) => { got += d.toString(); });
        s.on('close', () => resolve(got));
        s.on('error', () => resolve(got));
      });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(ended === '' || ended.startsWith('HTTP/1.1 408')).toBe(true);
      await slow.close();
    });
  });

  describe('security headers (4.3 item 7)', () => {
    it('every answer has the CSP, nosniff, no-store, frame deny, no referrer, and never an Access-Control-* header', async () => {
      const answers = [
        await call(port, { path: '/' }),
        await call(port, { path: '/viewer.js' }),
        await call(port, { path: '/api/boot', headers: auth() }),
        await call(port, { path: '/api/boot' }),                                   // 401
        await call(port, { path: '/', headers: { Host: 'evil.test' } }),           // 403
        await call(port, { path: '/nope' }),                                       // 404
        await call(port, { method: 'POST', path: '/api/boot', headers: write(), body: '{}' }),   // 405
        await call(port, { method: 'POST', path: '/api/board', headers: write({ 'Content-Type': 'text/plain' }), body: '{}' }),  // 415
        await call(port, { method: 'POST', path: '/api/board', headers: write(), body: '{}' }),  // 501
      ];
      expect(answers.map(a => a.status)).toEqual([200, 200, 200, 401, 403, 404, 405, 415, 501]);
      for (const a of answers) {
        expect(a.headers['content-security-policy']).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
        expect(a.headers['x-content-type-options']).toBe('nosniff');
        expect(a.headers['cache-control']).toBe('no-store');
        expect(a.headers['x-frame-options']).toBe('DENY');
        expect(a.headers['referrer-policy']).toBe('no-referrer');
        expect(a.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(Object.keys(a.headers).filter(h => h.startsWith('access-control-'))).toEqual([]);
      }
    });

    it('the page CSP: own scripts and inline only, fetch to itself only, no frames, no base, no forms', () => {
      expect(securityHeaders('html')['Content-Security-Policy']).toBe(
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
        "img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(securityHeaders('json')['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    });
  });

  describe('api/wait (long-poll)', () => {
    it('answers on time-out with the same generation', async () => {
      const g = fake.live.current().generation;
      const startedAt = Date.now();
      const a = await call(port, { path: `/api/wait?since=${g}`, headers: auth() });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(JSON.parse(a.text)).toEqual({ generation: g, building: false, error: null });
    });

    it('answers at once when a rebuild starts, and with the new generation when it moved', async () => {
      const g = fake.live.current().generation;
      const waiting = call(port, { path: `/api/wait?since=${g}`, headers: auth() });
      await new Promise(r => setTimeout(r, 50));
      const startedAt = Date.now();
      fake.change('two');
      const first = await waiting;
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(JSON.parse(first.text)).toMatchObject({ generation: g, building: true });
      await new Promise(r => setTimeout(r, 50));   // the rebuild runs on the next turn
      const again = Date.now();
      const next = await call(port, { path: `/api/wait?since=${g}`, headers: auth() });
      expect(Date.now() - again).toBeLessThan(250);
      expect(JSON.parse(next.text)).toEqual({ generation: g + 1, building: false, error: null });
      const boot = JSON.parse((await call(port, { path: '/api/boot', headers: auth() })).text);
      expect([boot.generation, boot.data.v]).toEqual([g + 1, 'two']);
    });

    it('since missing or not a whole number is 400', async () => {
      for (const q of ['', '?since=', '?since=-1', '?since=1.5', '?since=abc', '?since=99999999999']) {
        expect([q, (await call(port, { path: `/api/wait${q}`, headers: auth() })).status]).toEqual([q, 400]);
      }
    });
  });

  describe('close()', () => {
    it('answers an open long-poll, stops the live model and stops listening', async () => {
      const f = fakeLive();
      const opts: ServeOptions = { live: f.live, token, port: 0, waitMs: 20000 };
      const s = createServeServer(opts);
      const { port: p } = await s.listen();
      const waiting = call(p, { path: '/api/wait?since=1', headers: { 'X-C4PM-Token': token, Host: `127.0.0.1:${p}` } });
      await new Promise(r => setTimeout(r, 50));
      const startedAt = Date.now();
      await s.close();
      const a = await waiting;
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(a.status).toBe(200);
      expect(JSON.parse(a.text)).toEqual({ generation: 1, building: false, error: null });
      expect(await f.live.waitFor(1, 20000)).toMatchObject({ generation: 1 });   // stopped: answers at once
      await expect(call(p, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
  });
});
