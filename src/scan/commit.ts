import * as fs from 'fs';
import * as path from 'path';
import { runHistory } from './historyRun';
import { loadManifest, loadFromHistory, resolveRef } from '../history/store';
import { commitInfo } from '../history/git';
import { compareSnapshots, formatText } from '../compare/index';
import { toId } from '../names';
import { readRepoIdentity } from '../history/meta';
import { ensureInternalDirFor, tryResolveProject } from '../outputs';
import { openProject } from './project';
import type { ProjectPaths } from '../types';

/**
 * The git events the hooks record: one commit (HEAD), or a merge or pull (its result HEAD, plus the state before it,
 * ORIG_HEAD, when that is not stored yet, and the drift before -> after).
 */
export type CommitKind = 'post-commit' | 'post-merge';

/** What the hook needs back from recordCommit to log, print and decide on the page refresh. */
export interface CommitRecord {
  projectDir: string;
  viewOnCommit: boolean;
  /** The commits this run added to the history (full shas, oldest ref first); empty when all were stored already. */
  recorded: string[];
  /** post-merge only: the drift file written and its count of warning+ changes. */
  drift?: { file: string; changes: number };
  /** post-merge only: why the merge diff could not be written (history is still recorded). */
  driftError?: string;
  /** post-merge only: why no drift was computed ('no ORIG_HEAD', 'nothing changed'); no drift file is written. */
  driftSkipped?: string;
}

export interface RecordCommitOptions {
  store?: string;
  /** The HEAD sha the hook captured at its start (default: HEAD read now). */
  head?: string;
  /** post-merge: the ORIG_HEAD sha (state before the merge or pull) the hook captured; absent = there was none. */
  origHead?: string;
}

/**
 * Record history for a git commit or merge, the work behind the git hooks. Opens the project, loads its config and
 * records the final state only (`c4pm history` stays the full timeline): post-commit stores HEAD; post-merge stores
 * ORIG_HEAD (when not stored yet) and HEAD, then writes the drift ORIG_HEAD -> HEAD (by commit) to last-drift.txt.
 * Scans collect the calls of test files, so the page build after it reuses them from the parse cache.
 * Returns null when no anchor (.c4pm / .git) exists. Throws like the work it does (a commit that fails to record
 * included); the caller decides what a failure means (the hook writes it to last-hook.txt).
 */
export function recordCommit(repoRoot: string, kind: CommitKind, opts: RecordCommitOptions = {}): CommitRecord | null {
  // no anchor: the hook has nothing to record (checked before the config is read, so it never throws for it)
  if (!tryResolveProject(repoRoot)) return null;
  const { config, project, store } = openProject(repoRoot, opts.store ? { store: opts.store } : {}, {
    store: 'required',
    create: true,
    requireAnchor: true,
  });

  const head = opts.head ?? 'HEAD';
  const refs = kind === 'post-merge' && opts.origHead ? [opts.origHead, head] : [head];
  const entries = runHistory({ repo: repoRoot, store, refs, collectCalls: 'tests', throwOnFail: true, config, quiet: true });

  const record: CommitRecord = {
    projectDir: project.projectDir,
    viewOnCommit: config.viewOnCommit,
    recorded: entries.map(e => e.commit).filter((c): c is string => c !== null),
  };
  if (kind === 'post-merge') {
    const headSha = opts.head ?? commitInfo(repoRoot, 'HEAD')?.commit;
    if (!opts.origHead) {
      record.driftSkipped = 'no ORIG_HEAD';
    } else if (opts.origHead === headSha) {
      record.driftSkipped = 'nothing changed';
    } else {
      // a failing merge diff must not stop the page refresh: report it, keep going
      try {
        record.drift = writeMergeDiff(repoRoot, store, project, opts.origHead, headSha ?? head);
      } catch (err) {
        record.driftError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return record;
}

/**
 * Diff before -> after (two stored commits, found by sha), warning and above, saved as text in the project's data dir
 * (not printed: git discards hook stdout).
 */
function writeMergeDiff(repoRoot: string, store: string, project: ProjectPaths, before: string, after: string): { file: string; changes: number } {
  const repoId = toId(readRepoIdentity(repoRoot).repoName);
  const manifest = loadManifest(store, repoId);
  const fromEntry = resolveRef(manifest, before);
  const toEntry = resolveRef(manifest, after);
  const diff = compareSnapshots(loadFromHistory(store, repoId, fromEntry), loadFromHistory(store, repoId, toEntry));
  diff.changes = diff.changes.filter(c => c.severity === 'warning' || c.severity === 'critical');
  const file = path.join(project.dataDir, 'last-drift.txt');
  ensureInternalDirFor(project, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatText(diff) + '\n');
  return { file, changes: diff.changes.length };
}

/**
 * HEAD and ORIG_HEAD shas right now (null when the ref names no commit), for the hook to capture first thing:
 * a hook that waits for the lock must still record the state git had when it fired. Best effort: ORIG_HEAD is
 * one file the next merge, reset or rebase overwrites. Not a git repository: throws.
 */
export function hookRefs(repoRoot: string): { head: string | null; origHead: string | null } {
  return {
    head: commitInfo(repoRoot, 'HEAD')?.commit ?? null,
    origHead: commitInfo(repoRoot, 'ORIG_HEAD')?.commit ?? null,
  };
}

/**
 * The project's data dir (where hook.lock, last-hook.txt and last-drift.txt live; the same dir recordCommit
 * writes last-drift.txt in), created with .c4pm/.gitignore in place so git status stays clean.
 * null when no anchor exists: then nothing is created.
 */
export function prepareHookDataDir(repoRoot: string): string | null {
  const project = tryResolveProject(repoRoot);
  if (!project) return null;
  ensureInternalDirFor(project, project.dataDir);
  fs.mkdirSync(project.dataDir, { recursive: true });
  return project.dataDir;
}
