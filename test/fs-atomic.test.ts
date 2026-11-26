import * as fs from 'fs';

// Same module with renameSync wrapped, so one test can make the rename step fail.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, renameSync: jest.fn(actual.renameSync) };
});
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { removeStaleTemps, writeAtomic, writeError } from '../src/util/fsAtomic';

describe('writeAtomic (Phase 32 ED-1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-atomic-')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tmpFiles = (): string[] => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

  it.each([
    ['a 0755 file', 0o755],
    ['a 0600 file', 0o600],
  ])('writes %s and keeps its mode', (_label, mode) => {
    const file = path.join(dir, 'f.sh');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, mode);
    writeAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(mode);
    expect(tmpFiles()).toEqual([]);
  });

  it.each([
    ['a new file', undefined],
    ['an existing 0755 file', 0o755],
  ])('b646: an explicit mode 0600 wins for %s', (_label, existing) => {
    const file = path.join(dir, 'private.json');
    if (existing !== undefined) {
      fs.writeFileSync(file, 'old');
      fs.chmodSync(file, existing);
    }
    writeAtomic(file, 'new', { mode: 0o600 });
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(tmpFiles()).toEqual([]);
  });

  it('writes a new file with the mode of a plain write', () => {
    const plain = path.join(dir, 'plain.ts');
    fs.writeFileSync(plain, 'x');
    const file = path.join(dir, 'new.ts');
    writeAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(fs.statSync(plain).mode & 0o777);
  });

  it('writes through a symlink and keeps the link', () => {
    const real = path.join(dir, 'real.ts');
    const link = path.join(dir, 'link.ts');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    writeAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('new');
    expect(tmpFiles()).toEqual([]);
  });

  it('removes the temp file and keeps the old text when the rename fails', () => {
    const file = path.join(dir, 'f.ts');
    fs.writeFileSync(file, 'old');
    (fs.renameSync as jest.Mock).mockImplementationOnce(() => { throw new Error('rename boom'); });
    expect(() => writeAtomic(file, 'new')).toThrow('rename boom');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(tmpFiles()).toEqual([]);
  });
});

describe('removeStaleTemps (b725)', () => {
  let dir: string;
  let deadPid: number;
  beforeAll(() => {
    // A pid that just exited: the child ran and was waited for.
    deadPid = spawnSync(process.execPath, ['-e', '']).pid as number;
    expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-stale-')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const touch = (name: string): void => fs.writeFileSync(path.join(dir, name), 'half');
  const names = (): string[] => fs.readdirSync(dir).sort();

  it('removes a temp file whose writer is dead, also when writeAtomic writes the target', () => {
    const file = path.join(dir, 'board.json');
    touch(`board.json.${deadPid}.1700000000000.tmp`);
    expect(removeStaleTemps(file)).toBe(1);
    expect(names()).toEqual([]);

    touch(`board.json.${deadPid}.1700000000001.tmp`);
    writeAtomic(file, 'new');
    expect(names()).toEqual(['board.json']);
  });

  it('keeps the temp file of our own pid and of a live pid', () => {
    // pid 1 (init/launchd) is alive; kill(1, 0) gives EPERM unless run as root.
    const kept = [process.pid, process.ppid, 1].map((pid) => `board.json.${pid}.1700000000000.tmp`);
    for (const n of kept) touch(n);
    expect(removeStaleTemps(path.join(dir, 'board.json'))).toBe(0);
    expect(names()).toEqual([...kept].sort());
  });

  it('keeps a .tmp file of another name or another shape', () => {
    const kept = [
      `other.json.${deadPid}.1700000000000.tmp`,
      `xboard.json.${deadPid}.1700000000000.tmp`,
      `board.json.${deadPid}.tmp`,
      `board.json.abc.1700000000000.tmp`,
      `board.json.${deadPid}.1700000000000.tmp.bak`,
    ];
    for (const n of kept) touch(n);
    expect(removeStaleTemps(path.join(dir, 'board.json'))).toBe(0);
    expect(names()).toEqual([...kept].sort());
  });

  it('returns 0 and does not throw when the folder is missing', () => {
    expect(removeStaleTemps(path.join(dir, 'no-such-dir', 'board.json'))).toBe(0);
  });
});

describe('writeError (b723)', () => {
  const errno = (code: string | undefined, message: string): NodeJS.ErrnoException =>
    Object.assign(new Error(message), code === undefined ? {} : { code });

  it.each([
    ['EACCES', 'permission denied'],
    ['EPERM', 'permission denied'],
    ['EROFS', 'read-only file system'],
    ['ENOSPC', 'disk full'],
    ['ENOENT', 'folder does not exist'],
    ['EISDIR', "EISDIR: illegal operation on a directory, open '/x/a.c4.1.2.tmp'"],
    [undefined, 'rename boom'],
  ])('%s -> cannot write <target>: %s, code and cause kept', (code, reason) => {
    const raw = errno(code, code === 'EISDIR' || code === undefined ? reason : `${code}: raw, open '/x/a.c4.1.2.tmp'`);
    const err = writeError('/x/a.c4', raw) as NodeJS.ErrnoException & { cause?: unknown };
    expect(err.message).toBe(`cannot write /x/a.c4: ${reason}`);
    expect(err.code).toBe(code);
    expect(err.cause).toBe(raw);
  });

  (process.getuid?.() === 0 ? it.skip : it)('writeAtomic into a read-only folder names the file as given (a link stays the link), not the temp file', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ro-')));
    const real = path.join(dir, 'real.c4');
    const link = path.join(dir, 'link.c4');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => writeAtomic(link, 'new')).toThrow(expect.objectContaining({ message: `cannot write ${link}: permission denied`, code: 'EACCES' }));
      expect(fs.readFileSync(real, 'utf8')).toBe('old');
      expect(fs.readdirSync(dir).sort()).toEqual(['link.c4', 'real.c4']);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
