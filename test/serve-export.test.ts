import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createServeServer, type ServeServer } from '../src/serve/server';
import { newToken, securityHeaders } from '../src/serve/security';
import { createLiveModel, type LiveModel, type LiveState } from '../src/page/liveModel';
import type { PageExport } from '../src/page/viewExport';
import type { ViewModel } from '../src/types';

// b914 slice 2: POST /api/export of c4pm serve (src/serve/api.ts). The server runs in this process on port 0 with an
// exportPage stub that records its calls; the real writer is covered in test/cli-serve.test.ts.

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

function liveOnTmp(): LiveModel {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-export-')));
  tmps.push(dir);
  return createLiveModel(dir, {}, {
    debounceMs: 10,
    build: () => ({ model: { v: 'one' } as unknown as ViewModel, inputs: { planTexts: new Map([['p.c4', 'plan']]), boardText: 'board' } }),
    fingerprint: () => 'fp',
    watch: () => () => {},
  });
}

/** A live model that always shows `state` (building / error windows are not reachable with the timer-driven model). */
function stateLive(state: Partial<LiveState>): LiveModel {
  const s: LiveState = { generation: 1, dataJson: '{"v":"one"}', stamps: { plan: 'a', board: 'b' }, building: false, error: null, ...state };
  return { current: () => s, waitFor: async () => s, stop() {} };
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; text: string }
interface Call { method?: string; path?: string; headers?: Record<string, string>; body?: string }

function call(port: number, c: Call = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...c.headers };
    if (c.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(c.body));
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port, method: c.method ?? 'GET', path: c.path ?? '/', headers, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => { if (!answered) reject(err); });
    if (c.body !== undefined) req.write(c.body);
    req.end();
  });
}

const PAGE: PageExport = { file: '/x/c4pmView.html', name: 'c4pm-demo-2026-11-23.html', html: '<!doctype html>ok' };

interface Rig {
  server: ServeServer;
  port: number;
  calls: Array<{ dataJson: string; noSource: boolean }>;
  post(body: string | undefined, extra?: Record<string, string>): Promise<Answer>;
}

const token = newToken();
const rigs: Rig[] = [];
afterAll(async () => { for (const r of rigs) await r.server.close(); });

async function rig(live: LiveModel, exportPage?: (d: string, o: { noSource: boolean }) => PageExport): Promise<Rig> {
  const calls: Rig['calls'] = [];
  const stub = (d: string, o: { noSource: boolean }): PageExport => { calls.push({ dataJson: d, noSource: o.noSource }); return (exportPage ?? (() => PAGE))(d, o); };
  const server = createServeServer({ live, token, port: 0, waitMs: 300, exportPage: stub });
  const { port } = await server.listen();
  const r: Rig = {
    server, port, calls,
    post: (body, extra = {}) => call(port, {
      method: 'POST', path: '/api/export', body,
      headers: { 'X-C4PM-Token': token, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...extra },
    }),
  };
  rigs.push(r);
  return r;
}

