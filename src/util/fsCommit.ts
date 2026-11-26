import * as fs from 'fs';
import { removeStaleTemps, writeAtomic, writeError } from './fsAtomic';
import { log } from '../log';

/** One file of a set: the exact text read (`before`, null = the file must not exist) and the text to leave (`after`, null = delete). */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/** `changed`: a file differed from its `before` (or was created meanwhile); nothing was written. `rolled-back`: every touched file got its old text back. */
export type CommitSetResult = { ok: true } | { ok: false; reason: 'changed' | 'rolled-back'; detail: string };

const TAG = 'fsCommit';
/** linkSync error codes of a file system that has no hard links. */
const NO_LINK_CODES = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];

/** The text of `file` now, or null when there is none. Other read errors are thrown. */
function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Why `file` (now `now`) is not as it was read (`before`). */
function changedText(file: string, before: string | null, now: string | null): string {
  if (before === null) return `${file} was created meanwhile`;
  if (now === null) return `${file} was removed meanwhile`;
  return `${file} changed since it was read`;
}

/**
 * Create `file` with `text` only when nothing is there: a temp file next to it (writeAtomic's name, so removeStaleTemps
 * cleans one a killed writer left), then `fs.linkSync`, which fails with EEXIST when another writer created the file
 * first. A file system without hard links gets an exclusive open (`wx`) instead. Returns false when the file exists;
 * any other error is thrown as writeError. The temp file is always removed.
 */
function createExclusive(file: string, text: string): boolean {
  removeStaleTemps(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const exists = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'EEXIST';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (exists(err)) return false;
      if (!NO_LINK_CODES.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      try {
        fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      } catch (err2) {
        if (exists(err2)) return false;
        throw err2;
      }
    }
    return true;
  } catch (err) {
    throw writeError(file, err as NodeJS.ErrnoException);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Give every touched file its old text back (or remove it when it was new), last first. Never throws; returns what failed. */
function restore(touched: FileChange[]): string[] {
  const failed: string[] = [];
  for (const f of [...touched].reverse()) {
    try {
      if (f.before === null) fs.rmSync(f.path, { force: true });
      else writeAtomic(f.path, f.before);
    } catch (err) {
      failed.push(`could not restore ${f.path}: ${(err as Error).message}`);
    }
  }
  return failed;
}

/**
 * Write, create or delete several files as one change (T2 b696; generic: any writer of several files can use it).
 * 1. Refuses before writing anything when a file on disk differs from its `before` (null = must not exist): `changed`.
 * 2. Writes: new files first, each created exclusively (temp + link; a file created meanwhile = `changed`), then every
 *    other file with writeAtomic, or deletes it (`after` null). A file whose `after` equals its `before` is only checked.
 * 3. Runs `verify(path, textOnDisk)` on every written file (null = good, else the problem).
 * On any failure after the first write, every touched file gets its old text back (a new file is removed):
 * `rolled-back` (a create race keeps `changed`). Directories are not created: the caller makes them. Two entries for
 * one path are a caller bug, and a file that cannot be read in step 1 is an error: both are thrown (nothing written).
 */
export function commitFileSet(files: FileChange[], verify: (file: string, text: string) => string | null): CommitSetResult {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`commitFileSet: ${f.path} is listed twice`);
    seen.add(f.path);
  }

  for (const f of files) {
    const now = readOrNull(f.path);
    if (now !== f.before) {
      log(TAG, 'refused', { path: f.path });
      return { ok: false, reason: 'changed', detail: changedText(f.path, f.before, now) };
    }
  }

  const writes = files.filter((f) => f.after !== f.before);
  const ordered = [...writes.filter((f) => f.before === null), ...writes.filter((f) => f.before !== null)];
  const touched: FileChange[] = [];
  const fail = (reason: 'changed' | 'rolled-back', detail: string): CommitSetResult => {
    const failed = restore(touched);
    log(TAG, 'rolled back', { files: touched.length, reason, restoreFailures: failed.length });
    return { ok: false, reason, detail: [detail, ...failed].join('; ') };
  };

  for (const f of ordered) {
    try {
      if (f.before === null) {
        if (!createExclusive(f.path, f.after as string)) return fail('changed', changedText(f.path, null, ''));
      } else if (f.after === null) {
        fs.rmSync(f.path);
      } else {
        writeAtomic(f.path, f.after);
      }
      touched.push(f);
    } catch (err) {
      return fail('rolled-back', (err as Error).message);
    }
  }

  for (const f of ordered) {
    if (f.after === null) continue;
    let problem: string | null;
    try {
      problem = verify(f.path, fs.readFileSync(f.path, 'utf8'));
    } catch (err) {
      problem = (err as Error).message;
    }
    if (problem !== null) return fail('rolled-back', `${f.path}: ${problem}`);
  }
  log(TAG, 'written', { files: ordered.length });
  return { ok: true };
}
