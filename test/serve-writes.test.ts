import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServeServer, SERVE_ROUTES } from '../src/serve/server';
import type { ServeServer } from '../src/serve/server';
import { newToken } from '../src/serve/security';
import type { LiveModel, LiveState } from '../src/page/liveModel';
import { loadPlanState } from '../src/services/planState';
import { textStamp } from '../src/util/stamp';
import { makeBoardRepo } from './helpers/boardHarness';
import { serveCall, writeHeaders } from './helpers/serveCall';

// SV18 (b644, b645, b646): the three write routes through the guarded services.
const LAYOUT = { version: 2, nodes: { 'app.api': { rx: 1, ry: 2, rw: 3, rh: 4 } } };
const OUTSIDE_PLAN = [
  'specification {', '  element system', '  element container', '}', '',
  'model {', "  app = system 'App' {", "    api = container 'Api'", '  }', '}', '',
].join('\n');

/** A live model that always shows one state (the write routes do not read it). */
function stateLive(): LiveModel {
  const s: LiveState = { generation: 1, dataJson: '{"v":"one"}', stamps: { plan: 'a', board: 'b' }, building: false, error: null };
  return { current: () => s, waitFor: async () => s, stop() {} };
}

const servers: ServeServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

interface Running { port: number; token: string; post: (p: string, body: unknown, method?: string) => Promise<{ status: number; json: any }> }
async function start(opts: { root?: string; settingsFile?: string | null }): Promise<Running> {
  const token = newToken();
  const server = createServeServer({
    live: stateLive(), token, port: 0, waitMs: 300,
    ...(opts.root ? { repo: { root: opts.root, cli: {} } } : {}),
    ...('settingsFile' in opts ? { settingsFile: opts.settingsFile } : {}),
  });
  servers.push(server);
  const { port } = await server.listen();
  const post: Running['post'] = async (p, body, method = 'POST') => {
    const a = await serveCall(port, { method, path: p, headers: writeHeaders(port, token), body: JSON.stringify(body) });
    return { status: a.status, json: a.text ? JSON.parse(a.text) : null };
  };
  return { port, token, post };
}