describe('POST /api/export (b914)', () => {
  let live: LiveModel;
  let r: Rig;
  beforeAll(async () => { live = liveOnTmp(); r = await rig(live); });

  it('1. a good call answers { file, name, noSource, html } and hands the live dataJson to the writer', async () => {
    const a = await r.post('{"noSource":true}');
    expect(a.status).toBe(200);
    expect(JSON.parse(a.text)).toEqual({ ...PAGE, noSource: true });
    expect(r.calls).toEqual([{ dataJson: live.current().dataJson, noSource: true }]);
    for (const [k, v] of Object.entries(securityHeaders('json'))) expect(a.headers[k.toLowerCase()]).toBe(v);
  });

  it('2. no token and a wrong token are 401; the writer is not called', async () => {
    const before = r.calls.length;
    const base = { method: 'POST', path: '/api/export', body: '{"noSource":false}' };
    const h = { Origin: `http://127.0.0.1:${r.port}`, 'Content-Type': 'application/json' };
    expect((await call(r.port, { ...base, headers: h })).status).toBe(401);
    expect((await call(r.port, { ...base, headers: { ...h, 'X-C4PM-Token': 'nope' } })).status).toBe(401);
    expect(r.calls.length).toBe(before);
  });

  it('3. Origin, Sec-Fetch-Site, Host, method, content type and size checks apply', async () => {
    const before = r.calls.length;
    const body = '{"noSource":false}';
    const origin = `http://127.0.0.1:${r.port}`;
    const good = { 'X-C4PM-Token': token, Origin: origin, 'Content-Type': 'application/json' };
    const post = (headers: Record<string, string>, b: string = body, method = 'POST') => call(r.port, { method, path: '/api/export', body: b, headers });
    const { Origin: _o, ...noOrigin } = good;
    expect((await post(noOrigin)).status).toBe(403);
    expect((await post({ ...good, Origin: `http://evil.example:${r.port}` })).status).toBe(403);
    expect((await post({ ...good, Origin: `http://localhost:${r.port + 1}` })).status).toBe(403);
    expect((await post({ ...good, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post({ ...good, Host: `evil.com:${r.port}` })).status).toBe(403);
    const opt = await post(good, body, 'OPTIONS');
    expect(opt.status).toBe(403);
    expect(Object.keys(opt.headers).filter(k => k.startsWith('access-control-'))).toEqual([]);
    expect((await call(r.port, { path: '/api/export', headers: { 'X-C4PM-Token': token } })).status).toBe(405);
    expect((await post({ ...good, 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(good, JSON.stringify({ noSource: true, pad: 'x'.repeat(2000) }))).status).toBe(413);
    expect(r.calls.length).toBe(before);
  });

  it('4. any body but {"noSource": boolean} is 400 and the writer is not called', async () => {
    const before = r.calls.length;
    for (const b of ['{}', '{"noSource":"yes"}', '{"noSource":true,"file":"/etc/x"}', '[]', 'null']) {
      const a = await r.post(b);
      expect([b, a.status]).toEqual([b, 400]);
      expect(JSON.parse(a.text).message).toBe('api/export takes {"noSource": true|false} only');
    }
    expect(r.calls.length).toBe(before);
  });

  it('5. while a rebuild runs or after a failed one: 409 and nothing is written', async () => {
    const building = await rig(stateLive({ building: true }));
    const a = await building.post('{"noSource":false}');
    expect(a.status).toBe(409);
    expect(JSON.parse(a.text).message).toMatch(/being rebuilt/);
    const failed = await rig(stateLive({ error: 'boom' }));
    const b = await failed.post('{"noSource":false}');
    expect(b.status).toBe(409);
    expect(JSON.parse(b.text).message).toMatch(/last rebuild failed \(boom\)/);
    expect(building.calls.length + failed.calls.length).toBe(0);
  });

  it('6. a write error is 500 with its text and the server keeps answering', async () => {
    const bad = await rig(liveOnTmp(), () => { throw new Error('cannot write /x/c4pmView.html: permission denied'); });
    const a = await bad.post('{"noSource":false}');
    expect(a.status).toBe(500);
    expect(JSON.parse(a.text).message).toBe('export failed: cannot write /x/c4pmView.html: permission denied');
    const boot = await call(bad.port, { path: '/api/boot', headers: { 'X-C4PM-Token': token } });
    expect(boot.status).toBe(200);
  });

  it('7. without an exportPage the route answers 501 and writes nothing', async () => {
    const server = createServeServer({ live: liveOnTmp(), token, port: 0, waitMs: 300 });
    const { port } = await server.listen();
    try {
      const a = await call(port, {
        method: 'POST', path: '/api/export', body: '{"noSource":true}',
        headers: { 'X-C4PM-Token': token, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      });
      expect(a.status).toBe(501);
      expect(JSON.parse(a.text).message).toMatch(/not built yet.*nothing was written/);
    } finally {
      await server.close();
    }
  });
});
