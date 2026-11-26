import * as ownership from '../c4/check';
import { collectFindings } from '../check/collect';
import { todayIso } from '../util/dates';
import { openProject } from '../scan/project';
import { findPlan, scanWithPlan } from '../scan/planScan';
import { needsCallIndex } from '../sim/run';
import type { C4pmConfig, Plan, PlanFinding, Severity, Snapshot } from '../types';

/** P15-T7b1: what `c4pm check` computes, before any printing. */
export interface CheckResult {
  config: C4pmConfig;
  plan: Plan;
  snapshot: Snapshot;
  /** Plan + board findings at or above `minSeverity` (collectFindings). */
  findings: PlanFinding[];
  /** The repo's name as the scan read it (package.json name, else the folder name); the text header shows it. */
  repoName: string;
}

/**
 * Check the plan against the code: parse the plan first, build the snapshot with it (as `view` does),
 * gather the findings (plan rules + board rules, collectFindings) at or above `minSeverity` (default info). Writes nothing.
 * Returns null when the repo has no .c4 files.
 */
export function runCheck(
  repoRoot: string,
  cli: Partial<C4pmConfig>,
  opts: { sprint?: string; minSeverity?: Severity },
): CheckResult | null {
  const { config, project } = openProject(repoRoot, cli);
  const found = findPlan(repoRoot, config);
  const plan = found.plan;
  if (!plan) return null;

  // Phase 26 (T26-13): the opt-in rule no-tests attaches the tests, which needs the calls of the test files. T8 (Q6): an
  // s-item with a function -> function step pair needs every call (true covers 'tests'); else no s-item costs anything.
  const collectCalls = needsCallIndex(project, plan) ? true : config.tests?.noTests === true ? 'tests' : undefined;
  const snapshot = scanWithPlan(repoRoot, config, plan, collectCalls ? { collectCalls } : {});

  const findings = collectFindings(repoRoot, project, plan, snapshot, {
    sprint: cli.sprint ?? opts.sprint,
    minSeverity: opts.minSeverity,
    today: todayIso(),
    ...(config.tests ? { tests: config.tests } : {}),
    planDir: found.dir,
    config,
  }).all;
  return { config, plan, snapshot, findings, repoName: snapshot.meta.repoName };
}

/** @deprecated b475 (ARR-CL-A1): the old library name (src/index.ts). Use runCheck: it reads the config and the plan,
 *  builds the scan with the plan and returns the plan and board findings. */
export const checkPlan: typeof ownership.checkPlan = ownership.checkPlan;
