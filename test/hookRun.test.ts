import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { runHook } from '../src/hookRun';
import { installHooks } from '../src/hooks';
import { initProject } from '../src/init';
import { loadManifest, loadFromHistory, resolveRef } from '../src/history/store';
import { compareSnapshots, formatText } from '../src/compare/index';
import { toId } from '../src/names';
import { runCli, CLI_JS, SPAWN_TIMEOUT_MS } from './helpers/runCli';

const PROJECT = path.resolve(__dirname, '..');
let tmp: string;
let code: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });

function commitAll(msg: string) {
  git('add', '-A');
  git('commit', '-m', msg);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-hookrun-')));
  code = path.join(tmp, 'code');
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(code, 'src', 'index.ts'), 'export const a = 1;\n');
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const manifest = () => path.join(tmp, '.c4mp', 'projects', 'demo-app', 'history', 'manifest.json');
const page = () => path.join(tmp, 'C4MP', 'demo-app', 'c4mpView.html');
const dataDir = () => path.join(tmp, '.c4mp', 'projects', 'demo-app', 'data');
const driftFile = () => path.join(dataDir(), 'last-drift.txt');
const hookLines = () => fs.readFileSync(path.join(dataDir(), 'last-hook.txt'), 'utf8').split('\n').filter(Boolean);
const STORE = () => path.join(tmp, '.c4mp', 'projects');

const sha = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: tmp, encoding: 'utf8' }).trim();
const storedCommits = () => loadManifest(STORE(), toId('demo-app')).entries.map(e => e.commit);

/** Commit n new files on the current branch (each adds a function, so the scans differ). */
function commitFiles(prefix: string, n: number) {
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(code, 'src', `${prefix}${i}.ts`), `export function ${prefix}${i}() { return ${i}; }\n`);
    commitAll(`${prefix} ${i}`);
  }
}

/** The drift text the hook must write: before -> after by commit, warning and above. */
function expectedDrift(before: string, after: string): string {
  const repoId = toId('demo-app');
  const m = loadManifest(STORE(), repoId);
  const diff = compareSnapshots(loadFromHistory(STORE(), repoId, resolveRef(m, before)), loadFromHistory(STORE(), repoId, resolveRef(m, after)));
  diff.changes = diff.changes.filter(c => c.severity === 'warning' || c.severity === 'critical');
  return formatText(diff) + '\n';
}

/** main with one commit (c4mp init committed, so git status can be clean), then a branch `feature` with n commits. */
function mainAndFeature(n: number): { main: string; before: string } {
  initProject(tmp);
  commitAll('first');
  const main = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
  const before = sha('HEAD');
  git('checkout', '-q', '-b', 'feature');
  commitFiles('f', n);
  git('checkout', '-q', main);
  return { main, before };
}

