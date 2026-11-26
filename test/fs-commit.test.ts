import * as fs from 'fs';

// Same module with linkSync and renameSync wrapped, so a test can race a create or make one write fail.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, linkSync: jest.fn(actual.linkSync), renameSync: jest.fn(actual.renameSync) };
});
import * as os from 'os';
import * as path from 'path';
import { commitFileSet, type FileChange } from '../src/util/fsCommit';
import { listing } from './helpers/planEditHarness';

const actualFs = jest.requireActual('fs') as typeof fs;
const linkMock = fs.linkSync as unknown as jest.Mock;
const renameMock = fs.renameSync as unknown as jest.Mock;

describe('commitFileSet (T2 b696)', () => {
  let dir: string;
  const p = (name: string): string => path.join(dir, name);
  const read = (name: string): string | null => (fs.existsSync(p(name)) ? fs.readFileSync(p(name), 'utf8') : null);
  const ok = (): null => null;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-commit-')));
    fs.writeFileSync(p('a.txt'), 'a0');
    fs.writeFileSync(p('b.txt'), 'b0');
  });
  afterEach(() => {
    linkMock.mockImplementation(actualFs.linkSync);
    renameMock.mockImplementation(actualFs.renameSync);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes, creates and deletes in one set; verify sees each written text; no temp file is left', () => {
    const seen: string[] = [];
    const r = commitFileSet([
      { path: p('a.txt'), before: 'a0', after: 'a1' },
      { path: p('c.txt'), before: null, after: 'c1' },
      { path: p('b.txt'), before: 'b0', after: null },
    ], (file, text) => { seen.push(`${path.basename(file)}=${text}`); return null; });
    expect(r).toEqual({ ok: true });
    expect([read('a.txt'), read('b.txt'), read('c.txt')]).toEqual(['a1', null, 'c1']);
    expect(seen).toEqual(['c.txt=c1', 'a.txt=a1']);   // new files first; a delete is not verified
    expect(listing(dir)).toEqual(['a.txt:2', 'c.txt:2']);
  });

  it.each([
    ['a file changed since it was read', { path: 'a.txt', before: 'OLD', after: 'x' }, /a\.txt changed since it was read$/],
    ['a new file was created meanwhile', { path: 'a.txt', before: null, after: 'x' }, /a\.txt was created meanwhile$/],
    ['a file was removed meanwhile', { path: 'gone.txt', before: 'g0', after: 'x' }, /gone\.txt was removed meanwhile$/],
  ])('%s: refused before anything is written', (_label, change, detail) => {
    const before = listing(dir);
    const r = commitFileSet([
      { path: p('c.txt'), before: null, after: 'c1' },
      { path: p('b.txt'), before: 'b0', after: 'b1' },
      { ...change, path: p(change.path) },
    ], ok);
    expect(r).toMatchObject({ ok: false, reason: 'changed' });
    expect(r.ok ? '' : r.detail).toMatch(detail);
    expect(listing(dir)).toEqual(before);
    expect(read('b.txt')).toBe('b0');
  });

  it('an entry whose after equals before is only checked: not written, but a change to it refuses the set', () => {
    const mtime = fs.statSync(p('a.txt')).mtimeMs;
    expect(commitFileSet([{ path: p('a.txt'), before: 'a0', after: 'a0' }, { path: p('b.txt'), before: 'b0', after: 'b1' }], ok)).toEqual({ ok: true });
    expect(fs.statSync(p('a.txt')).mtimeMs).toBe(mtime);
    const r = commitFileSet([{ path: p('a.txt'), before: 'zz', after: 'zz' }, { path: p('b.txt'), before: 'b1', after: 'b2' }], ok);
    expect(r).toMatchObject({ ok: false, reason: 'changed' });
    expect(read('b.txt')).toBe('b1');
  });

  it('exclusive create race: another writer creates the file between the check and the link; the earlier create is undone', () => {
    linkMock.mockImplementation((src: fs.PathLike, dest: fs.PathLike) => {
      if (String(dest).endsWith('e.txt')) actualFs.writeFileSync(dest, 'theirs');   // the other agent wins
      return actualFs.linkSync(src, dest);
    });
    const r = commitFileSet([
      { path: p('d.txt'), before: null, after: 'd1' },
      { path: p('e.txt'), before: null, after: 'mine' },
      { path: p('a.txt'), before: 'a0', after: 'a1' },
    ], ok);
    expect(r).toEqual({ ok: false, reason: 'changed', detail: `${p('e.txt')} was created meanwhile` });
    expect([read('d.txt'), read('e.txt'), read('a.txt')]).toEqual([null, 'theirs', 'a0']);
    expect(listing(dir)).toEqual(['a.txt:2', 'b.txt:2', 'e.txt:6']);
  });

  it('a file system without hard links: the new file is still created exclusively', () => {
    linkMock.mockImplementation(() => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); });
    expect(commitFileSet([{ path: p('c.txt'), before: null, after: 'c1' }], ok)).toEqual({ ok: true });
    expect(read('c.txt')).toBe('c1');
    expect(listing(dir)).toEqual(['a.txt:2', 'b.txt:2', 'c.txt:2']);
  });

  it('verify fails on one file: every touched file gets its old text back (new removed, deleted restored)', () => {
    const before = listing(dir);
    const r = commitFileSet([
      { path: p('a.txt'), before: 'a0', after: 'a1' },
      { path: p('b.txt'), before: 'b0', after: null },
      { path: p('c.txt'), before: null, after: 'c1' },
      { path: p('d.txt'), before: null, after: 'bad' },
    ], (_file, text) => (text === 'bad' ? 'not good' : null));
    expect(r).toEqual({ ok: false, reason: 'rolled-back', detail: `${p('d.txt')}: not good` });
    expect(listing(dir)).toEqual(before);
    expect([read('a.txt'), read('b.txt')]).toEqual(['a0', 'b0']);
  });

  it('a write that fails half way: the files already written are restored, the error is the detail', () => {
    renameMock.mockImplementation((src: fs.PathLike, dest: fs.PathLike) => {
      if (String(dest).endsWith('b.txt')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actualFs.renameSync(src, dest);
    });
    const r = commitFileSet([
      { path: p('a.txt'), before: 'a0', after: 'a1' },
      { path: p('b.txt'), before: 'b0', after: 'b1' },
    ], ok);
    expect(r).toEqual({ ok: false, reason: 'rolled-back', detail: `cannot write ${p('b.txt')}: permission denied` });
    expect([read('a.txt'), read('b.txt')]).toEqual(['a0', 'b0']);
    expect(listing(dir)).toEqual(['a.txt:2', 'b.txt:2']);
  });

  it('a path listed twice is a caller bug: thrown, nothing written', () => {
    const twice: FileChange[] = [{ path: p('a.txt'), before: 'a0', after: 'a1' }, { path: p('a.txt'), before: 'a0', after: 'a2' }];
    expect(() => commitFileSet(twice, ok)).toThrow(/listed twice/);
    expect(read('a.txt')).toBe('a0');
  });
});
