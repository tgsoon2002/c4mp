import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLiveModel, type LiveBuildReport, type LiveModelOptions, type PageBuild } from '../src/page/liveModel';
import { pageData } from '../src/page/html';
import { textStamp } from '../src/util/stamp';
import { boardFileFor } from '../src/board/load';
import { tryResolveProject } from '../src/outputs';
import { initProject } from '../src/init';
import type { C4pmConfig, ViewModel } from '../src/types';
import { openProject } from '../src/scan/project';

// Phase 30 SV5 (b792): the live model of c4pm serve (src/page/liveModel.ts). Unit tests: fake timers, an injected
// watcher, builder and fingerprint. One integration test: a real tmp repo, the real watcher and page build.

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });
const tmpDir = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
};

/** A fake page build: the model is `{ v }`, the plan text and the board text are given. */
const fakeBuild = (v: string, plan = 'plan', board: string | null = 'board'): PageBuild =>
  ({ model: { v } as unknown as ViewModel, inputs: { planTexts: new Map([['p.c4', plan]]), boardText: board } });

/** The injected seams: `next` is what the next build gives (a function may throw), `fp` the fingerprint. */
function harness(extra: Partial<LiveModelOptions> = {}) {
  const h = {
    next: (): PageBuild => fakeBuild('one'),
    fp: 'fp1',
    builds: 0,
    stops: 0,
    reports: [] as LiveBuildReport[],
    onChange: null as null | ((files: string[]) => void),
    debounce: -1,
  };
  const live = createLiveModel(tmpDir('c4pm-live-unit-'), {}, {
    debounceMs: 50,
    build: () => { h.builds++; return h.next(); },
    fingerprint: () => h.fp,
    watch: (_root, _config, o) => { h.onChange = o.onChange; h.debounce = o.debounceMs; return () => { h.stops++; }; },
    onBuild: (r) => h.reports.push(r),
    ...extra,
  });
  /** A watcher change with a new fingerprint (unless `fp` is given). */
  const change = (files: string[], fp = `fp${Math.random()}`): void => { h.fp = fp; h.onChange!(files); };
  return { h, live, change };
}

