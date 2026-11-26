// Phase 29 T5 (b624): fewer git calls, same output. The page build reads each component source file's history once
// (componentHistoryReader), and the history run reads no repo meta from git (readRepoIdentity; scanCore skips git when
// the meta override sets it). Git calls are counted with spies on child_process.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Wrap (not replace) the two sync spawners so gitCallsOf can record the git calls; behaviour stays the real one.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFileSync: jest.fn(actual.execFileSync), spawnSync: jest.fn(actual.spawnSync) };
});

import * as childProcess from 'child_process';
import { execFileSync } from 'child_process';
import { componentHistoryReader, readComponentHistory } from '../src/view/source';
import { buildViewModel } from '../src/view/model';
import { runSnapshot } from '../src/pipeline';
import { runHistory } from '../src/scan/historyRun';
import { loadFromHistory, loadManifest } from '../src/history/store';
import { toId } from '../src/names';
import { gitBin } from '../src/util/gitBin';
import { Plan, PlanElement, ViewNode } from '../src/types';

const gitEnv = (date: string) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

function git(repo: string, args: string[], date = '2026-01-01T10:00:00Z'): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: gitEnv(date) });
}

function makeRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  return repo;
}

function commitAll(repo: string, message: string, date: string): void {
  git(repo, ['add', '.'], date);
  git(repo, ['commit', '-m', message], date);
}

/** The git argument lists (after `-C <repo>`) of every git call made by run(), execFileSync and spawnSync alike. */
function gitCallsOf(run: () => void): string[][] {
  const calls: string[][] = [];
  const bin = gitBin();   // resolved before the spies record, so its own xcrun call is not counted (b628)
  const record = (file: unknown, args: unknown) => {
    if (file === bin && Array.isArray(args)) calls.push((args[0] === '-C' ? args.slice(2) : args) as string[]);
  };
  const exec = childProcess.execFileSync as unknown as jest.Mock;
  const spawn = childProcess.spawnSync as unknown as jest.Mock;
  const real = { exec: exec.getMockImplementation()!, spawn: spawn.getMockImplementation()! };
  exec.mockImplementation((file: unknown, args: unknown, o: unknown) => { record(file, args); return real.exec(file, args, o); });
  spawn.mockImplementation((file: unknown, args: unknown, o: unknown) => { record(file, args); return real.spawn(file, args, o); });
  try {
    run();
  } finally {
    exec.mockImplementation(real.exec);
    spawn.mockImplementation(real.spawn);
  }
  return calls;
}

const isLogFollow = (args: string[]) => args[0] === 'log' && args.includes('--follow');

describe('componentHistoryReader', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo('c4pm-t5-reader-');
    fs.writeFileSync(path.join(repo, 'a.c4'), 'v1');
    fs.writeFileSync(path.join(repo, 'b.c4'), 'v1');
    commitAll(repo, 'first', '2026-01-01T10:00:00Z');
    fs.writeFileSync(path.join(repo, 'a.c4'), 'v2');
    commitAll(repo, 'second', '2026-01-02T10:00:00Z');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('gives the same entries as readComponentHistory, with one git log --follow per distinct file', () => {
    const direct = { a: readComponentHistory(repo, 'a.c4'), b: readComponentHistory(repo, 'b.c4'), none: readComponentHistory(repo, 'none.c4') };
    expect(direct.a.map((e) => e.message)).toEqual(['second', 'first']);
    const got: Record<string, unknown[]> = {};
    const calls = gitCallsOf(() => {
      const historyOf = componentHistoryReader(repo);
      got.a1 = historyOf('a.c4');
      got.b = historyOf('b.c4');
      got.a2 = historyOf('a.c4');
      got.none1 = historyOf('none.c4');
      got.none2 = historyOf('none.c4');
    });
    expect(got.a1).toEqual(direct.a);
    expect(got.a2).toEqual(direct.a);
    expect(got.b).toEqual(direct.b);
    expect(got.none1).toEqual([]);
    expect(got.none2).toEqual(direct.none);
    expect(calls.filter(isLogFollow).map((a) => a[a.length - 1])).toEqual(['a.c4', 'b.c4', 'none.c4']);
  });

  it('returns fresh entry objects on every call (no shared arrays between nodes)', () => {
    const historyOf = componentHistoryReader(repo);
    const first = historyOf('a.c4');
    const second = historyOf('a.c4');
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    first[0].message = 'changed';
    first.pop();
    expect(historyOf('a.c4')).toEqual(readComponentHistory(repo, 'a.c4'));
  });

  it('a new reader reads again (the memo lives for one build only)', () => {
    const calls = gitCallsOf(() => {
      componentHistoryReader(repo)('a.c4');
      componentHistoryReader(repo)('a.c4');
    });
    expect(calls.filter(isLogFollow)).toHaveLength(2);
  });
});

