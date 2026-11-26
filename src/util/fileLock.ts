import * as fs from 'fs';

/** Options of withFileLock: how long to wait for a held lock, when a lock is stale, how often to look again. */
export interface FileLockOptions {
  /** Give up after this long and throw LockBusyError (default 10 min). */
  waitMs?: number;
  /** A lock older than this is stale, whoever holds it (default 30 min; guards against a reused pid). */
  maxAgeMs?: number;
  /** Sleep between two tries (default 200 ms). */
  pollMs?: number;
}

/** The lock stayed held by another live holder for the whole wait. `code` is 'ELOCKBUSY'. */
export class LockBusyError extends Error {
  readonly code = 'ELOCKBUSY';
  constructor(
    readonly lockFile: string,
    /** The holder's pid, or null when the lock file is empty or not in the `pid time` form. */
    readonly holderPid: number | null,
    waitedMs: number,
  ) {
    super(`lock ${lockFile} is held by ${holderPid === null ? 'an unknown holder (empty lock file)' : `pid ${holderPid}`}; waited ${waitedMs} ms`);
    this.name = 'LockBusyError';
  }
}

/** What a lock file held when it was looked at: its text (null = could not be read) and its mtime. */
interface Seen {
  text: string | null;
  mtimeMs: number;
}

/**
 * Run `fn` while holding the exclusive lock file `lockFile`, then release it; returns what `fn` returns.
 * Synchronous: every caller is (waits sleep with Atomics.wait). Not re-entrant: the same process taking the same
 * lock again waits for itself until waitMs.
 *
 * Take: create the file with 'wx' (fails when it exists) and write `<pid> <time ms>` into it.
 * When it exists, the holder is read: the lock is stale when that pid is dead (`process.kill(pid, 0)` gives ESRCH;
 * EPERM means alive) or the time is older than maxAgeMs. An empty or unreadable lock (its creator may not have
 * written yet) counts as held until its mtime is older than maxAgeMs. A stale lock is removed only if it still holds
 * what was read (re-read right before unlink), then the take is tried again. A held lock is polled every pollMs
 * until waitMs, then LockBusyError (names the file and the holder pid).
 * Two waiters breaking the same stale lock: the content check keeps one from removing the lock the other just took,
 * except in the moment between that check and the unlink (accepted; local filesystems only, 'wx' is not safe on
 * network mounts). `fn` runs in try/finally; the lock is removed after it only if it still holds our own content.
 * Any other file error is thrown unchanged.
 */
export function withFileLock<T>(lockFile: string, fn: () => T, opts: FileLockOptions = {}): T {
  const waitMs = opts.waitMs ?? 10 * 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 200;
  const own = `${process.pid} ${Date.now()}`;
  const start = Date.now();

  while (!tryCreate(lockFile, own)) {
    const seen = look(lockFile);
    if (!seen) continue; // released between our create and our read: try again at once
    if (isStale(seen, maxAgeMs)) {
      const again = look(lockFile);
      if (again && again.text === seen.text && again.mtimeMs === seen.mtimeMs) removeIfPresent(lockFile);
      continue;
    }
    const waited = Date.now() - start;
    if (waited >= waitMs) throw new LockBusyError(lockFile, holderOf(seen.text)?.pid ?? null, waited);
    sleep(Math.min(pollMs, waitMs - waited));
  }

  try {
    return fn();
  } finally {
    const now = look(lockFile);
    if (now && now.text === own) removeIfPresent(lockFile);
  }
}

/** Create the lock with our content; false when it already exists. A failed write removes the half-made lock. */
function tryCreate(lockFile: string, own: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, own);
  } catch (err) {
    fs.closeSync(fd);
    removeIfPresent(lockFile);
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/** The lock's mtime and text; null when there is no lock file. A text that cannot be read is null (held until maxAge). */
function look(lockFile: string): Seen | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockFile).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return { text: fs.readFileSync(lockFile, 'utf8'), mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { text: null, mtimeMs };
  }
}

/** `<pid> <time ms>` from a lock's text; null when the text is missing, empty or in another form. */
function holderOf(text: string | null): { pid: number; time: number } | null {
  const m = text === null ? null : /^(\d+) (\d+)$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  return pid > 0 ? { pid, time: Number(m[2]) } : null;
}

function isStale(seen: Seen, maxAgeMs: number): boolean {
  const holder = holderOf(seen.text);
  if (!holder) return Date.now() - seen.mtimeMs > maxAgeMs;
  return Date.now() - holder.time > maxAgeMs || !isAlive(holder.pid);
}

/** Whether a process with this pid exists: ESRCH = no, EPERM = yes (another user's); any other error is thrown. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

function removeIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Block this thread for `ms` (no busy loop). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}