describe('createLiveModel (unit, fake timers)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts at generation 1 with the page data, the stamps, no error; the watcher gets the debounce', () => {
    const { h, live } = harness();
    const s = live.current();
    expect(s).toEqual({
      generation: 1,
      dataJson: JSON.stringify(pageData(fakeBuild('one').model)),
      stamps: { plan: textStamp([['p.c4', 'plan']]), board: textStamp([['board', 'board']]) },
      building: false,
      error: null,
    });
    expect(h.debounce).toBe(50);
    expect(h.reports.map(r => [r.outcome, r.generation, r.files])).toEqual([['new', 1, []]]);
    live.stop();
  });

  it('a change: building at once (a waiter hears it), then one rebuild and generation 2', async () => {
    const { h, live, change } = harness();
    const heard = live.waitFor(1, 10000);
    h.next = () => fakeBuild('two');
    change(['src/a.ts']);
    expect(live.current().building).toBe(true);
    expect(await heard).toMatchObject({ generation: 1, building: true });
    expect(h.builds).toBe(1);   // the rebuild runs on the next turn, after the waiters are answered
    jest.runOnlyPendingTimers();
    expect(live.current()).toMatchObject({ generation: 2, building: false, error: null });
    expect(JSON.parse(live.current().dataJson).v).toBe('two');
    expect(h.reports[1]).toMatchObject({ outcome: 'new', generation: 2, files: ['src/a.ts'] });
    live.stop();
  });

  it('fingerprint unchanged: no build; same data and stamps (a touched file): built, no new generation', () => {
    const { h, live, change } = harness();
    change(['src/a.ts'], 'fp1');
    jest.runOnlyPendingTimers();
    expect(h.builds).toBe(1);
    change(['src/a.ts'], 'fp2');
    jest.runOnlyPendingTimers();
    expect(h.builds).toBe(2);
    expect(h.reports.slice(1).map(r => r.outcome)).toEqual(['skipped', 'same']);
    expect(live.current()).toMatchObject({ generation: 1, building: false });
    live.stop();
  });

  it('a stamp change alone (board reformatted, same data) is a new generation with the new stamp', () => {
    const { h, live, change } = harness();
    const before = live.current().stamps;
    h.next = () => fakeBuild('one', 'plan', 'board  ');
    change(['board.json']);
    jest.runOnlyPendingTimers();
    expect(live.current().generation).toBe(2);
    expect(live.current().stamps).toEqual({ plan: before.plan, board: textStamp([['board', 'board  ']]) });
    live.stop();
  });

  it('a failed build keeps the last good data and records the error; the next good build clears it', () => {
    const { h, live, change } = harness();
    const good = live.current();
    h.next = () => { throw new Error('Invalid JSON in config.json'); };
    change(['.c4pm/config.json']);
    jest.runOnlyPendingTimers();
    expect(live.current()).toEqual({ ...good, error: 'Invalid JSON in config.json' });
    expect(h.reports[1]).toMatchObject({ outcome: 'failed', error: 'Invalid JSON in config.json' });
    h.next = () => fakeBuild('fixed');
    change(['.c4pm/config.json']);
    jest.runOnlyPendingTimers();
    expect(live.current()).toMatchObject({ generation: 2, error: null, building: false });
    live.stop();
  });

  it('changes before the rebuild runs join it: one build with every file', () => {
    const { h, live, change } = harness();
    change(['src/b.ts']);
    change(['src/a.ts', 'src/b.ts']);
    jest.runOnlyPendingTimers();
    expect(h.builds).toBe(2);
    expect(h.reports[1].files).toEqual(['src/a.ts', 'src/b.ts']);
    live.stop();
  });

  it('a change while a build runs queues one more build; building stays true until it ends', () => {
    const { h, live, change } = harness();
    h.next = () => { change(['src/late.ts']); h.next = () => fakeBuild('three'); return fakeBuild('two'); };
    change(['src/a.ts']);
    jest.runOnlyPendingTimers();
    expect(live.current()).toMatchObject({ generation: 2, building: true });
    jest.runOnlyPendingTimers();
    expect(live.current()).toMatchObject({ generation: 3, building: false });
    expect(JSON.parse(live.current().dataJson).v).toBe('three');
    expect(h.reports.slice(1).map(r => r.files)).toEqual([['src/a.ts'], ['src/late.ts']]);
    live.stop();
  });

  it('waitFor: at once for another generation; on time-out the same generation; stop answers waiters', async () => {
    const { live } = harness();
    await expect(live.waitFor(0, 10000)).resolves.toMatchObject({ generation: 1 });
    await expect(live.waitFor(7, 10000)).resolves.toMatchObject({ generation: 1 });   // a page of an earlier server run
    const timedOut = live.waitFor(1, 200);
    jest.advanceTimersByTime(199);
    let done = false;
    void timedOut.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(timedOut).resolves.toMatchObject({ generation: 1, building: false });
    const waiting = live.waitFor(1, 60000);
    live.stop();
    await expect(waiting).resolves.toMatchObject({ generation: 1 });
  });

  it('stop: the watcher stops, a queued rebuild is dropped, no timer is left, later changes do nothing', () => {
    const { h, live, change } = harness();
    void live.waitFor(1, 60000);
    change(['src/a.ts']);
    live.stop();
    expect(h.stops).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    change(['src/b.ts']);
    jest.runAllTimers();
    expect(h.builds).toBe(1);
    expect(live.current()).toMatchObject({ generation: 1, building: false });
    live.stop();
    expect(h.stops).toBe(1);
  });

  it('the first build throws to the caller and stops the watcher', () => {
    let stops = 0;
    expect(() => createLiveModel(tmpDir('c4pm-live-unit-'), {}, {
      debounceMs: 50,
      build: () => { throw new Error('no such ref'); },
      fingerprint: () => 'fp',
      watch: () => () => { stops++; },
    })).toThrow('no such ref');
    expect(stops).toBe(1);
  });
});

