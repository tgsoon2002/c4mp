import * as fs from 'fs';

// Same module with readFileSync wrapped (real behaviour), so the b585 test can count the reads of one file.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readFunctionSource, readComponentHistory, readFileLines, sliceLines } from '../src/view/source';
import { buildViewModel } from '../src/view/model';
import { runSnapshot } from '../src/pipeline';
import { ViewNode } from '../src/types';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('readFunctionSource', () => {
  it('reads the exact lines of a known function in this real repo', () => {
    // Find normalizeIgnore in src/config.ts (10 lines, 1-based inclusive) instead of pinning line
    // numbers: the file grows whenever a config key is added.
    const all = fs.readFileSync(path.join(REPO_ROOT, 'src/config.ts'), 'utf-8').split('\n');
    const start = all.findIndex((l) => l.startsWith('function normalizeIgnore(')) + 1;
    expect(start).toBeGreaterThan(0);
    const lines = readFunctionSource(REPO_ROOT, 'src/config.ts', start, start + 9);
    expect(lines).toEqual([
      "function normalizeIgnore(entry: string): string {",
      "  let normalized = entry;",
      "  if (normalized.startsWith('./')) {",
      "    normalized = normalized.slice(2);",
      "  }",
      "  if (normalized.endsWith('/')) {",
      "    normalized = normalized.slice(0, -1);",
      "  }",
      "  return normalized;",
      "}",
    ]);
  });

  it('returns [] for a nonexistent file, never throws', () => {
    expect(() => readFunctionSource(REPO_ROOT, 'src/does-not-exist.ts', 1, 5)).not.toThrow();
    expect(readFunctionSource(REPO_ROOT, 'src/does-not-exist.ts', 1, 5)).toEqual([]);
  });

  it('returns [] when startLine is out of range, never throws', () => {
    expect(() => readFunctionSource(REPO_ROOT, 'src/config.ts', 999999, 1000005)).not.toThrow();
    expect(readFunctionSource(REPO_ROOT, 'src/config.ts', 999999, 1000005)).toEqual([]);
  });

  it('returns [] for an invalid range (end before start), never throws', () => {
    expect(readFunctionSource(REPO_ROOT, 'src/config.ts', 10, 5)).toEqual([]);
  });
});

