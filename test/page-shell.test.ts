import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import vm from 'vm';
import {
  buildPageModel, buildView, pageData, renderViewHtml, renderViewShell, SHELL_SCRIPTS, viewerScriptText, VIEWER_SCRIPTS,
} from '../src/page/html';
import { boardFileFor } from '../src/board/load';
import { tryResolveProject } from '../src/outputs';
import { initProject } from '../src/init';
import { TOOL_VERSION } from '../src/constants';
import { CREDIT_URL, NO_URL_EXCEPT_CREDIT, URL_RULE_MISSES } from './helpers/creditUrl';

// Phase 30 SV4 (b791): the page data split (buildPageModel, pageData, viewerScriptText) and the page shell of c4pm serve
// (renderViewShell + viewer/serve-boot.js). The static page stays what it was.

const VIEWER = path.join(__dirname, '..', 'viewer');
const SAMPLE = path.join(__dirname, 'fixtures/sample');
const readViewer = (f: string): string => fs.readFileSync(path.join(VIEWER, f), 'utf8');

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

/** Tmp repo with `.git`, one source file, one plan file; with a board file when `board` is given. */
function makeRepo(board: string | null): { repo: string; boardFile: string; planFile: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-shell-')));
  tmps.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shell-demo' }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  initProject(repo);
  const project = tryResolveProject(repo)!;
  fs.mkdirSync(project.planDir, { recursive: true });
  const planFile = path.join(project.planDir, 'arch.c4');
  fs.writeFileSync(planFile, "model {\n  app = system 'App' {\n    web = container 'Web'\n  }\n}\n");
  const boardFile = boardFileFor(project);
  if (board !== null) {
    fs.mkdirSync(path.dirname(boardFile), { recursive: true });
    fs.writeFileSync(boardFile, board);
  }
  return { repo, boardFile, planFile };
}

describe('page data split (SV4)', () => {
  it('buildView = renderViewHtml of buildPageModel: the same page bytes', () => {
    const built = buildView({ repo: SAMPLE });
    const { model } = buildPageModel({ repo: SAMPLE });
    expect(renderViewHtml(model)).toBe(built.html);
    expect(model).toEqual(built.model);
  });

  it('pageData is the model plus kindWords, wireframeRules and toolVersion; the page embeds exactly it', () => {
    const { model } = buildPageModel({ repo: SAMPLE });
    const data = pageData(model) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([...Object.keys(model), 'kindWords', 'wireframeRules', 'toolVersion'].sort());
    expect(data.toolVersion).toBe(TOOL_VERSION);
    const html = renderViewHtml(model);
    const embedded = html.match(/window\.C4PM_DATA = ([\s\S]+?);<\/script>/)![1];
    expect(JSON.parse(embedded)).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('viewerScriptText is every VIEWER_SCRIPTS file in order, no http(s) URL, and the page inlines it', () => {
    const text = viewerScriptText();
    expect(text).toBe(VIEWER_SCRIPTS.map(readViewer).join('\n'));
    let at = -1;
    for (const f of VIEWER_SCRIPTS) {
      const i = text.indexOf(readViewer(f), at + 1);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(text).not.toMatch(/https?:\/\//);
    expect(renderViewHtml(buildPageModel({ repo: SAMPLE }).model)).toContain(text);
  });

  it('inputs: boardText is the board file text; planTexts holds the plan file', () => {
    const board = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [] }] }, null, 2) + '\n';
    const { repo, planFile } = makeRepo(board);
    const { inputs } = buildPageModel({ repo });
    expect(inputs.boardText).toBe(board);
    expect([...inputs.planTexts.values()]).toEqual([fs.readFileSync(planFile, 'utf8')]);
  });

  it('inputs: boardText is null without a board file, and without a project', () => {
    const { repo, boardFile } = makeRepo(null);
    expect(fs.existsSync(boardFile)).toBe(false);
    expect(buildPageModel({ repo }).inputs.boardText).toBeNull();
    expect(buildPageModel({ repo: SAMPLE }).inputs.boardText).toBeNull();
  });
});

