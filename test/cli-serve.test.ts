import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { startServe, serveLink } from '../src/cli/serveCmd';
import { servePortFor, serveKeyFor } from '../src/serve/identity';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import { writeProjectView } from '../src/page/viewExport';
import { todayIso } from '../src/util/dates';
import { CLI_JS, SPAWN_TIMEOUT_MS } from './helpers/runCli';

// Phase 30 SV7 (b794): c4mp serve (startServe in process, the command as a child process).

const URL_LINE = /^c4mp serve: (http:\/\/127\.0\.0\.1:(\d+)\/#t=([A-Za-z0-9_-]{43}))$/;

const tmps: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) { c.kill('SIGKILL'); c.stdout?.destroy(); c.stderr?.destroy(); } });
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-serve-')));
  tmps.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'serve-demo' }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  initProject(repo);
  const project = tryResolveProject(repo)!;
  fs.mkdirSync(project.planDir, { recursive: true });
  fs.writeFileSync(path.join(project.planDir, 'arch.c4'), "model {\n  app = system 'App' {\n    web = container 'Web'\n  }\n}\n");
  return repo;
}

/** True when nothing listens on 127.0.0.1:<port> (a probe that binds it and lets go). */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function get(port: number, urlPath: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ agent: false, host: '127.0.0.1', port, path: urlPath, headers: token ? { 'X-C4PM-Token': token } : {} }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
  });
}

/** POST a JSON body with the token and our own Origin (built from parts: no URL literal here). */
function post(port: number, urlPath: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      'X-C4PM-Token': token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)),
      Origin: ['http:', '', `127.0.0.1:${port}`].join('/'),
    };
    const req = http.request({ agent: false, host: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

const refuses = (port: number): Promise<boolean> => get(port, '/api/boot').then(() => false, e => e.code === 'ECONNREFUSED');

interface Child { proc: ChildProcess; lines: string[]; err: string[]; exit: Promise<number | null>; waitLine(re: RegExp, ms: number): Promise<RegExpMatchArray> }

function spawnServe(repo: string, extra: string[] = ['--port', '0']): Child {
  const proc = spawn(process.execPath, [CLI_JS, 'serve', '--repo', repo, '--no-open', ...extra]);
  children.push(proc);
  const lines: string[] = [];
  const err: string[] = [];
  const listeners: Array<() => void> = [];
  let outBuf = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (d: string) => {
    outBuf += d;
    const parts = outBuf.split('\n');
    outBuf = parts.pop()!;
    lines.push(...parts);
    listeners.forEach(f => f());
  });
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (d: string) => err.push(d));
  const exit = new Promise<number | null>(r => proc.on('exit', code => r(code)));
  const waitLine = (re: RegExp, ms: number): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (const l of lines) { const m = re.exec(l); if (m) { resolve(m); return true; } }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(() => reject(new Error(`no line matching ${re} in ${ms} ms: ${lines.join(' | ')}`)), ms);
      listeners.push(() => { if (check()) clearTimeout(timer); });
    });
  return { proc, lines, err, exit, waitLine };
}