describe('readFileLines / sliceLines (b585)', () => {
  it('readFileLines gives the file split on newlines; sliceLines takes a 1-based inclusive range, end clamped', () => {
    const lines = readFileLines(REPO_ROOT, 'src/config.ts');
    expect(lines).toEqual(fs.readFileSync(path.join(REPO_ROOT, 'src/config.ts'), 'utf-8').split('\n'));
    expect(sliceLines(['a', 'b', 'c'], 2, 3)).toEqual(['b', 'c']);
    expect(sliceLines(['a', 'b', 'c'], 3, 99)).toEqual(['c']);
  });

  it('readFileLines gives null for a missing file and never throws; sliceLines of null is []', () => {
    expect(() => readFileLines(REPO_ROOT, 'src/does-not-exist.ts')).not.toThrow();
    expect(readFileLines(REPO_ROOT, 'src/does-not-exist.ts')).toBeNull();
    expect(sliceLines(null, 1, 5)).toEqual([]);
  });

  it.each([
    ['start past the end', 4, 9],
    ['end before start', 3, 2],
    ['start below 1', 0, 2],
    ['not an integer', 1.5, 2],
  ])('sliceLines gives [] for %s', (_label, start, end) => {
    expect(sliceLines(['a', 'b', 'c'], start, end)).toEqual([]);
  });

  it('the view model reads a file of 3000 functions once and gives each function and method its own lines', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b585-'));
    try {
      const fns = Array.from({ length: 3000 }, (_, i) => `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`);
      const cls = 'export class Box {\n  get(): number {\n    return 1;\n  }\n}\n';
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'big.ts'), fns.join('') + cls);
      const snapshot = runSnapshot({ repo, write: false, quiet: true });
      const readSpy = fs.readFileSync as unknown as jest.Mock;
      readSpy.mockClear();
      const model = buildViewModel(snapshot, 'summary');
      const bigReads = readSpy.mock.calls.filter((args) => String(args[0]).endsWith(path.join('src', 'big.ts')));
      expect(bigReads).toHaveLength(1);

      const byId = new Map<string, ViewNode>();
      const walk = (n: ViewNode): void => { byId.set(n.id, n); n.children.forEach(walk); };
      walk(model.root);
      expect(byId.get('src/big.ts#fn0')!.code).toEqual(['export function fn0(x: number): number {', '  return x + 0;', '}']);
      expect(byId.get('src/big.ts#fn2999')!.code).toEqual(['export function fn2999(x: number): number {', '  return x + 2999;', '}']);
      expect(byId.get('src/big.ts#Box.get')!.code).toEqual(['  get(): number {', '    return 1;', '  }']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('readComponentHistory', () => {
  function makeTempRepo(): string {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-source-history-'));
    execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });
    return tempRepo;
  }

  function commit(tempRepo: string, file: string, content: string, message: string, date: string): string {
    fs.writeFileSync(path.join(tempRepo, file), content);
    execFileSync('git', ['-C', tempRepo, 'add', file], { stdio: 'ignore' });
    execFileSync('git', ['-C', tempRepo, 'commit', '-m', message], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    return execFileSync('git', ['-C', tempRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }

  it('returns commits newest-first with real hashes/dates/messages', () => {
    const tempRepo = makeTempRepo();
    try {
      const hash1 = commit(tempRepo, 'a.txt', 'v1', 'first commit', '2026-01-01T10:00:00Z');
      const hash2 = commit(tempRepo, 'a.txt', 'v2', 'second commit', '2026-01-02T10:00:00Z');

      const entries = readComponentHistory(tempRepo, 'a.txt');

      expect(entries).toHaveLength(2);
      // newest first, matching git log's default order
      expect(entries[0].commit).toBe(hash2);
      expect(entries[0].date).toBe('2026-01-02');
      expect(entries[0].message).toBe('second commit');
      expect(entries[1].commit).toBe(hash1);
      expect(entries[1].date).toBe('2026-01-01');
      expect(entries[1].message).toBe('first commit');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('respects the limit option', () => {
    const tempRepo = makeTempRepo();
    try {
      commit(tempRepo, 'a.txt', 'v1', 'c1', '2026-01-01T10:00:00Z');
      commit(tempRepo, 'a.txt', 'v2', 'c2', '2026-01-02T10:00:00Z');
      const hash3 = commit(tempRepo, 'a.txt', 'v3', 'c3', '2026-01-03T10:00:00Z');

      const entries = readComponentHistory(tempRepo, 'a.txt', 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].commit).toBe(hash3);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('keeps the rest of the line as message when the commit message itself contains "|"', () => {
    const tempRepo = makeTempRepo();
    try {
      commit(tempRepo, 'a.txt', 'v1', 'fix: a | b | c', '2026-01-01T10:00:00Z');
      const entries = readComponentHistory(tempRepo, 'a.txt');
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('fix: a | b | c');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('returns [] for a nonexistent path, never throws', () => {
    const tempRepo = makeTempRepo();
    try {
      commit(tempRepo, 'a.txt', 'v1', 'c1', '2026-01-01T10:00:00Z');
      expect(() => readComponentHistory(tempRepo, 'does-not-exist.txt')).not.toThrow();
      expect(readComponentHistory(tempRepo, 'does-not-exist.txt')).toEqual([]);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('returns [] outside any git repo, never throws', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nogit-'));
    try {
      expect(() => readComponentHistory(tempDir, 'a.txt')).not.toThrow();
      expect(readComponentHistory(tempDir, 'a.txt')).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
