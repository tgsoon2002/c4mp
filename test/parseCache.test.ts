import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { clearParseCache, parseCacheStats, parseCacheSize } from '../src/parseCache';

// b217 fix A: a second scan in one process reuses parsed files; results never change.
// b620: the key is the file content (no mtime), and each scan sweeps entries it did not use.

describe('parse cache', () => {
  let dir: string;
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  const scan = () => {
    const snap = runSnapshot({ repo: dir, write: false, quiet: true, collectCalls: true });
    return JSON.stringify({ ...snap, meta: { ...snap.meta, createdAt: '' } });
  };

  beforeEach(() => {
    clearParseCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pc-'));
    write('a.ts', "import { b } from './b';\nexport function a() { return b(); }\n");
    write('b.ts', 'export function b() { return 1; }\n');
    write('c.ts', 'export function c() { return 3; }\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('second scan: all hits, identical snapshot; cold scan after clear gives the same JSON', () => {
    const first = scan();
    expect(parseCacheStats()).toEqual({ hits: 0, misses: 3 });
    const second = scan();
    expect(parseCacheStats()).toEqual({ hits: 3, misses: 0 });
    expect(second).toBe(first);
    clearParseCache();
    expect(scan()).toBe(first);
  });

  it('an edited file is the only miss and its new content shows, also with the same size and mtime', () => {
    const cPath = path.join(dir, 'c.ts');
    const first = scan();
    const before = fs.statSync(cPath);
    write('c.ts', 'export function d() { return 3; }\n');   // same size
    fs.utimesSync(cPath, before.atime, before.mtime);   // same mtime: only the content tells
    const second = scan();
    expect(parseCacheStats()).toEqual({ hits: 2, misses: 1 });
    expect(second).not.toBe(first);
    expect(second).toContain('"name":"d"');
    expect(parseCacheSize()).toBe(3);   // the old version of c.ts was swept
  });

  it('a deleted file disappears from the snapshot and from the cache', () => {
    scan();
    expect(parseCacheSize()).toBe(3);
    fs.unlinkSync(path.join(dir, 'c.ts'));
    const second = scan();
    expect(second).not.toContain('c.ts');
    expect(parseCacheStats()).toEqual({ hits: 2, misses: 0 });
    expect(parseCacheSize()).toBe(2);
  });

  it('a parse-error file stays parseError when cached', () => {
    write('bad.ts', 'export function ( {{{ ;\n');
    const parseErrors = () => {
      const snap = runSnapshot({ repo: dir, write: false, quiet: true });
      return snap.files.filter((o) => o.parseError).map((o) => o.file);
    };
    expect(parseErrors()).toEqual(['bad.ts']);
    expect(parseErrors()).toEqual(['bad.ts']);
    expect(parseCacheStats().hits).toBe(4);
  });
});