describe('page shell (SV4)', () => {
  const shell = renderViewShell();
  const boot = readViewer('serve-boot.js');

  it('b168: the URL rule allows only the credit link; any other http(s) URL still fails it', () => {
    expect(`<a href="${CREDIT_URL}">`).not.toMatch(NO_URL_EXCEPT_CREDIT);
    for (const s of URL_RULE_MISSES) expect(s).toMatch(NO_URL_EXCEPT_CREDIT);
  });

  it('has two script tags, no data, no http(s) URL, the boot script and no viewer script', () => {
    expect((shell.match(/<script>/g) ?? []).length).toBe(2);
    expect((shell.match(/<\/script>/g) ?? []).length).toBe(2);
    expect(shell).toContain('<script>window.C4PM_DATA = null;</script>');
    expect(shell).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)
    expect(SHELL_SCRIPTS).toEqual(['serve-boot.js']);
    expect(shell).toContain(boot);
    expect(shell).not.toContain(viewerScriptText());
    expect(shell).not.toContain('window.C4PM_STATE = {');
  });

  it('holds no model text: the sample summary and node names are absent', () => {
    const { model } = buildPageModel({ repo: SAMPLE });
    expect(shell).not.toContain(model.summary);
    expect(shell).not.toContain('"schemaVersion"');
  });

  it('is the static page with the data and scripts slots swapped (same template, generator and styles)', () => {
    const page = renderViewHtml(buildPageModel({ repo: SAMPLE }).model);
    const head = (s: string) => s.slice(0, s.indexOf('<script>window.C4PM_DATA'));
    expect(head(shell)).toBe(head(page));
  });

  it('serve-boot.js has no http(s) URL and no closing script tag', () => {
    expect(boot).not.toMatch(/https?:\/\//);
    expect(boot).not.toMatch(/<\/script/i);
  });
});

// ---------- serve-boot.js in a vm with a fake fetch, location, history and sessionStorage ----------

interface FetchCall { url: string; init: { method: string; headers: Record<string, string>; body?: string } }
type Answer = { status: number; json?: unknown } | 'network-error';

