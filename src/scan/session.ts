import * as crypto from 'crypto';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../config';
import { CollectCalls, ScanCore, scanCore, snapshotFromCore } from '../pipeline';
import { C4pmConfig, Plan, Snapshot } from '../types';

export interface ScanSessionOptions {
  collectCalls?: CollectCalls;   // true = every file, 'tests' = role-test files only (Phase 26)
  // TODO(MCP/watch): fingerprint option (src/scan/fingerprint.ts) for cache invalidation; one-shot CLI needs none.
}

/**
 * One scan of a repo, shared by everything a command does. The plan independent work (core) runs once;
 * snapshots per plan are memoised. The session is an explicit object, not global state. It never
 * invalidates itself: open a new one when files may have changed (scan/historyRun.ts must not reuse one).
 */
export interface ScanSession {
  core(): ScanCore;
  snapshotFor(plan?: Plan): Snapshot;
  // TODO(STOR-2): storage(plan: Plan): StorageState
}

/** Memo key: hash of the plan's content; no plan is its own key. */
export function planKey(plan?: Plan): string {
  return plan ? crypto.createHash('sha1').update(JSON.stringify(plan)).digest('hex') : 'none';
}

export function openScanSession(repoRoot: string, config: Partial<C4pmConfig> = {}, opts: ScanSessionOptions = {}): ScanSession {
  const root = path.resolve(repoRoot);
  const full: C4pmConfig = { ...DEFAULT_CONFIG, ...config };
  let cached: ScanCore | undefined;
  const snapshots = new Map<string, Snapshot>();

  const core = (): ScanCore => (cached ??= scanCore(root, full, { collectCalls: opts.collectCalls }));

  return {
    core,
    snapshotFor(plan?: Plan): Snapshot {
      const key = planKey(plan);
      let snap = snapshots.get(key);
      if (!snap) {
        snap = snapshotFromCore(core(), plan);
        snapshots.set(key, snap);
      }
      return snap;
    },
  };
}
