import * as fs from 'fs';
import * as path from 'path';
import { isAlive } from './fileLock';

/**
 * Write `text` to `file` through a temp file in the same directory, then rename (rename is atomic on one volume).
 * A failed or killed write leaves the old file whole. The temp file is removed on failure; the error is thrown as
 * writeError (b723: `cannot write <file>: permission denied`, naming `file` as given, with the fs code).
 * Phase 32 (ED-1): an existing file keeps its mode (a 0755 script stays executable), and a symlink stays a link:
 * the file it points to is written.
 * b725: a temp file that a killed writer left next to the target is removed first (removeStaleTemps).
 */
export function writeAtomic(file: string, text: string, opts: { mode?: number } = {}): void {
  let target = file;
  let mode: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    // A new file (or a dangling link, which realpath refuses): written as a plain new file.
    target = file;
  }
  removeStaleTemps(target);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: opts.mode ?? 0o666 });
    const m = opts.mode ?? mode;   // b646: an explicit mode wins over the kept one
    if (m !== undefined) fs.chmodSync(tmp, m);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw writeError(file, err as NodeJS.ErrnoException);
  }
}

/**
 * b725: remove the temp files of writeAtomic that a killed writer left next to `target`: entries named exactly
 * `<basename(target)>.<pid>.<ms>.tmp` whose pid is not running (isAlive: ESRCH) and is not ours.
 * A live pid (or EPERM: running, owned by another user, or any other kill error) keeps its file. Returns how many
 * were removed; never throws.
 */
export function removeStaleTemps(target: string): number {
  try {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.`;
    let removed = 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix)) continue;
      const m = /^(\d+)\.\d+\.tmp$/.exec(entry.slice(prefix.length));
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      try {
        if (isAlive(pid)) continue;   // EPERM counts as alive: another user's
      } catch {
        continue;   // unknown: keep
      }
      fs.rmSync(path.join(dir, entry), { force: true });
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** b723: the reason text of a write failure, by fs error code (anything else keeps the raw message). */
const WRITE_REASONS: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EROFS: 'read-only file system',
  ENOSPC: 'disk full',
  ENOENT: 'folder does not exist',
};

/**
 * b723: the error of a failed write of `target`, for people: `cannot write <target>: permission denied` instead of the
 * raw fs message, which names the temp file. The fs `code` is copied (callers can still test it) and `cause` is the raw error.
 */
export function writeError(target: string, err: NodeJS.ErrnoException): Error {
  const reason = (err.code !== undefined ? WRITE_REASONS[err.code] : undefined) ?? err.message;
  const out = new Error(`cannot write ${target}: ${reason}`) as NodeJS.ErrnoException & { cause?: unknown };
  if (err.code !== undefined) out.code = err.code;
  out.cause = err;
  return out;
}
