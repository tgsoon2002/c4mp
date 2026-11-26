import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import { clearParseCache, parseCacheStats } from '../src/parseCache';
import { repoCacheDir } from '../src/util/userCache';

// QS-2 (b676): queries keep parsed files on disk (per-user cache), so the next process skips parsing.
// clearParseCache() between two calls stands for a new process (memory empty, the disk is read again).

describe('disk parse cache', () => {
  let dir: string;
  let cacheRoot: string;
  const oldCacheDir = process.env.C4PM_CACHE_DIR;
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  const query = () => {
    const snap = loadQueryContext(dir).snapshot;
    return JSON.stringify({ ...snap, meta: { ...snap.meta, createdAt: '' } });
  };
  const diskFile = () => path.join(repoCacheDir(dir)!, 'parse-cache.json');

  beforeEach(() => {
    clearParseCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pcd-'));
    write('a.ts', "import { b } from './b';\nexport function a() { return b(); }\n");
    write('b.ts', 'export function b() { return 1; }\n');
    write('c.ts', 'export function c() { return 3; }\n');
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pcd-cache-'));
    process.env.C4PM_CACHE_DIR = cacheRoot;
  });
  afterEach(() => {
    if (oldCacheDir === undefined) delete process.env.C4PM_CACHE_DIR;
    else process.env.C4PM_CACHE_DIR = oldCacheDir;
    clearParseCache();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('a second process makes 0 parses and gives the same snapshot', () => {
    const first = query();
    expect(parseCacheStats()).toEqual({ hits: 0, misses: 3 });
    expect(fs.existsSync(diskFile())).toBe(true);
    clearParseCache();
    const second = query();
    expect(parseCacheStats()).toEqual({ hits: 3, misses: 0 });
    expect(second).toBe(first);
  });

  it('a changed file is the only miss', () => {
    query();
    write('c.ts', 'export function c() { return 4; }\n');
    clearParseCache();
    query();
    expect(parseCacheStats()).toEqual({ hits: 2, misses: 1 });
  });

  it('a broken cache file is ignored and rewritten as valid JSON', () => {
    const expected = query();
    fs.writeFileSync(diskFile(), '{not json');
    clearParseCache();
    expect(query()).toBe(expected);
    expect(parseCacheStats().misses).toBe(3);
    expect(JSON.parse(fs.readFileSync(diskFile(), 'utf8')).format).toBe(7);
  });

  // 2: outlines without content hashes (b568); 3: C++ outlines read before the macro retry and nested classes (b573, b575);
  // 4: calls without positions and ownUses (b682); 5: Python files without calls (b592); 6: outlines without nested (b782).
  it.each([2, 3, 4, 5, 6])('a format-%i cache file is ignored; the new outlines carry hashes', (format) => {
    query();
    const data = JSON.parse(fs.readFileSync(diskFile(), 'utf8'));
    fs.writeFileSync(diskFile(), JSON.stringify({ ...data, format }));
    clearParseCache();
    const snap = loadQueryContext(dir).snapshot;
    expect(parseCacheStats()).toEqual({ hits: 0, misses: 3 });
    expect(snap.files.every((f) => /^[0-9a-f]{16}$/.test(f.hash ?? '') && f.elements.every((e) => /^[0-9a-f]{16}$/.test(e.hash ?? '')))).toBe(true);
  });

  it('a cache file of another c4pm version is ignored', () => {
    query();
    const data = JSON.parse(fs.readFileSync(diskFile(), 'utf8'));
    fs.writeFileSync(diskFile(), JSON.stringify({ ...data, tool: 'c4pm@0.0.0' }));
    clearParseCache();
    query();
    expect(parseCacheStats()).toEqual({ hits: 0, misses: 3 });
  });

  it('C4PM_CACHE_DIR=off writes no cache file', () => {
    process.env.C4PM_CACHE_DIR = 'off';
    query();
    clearParseCache();
    query();
    expect(parseCacheStats().misses).toBe(3);
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it('writes nothing to the repo folder', () => {
    const before = fs.readdirSync(dir).sort();
    query();
    clearParseCache();
    query();
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('a lock held by another live process does not block the query; nothing is written', () => {
    const cacheDir = repoCacheDir(dir)!;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'parse-cache.lock'), `${process.ppid} ${Date.now()}`);
    const snap = loadQueryContext(dir).snapshot;
    expect(snap.files.map((f) => f.file).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(fs.existsSync(diskFile())).toBe(false);
  }, 15000);
});
