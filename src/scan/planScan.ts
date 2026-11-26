import { parsePlan } from '../plan/parser';
import { pickScanConfig } from '../outputs';
import { openProject } from './project';
import { findPlanFiles } from '../plan/files';
import { runSnapshot } from '../pipeline';
import { openScanSession } from './session';
import type { ScanSession } from './session';
import type { CollectCalls } from '../pipeline';
import type { C4pmConfig, Plan, Snapshot } from '../types';

/** A repo's plan as found on disk: the plan files, the folder they came from, and the parsed plan. */
export interface FoundPlan {
  /** Repo-relative plan files in the order they were found (posix; may start with `../`). */
  files: string[];
  /** Absolute folder the plan files came from; null for the repo-wide fallback. */
  dir: string | null;
  /** The parsed plan; undefined when there are no .c4 files. */
  plan: Plan | undefined;
}

/**
 * Find a repo's plan files (config architectureDir > the project's plan folder > legacy c4/ > the whole repo) and parse
 * them. For the commands that also need the file list or the folder (Plan editing, Board editing); planFor gives the plan.
 */
export function findPlan(repoRoot: string, config: C4pmConfig): FoundPlan {
  const { files, dir } = findPlanFiles(repoRoot, config);
  return { files, dir, plan: files.length > 0 ? parsePlan(repoRoot, files) : undefined };
}

/**
 * The parsed plan for a repo, or undefined when it has no .c4 files.
 * Same plan `view` builds (src/page/html.ts buildView), so every command reads the plan alike.
 */
export function planFor(repoRoot: string, config: C4pmConfig): Plan | undefined {
  return findPlan(repoRoot, config).plan;
}

/**
 * b784: the plan for names without a scan: the repo's own config (openProject) then planFor; null when the repo has no
 * .c4 files. The one helper of every reader that needs plan names but no code scan (c4pm sim, MCP sim tools, Board
 * editing, Simulation editing). A broken config or plan throws, as before.
 */
export function planNoScan(repoRoot: string): Plan | null {
  return planFor(repoRoot, openProject(repoRoot).config) ?? null;
}

/**
 * b320: a scan session with the scan config of the plan commands (pickScanConfig): one scan core per plan command,
 * shared by every step of plan apply. Lazy: nothing is scanned until a caller asks for the core or a snapshot.
 */
export function planScanSession(repoRoot: string, config: C4pmConfig): ScanSession {
  return openScanSession(repoRoot, pickScanConfig(config));
}

/**
 * A quiet, write-free scan of the repo built with the plan (as `view` does, P14-T24), so claim-mode components are in it.
 * The one plan-aware scan (b474): the Query layer (query context, status, check, stubs, resolve-link) and Plan editing
 * (the write gate, link and --case checks, through services/planState.ts scanWithPlan) all call it.
 * `collectCalls` passes through to the scan: 'tests' = the calls of the test files (check's no-tests rule), true = the
 * calls of every file (the query context: calls, callers). `parseCacheDir` (QS-2): the disk parse cache folder; only the
 * query context passes it.
 */
export function scanWithPlan(
  repoRoot: string,
  config: C4pmConfig,
  plan: Plan | undefined,
  opts: { collectCalls?: CollectCalls; parseCacheDir?: string | null } = {},
): Snapshot {
  return runSnapshot({
    repo: repoRoot,
    write: false,
    quiet: true,
    config: pickScanConfig(config),
    plan,
    ...(opts.collectCalls ? { collectCalls: opts.collectCalls } : {}),
    ...(opts.parseCacheDir ? { parseCacheDir: opts.parseCacheDir } : {}),
  });
}
