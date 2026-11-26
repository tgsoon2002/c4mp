import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runSnapshot } from '../src/pipeline';
import { runHistory } from '../src/scan/historyRun';
import * as parseCache from '../src/parseCache';
import { clearParseCache, parseCacheStats, parseCacheSize } from '../src/parseCache';

// b620: the parse cache is keyed by repo-relative path + content, so the same tree in another folder
// (history exports each commit to a new temp dir) hits; each scan sweeps what it did not use.

const SAMPLE = path.join(__dirname, 'fixtures', 'sample');

describe('parse cache across folders and history', () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  const copySample = () => {
    const d = tempDir('c4pm-pch-');
    fs.cpSync(SAMPLE, d, { recursive: true });
    return d;
  };
  // Snapshot JSON without the run-specific fields (time, folder).
  const scanJson = (dir: string) => {
    const snap = runSnapshot({ repo: dir, write: false, quiet: true, collectCalls: true });
    return JSON.stringify({ ...snap, meta: { ...snap.meta, createdAt: '', repoPath: '' } }).split(dir).join('<repo>');
  };

  beforeEach(() => clearParseCache());
  afterEach(() => {
    jest.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('the same tree in a second folder: all hits, and the JSON equals a cold scan', () => {
    const a = copySample();
    const b = copySample();
    scanJson(a);
    const files = parseCacheStats().misses;
    expect(files).toBeGreaterThan(5);
    expect(parseCacheStats().hits).toBe(0);
    const warm = scanJson(b);
    expect(parseCacheStats()).toEqual({ hits: files, misses: 0 });
    clearParseCache();
    expect(scanJson(b)).toBe(warm);
    expect(parseCacheStats()).toEqual({ hits: 0, misses: files });
  });

  it('after A then B with one file changed, the cache holds exactly the files of B (old version swept)', () => {
    const a = copySample();
    const b = copySample();
    fs.appendFileSync(path.join(b, 'api', 'src', 'lib', 'log.ts'), '\nexport function extraLog() { return 1; }\n');
    scanJson(a);
    const snapB = runSnapshot({ repo: b, write: false, quiet: true, collectCalls: true });
    expect(parseCacheStats()).toEqual({ hits: snapB.files.length - 1, misses: 1 });
    expect(parseCacheSize()).toBe(snapB.files.length);
  });

  it('runHistory over 4 commits that each change one file: later commits miss only that file; size never above one scan', () => {
    const repo = tempDir('c4pm-pch-repo-');
    const store = tempDir('c4pm-pch-store-');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'pch-history' }));
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const n of names) fs.writeFileSync(path.join(repo, `${n}.ts`), `export function ${n}() { return 0; }\n`);
    git('add', '-A');
    git('commit', '-m', 'c1');
    for (let i = 1; i <= 3; i++) {
      fs.appendFileSync(path.join(repo, `${names[i]}.ts`), `export function ${names[i]}${i}() { return ${i}; }\n`);
      git('add', '-A');
      git('commit', '-m', `c${i + 1}`);
    }

    // Record the stats and the cache size at the end of every scan's file loop.
    const original = parseCache.endParseGeneration;
    const scans: { hits: number; misses: number; size: number }[] = [];
    jest.spyOn(parseCache, 'endParseGeneration').mockImplementation(() => {
      original();
      scans.push({ ...parseCacheStats(), size: parseCacheSize() });
    });

    const entries = runHistory({ repo, store, quiet: true });
    expect(entries).toHaveLength(4);
    expect(scans).toHaveLength(4);
    const files = scans[0].misses;
    expect(scans[0]).toEqual({ hits: 0, misses: files, size: files });
    for (const s of scans.slice(1)) expect(s).toEqual({ hits: files - 1, misses: 1, size: files });
  });
});
