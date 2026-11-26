import * as path from 'path';
import { collectFindings } from '../check/collect';
import { todayIso } from '../util/dates';
import { parseFailures } from '../c4/check';
import { log } from '../log';
import { CMD_NAME, DATA_DIR } from '../constants';
import { legacyStoreDir } from '../util/userFiles';
import { openProject } from '../scan/project';
import { findPlan, scanWithPlan } from '../scan/planScan';
import { needsCallIndex } from '../sim/run';
import { listSnapshots } from '../scan/snapshots';
import type { C4pmConfig, Plan, Snapshot } from '../types';

/** P15-T7b2: what `c4pm status` computes, before any printing. */
export interface StatusResult {
  /** null when the snapshot could not be generated (printed as `Snapshot: failed to generate`). */
  snapshot: {
    name: string;
    containers: number;
    components: number;
    files: number;
    codeElements: number;
    componentEdges: number;
    unresolvedImports: number;
    /** Source files that did not parse cleanly (sorted); the count is its length. */
    parseFailures: string[];
  } | null;
  history: {
    count: number;
    /** commit is null when the entry has no git commit; date is YYYY-MM-DD. */
    latest: { commit: string | null; date: string } | null;
    /** true when a .c4pm anchor was found. */
    anchored: boolean;
    /**
     * Why the stored history could not be listed (e.g. a corrupt manifest: path and reason), else null.
     * When set, count 0 means "unreadable", not "none stored".
     */
    error: string | null;
  };
  /**
   * null = no .c4 files; 'error' = the plan could not be read or checked.
   * When `snapshot` is null the counts are 0 and mean "unable to check", not "no findings".
   */
  plan: { files: number; critical: number; warning: number; info: number } | null | 'error';
  config: { languages: string[]; ignore: string[] };
}

/**
 * Gather snapshot size, stored history, plan findings and effective config. Writes nothing.
 * The plan is parsed before the snapshot, so the snapshot is built with it (as `view` does).
 * Snapshot, history and plan failures are reported in the result (null / history.error / 'error'), not thrown;
 * only a config that cannot be loaded throws.
 */
export function runStatus(repoRoot: string, cli: Partial<C4pmConfig>): StatusResult {
  // Project & scan: the config (throws), the anchor and the store when one is known (set, or the anchor's default)
  const { config, project, store } = openProject(repoRoot, cli, { store: 'known' });

  let plan: Plan | undefined;
  let planDir: string | null = null;
  let planError = false;
  try {
    const found = findPlan(repoRoot, config);
    plan = found.plan;
    planDir = found.dir;
  } catch {
    planError = true;
  }

  let snap: Snapshot | null = null;
  let snapshot: StatusResult['snapshot'] = null;
  try {
    // T8 (Q6): every call when an s-item has a function -> function step pair, as check does, so the counts agree
    snap = scanWithPlan(repoRoot, config, plan, needsCallIndex(project, plan ?? null) ? { collectCalls: true } : {});
    const s = snap.stats;
    snapshot = {
      name: snap.meta.repoName,
      containers: s.containers,
      components: s.components,
      files: s.files,
      codeElements: s.codeElements,
      componentEdges: s.componentEdges,
      unresolvedImports: s.unresolvedImports,
      parseFailures: parseFailures(snap),
    };
  } catch {
    snapshot = null;
  }

  // Read-only: with no anchor and no store set, fall back to the legacy store instead of failing.
  const historyStore = store ?? legacyStoreDir();
  log('cli', 'status store', { store: historyStore, anchored: !!project });
  let count = 0;
  let latest: StatusResult['history']['latest'] = null;
  let historyError: string | null = null;
  try {
    const { entries } = listSnapshots(repoRoot, cli, { store: historyStore });
    count = entries.length;
    if (count > 0) {
      const last = entries[count - 1];
      latest = { commit: last.commit, date: (last.commitDate ?? last.createdAt).slice(0, 10) };
    }
  } catch (err) {
    // reported, not hidden: a corrupt manifest must not read as "no history"
    count = 0;
    latest = null;
    historyError = err instanceof Error ? err.message : String(err);
  }

  let planResult: StatusResult['plan'];
  try {
    if (planError) throw new Error('plan error');
    if (!plan) {
      planResult = null;
    } else if (snapshot) {
      // plan + board findings, the same collector as `check`, so the counts agree
      const findings = collectFindings(repoRoot, project, plan, snap as Snapshot, { sprint: config.sprint ?? undefined, today: todayIso(), planDir, config }).all;
      planResult = {
        files: plan.files.length,
        critical: findings.filter(f => f.severity === 'critical').length,
        warning: findings.filter(f => f.severity === 'warning').length,
        info: findings.filter(f => f.severity === 'info').length,
      };
    } else {
      planResult = { files: plan.files.length, critical: 0, warning: 0, info: 0 };
    }
  } catch {
    planResult = 'error';
  }

  return {
    snapshot,
    history: { count, latest, anchored: !!project, error: historyError },
    plan: planResult,
    config: { languages: config.languages, ignore: config.ignore },
  };
}

/** The lines `c4pm status` prints (Snapshot, History, Plan, Config; then Parse errors + file list when any file did not parse). */
export function formatStatusLines(r: StatusResult): string[] {
  const s = r.snapshot;
  const snapshotLine = s
    ? `Snapshot: ${s.name} — ${s.containers} containers, ${s.components} components, ${s.files} files, ${s.codeElements} code elements, ${s.componentEdges} component edges, ${s.unresolvedImports} unresolved imports`
    : 'Snapshot: failed to generate';

  const h = r.history;
  let historyLine: string;
  if (h.error !== null) {
    historyLine = `History: unreadable: ${h.error}`;
  } else if (h.count === 0 || !h.latest) {
    historyLine = h.anchored
      ? `History: none (run ${CMD_NAME} history)`
      : `History: none (no ${DATA_DIR} found; run ${CMD_NAME} init)`;
  } else {
    const sha7 = h.latest.commit ? h.latest.commit.slice(0, 7) : 'nogit';
    historyLine = `History: ${h.count} stored (latest ${sha7} ${h.latest.date})`;
  }

  const p = r.plan;
  let planLine: string;
  if (p === 'error') planLine = 'Plan: error reading';
  else if (p === null) planLine = 'Plan: none';
  else if (!s) planLine = `Plan: ${p.files} .c4 files, unable to check (snapshot failed)`;
  else planLine = `Plan: ${p.files} .c4 files, ${p.critical} critical, ${p.warning} warning, ${p.info} info`;

  const ignoreStr = r.config.ignore.length > 0 ? r.config.ignore.join(',') : '(none)';
  const configLine = `Config: languages=${r.config.languages.join(',')}, ignore=${ignoreStr}`;
  const lines = [snapshotLine, historyLine, planLine, configLine];
  if (s && s.parseFailures.length > 0) {
    lines.push(`Parse errors: ${s.parseFailures.length} files did not parse`);
    for (const f of s.parseFailures) lines.push(`  ${f}`);
  }
  return lines;
}
