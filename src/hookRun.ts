import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';
import { CMD_NAME } from './constants';
import { hookRefs, prepareHookDataDir, recordCommit } from './scan/commit';
import type { CommitRecord } from './scan/commit';
import { writeProjectView } from './page/viewExport';
import { withFileLock, LockBusyError } from './util/fileLock';
import { writeAtomic } from './util/fsAtomic';

/** How long a hook waits for the one before it (same project) before it gives up with 'skipped: busy'. */
const HOOK_LOCK_WAIT_MS = 10 * 60_000;
/** b629 (rule B): a live hook keeps its lock this long; the age test only guards against a reused or hung pid. */
const HOOK_LOCK_MAX_AGE_MS = 6 * 60 * 60_000;
/** last-hook.txt keeps this many lines, newest last. */
const HOOK_LOG_LINES = 20;

export interface HookOpts {
  store?: string;
  lockWaitMs?: number;
  /** HEAD sha the hook block read when git fired the hook (`--head`); absent for blocks installed before 0.8.0. */
  head?: string;
  /** ORIG_HEAD sha the post-merge block read (`--orig-head`); absent when git had none, or for old blocks. */
  origHead?: string;
}

type HookShas = { head: string | null; origHead: string | null };

/** A full commit sha as `git rev-parse --verify` prints it. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * HEAD and ORIG_HEAD for this run. The hook block (0.8.0 on) reads them in the foreground and passes them, so a
 * hook whose node start is slow still records its own commit. A passed value that is not a 40-hex sha is ignored
 * (logged) and read late with hookRefs, as are both when nothing was passed (a block installed before 0.8.0).
 * post-merge: a valid --head without --orig-head means the block found no ORIG_HEAD, so none is read late
 * (a later git command may have written one since). post-commit never needs ORIG_HEAD.
 */
function hookShas(kind: 'post-commit' | 'post-merge', repoRoot: string, opts: HookOpts): HookShas {
  if (opts.head === undefined && opts.origHead === undefined) return hookRefs(repoRoot);
  const head = passedSha('--head', opts.head);
  const origHead = kind === 'post-merge' ? passedSha('--orig-head', opts.origHead) : null;
  const origKnown = kind === 'post-commit' || origHead !== null || (head !== null && opts.origHead === undefined);
  if (head !== null && origKnown) return { head, origHead };
  const late = hookRefs(repoRoot);
  log('hook', 'shas read late', { kind, head: late.head, origHead: late.origHead });
  return { head: head ?? late.head, origHead: origKnown ? origHead : late.origHead };
}

/** The passed sha when it is a full sha; null (logged) when absent or malformed. */
function passedSha(flag: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (SHA_RE.test(value)) return value;
  log('hook', 'ignored a malformed sha', { flag, value });
  return null;
}

/** The fields of one last-hook.txt line; '-' where the run did not get that far. */
interface HookLine {
  kind: string;
  head: string;
  refs: string;
  drift: string;
  page: string;
  result: string;
}

/**
 * Logic behind `c4pm hook <kind>` (what the git hooks run in the background).
 * NEVER throws: a failing hook must never block git. Steps: capture HEAD and ORIG_HEAD (before any wait), find the
 * project (no anchor: return, nothing created), then run inside `<dataDir>/hook.lock` (one hook per project at a
 * time; waits up to 10 min, then 'skipped: busy'): Project & scan records the commit (recordCommit), Page build
 * writes the page. Every run with a project appends one line to `<dataDir>/last-hook.txt` (last 20 kept):
 * start, kind, head, refs recorded, drift, page, seconds, peak memory, result ('ok' / 'skipped: busy' / 'failed: msg').
 * opts.lockWaitMs: how long to wait for the lock (default 10 min; tests use a short one).
 * opts.head / opts.origHead: the shas the hook block read when git fired the hook (see hookShas).
 */