describe('runHook', () => {
  it('post-commit writes history and the page for a target below the git root', () => {
    commitAll('first');
    runHook('post-commit', code, {});
    expect(fs.existsSync(manifest())).toBe(true);
    expect(fs.existsSync(page())).toBe(true);
  });

  it('viewOnCommit:false writes history but not the page', () => {
    fs.mkdirSync(path.join(tmp, '.c4mp'));
    fs.writeFileSync(path.join(tmp, '.c4mp', 'config.json'), JSON.stringify({ viewOnCommit: false }));
    commitAll('first');
    runHook('post-commit', code, {});
    expect(fs.existsSync(manifest())).toBe(true);
    expect(fs.existsSync(page())).toBe(false);
  });

  it('post-merge writes history and the page', () => {
    commitAll('first');
    runHook('post-merge', code, {});
    expect(fs.existsSync(manifest())).toBe(true);
    expect(fs.existsSync(page())).toBe(true);
  });

  it('--no-ff merge of 3 commits: history gains only the merge commit, drift is ORIG_HEAD -> HEAD, nothing printed, git status clean', () => {
    const { before } = mainAndFeature(3);
    runHook('post-commit', code, {}); // the state before the merge is stored already
    expect(storedCommits()).toEqual([before]);
    git('merge', '--no-ff', '-m', 'merge feature', 'feature');
    const merge = sha('HEAD');
    expect(sha('ORIG_HEAD')).toBe(before);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      runHook('post-merge', code, {});
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      if (ttyDesc) Object.defineProperty(process.stdout, 'isTTY', ttyDesc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    expect(storedCommits().sort()).toEqual([before, merge].sort());
    expect(fs.readFileSync(driftFile(), 'utf8')).toBe(expectedDrift(before, merge));
    expect(fs.existsSync(path.join(tmp, '.c4mp', 'projects', 'demo-app', 'last-drift.txt'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: tmp, encoding: 'utf8' })).toBe('');
    const last = hookLines()[hookLines().length - 1];
    expect(last).toMatch(new RegExp(`\\| post-merge \\| head ${merge.slice(0, 7)} \\| refs ${merge.slice(0, 7)} \\| drift \\d+ changes \\| page written \\| [\\d.]+ s \\| maxRSS \\d+ MB \\| ok$`));
  });

  it('fast-forward merge of 5 commits: one entry added (the new tip), not 5; drift is old tip -> new tip', () => {
    const { before } = mainAndFeature(5);
    runHook('post-commit', code, {});
    git('merge', '--ff-only', 'feature');
    const tip = sha('HEAD');
    expect(sha('ORIG_HEAD')).toBe(before);
    runHook('post-merge', code, {});
    expect(storedCommits().sort()).toEqual([before, tip].sort());
    expect(fs.readFileSync(driftFile(), 'utf8')).toBe(expectedDrift(before, tip));
    expect(hookLines()[1]).toContain(`| refs ${tip.slice(0, 7)} |`);
  });

  it('fresh history (nothing stored, no data folder yet): the before state is recorded too and the drift written', () => {
    const { before } = mainAndFeature(2);
    git('merge', '--no-ff', '-m', 'merge feature', 'feature');
    const merge = sha('HEAD');
    fs.rmSync(dataDir(), { recursive: true, force: true });
    runHook('post-merge', code, {});
    expect(storedCommits().sort()).toEqual([before, merge].sort());
    expect(fs.readFileSync(driftFile(), 'utf8')).toBe(expectedDrift(before, merge));
    expect(hookLines()[0]).toContain(`| refs ${before.slice(0, 7)} ${merge.slice(0, 7)} |`);
  });

  it('no ORIG_HEAD: no drift file, last-hook.txt says skipped: no ORIG_HEAD', () => {
    commitAll('first');
    runHook('post-merge', code, {});
    expect(storedCommits()).toEqual([sha('HEAD')]);
    expect(fs.existsSync(driftFile())).toBe(false);
    expect(hookLines()).toHaveLength(1);
    expect(hookLines()[0]).toContain('| drift skipped: no ORIG_HEAD |');
    expect(hookLines()[0]).toMatch(/\| ok$/);
  });

  it('two hooks started at once (two processes) run one after the other; every entry is stored, 2 lines written', async () => {
    const { before } = mainAndFeature(2);
    git('merge', '--ff-only', 'feature');
    const tip = sha('HEAD');
    const runChild = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_JS, 'hook', 'post-merge', '--repo', code], { cwd: PROJECT, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', resolve);
    });
    expect(await Promise.all([runChild(), runChild()])).toEqual([0, 0]);

    expect(storedCommits().sort()).toEqual([before, tip].sort());
    const lines = hookLines();
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/\| ok$/);
    // the second one waited for the whole first run: it found both commits stored, and its time includes that wait
    const [first, second] = lines; // written in the lock, so in run order
    expect(first.split(' | ')[3]).toBe(`refs ${before.slice(0, 7)} ${tip.slice(0, 7)}`);
    expect(second.split(' | ')[3]).toBe('refs none');
    const secondsOf = (l: string) => Number(l.split(' | ')[6].replace(' s', ''));
    expect(secondsOf(second)).toBeGreaterThan(secondsOf(first));
  }, 120000);

  it('a passed head (an older commit) is recorded, not HEAD', () => {
    commitAll('first');
    const first = sha('HEAD');
    commitFiles('n', 1);
    runHook('post-commit', code, { head: first });
    expect(storedCommits()).toEqual([first]);
    expect(hookLines()[0]).toContain(`| head ${first.slice(0, 7)} | refs ${first.slice(0, 7)} |`);
  });

  it('a malformed head is ignored: HEAD is read and recorded', () => {
    commitAll('first');
    runHook('post-commit', code, { head: 'not-a-sha' });
    expect(storedCommits()).toEqual([sha('HEAD')]);
    expect(hookLines()[0]).toMatch(/\| ok$/);
  });

  it('post-merge with a passed head and no orig-head: the block saw no ORIG_HEAD, so none is read late', () => {
    commitAll('first');
    const first = sha('HEAD');
    commitFiles('n', 1);
    git('update-ref', 'ORIG_HEAD', first); // written by a later git command, after the hook fired
    runHook('post-merge', code, { head: sha('HEAD') });
    expect(storedCommits()).toEqual([sha('HEAD')]);
    expect(hookLines()[0]).toContain('| drift skipped: no ORIG_HEAD |');
  });

  it('last-hook.txt keeps only the last 20 lines', () => {
    commitAll('first');
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), 'last-hook.txt'), Array.from({ length: 25 }, (_, i) => `old ${i + 1}`).join('\n') + '\n');
    runHook('post-commit', code, {});
    const lines = hookLines();
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('old 7');
    expect(lines[19]).toMatch(/\| post-commit \| .*\| drift skipped: not a merge \| page written \| .*\| ok$/);
  });

  it('a held lock past the wait: no error, the line says skipped: busy', () => {
    commitAll('first');
    fs.mkdirSync(dataDir(), { recursive: true });
    const lock = path.join(dataDir(), 'hook.lock');
    fs.writeFileSync(lock, `${process.pid} ${Date.now()}`); // held by a live process (this one)
    try {
      expect(() => runHook('post-commit', code, { lockWaitMs: 300 })).not.toThrow();
    } finally {
      fs.rmSync(lock, { force: true });
    }
    expect(fs.existsSync(manifest())).toBe(false);
    expect(hookLines()[0]).toMatch(new RegExp(`\\| post-commit \\| head ${sha('HEAD').slice(0, 7)} \\| refs - \\| drift - \\| page - \\| .*\\| skipped: busy$`));
  });

  it('b629: a live hook holding the lock for 31 min is not taken over (6 h max age): skipped: busy', () => {
    commitAll('first');
    fs.mkdirSync(dataDir(), { recursive: true });
    const lock = path.join(dataDir(), 'hook.lock');
    const held = `${process.pid} ${Date.now() - 31 * 60_000}`; // live pid, older than the old 30 min rule
    fs.writeFileSync(lock, held);
    try {
      expect(() => runHook('post-commit', code, { lockWaitMs: 300 })).not.toThrow();
      expect(fs.readFileSync(lock, 'utf8')).toBe(held); // not taken over
    } finally {
      fs.rmSync(lock, { force: true });
    }
    expect(fs.existsSync(manifest())).toBe(false);
    expect(hookLines()[0]).toMatch(/\| skipped: busy$/);
  });

  it('a corrupt manifest: the hook does not throw and last-hook.txt says failed: <message>', () => {
    commitAll('first');
    fs.mkdirSync(path.dirname(manifest()), { recursive: true });
    fs.writeFileSync(manifest(), '{"entries": [');
    expect(() => runHook('post-commit', code, {})).not.toThrow();
    expect(hookLines()[0]).toMatch(/\| failed: history manifest .*manifest\.json is not valid JSON/);
    expect(fs.readFileSync(manifest(), 'utf8')).toBe('{"entries": [');
  });

  it('no anchor: does nothing and does not throw', () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-noanchor-')));
    try {
      fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"x"}');
      expect(() => runHook('post-commit', bare, {})).not.toThrow();
      expect(fs.readdirSync(bare)).toEqual(['package.json']);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('never throws on a missing path or unknown kind', () => {
    expect(() => runHook('post-commit', path.join(tmp, 'nope'), {})).not.toThrow();
    expect(() => runHook('bogus', code, {})).not.toThrow();
  });
});