const planStamp = (root: string): string => textStamp(loadPlanState(root, {})!.texts);
const planBytes = (root: string): string[] => [...loadPlanState(root, {})!.texts.values()];
const tmp = (p: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

describe('c4pm serve write routes (SV18)', () => {
  it('enumerate: every write route has a case below', () => {
    expect(SERVE_ROUTES.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/api/export', '/api/layout', '/api/board', '/api/settings']);
  });

  describe('api/layout', () => {
    it('good: writes the layout line and answers the new stamp', async () => {
      const repo = makeBoardRepo('c4pm-sw-l1-');
      const s = await start({ root: repo.root });
      const r = await s.post('/api/layout', { expect: planStamp(repo.root), layout: LAYOUT });
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.report.files[0].file.endsWith('a.c4')).toBe(true);
      expect(planBytes(repo.root).join('')).toContain("layout ';1,2,3,4'");
      expect(r.json.stamp).toBe(planStamp(repo.root));
    });

    it('wrong expect: 409 changed, bytes unchanged', async () => {
      const repo = makeBoardRepo('c4pm-sw-l2-');
      const before = planBytes(repo.root);
      const s = await start({ root: repo.root });
      const r = await s.post('/api/layout', { expect: 'old', layout: LAYOUT });
      expect(r.status).toBe(409);
      expect(r.json.write.error.code).toBe('changed');
      expect(planBytes(repo.root)).toEqual(before);
    });

    it('a plan outside .c4pm: 422 outside-c4pm, nothing written; a force key is 400', async () => {
      const root = tmp('c4pm-sw-l3-');
      fs.mkdirSync(path.join(root, 'c4'));
      fs.writeFileSync(path.join(root, 'c4', 'arch.c4'), OUTSIDE_PLAN);
      const s = await start({ root });
      const r = await s.post('/api/layout', { expect: planStamp(root), layout: LAYOUT });
      expect(r.status).toBe(422);
      expect(r.json.write.error.code).toBe('outside-c4pm');
      expect(fs.readFileSync(path.join(root, 'c4', 'arch.c4'), 'utf8')).toBe(OUTSIDE_PLAN);
      const f = await s.post('/api/layout', { expect: planStamp(root), layout: LAYOUT, force: true });
      expect(f.status).toBe(400);
      expect(fs.readFileSync(path.join(root, 'c4', 'arch.c4'), 'utf8')).toBe(OUTSIDE_PLAN);
    });

    it('bad bodies: 400 with the reason', async () => {
      const repo = makeBoardRepo('c4pm-sw-l4-');
      const s = await start({ root: repo.root });
      const v = await s.post('/api/layout', { expect: 'x', layout: { version: 1, nodes: {} } });
      expect(v.status).toBe(400);
      expect(v.json.message).toBe('api/layout: unsupported layout version: 1 (expected 2)');
      expect((await s.post('/api/layout', { expect: 'x', layout: LAYOUT, extra: 1 })).status).toBe(400);
      expect((await s.post('/api/layout', { layout: LAYOUT })).status).toBe(400);
    });
  });

  describe('api/board', () => {
    const stamp = (text: string): string => textStamp([['board', text]]);

    it('good: writes b5 and answers the stamp', async () => {
      const repo = makeBoardRepo('c4pm-sw-b1-');
      const s = await start({ root: repo.root });
      const r = await s.post('/api/board', { expect: stamp(repo.text()), ops: [{ op: 'set', id: 'b5', fields: { status: 'done' } }] });
      expect(r.status).toBe(200);
      expect(r.json.results[0].written).toBe(true);
      expect(JSON.parse(repo.text()).boards[0].items.find((i: any) => i.id === 'b5').status).toBe('done');
      expect(r.json.stamp).toBe(stamp(repo.text()));
    });

    it('wrong expect: 409, nothing written', async () => {
      const repo = makeBoardRepo('c4pm-sw-b2-');
      const before = repo.text();
      const s = await start({ root: repo.root });
      const r = await s.post('/api/board', { expect: 'old', ops: [{ op: 'set', id: 'b5', fields: { status: 'done' } }] });
      expect(r.status).toBe(409);
      expect(repo.text()).toBe(before);
    });

    it('stops at the first refusal: 422, earlier ops stay written, later ones do not run', async () => {
      const repo = makeBoardRepo('c4pm-sw-b3-');
      const s = await start({ root: repo.root });
      const ops = [
        { op: 'set', id: 'b5', fields: { status: 'done' } },
        { op: 'set', id: 'zz', fields: { status: 'done' } },
        { op: 'set', id: 'b1', fields: { owner: 'X' } },
      ];
      const r = await s.post('/api/board', { expect: stamp(repo.text()), ops });
      expect(r.status).toBe(422);
      expect(r.json.stoppedAt).toBe(1);
      const items = JSON.parse(repo.text()).boards[0].items;
      expect(items.find((i: any) => i.id === 'b5').status).toBe('done');
      expect(items.find((i: any) => i.id === 'b1').owner).toBe('K');
    });

    it.each([
      ['ops not an array', { expect: 'x', ops: 'no' }, 'api/board takes'],
      ['no ops', { expect: 'x', ops: [] }, 'no ops'],
      ['201 ops', { expect: 'x', ops: Array.from({ length: 201 }, () => ({ op: 'group-add', board: 'main', name: 'g' })) }, 'too many ops (201, at most 200)'],
      ['unknown op', { expect: 'x', ops: [{ op: 'delete' }] }, "op 0: unknown op 'delete'"],
      ['field kind', { expect: 'x', ops: [{ op: 'set', id: 'b1', fields: { kind: 'bug' } }] }, "op 0: field 'kind' cannot be set from the page"],
      ['number value', { expect: 'x', ops: [{ op: 'set', id: 'b1', fields: { owner: 5 } }] }, "op 0: field 'owner' must be a string"],
      ['no fields', { expect: 'x', ops: [{ op: 'set', id: 'b1', fields: {} }] }, 'fields must hold at least one field'],
      ['empty name', { expect: 'x', ops: [{ op: 'group-add', board: 'main', name: '' }] }, 'name must be a non-empty string'],
    ])('bad body (%s): 400', async (_n, body, reason) => {
      const repo = makeBoardRepo('c4pm-sw-b4-');
      const before = repo.text();
      const s = await start({ root: repo.root });
      const r = await s.post('/api/board', body);
      expect(r.status).toBe(400);
      expect(r.json.message).toContain(reason);
      expect(repo.text()).toBe(before);
    });
  });

  describe('api/settings', () => {
    it('good: writes the file (0600) and api/boot sends it', async () => {
      const file = path.join(tmp('c4pm-sw-s1-'), 'user', 'settings.json');
      const s = await start({ settingsFile: file });
      const r = await s.post('/api/settings', { settings: { theme: 'dark' } }, 'PUT');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, settings: { theme: 'dark' } });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ theme: 'dark' });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const boot = await serveCall(s.port, { path: '/api/boot', headers: { 'X-C4PM-Token': s.token } });
      expect(JSON.parse(boot.text).settings).toEqual({ theme: 'dark' });
    });

    it('bad: 400 and no file', async () => {
      const file = path.join(tmp('c4pm-sw-s2-'), 'settings.json');
      const s = await start({ settingsFile: file });
      expect((await s.post('/api/settings', { settings: { theme: 'Dark' } }, 'PUT')).status).toBe(400);
      expect((await s.post('/api/settings', { x: 1 }, 'PUT')).status).toBe(400);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('turned off: 409', async () => {
      const s = await start({ settingsFile: null });
      expect((await s.post('/api/settings', { settings: { theme: 'dark' } }, 'PUT')).status).toBe(409);
    });
  });

  it.each([
    ['POST', '/api/layout', { expect: 'x', layout: LAYOUT }],
    ['POST', '/api/board', { expect: 'x', ops: [{ op: 'set', id: 'b5', fields: { status: 'done' } }] }],
    ['PUT', '/api/settings', { settings: { theme: 'dark' } }],
  ])('%s %s without the token is 401, without Origin 403; nothing written', async (method, p, body) => {
    const repo = makeBoardRepo('c4pm-sw-t-');
    const before = repo.text();
    const file = path.join(tmp('c4pm-sw-t2-'), 'settings.json');
    const s = await start({ root: repo.root, settingsFile: file });
    const h = writeHeaders(s.port, s.token);
    const { 'X-C4PM-Token': _t, ...noToken } = h;
    const { Origin: _o, ...noOrigin } = h;
    const text = JSON.stringify(body);
    expect((await serveCall(s.port, { method, path: p, headers: noToken, body: text })).status).toBe(401);
    expect((await serveCall(s.port, { method, path: p, headers: noOrigin, body: text })).status).toBe(403);
    expect(repo.text()).toBe(before);
    expect(fs.existsSync(file)).toBe(false);
  });
});
