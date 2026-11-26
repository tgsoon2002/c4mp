import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { withFileLock, LockBusyError } from '../src/util/fileLock';
// tests that start a node child get the shared long timeout (macOS process-start stall, b621/b628)
import { SPAWN_TIMEOUT_MS } from './helpers/runCli';

describe('withFileLock', () => {
  let dir: string;
  let lock: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-lock-'));
    lock = path.join(dir, 'x.lock');
  });

  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A pid that no process has any more: a node that has already exited. */
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

  /** A live process that is not us (sleeps until killed in afterEach). */
  const livePid = (): number => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(c);
    return c.pid!;
  };

  /**
   * Another process that takes the lock (same `pid time` format), says "held" on stdout, and releases it 1 s later.
   * Resolves once it holds the lock; rejects with its exit code and stderr if it ends before that.
   */
  const startHolder = (): Promise<ChildProcess> =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', `
        const fs = require('fs');
        fs.writeFileSync(process.argv[1], process.pid + ' ' + Date.now(), { flag: 'wx' });
        process.stdout.write('held\\n');
        setTimeout(() => fs.unlinkSync(process.argv[1]), 1000);
      `, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(c);
      let out = '';
      let err = '';
      c.stdout!.on('data', (d) => { out += d; if (out.includes('held')) resolve(c); });
      c.stderr!.on('data', (d) => (err += d));
      c.on('error', reject);
      c.on('exit', (code) => { if (!out.includes('held')) reject(new Error(`holder exited ${code} before taking the lock: ${err}`)); });
    });

  it('takes the lock (our pid inside) for fn, returns its value and releases', () => {
    const value = withFileLock(lock, () => {
      expect(fs.readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${process.pid} \\d+$`));
      return 42;
    });
    expect(value).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases the lock when fn throws, and rethrows', () => {
    expect(() => withFileLock(lock, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a second taker waits for a holder (another process, ~1 s) and then gets the lock', async () => {
    await startHolder();
    expect(fs.readFileSync(lock, 'utf8')).not.toMatch(new RegExp(`^${process.pid} `));

    const start = Date.now();
    const text = withFileLock(lock, () => fs.readFileSync(lock, 'utf8'), { pollMs: 50, waitMs: 10_000 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(500);
    expect(text).toMatch(new RegExp(`^${process.pid} `));
    expect(fs.existsSync(lock)).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ['a dead pid', () => `${deadPid()} ${Date.now()}`, 0],
    ['a live pid older than maxAge', () => `${livePid()} ${Date.now() - 60 * 60_000}`, 0],
    ['an empty file older than maxAge (by mtime)', () => '', 60 * 60_000],
  ])('a stale lock (%s) is taken over', (_case, content, ageMs) => {
    fs.writeFileSync(lock, content());
    if (ageMs) {
      const old = (Date.now() - ageMs) / 1000;
      fs.utimesSync(lock, old, old);
    }
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { waitMs: 1000, pollMs: 20 });
    expect(ran).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ['another live holder', () => `${livePid()} ${Date.now()}`],
    ['an empty (just created) lock', () => ''],
  ])('busy past waitMs throws LockBusyError naming the file; the lock of %s is never deleted', (_case, content) => {
    const text = content();
    fs.writeFileSync(lock, text);
    let ran = false;
    let err: unknown;
    try {
      withFileLock(lock, () => { ran = true; }, { waitMs: 300, pollMs: 50 });
    } catch (e) {
      err = e;
    }
    expect(ran).toBe(false);
    expect(err).toBeInstanceOf(LockBusyError);
    expect((err as LockBusyError).code).toBe('ELOCKBUSY');
    expect((err as Error).message).toContain(lock);
    if (text) expect((err as LockBusyError).holderPid).toBe(Number(text.split(' ')[0]));
    expect(fs.readFileSync(lock, 'utf8')).toBe(text);
  }, SPAWN_TIMEOUT_MS);

  it('releases only its own lock: a lock replaced during fn is left in place', () => {
    const other = `${livePid()} ${Date.now()}`;
    withFileLock(lock, () => fs.writeFileSync(lock, other));
    expect(fs.readFileSync(lock, 'utf8')).toBe(other);
  }, SPAWN_TIMEOUT_MS);

  it('a file error other than "exists" is thrown unchanged', () => {
    expect(() => withFileLock(path.join(dir, 'no-such-dir', 'x.lock'), () => 1)).toThrow(/ENOENT/);
  });
});
