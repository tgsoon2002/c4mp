import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRepoIdentity } from '../history/meta';
import { runSnapshot } from '../pipeline';
import type { CollectCalls } from '../pipeline';
import { currentBranch, listCommits, exportCommit, commitInfo } from '../history/git';
import type { CommitInfo } from '../history/git';
import { loadManifest, saveToHistory, historyDir } from '../history/store';
import { toId } from '../names';
import { HistoryEntry, C4pmConfig } from '../types';
import { log } from '../log';
import { isAlive } from '../util/fileLock';

/**
 * Prefix of the per-commit export dirs in os.tmpdir(); the start-of-run sweep matches only this prefix.
 * b735: runHistory names them `c4pm-export-<pid>-XXXXXX` so the sweep can tell a killed run's dir at once.
 */
const EXPORT_PREFIX = 'c4pm-export-';
/** An export dir older than this was left by a killed run (a finished run removes its own). */
const STALE_EXPORT_MS = 24 * 60 * 60 * 1000;

export interface HistoryRunOptions {
  repo: string;
  store: string;
  /** Without refs: the newest `max` first-parent commits (default 20), as `c4pm history` lists them. */
  max?: number;
  since?: string;
  /**
   * Record exactly these commits (any ref git resolves: HEAD, a sha), in this order, instead of listing first-parent
   * commits (max / since are then unused). A ref that names no commit is skipped and counted; repeats are recorded once.
   */
  refs?: string[];
  /** Passed to runSnapshot: which files get their calls collected (the saved snapshot drops calls either way). */
  collectCalls?: CollectCalls;
  /** A commit that fails to record is thrown (after its temp dir is removed) instead of counted. */
  throwOnFail?: boolean;
  config?: Partial<C4pmConfig>;
  quiet?: boolean;
}

export function runHistory(opts: HistoryRunOptions): HistoryEntry[] {
  const { repo, store } = opts;
  const maxCommits = opts.max ?? 20;
  const since = opts.since;
  // quiet: no per-commit console output (used by git hooks). log('history', ...) prints only when C4PM_DEBUG
  // names 'history'; a hook's result goes to last-hook.txt in the data dir (runHook, src/hookRun.ts), its stdout
  // to /dev/null.
  const say = (line: string) => { if (!opts.quiet) console.log(line); };

  removeStaleExports();

  const base = readRepoIdentity(repo);
  const branch = currentBranch(repo);
  const picked = opts.refs ? commitsOfRefs(repo, opts.refs) : { commits: listCommits(repo, { max: maxCommits, since }), unresolved: 0 };
  const commits = picked.commits;
  const repoId = toId(base.repoName);
  const manifest = loadManifest(store, repoId);

  const newEntries: HistoryEntry[] = [];
  let alreadyStored = 0;
  let failed = 0;

  for (const commitInfo of commits) {
    const { commit, date, subject, depth } = commitInfo;
    const sha7 = commit.slice(0, 7);

    // Check if already in manifest
    const existing = manifest.entries.find(e => e.commit === commit);
    if (existing) {
      say(`= ${sha7} already in history`);
      alreadyStored++;
      continue;
    }

    let tmp: string | null = null;
    try {
      // Create temp dir
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${EXPORT_PREFIX}${process.pid}-`));

      // Export commit to temp dir
      exportCommit(repo, commit, tmp);

      // Run snapshot on temp dir with proper metadata
      const snapshot = runSnapshot({
        repo: tmp,
        write: false,
        quiet: true,
        meta: {
          repoPath: base.repoPath,
          repoName: base.repoName,
          git: {
            commit,
            branch: branch ?? 'unknown',
            date,
            depth
          }
        },
        config: opts.config,
        collectCalls: opts.collectCalls
      });

      // Save to history
      const entry = saveToHistory(store, snapshot);
      newEntries.push(entry);

      // Format subject (max 50 chars)
      const displaySubject = subject.length > 50 ? subject.slice(0, 47) + '...' : subject;
      const stats = snapshot.stats;
      say(`+ ${sha7} ${date.slice(0, 10)} ${displaySubject} · ${stats.components} components, ${stats.files} files, ${stats.codeElements} elements`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      say(`! ${sha7} failed: ${message}`);
      if (opts.throwOnFail) throw err;
    } finally {
      if (tmp) {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  const histDir = historyDir(store, repoId);
  const unresolvedNote = picked.unresolved > 0 ? `, ${picked.unresolved} unresolved` : '';
  say(`History: ${newEntries.length} new, ${alreadyStored} already stored, ${failed} failed${unresolvedNote} → ${histDir}`);

  log('history', 'runHistory complete', { new: newEntries.length, stored: alreadyStored, failed, unresolved: picked.unresolved });

  return newEntries;
}

/** The commits of explicit refs, in the given order, each once; refs that name no commit are counted, not listed. */
function commitsOfRefs(repo: string, refs: string[]): { commits: CommitInfo[]; unresolved: number } {
  const commits: CommitInfo[] = [];
  let unresolved = 0;
  for (const ref of refs) {
    const info = commitInfo(repo, ref);
    if (!info) {
      unresolved++;
      log('history', 'ref names no commit, skipped', { ref });
      continue;
    }
    if (!commits.some(c => c.commit === info.commit)) commits.push(info);
  }
  return { commits, unresolved };
}

/**
 * Remove export dirs (os.tmpdir()/c4pm-export-*) older than 24 h by mtime: a killed run cannot remove its own
 * (no signal handler: runHistory is synchronous, a JS handler would only delay the kill). Other names, also older
 * `c4pm-*` dirs from before this prefix, are never touched. A dir that vanishes meanwhile is fine; other errors throw.
 * b735: a `c4pm-export-<pid>-XXXXXX` dir is also removed at once when that pid is not ours and not running
 * (isAlive false); a live pid, or a kill error other than ESRCH, leaves it to the 24 h rule.
 * @internal exported for test/history-exports.test.ts.
 */
export function removeStaleExports(): void {
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(tmpRoot)) {
    if (!name.startsWith(EXPORT_PREFIX)) continue;
    const dir = path.join(tmpRoot, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isDirectory()) continue;
    const m = /^(\d+)-/.exec(name.slice(EXPORT_PREFIX.length));
    let ownerDead = false;
    if (m && Number(m[1]) !== process.pid) {
      try {
        ownerDead = !isAlive(Number(m[1]));
      } catch {
        ownerDead = false;   // unknown: keep, the 24 h rule still applies
      }
    }
    if (!ownerDead && now - st.mtimeMs <= STALE_EXPORT_MS) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  if (removed > 0) log('history', 'removed stale export dirs', { tmpRoot, removed });
}
