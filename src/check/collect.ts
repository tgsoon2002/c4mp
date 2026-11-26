import { checkPlan, compareFindings } from '../c4/check';
import { loadWireframes, type WireframeLoad } from '../c4/wireframeFiles';
import { checkWireframes } from '../c4/wireframeCheck';
import { checkLayerDirection } from '../c4/layerCheck';
import { checkFoundation } from '../c4/foundationCheck';
import { boardForView } from '../board/run';
import { simsForCheck } from '../sim/run';
import { readStorage, type StorageState } from '../storage/storageState';
import { checkStorage } from '../storage/checkStorage';
import { MIN_SEVERITIES, SEVERITY_ORDER } from '../constants';
import type { BoardFile, C4pmConfig, Plan, PlanFinding, ProjectPaths, Severity, SimItem, Snapshot, TestsConfig } from '../types';

/** What `collectFindings` returns: the raw parts and their merge. */
export interface CollectedFindings {
  /**
   * `checkPlan` output, then the storage rules (storage/checkStorage.ts), the wireframe rules (c4/wireframeCheck.ts) and
   * the layer direction rules (c4/layerCheck.ts, b466) and the foundation suggestion (c4/foundationCheck.ts, b908), at or above `minSeverity`, sorted by severity, rule, id
   * (compareFindings, b615). Empty when there is no plan.
   */
  plan: PlanFinding[];
  /** The loaded board (null when the repo has no board file), for callers that also draw it. */
  boardData: BoardFile | null;
  /** W7 (b303): the one load of the screens' wireframe files the rules read; the page draws the same (null without a plan). */
  wireframes: WireframeLoad | null;
  /** STOR-3 (S2): the one storage read (readStorage) the storage rules used; the page reuses it. null without a store (Q4) or plan. */
  storage: StorageState | null;
  /** Board findings at or above `minSeverity`, sorted by severity, rule, id. */
  board: PlanFinding[];
  /** Phase 25 (T7): s-item findings (sim/run.ts simsForCheck) at or above `minSeverity`, sorted by severity, rule, id. */
  sims: PlanFinding[];
  /** The s-items that parsed (null when the project has no sim folder), for the page (S4) to draw. */
  simData: SimItem[] | null;
  /** `plan` + `board` + `sims`: stable merge by severity, plan findings first inside a severity, then board, then sims. */
  all: PlanFinding[];
}

/**
 * The ONE place that gathers findings (PHASE_23_24 rule 3, S4). CLI `check`, MCP `check`, `status` and the view all call it;
 * a new finding source is added here and every consumer sees it. Raw: no grouping, hiding or acks (that is the presentation layer).
 * `project`: the caller's opened project (openProject; null without an anchor), whose board the board rules read.
 * `plan` null (no .c4 files) skips the rule engine; the board rules still run. `minSeverity` (default info) cuts both sources.
 * planDir and config are for the rule sets that read files (wireframes W7, storage STOR-3); config.layers.skip turns on layer-skip.
 */
export function collectFindings(
  repoRoot: string,
  project: ProjectPaths | null,
  plan: Plan | null,
  snapshot: Snapshot,
  opts: { sprint?: string; minSeverity?: Severity; today: string; tests?: TestsConfig; planDir: string | null; config: C4pmConfig },
): CollectedFindings {
  const limit = SEVERITY_ORDER.indexOf(opts.minSeverity ?? 'info');
  // b707: an unknown level (a typo) used to keep nothing, so a CI gate passed with a critical finding.
  if (limit < 0) throw new Error(`unknown minimum severity '${String(opts.minSeverity)}'; use ${MIN_SEVERITIES.join(', ')}`);
  const keep = (f: PlanFinding): boolean => SEVERITY_ORDER.indexOf(f.severity) <= limit;

  let wireframes: WireframeLoad | null = null;
  let storage: StorageState | null = null;
  let planFindings: PlanFinding[] = [];
  if (plan) {
    wireframes = loadWireframes(repoRoot, opts.planDir, plan.elements.filter((e) => e.kind === 'screen').map((e) => e.id));
    // Q4: no store in the plan = no storage read and no storage finding (keeps check fast on repos without a storage plan).
    if (plan.elements.some((e) => e.kind === 'store')) storage = readStorage(plan, repoRoot, opts.config);
    // b615: one sort over every source, so storage and wireframe findings take their severity place too.
    planFindings = [
      ...checkPlan(plan, snapshot, repoRoot, { sprint: opts.sprint, ...(opts.tests ? { tests: opts.tests } : {}) }),
      ...(storage ? checkStorage(plan, storage) : []),
      ...checkWireframes(plan, wireframes),
      // b466: code arrows against the plan's subregion order; not in checkPlan (planTx gates every plan edit with checkPlan).
      ...checkLayerDirection(plan, snapshot, { skip: opts.config.layers?.skip === true }),
      // b908: fan-in suggestion; not in checkPlan for the same reason as the layer rules
      ...checkFoundation(plan, snapshot),
    ].filter(keep).sort(compareFindings);
  }
  const bf = boardForView(repoRoot, project, plan, opts.today);
  const board = bf.findings.filter(keep);
  // Phase 25 T7: the s-item rules (the project's sim/ folder); no folder = no load, no finding.
  const sf = simsForCheck(project, plan, snapshot);
  const sims = sf.findings.filter(keep);

  const extra = [...board, ...sims];
  const all = extra.length === 0
    ? planFindings
    : [...planFindings, ...extra]
        .map((f, i) => ({ f, i }))
        .sort((a, b) => SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity) || a.i - b.i)
        .map((x) => x.f);
  return { plan: planFindings, boardData: bf.data, wireframes, storage, board, sims, simData: sf.data, all };
}