export function runHook(kind: string, repoRoot: string, opts: HookOpts = {}): void {
  const startMs = Date.now();
  log('hook', 'start', { kind, repoRoot, opts });
  try {
    if (kind !== 'post-commit' && kind !== 'post-merge') {
      log('hook', 'unknown kind, nothing to do', { kind });
      return;
    }
    // first thing, before waiting for the lock: a queued hook must record the state git had when it fired
    let refs: HookShas | null = null;
    let refsError: unknown = null;
    try {
      refs = hookShas(kind, repoRoot, opts);
    } catch (err) {
      refsError = err; // reported in last-hook.txt below once the project is known
    }

    const dataDir = prepareHookDataDir(repoRoot);
    if (!dataDir) {
      log('hook', 'no anchor, silent no-op', { repoRoot });
      return;
    }

    const line: HookLine = { kind, head: refs?.head?.slice(0, 7) ?? '-', refs: '-', drift: '-', page: '-', result: 'ok' };
    const finish = () => appendHookLine(path.join(dataDir, 'last-hook.txt'), startMs, line);
    try {
      withFileLock(path.join(dataDir, 'hook.lock'), () => {
        try {
          if (refsError) throw refsError;
          runLocked(kind, repoRoot, opts, refs, line);
        } catch (err) {
          line.result = `failed: ${messageOf(err)}`;
          log('hook', 'failed', { kind, repoRoot, error: messageOf(err) });
        } finally {
          finish(); // inside the lock: two hooks never write the file at once
        }
      }, { waitMs: opts.lockWaitMs ?? HOOK_LOCK_WAIT_MS, maxAgeMs: HOOK_LOCK_MAX_AGE_MS });
    } catch (err) {
      // the lock itself: held past the wait, or the lock file could not be made
      line.result = err instanceof LockBusyError ? 'skipped: busy' : `failed: ${messageOf(err)}`;
      log('hook', 'not run', { kind, repoRoot, result: line.result });
      finish();
    }
  } catch (err) {
    log('hook', 'failed (swallowed)', { kind, repoRoot, error: messageOf(err) });
  }
}

/** The hook's work while holding the lock; fills `line` as it goes. Throws like the work it does. */
function runLocked(
  kind: 'post-commit' | 'post-merge',
  repoRoot: string,
  opts: { store?: string },
  refs: { head: string | null; origHead: string | null } | null,
  line: HookLine,
): void {
  const record = recordCommit(repoRoot, kind, {
    store: opts.store,
    head: refs?.head ?? undefined,
    origHead: refs?.origHead ?? undefined,
  });
  if (!record) {
    // the anchor was there a moment ago (prepareHookDataDir): it went away while this hook waited
    throw new Error('project anchor disappeared');
  }
  line.refs = record.recorded.length > 0 ? record.recorded.map(c => c.slice(0, 7)).join(' ') : 'none';
  line.drift = driftText(kind, record);

  if (record.drift) {
    const drift = record.drift;
    log('hook', 'drift written', drift);
    if (process.stdout.isTTY) {
      console.log(`${CMD_NAME}: ${drift.changes} warning+ changes since before the merge; details in ${drift.file}`);
    }
  } else if (record.driftError !== undefined) {
    log('hook', 'merge diff failed', { error: record.driftError });
  }

  if (record.viewOnCommit) {
    const outFile = writeProjectView(repoRoot, { store: opts.store });
    line.page = 'written';
    log('hook', 'page refreshed', { outFile, projectDir: record.projectDir });
  } else {
    line.page = 'off';
    log('hook', 'viewOnCommit is false, page not refreshed');
  }
}

function driftText(kind: string, record: CommitRecord): string {
  if (kind !== 'post-merge') return 'skipped: not a merge';
  if (record.drift) return `${record.drift.changes} changes`;
  if (record.driftError !== undefined) return `error: ${oneLine(record.driftError)}`;
  return `skipped: ${record.driftSkipped ?? 'unknown'}`;
}

/**
 * Append one line to last-hook.txt, keeping the newest HOOK_LOG_LINES, written atomically. Columns:
 * start (ISO) | kind | head sha7 | refs recorded | drift | page | seconds | peak memory | result.
 */
function appendHookLine(file: string, startMs: number, line: HookLine): void {
  const seconds = ((Date.now() - startMs) / 1000).toFixed(1);
  const text = [
    new Date(startMs).toISOString(),
    line.kind,
    `head ${line.head}`,
    `refs ${line.refs}`,
    `drift ${line.drift}`,
    `page ${line.page}`,
    `${seconds} s`,
    // b640: resourceUsage().maxRSS, labelled as such: on macOS it leaves out compressed and swapped pages,
    // so Activity Monitor's footprint can be higher.
    `maxRSS ${peakMemoryMb()} MB`,
    oneLine(line.result),
  ].join(' | ');
  const old = readLines(file);
  writeAtomic(file, [...old, text].slice(-HOOK_LOG_LINES).join('\n') + '\n');
  log('hook', 'last-hook.txt', { file, line: text });
}

/** The lines of a text file; none when it does not exist yet. */
function readLines(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter(l => l.length > 0);
}

/** Peak resident memory of this process in MB: resourceUsage().maxRSS (KB on node), else the current rss. */
function peakMemoryMb(): number {
  const maxRssKb = typeof process.resourceUsage === 'function' ? process.resourceUsage().maxRSS : 0;
  const bytes = maxRssKb > 0 ? maxRssKb * 1024 : process.memoryUsage().rss;
  return Math.round(bytes / (1024 * 1024));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