describe('buildViewModel component history', () => {
  // 3 components declared in arch.c4, 1 in other.c4: 4 component nodes with a source, 2 distinct files.
  let repo: string;
  const comps = [
    { id: 'app.one', dir: 'one', c4: 'arch.c4' },
    { id: 'app.two', dir: 'two', c4: 'arch.c4' },
    { id: 'app.three', dir: 'three', c4: 'arch.c4' },
    { id: 'app.four', dir: 'four', c4: 'other.c4' },
  ];
  const plan = (): Plan => {
    const elements: PlanElement[] = comps.map((c, i) => ({
      id: c.id,
      kind: 'component',
      title: c.dir,
      description: null,
      technology: null,
      links: [{ raw: `./src/${c.dir}/m.ts#f${i}`, path: `src/${c.dir}/m.ts`, name: `f${i}`, lines: null, title: null }],
      metadata: {},
      parent: null,
      source: { file: c.c4, line: i + 1 },
    }));
    return { files: ['arch.c4', 'other.c4'], elements, relations: [], issues: [] };
  };

  beforeAll(() => {
    repo = makeRepo('c4pm-t5-model-');
    comps.forEach((c, i) => {
      fs.mkdirSync(path.join(repo, 'src', c.dir), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', c.dir, 'm.ts'), `export function f${i}(): number {\n  return ${i};\n}\n`);
    });
    fs.writeFileSync(path.join(repo, 'arch.c4'), '// arch v1\n');
    fs.writeFileSync(path.join(repo, 'other.c4'), '// other v1\n');
    commitAll(repo, 'declare components', '2026-01-01T10:00:00Z');
    fs.writeFileSync(path.join(repo, 'arch.c4'), '// arch v2\n');
    commitAll(repo, 'edit arch', '2026-01-02T10:00:00Z');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('runs 1 git log --follow per distinct source file; every node gets the entries readComponentHistory gives', () => {
    const p = plan();
    const snapshot = runSnapshot({ repo, plan: p, write: false, quiet: true });
    let model!: ReturnType<typeof buildViewModel>;
    const calls = gitCallsOf(() => { model = buildViewModel(snapshot, 'summary', p); });
    expect(calls.filter(isLogFollow).map((a) => a[a.length - 1]).sort()).toEqual(['arch.c4', 'other.c4']);

    const nodes: ViewNode[] = [];
    const walk = (n: ViewNode) => { if (n.kind === 'component' && n.source) nodes.push(n); n.children.forEach(walk); };
    walk(model.root);
    expect(nodes.map((n) => n.id).sort()).toEqual(comps.map((c) => c.id).sort());
    for (const n of nodes) {
      expect(n.history).toEqual(readComponentHistory(repo, n.source!));
    }
    const one = nodes.find((n) => n.id === 'app.one')!;
    const two = nodes.find((n) => n.id === 'app.two')!;
    expect(one.history!.map((e) => e.message)).toEqual(['edit arch', 'declare components']);
    expect(two.history).not.toBe(one.history);
  });
});

describe('runHistory refs [HEAD]: no meta git calls', () => {
  let repo: string;
  let store: string;
  beforeAll(() => {
    repo = makeRepo('c4pm-t5-history-');
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t5-store-'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 't5-history' }));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'import { b } from "./b";\nexport const a = b;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
    commitAll(repo, 'one', '2026-01-01T10:00:00Z');
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('spawns only currentBranch, commitInfo and exportCommit git calls, and stores the same meta as before', () => {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const calls = gitCallsOf(() => { runHistory({ repo, store, refs: ['HEAD'], quiet: true }); });
    expect(calls).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],                         // currentBranch
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],          // commitInfo
      ['log', '-1', '--format=%H%x1f%cI%x1f%s', head],                // commitInfo
      ['rev-list', '--count', head],                                  // commitInfo (depth)
      ['archive', '--format=tar', head],                              // exportCommit
    ]);

    const repoId = toId('t5-history');
    const [entry] = loadManifest(store, repoId).entries;
    const { meta } = loadFromHistory(store, repoId, entry);
    expect(meta).toEqual({
      tool: meta.tool,
      repoPath: path.resolve(repo),
      repoName: 't5-history',
      createdAt: meta.createdAt,
      git: { commit: head, branch, date: execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim(), depth: 1 },
    });
  });
});
