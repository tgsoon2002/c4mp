import { handlerExtensions } from '../languages';
import { compareSnapshots } from '../compare/index';
import { readerExtensions } from '../schema/readers';
import { watchRepo, watchRoots } from '../watch';
import { projectInputRoots } from './inputs';
import { openProject } from './project';
import { scanWithPlan } from './planScan';
import type { C4pmConfig, SnapshotDiff } from '../types';

/** What startWatch reports back; the caller decides what to print. */
export interface WatchCallbacks {
  /** Before each scan: no files for the initial snapshot, else the changed files that trigger the re-scan. */
  onScanStart?: (changed?: string[]) => void;
  /** After each re-scan: the diff from the previous snapshot to the new one. */
  onSnapshot: (diff: SnapshotDiff) => void;
  /** A re-scan (or onSnapshot) threw: watching goes on and the previous snapshot stays the base. */
  onError: (err: unknown) => void;
}

/**
 * Watch mode, the work behind `c4pm watch`: load the config, take the initial snapshot, watch the source files
 * of the configured languages and re-scan after each debounced change, handing the diff to onSnapshot.
 * Writes nothing. Throws when the config or the initial snapshot fails; returns the stop function.
 */
export function startWatch(
  repoRoot: string,
  cliConfig: Partial<C4pmConfig>,
  opts: { debounceMs: number } & WatchCallbacks,
): () => void {
  // the merged config (no anchor needed, no store): openProject reads it as loadConfig + configOptsFor did
  const { config } = openProject(repoRoot, cliConfig);

  // The handlers decide which extensions trigger a re-scan
  const extensions = handlerExtensions(config.languages);

  // quiet, write-free, without a plan
  const scan = () => scanWithPlan(repoRoot, config, undefined);

  opts.onScanStart?.();
  let prevSnapshot = scan();

  return watchRepo(repoRoot, {
    debounceMs: opts.debounceMs,
    ignore: config.ignore,
    languages: config.languages,
    extensions,
    onChange: (files) => {
      try {
        opts.onScanStart?.(files);
        const newSnapshot = scan();
        opts.onSnapshot(compareSnapshots(prevSnapshot, newSnapshot));
        prevSnapshot = newSnapshot;
      } catch (err) {
        opts.onError(err);
      }
    },
  });
}

/**
 * b679 (SV3): watch everything a page build reads (projectInputRoots: code and the storage readers' files, plan,
 * wireframes, board, s-items, config) and hand the debounced changed files to onChange (repo-relative inside the repo,
 * else absolute). No scan: the caller (the live model) rebuilds. Returns the stop function.
 */
export function startProjectWatch(
  repoRoot: string,
  config: C4pmConfig,
  opts: { debounceMs: number; onChange: (files: string[]) => void },
): () => void {
  return watchRoots(projectInputRoots(repoRoot, config, readerExtensions()), {
    repoRoot,
    debounceMs: opts.debounceMs,
    ignore: config.ignore,
    languages: config.languages,
    onChange: opts.onChange,
  });
}