function runBoot(opts: { hash: string; port?: string; stored?: Record<string, string>; answer: Answer; storageBlocked?: boolean }) {
  const calls: FetchCall[] = [];
  const replaced: string[] = [];
  const appended: Array<{ tag: string; src?: string }> = [];
  const store = new Map(Object.entries(opts.stored ?? {}));
  const mapWrap = { textContent: '' };
  const header = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  const location = { hash: opts.hash, port: opts.port ?? '4321', pathname: '/', search: '' };
  const answerOf = (a: Answer) => a === 'network-error'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve({ status: a.status, json: () => (a.json === undefined ? Promise.reject(new SyntaxError('no json')) : Promise.resolve(a.json)) });
  let next: Answer = opts.answer;
  const blocked = () => { throw new Error('storage blocked'); };
  const ctx: Record<string, unknown> = {
    location,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } },
    sessionStorage: opts.storageBlocked
      ? { getItem: blocked, setItem: blocked }
      : { getItem: (k: string) => (store.has(k) ? store.get(k)! : null), setItem: (k: string, v: string) => { store.set(k, String(v)); } },
    fetch: (url: string, init: FetchCall['init']) => { calls.push({ url, init }); return answerOf(next); },
    document: {
      getElementById: (id: string) => (id === 'map-wrap' ? mapWrap : id === 'header' ? header : null),
      createElement: (tag: string) => ({ tag }),
      body: { appendChild: (el: { tag: string; src?: string }) => { appended.push(el); return el; } },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readViewer('serve-boot.js'), ctx);
  return {
    ctx, calls, replaced, appended, store, mapWrap, header,
    setAnswer: (a: Answer) => { next = a; },
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const NEEDS_LINK = 'This page needs the link that c4mp serve printed (it carries a key). Open that link again. Run `c4mp serve --link` to see it.';
const BOOT = { data: { schemaVersion: 1, root: { id: 'r' } }, generation: 3, stamps: { plan: 'p1', board: 'b1' }, settings: { theme: 'dark' }, error: null };

const hashT = '#t=abc';

describe('serve-boot.js (SV4)', () => {
  it('a token in the hash is stored per port, cut from the URL (other hash parts kept) and sent as X-C4PM-Token', async () => {
    const b = runBoot({ hash: '#io&t=abc', answer: { status: 200, json: BOOT } });
    expect(b.store.get('c4mp.token:4321')).toBe('abc');
    expect(b.replaced).toEqual(['/#io']);
    expect(b.calls).toEqual([{ url: 'api/boot', init: { method: 'GET', headers: { 'X-C4PM-Token': 'abc' } } }]);
    await b.settle();
  });

  it('#t=<token> alone leaves no hash', () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 200, json: BOOT } });
    expect(b.replaced).toEqual(['/']);
  });

  it('no token in the hash: the stored one is used and the URL is left alone', () => {
    const b = runBoot({ hash: '#arch', stored: { 'c4mp.token:4321': 'kept' }, answer: { status: 200, json: BOOT } });
    expect(b.replaced).toEqual([]);
    expect(b.calls[0].init.headers['X-C4PM-Token']).toBe('kept');
  });

  it('a token stored for another port is not used: no request, the "needs the link" text', () => {
    const b = runBoot({ hash: '', stored: { 'c4mp.token:9999': 'other' }, answer: { status: 200, json: BOOT } });
    expect(b.calls).toEqual([]);
    expect(b.mapWrap.textContent).toBe(NEEDS_LINK);
  });

  it('blocked sessionStorage: the hash token still works for this load', () => {
    const b = runBoot({ hash: '#t=abc', storageBlocked: true, answer: { status: 200, json: BOOT } });
    expect(b.calls[0].init.headers['X-C4PM-Token']).toBe('abc');
    expect(b.replaced).toEqual(['/']);
  });

  it('a 401 shows the "needs the link" text and loads no viewer script', async () => {
    const b = runBoot({ hash: '#t=bad', answer: { status: 401, json: { message: 'token' } } });
    await b.settle();
    expect(b.mapWrap.textContent).toBe(NEEDS_LINK);
    expect(b.appended).toEqual([]);
    expect(b.ctx.C4PM_LIVE).toBeUndefined();
  });

  it('a network error says c4mp serve is not running', async () => {
    const b = runBoot({ hash: '#t=abc', answer: 'network-error' });
    await b.settle();
    expect(b.mapWrap.textContent).toBe('c4mp serve is not running. Start it again: c4mp serve --repo <path>');
    expect(b.appended).toEqual([]);
  });

  it('another status shows it with the server message', async () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 500, json: { message: 'plan broken' } } });
    await b.settle();
    expect(b.mapWrap.textContent).toBe('c4mp serve answered 500: plan broken. Reload the page.');
  });

  // Phase 35 C (b945): the first load shows the C4MP spinner (brand.js) in #map-wrap until api/boot answers, then removes it.
  it('the first load shows the spinner and the Loading line; ok removes them, a failure replaces them with its text', async () => {
    // a dedicated vm run: a map-wrap that keeps its children, a fake brand, getElementById('boot-loading') finding the box
    const calls: string[] = [];
    const wrap: any = { children: [] as any[], textContent: '', appendChild(c: any) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c: any) { this.children.splice(this.children.indexOf(c), 1); } };
    const mkEl = (tag: string): any => ({ tag, children: [] as any[], attrs: {} as Record<string, string>, textContent: '', id: '', className: '', appendChild(c: any) { this.children.push(c); c.parentNode = this; return c; }, setAttribute(k: string, v: string) { this.attrs[k] = v; } });
    let resolveFetch: (v: unknown) => void = () => {};
    const ctx: Record<string, unknown> = {
      location: { hash: '#t=abc', port: '4321', pathname: '/', search: '' },
      history: { state: null, replaceState: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      fetch: () => new Promise((r) => { resolveFetch = r; }),
      C4PM_BRAND: { spinner: (px: number) => { calls.push('spinner:' + px); const s = mkEl('span'); s.className = 'c4mp-spin'; return s; } },
      document: {
        getElementById: (id: string) => (id === 'map-wrap' ? wrap : id === 'boot-loading' ? wrap.children.find((c: any) => c.id === 'boot-loading') ?? null : null),
        createElement: mkEl,
        body: { appendChild: (el: unknown) => el },
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(readViewer('serve-boot.js'), ctx);
    expect(calls).toEqual(['spinner:48']);
    const box = wrap.children.find((c: any) => c.id === 'boot-loading');
    expect(box.className).toBe('c4mp-boot');
    expect(box.children[0].className).toBe('c4mp-spin');
    expect(box.children[1].textContent).toBe('Loading the map ...');
    resolveFetch({ status: 200, json: () => Promise.resolve(BOOT) });
    await new Promise((r) => setImmediate(r));
    expect(wrap.children.length).toBe(0);
  });

  it('ok: C4PM_DATA and C4PM_LIVE are set, then viewer.js is appended', async () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 200, json: BOOT } });
    expect(b.appended).toEqual([]);
    await b.settle();
    expect(b.ctx.C4PM_DATA).toEqual(BOOT.data);
    const live = b.ctx.C4PM_LIVE as Record<string, unknown>;
    expect(live).toMatchObject({ generation: 3, stamps: { plan: 'p1', board: 'b1' }, settings: { theme: 'dark' }, error: null });
    expect(typeof live.request).toBe('function');
    expect(b.appended).toEqual([{ tag: 'script', src: 'viewer.js' }]);
    expect(b.mapWrap.textContent).toBe('');
  });

  it('C4PM_LIVE.request sends the header and a JSON body; resolves { status, json }', async () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 200, json: BOOT } });
    await b.settle();
    const request = (b.ctx.C4PM_LIVE as { request: (m: string, p: string, body?: unknown) => Promise<unknown> }).request;
    b.setAnswer({ status: 409, json: { message: 'changed' } });
    const got = await request('POST', 'api/layout', { nodes: [1] });
    expect(got).toEqual({ status: 409, json: { message: 'changed' } });
    expect(b.calls[1]).toEqual({
      url: 'api/layout',
      init: { method: 'POST', headers: { 'X-C4PM-Token': 'abc', 'Content-Type': 'application/json' }, body: '{"nodes":[1]}' },
    });
    b.setAnswer({ status: 204 });
    expect(await request('GET', 'api/wait?since=3')).toEqual({ status: 204, json: null });
  });

  it('C4PM_LIVE.dirty / isDirty: false until a registered check says true', async () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 200, json: BOOT } });
    await b.settle();
    const live = b.ctx.C4PM_LIVE as { dirty: (f: unknown) => void; isDirty: () => boolean };
    expect(live.isDirty()).toBe(false);
    live.dirty(() => false);
    expect(live.isDirty()).toBe(false);
    live.dirty(() => true);
    expect(live.isDirty()).toBe(true);
  });

  it('a check that throws counts as dirty; dirty() needs a function', async () => {
    const b = runBoot({ hash: '#t=abc', answer: { status: 200, json: BOOT } });
    await b.settle();
    const live = b.ctx.C4PM_LIVE as { dirty: (f: unknown) => void; isDirty: () => boolean };
    live.dirty(() => { throw new Error('broken'); });
    expect(live.isDirty()).toBe(true);
    expect(() => live.dirty('x')).toThrow(new TypeError('C4PM_LIVE.dirty needs a function'));
  });

  it.each([
    ['network error', hashT, 'network-error' as Answer, 'stopped'],
    ['no token', '', { status: 200, json: BOOT } as Answer, 'failed'],
    ['401', hashT, { status: 401, json: {} } as Answer, 'failed'],
    ['500', hashT, { status: 500, json: { message: 'x' } } as Answer, 'failed'],
    ['ok (live.js sets the light, not serve-boot)', hashT, { status: 200, json: BOOT } as Answer, undefined],
  ])('boot light: %s -> data-live %s', async (_n, hash, answer, expected) => {
    const b = runBoot({ hash, answer });
    await b.settle();
    expect(b.header.attrs['data-live']).toBe(expected);
  });
});
