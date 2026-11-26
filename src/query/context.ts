import * as path from 'path';
import { openProject } from '../scan/project';
import { planFor, scanWithPlan } from '../scan/planScan';
import { extractClaims, isClaimModePlan, resolveOwnership } from '../c4/ownership';
import type {
  C4pmConfig, Claim, CodeElement, Ownership, ParseIssue, Plan, Snapshot, SnapshotFile,
} from '../types';
import { elementsNamed } from '../languages/treesitter';
import { readerExtensions } from '../schema/readers';
import { QueryError } from './errors';
import { repoCacheDir } from '../util/userCache';

/** Everything a read-only query needs: one config, one scan, the plan and (claim mode) the ownership. */
export interface QueryContext {
  repoRoot: string;
  config: C4pmConfig;
  snapshot: Snapshot;
  plan: Plan | null;
  planIssues: ParseIssue[];
  claims: Claim[];
  ownership: Ownership | null;
  claimMode: boolean;
  builtAt: string;
  /** '' until P15-T1c sets it. */
  fingerprint: string;
  /** STOR-4 (b336, A17): the storage readers' file extensions ('.sql', ...), so the fingerprint also follows those files. */
  extraExtensions: string[];
}

/** Which calls the scan keeps (scanWithPlan's option): true = the calls of every file, 'tests' = of the test files only. */
type ScanCalls = NonNullable<Parameters<typeof scanWithPlan>[3]>['collectCalls'];

/** b683: the plan part of a context, read without the scan: the plan, its claims, claim mode. */
export type PlanView = Pick<QueryContext, 'plan' | 'claims' | 'claimMode'>;

/** Run a step; any error becomes QueryError('scan-failed') with the original message kept. */
function step<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof QueryError) throw err;
    // b728: keep the original error as `cause`, so its stack is not lost; formatError / errorJson print code and message only.
    const out = new QueryError('scan-failed', err instanceof Error ? err.message : String(err)) as QueryError & { cause?: unknown };
    out.cause = err;
    throw out;
  }
}

/** b683: read the plan and its claims (no scan); a plan-parse error throws QueryError('scan-failed'). */
function planViewOf(root: string, config: C4pmConfig): PlanView {
  const plan = step(() => planFor(root, config)) ?? null;
  const claimMode = plan !== null && isClaimModePlan(plan);
  return { plan, claims: claimMode && plan ? extractClaims(plan) : [], claimMode };
}

/**
 * Build a QueryContext for repoRoot. Read-only: writes nothing to the repo and needs no `.c4pm` anchor. QS-2: parsed
 * files are kept in the per-user cache (repoCacheDir; C4PM_CACHE_DIR=off turns it off), so the next query skips parsing.
 * Config/scan/plan-parse errors throw QueryError('scan-failed'); plan issues are returned in planIssues.
 * `collectCalls` (internal, no CLI option): which calls the scan keeps; default true (every file, for calls/callers).
 * Plan editing's remove passes 'tests', the scan the page build makes.
 */
export function loadQueryContext(
  repoRoot: string,
  opts?: { cli?: Partial<C4pmConfig>; sprint?: string; collectCalls?: ScanCalls },
): QueryContext {
  const root = path.resolve(repoRoot);
  const cli: Partial<C4pmConfig> | undefined = opts?.sprint
    ? { ...opts.cli, sprint: opts.sprint }
    : opts?.cli;

  // Project & scan opens the project, reads the plan and scans it with the plan (calls of every file kept by default).
  const { config } = step(() => openProject(root, cli));
  return contextOf(root, config, opts?.collectCalls ?? true);
}

/** The scan part of loadQueryContext, for a project already opened (`config`): plan, scan, claims and ownership. */
function contextOf(root: string, config: C4pmConfig, collectCalls: ScanCalls, view: PlanView = planViewOf(root, config)): QueryContext {
  const { plan, claims, claimMode } = view;
  const snapshot = step(() => scanWithPlan(root, config, plan ?? undefined, { collectCalls, parseCacheDir: repoCacheDir(root) }));

  const ownership = claimMode ? resolveOwnership(claims, snapshot.files, snapshot.fileEdges) : null;

  return {
    repoRoot: root,
    config,
    snapshot,
    plan,
    planIssues: plan ? plan.issues : [],
    claims,
    ownership,
    claimMode,
    builtAt: snapshot.meta.createdAt,
    fingerprint: '',
    extraExtensions: readerExtensions(),
  };
}

/**
 * b680: what a query has before the scan: the repo root and the config (openProject only, cheap). `full()` runs the
 * scan (loadQueryContext's) on its first call and returns the same QueryContext after. A query that can answer without
 * the scan (search with no hit, show of a file no language reads) never calls it.
 */
export interface QueryBase {
  repoRoot: string;
  config: C4pmConfig;
  /** b683: the plan and its claims without the scan (memo; the scan reuses it). */
  planView(): PlanView;
  full(): QueryContext;
}

/** b680: a QueryBase for repoRoot; config errors throw QueryError('scan-failed') here, scan errors from full(). */
export function openQueryBase(repoRoot: string, opts?: { cli?: Partial<C4pmConfig> }): QueryBase {
  const root = path.resolve(repoRoot);
  const { config } = step(() => openProject(root, opts?.cli));
  let ctx: QueryContext | undefined;
  let view: PlanView | undefined;
  const planView = (): PlanView => (view ??= ctx ?? planViewOf(root, config));
  return { repoRoot: root, config, planView, full: () => (ctx ??= contextOf(root, config, true, view)) };
}

/** b680: a QueryBase over a context already built (the MCP server, tests); a QueryBase is returned as is. */
export function queryBaseOf(ctx: QueryContext | QueryBase): QueryBase {
  if ('full' in ctx) return ctx;
  return { repoRoot: ctx.repoRoot, config: ctx.config, full: () => ctx, planView: () => ctx };
}

/** The scanned file whose repo-relative path equals `filePath` exactly. */
export function fileOf(ctx: QueryContext, filePath: string): SnapshotFile | undefined {
  return ctx.snapshot.files.find((f) => f.file === filePath);
}

/** All elements of `file` named `name` (duplicates kept); b782: a nested function (`outer.inner`) too. */
export function elementsOf(ctx: QueryContext, file: SnapshotFile, name: string): CodeElement[] {
  return elementsNamed(file, name);
}