describe('startServe (in process)', () => {
  it('serves boot data, prints its lines and stops cleanly', async () => {
    const repo = makeRepo();
    const out: string[] = [];
    const run = await startServe(repo, {}, { port: 0, debounceMs: 50, open: false, out: l => out.push(l), err: l => out.push('ERR ' + l) });
    try {
      const m = URL_LINE.exec('c4mp serve: ' + run.url)!;
      expect(m).not.toBeNull();
      const boot = await get(run.port, '/api/boot', m[3]);
      expect(boot.status).toBe(200);
      expect(boot.json.data.root).toBeDefined();
      expect(boot.json.generation).toBe(1);
      expect(out[0]).toBe('building the page data ...');
      expect(out.some(l => /^built in \d+ ms$/.test(l))).toBe(true);
      expect(out).toContain('c4mp serve: ' + run.url);
    } finally {
      await run.stop();
    }
    expect(await refuses(run.port)).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('api/export writes the complete page file and answers the download (source left out when noSource)', async () => {
    const repo = makeRepo();
    const out: string[] = [];
    const run = await startServe(repo, {}, { port: 0, debounceMs: 50, open: false, out: l => out.push(l), err: l => out.push('ERR ' + l) });
    try {
      const token = URL_LINE.exec('c4mp serve: ' + run.url)![3];
      const project = tryResolveProject(repo)!;
      const lines = out.length;

      const full = await post(run.port, '/api/export', token, { noSource: false });
      expect(full.status).toBe(200);
      expect(full.json.name).toBe(`c4mp-${project.repoId}-${todayIso()}.html`);
      expect(full.json.file).toBe(project.viewFile);
      const onDisk = fs.readFileSync(project.viewFile, 'utf8');
      expect(onDisk).toBe(full.json.html);
      expect(onDisk).toContain('export function a() { return 1; }');
      const again = path.join(repo, 'again.html');
      writeProjectView(repo, { cliConfig: {}, outFile: again });
      expect(fs.readFileSync(again, 'utf8')).toBe(onDisk);

      const lean = await post(run.port, '/api/export', token, { noSource: true });
      expect(lean.status).toBe(200);
      expect(lean.json.noSource).toBe(true);
      expect(fs.readFileSync(project.viewFile, 'utf8')).toContain('export function a() { return 1; }');
      expect(lean.json.html).not.toContain('export function a() { return 1; }');
      expect(lean.json.html).not.toContain('"code":');
      expect(out.length).toBe(lines);   // the export prints nothing in the terminal
    } finally {
      await run.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  it('opens the link once and cleans the launcher once on stop', async () => {
    const repo = makeRepo();
    const calls: string[] = [];
    let cleanups = 0;
    const run = await startServe(repo, {}, {
      port: 0, debounceMs: 50, open: true, out: () => {}, err: () => {},
      opener: url => { calls.push(url); return { launcher: null, cleanup: () => { cleanups++; } }; },
    });
    expect(calls).toEqual([run.url]);
    await run.stop();
    await run.stop();
    expect(cleanups).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('rejects a bad --from with nothing left running', async () => {
    const repo = makeRepo();
    await expect(startServe(repo, {}, { port: 0, debounceMs: 50, open: false, from: 'no-such-ref', out: () => {}, err: () => {} })).rejects.toThrow();
  }, SPAWN_TIMEOUT_MS);

  it('b920: keeps the same port and link per repo; newKey makes another key', async () => {
    const repo = makeRepo();
    const kept = servePortFor(repo);
    if (!(await portFree(kept))) { console.warn(`skipped: port ${kept} is busy on this machine`); return; }
    const keyFile = path.join(path.dirname(repo), `${path.basename(repo)}-keys`, 'serve-keys.json');
    tmps.push(path.dirname(keyFile));
    const o = { debounceMs: 50, open: false, keyFile, out: () => {}, err: () => {} };
    const first = await startServe(repo, {}, o);
    const url1 = first.url;
    await first.stop();
    const second = await startServe(repo, {}, o);
    const url2 = second.url;
    await second.stop();
    expect(first.port).toBe(kept);
    expect(url2).toBe(url1);
    const third = await startServe(repo, {}, { ...o, newKey: true });
    const url3 = third.url;
    await third.stop();
    expect(url3).not.toBe(url1);
    expect(third.port).toBe(kept);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  }, SPAWN_TIMEOUT_MS);

  it('b920: a busy kept port is a clear error, never another port', async () => {
    const repo = makeRepo();
    const kept = servePortFor(repo);
    const blocker = net.createServer();
    const listening = await new Promise<boolean>(r => { blocker.once('error', () => r(false)); blocker.listen(kept, '127.0.0.1', () => r(true)); });
    try {
      await expect(startServe(repo, {}, { debounceMs: 50, open: false, keyFile: null, out: () => {}, err: () => {} }))
        .rejects.toThrow(`port ${kept} is in use. It is the port c4mp serve keeps for this repo`);
    } finally {
      if (listening) await new Promise<void>(r => blocker.close(() => r()));
    }
  }, SPAWN_TIMEOUT_MS);

  it('rejects a busy port', async () => {
    const repo = makeRepo();
    const blocker = net.createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(startServe(repo, {}, { port: busy, debounceMs: 50, open: false, out: () => {}, err: () => {} }))
        .rejects.toThrow(`port ${busy} is in use`);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  }, SPAWN_TIMEOUT_MS);
});

describe('c4mp serve --link (b939)', () => {
  const tempDir = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-link-'))); tmps.push(d); return d; };
  const linkCli = (repo: string, userDir: string, extra: string[] = []) =>
    spawnSync(process.execPath, [CLI_JS, 'serve', '--link', '--repo', repo, ...extra], { encoding: 'utf8', env: { ...process.env, C4PM_USER_DIR: userDir, C4MP_USER_DIR: userDir }, timeout: SPAWN_TIMEOUT_MS });

  it('no remembered key: one line, exit 0, no key file made', () => {
    const repo = makeRepo();
    const userDir = tempDir();
    const r = linkCli(repo, userDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('no link yet: run c4mp serve once\n');
    expect(fs.existsSync(path.join(userDir, 'serve-keys.json'))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it('prints the link serve prints (same port and key), running while it runs, not running after', async () => {
    const repo = makeRepo();
    const keyFile = path.join(tempDir(), 'serve-keys.json');
    expect(await serveLink(repo, { keyFile })).toEqual(['no link yet: run c4mp serve once']);
    const run = await startServe(repo, {}, { port: 0, debounceMs: 50, open: false, keyFile, out: () => {}, err: () => {} });
    expect(await serveLink(repo, { port: run.port, keyFile })).toEqual([run.url, 'running']);
    await run.stop();
    expect(await serveLink(repo, { port: run.port, keyFile })).toEqual([run.url, 'not running']);
  }, SPAWN_TIMEOUT_MS);

  it('tells another server (401) and a busy server (accepts, never answers) apart', async () => {
    const repo = makeRepo();
    const keyFile = path.join(tempDir(), 'serve-keys.json');
    serveKeyFor(repo, { fresh: false, file: keyFile });
    const held: http.ServerResponse[] = [];
    const listen = (handler: http.RequestListener) => new Promise<http.Server>(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
    const portOf = (s: http.Server) => (s.address() as net.AddressInfo).port;
    const refusing = await listen((_req, res) => { res.statusCode = 401; res.end(); });
    const silent = await listen((_req, res) => { held.push(res); });
    try {
      expect((await serveLink(repo, { port: portOf(refusing), keyFile }))[1]).toBe('another server answers on this port (not this link\'s key)');
      expect((await serveLink(repo, { port: portOf(silent), keyFile, timeoutMs: 300 }))[1]).toBe('running, busy (rebuilding?)');
    } finally {
      held.forEach(r => r.destroy());
      await new Promise<void>(r => refusing.close(() => r()));
      await new Promise<void>(r => silent.close(() => r()));
    }
  }, SPAWN_TIMEOUT_MS);

  it('default port is the one kept for the repo; a null key file means no link', async () => {
    const repo = makeRepo();
    const keyFile = path.join(tempDir(), 'serve-keys.json');
    const key = serveKeyFor(repo, { fresh: false, file: keyFile });
    const [link] = await serveLink(repo, { keyFile, timeoutMs: 200 });
    expect(link).toBe(`http://127.0.0.1:${servePortFor(repo)}/#t=${key}`);
    expect(await serveLink(repo, { keyFile: null })).toEqual(['no link yet: run c4mp serve once']);
  }, SPAWN_TIMEOUT_MS);

  it('--link with --new-key is refused (exit 1) and writes nothing', () => {
    const repo = makeRepo();
    const userDir = tempDir();
    const r = linkCli(repo, userDir, ['--new-key']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--link cannot be used with --new-key');
    expect(fs.existsSync(path.join(userDir, 'serve-keys.json'))).toBe(false);
  }, SPAWN_TIMEOUT_MS);
});

describe('c4mp serve (child process)', () => {
  it('prints the link, answers boot, stops on SIGINT with exit 0, writes no page file', async () => {
    const repo = makeRepo();
    const c = spawnServe(repo);
    const m = await c.waitLine(URL_LINE, SPAWN_TIMEOUT_MS);
    const port = Number(m[2]);
    expect((await get(port, '/api/boot', m[3])).status).toBe(200);
    expect(fs.existsSync(path.join(repo, 'C4MP'))).toBe(false);
    c.proc.kill('SIGINT');
    const code = await Promise.race([c.exit, new Promise<string>(r => setTimeout(() => r('timeout'), 5000))]);
    expect(code).toBe(0);
    expect(c.lines).toContain('stopping');
    expect(await refuses(port)).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('refreshes after a code change', async () => {
    const repo = makeRepo();
    const c = spawnServe(repo, ['--port', '0', '--debounce', '100']);
    const m = await c.waitLine(URL_LINE, SPAWN_TIMEOUT_MS);
    const port = Number(m[2]);
    fs.appendFileSync(path.join(repo, 'src', 'index.ts'), 'export function b() { return 2; }\n');
    await c.waitLine(/^updated \(generation 2/, 20_000);
    const wait = await get(port, '/api/wait?since=1', m[3]);
    expect(wait.json.generation).toBe(2);
  }, SPAWN_TIMEOUT_MS);

  it('a busy --port exits 1 with the reason', async () => {
    const repo = makeRepo();
    const blocker = net.createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const c = spawnServe(repo, ['--port', String(busy)]);
      expect(await c.exit).toBe(1);
      expect(c.err.join('')).toContain(`port ${busy} is in use`);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  }, SPAWN_TIMEOUT_MS);
});