describe('createLiveModel (integration: real repo, watcher and page build)', () => {
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  it('code, board, touch, a broken and a fixed config: generations, stamps, last good data', async () => {
    const repo = tmpDir('c4pm-live-');
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'live-demo' }));
    const src = path.join(repo, 'src', 'index.ts');
    fs.writeFileSync(src, 'export function alpha() { return 1; }\n');
    initProject(repo);
    const project = tryResolveProject(repo)!;
    fs.mkdirSync(project.planDir, { recursive: true });
    fs.writeFileSync(path.join(project.planDir, 'arch.c4'), "model {\n  app = system 'App' {\n    web = container 'Web'\n  }\n}\n");
    const boardFile = boardFileFor(project);
    fs.mkdirSync(path.dirname(boardFile), { recursive: true });
    const board = (title: string): string =>
      JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [{ id: 'b1', kind: 'task', title, status: 'planned' }] }] }, null, 2) + '\n';
    fs.writeFileSync(boardFile, board('first task'));
    const configText = fs.readFileSync(project.configFile, 'utf8');

    const reports: LiveBuildReport[] = [];
    const live = createLiveModel(repo, {}, { debounceMs: 50, onBuild: (r) => reports.push(r) });
    /** The next build report with this outcome (an earlier skipped one, e.g. a late event of the setup, is passed over). */
    const until = async (outcome: LiveBuildReport['outcome']): Promise<LiveBuildReport> => {
      const from = reports.length;
      for (let t = 0; t < 300; t++) {
        const hit = reports.slice(from).find(r => r.outcome === outcome);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`no ${outcome} build; got ${JSON.stringify(reports.slice(from))}`);
    };
    try {
      const g1 = live.current();
      expect(g1).toMatchObject({ generation: 1, building: false, error: null });
      expect(g1.dataJson).toContain('alpha');
      await sleep(300);   // the watcher is up

      const waiting = live.waitFor(1, 20000);
      fs.writeFileSync(src, 'export function alpha() { return 1; }\nexport function zebraFn() { return 2; }\n');
      await until('new');
      expect(live.current().generation).toBe(2);
      expect(live.current().dataJson).toContain('zebraFn');
      expect((await waiting).generation).toBeGreaterThanOrEqual(1);

      fs.writeFileSync(boardFile, board('second task'));
      await until('new');
      expect(live.current().generation).toBe(3);
      expect(live.current().stamps.board).toBe(textStamp([['board', board('second task')]]));
      expect(live.current().stamps.board).not.toBe(g1.stamps.board);
      expect(live.current().stamps.plan).toBe(g1.stamps.plan);

      const t = new Date(Date.now() + 5000);
      fs.utimesSync(src, t, t);
      await until('same');
      expect(live.current().generation).toBe(3);

      const g3 = live.current();
      fs.writeFileSync(project.configFile, '{ not json');
      const failed = await until('failed');
      expect(failed.error).toContain('Invalid JSON');
      expect(live.current()).toEqual({ ...g3, error: failed.error });

      fs.writeFileSync(project.configFile, configText);
      await until('same');
      expect(live.current()).toEqual(g3);
    } finally {
      live.stop();
    }
  }, 60000);
});

describe('b915 store', () => {
  /** The store the model's build received (the `build` seam records opts.store). */
  const storeOf = (dir: string, cli: Partial<C4pmConfig>, opts: Partial<LiveModelOptions> = {}): string | undefined => {
    let seen: string | undefined;
    const live = createLiveModel(dir, cli, {
      debounceMs: 50,
      build: (o) => { seen = o.store; return fakeBuild('one'); },
      fingerprint: () => 'fp',
      watch: () => () => {},
      ...(opts.store !== undefined ? { store: opts.store } : {}),
    });
    live.stop();
    return seen;
  };
  const repoDir = (): string => {
    const d = tmpDir('c4pm-live-store-');
    fs.mkdirSync(path.join(d, '.git'));
    return d;
  };

  it('no option: the anchor default store (as openProject resolves it), never the legacy ~/.c4pm/store', () => {
    const dir = repoDir();
    const store = storeOf(dir, {});
    expect(store).toBe(openProject(dir, {}, { store: 'known' }).store);
    expect(store).toBeTruthy();
    expect(store).not.toBe(path.join(os.homedir(), '.c4pm', 'store'));
  });

  it('cli store: that store; opts.store beats a cli store', () => {
    const dir = repoDir();
    const s = path.join(dir, 's');
    const t = path.join(dir, 't');
    expect(storeOf(dir, { store: s })).toBe(openProject(dir, { store: s }, { store: 'known' }).store);
    expect(storeOf(dir, { store: s })).toContain(`${path.sep}s`);
    expect(storeOf(dir, { store: s }, { store: t })).toBe(openProject(dir, { store: t }, { store: 'known' }).store);
    expect(storeOf(dir, { store: s }, { store: t })).toContain(`${path.sep}t`);
  });
});