describe('hook subcommand and generated shell block', () => {
  it('exits 0 even when the repo path does not exist', () => {
    const r = runCli(['hook', 'post-commit', '--repo', path.join(tmp, 'nope')], {
      cwd: PROJECT, encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });

  it('is hidden from --help', () => {
    const r = runCli(['--help'], { cwd: PROJECT, encoding: 'utf8' });
    expect(r.stdout).not.toMatch(/^\s+hook\b/m);
  });

  it('a real commit runs the installed hook in the background (shim c4mp on PATH)', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-shim-'));
    try {
      fs.writeFileSync(path.join(bin, 'c4mp'), `#!/bin/sh\ncd "${PROJECT}" && exec "${process.execPath}" "${CLI_JS}" "$@"\n`);
      fs.chmodSync(path.join(bin, 'c4mp'), 0o755);
      installHooks(code);
      fs.writeFileSync(path.join(tmp, '.gitignore'), '.c4mp/\nC4MP/\n');
      git('add', '-A');
      execFileSync('git', ['commit', '-m', 'first'], {
        cwd: tmp, stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      // wait for the hook's own end signal: it writes last-hook.txt last (atomically), after the manifest and page.
      // The chain git -> sh hook -> shim -> node CLI -> git xN can stall at each process start (macOS, b628).
      const lastHook = path.join(dataDir(), 'last-hook.txt');
      const deadline = Date.now() + 2 * SPAWN_TIMEOUT_MS;
      const wait = () => new Promise(r => setTimeout(r, 500));
      return (async () => {
        while (Date.now() < deadline && !fs.existsSync(lastHook)) await wait();
        expect(fs.existsSync(lastHook)).toBe(true);
        const lines = hookLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\| ok$/);
        expect(fs.existsSync(manifest())).toBe(true);
        expect(fs.existsSync(page())).toBe(true);
      })().finally(() => fs.rmSync(bin, { recursive: true, force: true }));
    } catch (e) {
      fs.rmSync(bin, { recursive: true, force: true });
      throw e;
    }
  }, 3 * SPAWN_TIMEOUT_MS);

  it('3 quick commits with a slow-starting c4mp (2 s): each hook records its own commit', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-shim-'));
    try {
      // the sleep stands in for a slow node start (macOS syspolicyd): HEAD has moved on by the time node runs
      fs.writeFileSync(path.join(bin, 'c4mp'), `#!/bin/sh\nsleep 2\ncd "${PROJECT}" && exec "${process.execPath}" "${CLI_JS}" "$@"\n`);
      fs.chmodSync(path.join(bin, 'c4mp'), 0o755);
      fs.mkdirSync(path.join(tmp, '.c4mp'));
      fs.writeFileSync(path.join(tmp, '.c4mp', 'config.json'), JSON.stringify({ viewOnCommit: false })); // lighter runs
      fs.writeFileSync(path.join(tmp, '.gitignore'), '.c4mp/\nC4MP/\n');
      installHooks(code);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const commits: string[] = [];
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(code, 'src', `q${i}.ts`), `export function q${i}() { return ${i}; }\n`);
        git('add', '-A');
        execFileSync('git', ['commit', '-q', '-m', `quick ${i}`], { cwd: tmp, stdio: 'ignore', env });
        commits.push(sha('HEAD'));
      }
      const linesNow = () => (fs.existsSync(path.join(dataDir(), 'last-hook.txt')) ? hookLines().length : 0);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && linesNow() < 3) await new Promise(r => setTimeout(r, 500));
      expect(linesNow()).toBe(3);
      for (const l of hookLines()) expect(l).toMatch(/\| ok$/);
      expect(storedCommits().sort()).toEqual([...commits].sort());
      const heads = hookLines().map(l => l.split(' | ')[2]).sort();
      expect(heads).toEqual(commits.map(c => `head ${c.slice(0, 7)}`).sort());
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 180000);

  it('with no c4mp on PATH the hook block exits 0 and commit succeeds', () => {
    installHooks(code);
    git('add', '-A');
    expect(() =>
      execFileSync('git', ['commit', '-m', 'x'], { cwd: tmp, stdio: 'ignore', env: { ...process.env, PATH: '/usr/bin:/bin' } }),
    ).not.toThrow();
  });
});
