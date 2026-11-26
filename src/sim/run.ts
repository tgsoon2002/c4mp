import type { Plan, PlanFinding, ProjectPaths, SimItem, SimStep, Snapshot } from '../types';
import { callIndex } from '../callGraph/callResolve';
import { compareFindings } from '../c4/check';
import { loadSims } from './load';
import { checkSims, FUNCTION_KINDS } from './check';
import { resolveSimTarget } from './resolve';

/**
 * The ONE entry point that loads and checks the s-items (as boardForView for the board). Only `collectFindings`
 * (src/check/collect.ts) calls it, so CLI, MCP, status and the page cannot disagree. No sim folder: `{data: null,
 * findings: []}`. Every file issue and note of loadSims is a `sim-parse` warning (id = the file, `s-3.json`); the
 * items that parsed are checked (checkSims) against the plan and the scan. Calls are judged only for the files whose
 * calls the scan read (`snapshot.calls`; T8 reads them when a pair needs them). Findings sorted by severity, rule, id.
 */
export function simsForCheck(
  project: ProjectPaths | null,
  plan: Plan | null,
  snapshot: Snapshot,
): { data: SimItem[] | null; findings: PlanFinding[] } {
  const loaded = loadSims(project);
  if (loaded.dir === null) return { data: null, findings: [] };
  const findings: PlanFinding[] = [...loaded.issues, ...loaded.notes].map((i) => ({
    severity: 'warning' as const,
    rule: 'sim-parse',
    id: i.file || 'sim/',   // the folder itself could not be read (loadSims issue with file '')
    message: i.message,
  }));
  if (loaded.items.length > 0) {
    const calls = snapshot.calls ? new Set(snapshot.calls.map((c) => c.file)) : null;
    findings.push(...checkSims(loaded.items, { plan, code: callIndex(snapshot), callFiles: calls }));
  }
  findings.sort(compareFindings);
  return { data: loaded.items, findings };
}

/**
 * T8 (Q6): true when the scan must read every call for the s-item rules: a flow has two consecutive steps whose targets
 * both name a function without a scan (a plan function or method by uid or fqn, planned ones too, or a `path#name` code
 * ref, which only a scan could tell from a class). Those pairs are what checkSims judges with the calls (pair 3); with
 * several targets one function on each side is enough. Reads only the sim JSON and the plan: a repo with no sim folder,
 * or no such pair, pays nothing. Journey stages are not paired (checkSims judges flow steps only). Callers pass
 * `collectCalls: true` to the scan when this is true, else their usual value.
 */
export function needsCallIndex(project: ProjectPaths | null, plan: Plan | null): boolean {
  const items = loadSims(project).items;
  const fnRef = (ref: string): boolean => {
    const hit = resolveSimTarget(ref, plan, null);
    return hit.kind === 'plan' ? FUNCTION_KINDS.has(hit.el.kind) : ref.includes('#');
  };
  const hasFn = (step: SimStep): boolean => step.target.some(fnRef);
  return items.some((item) => item.kind === 'flow'
    && (item.steps ?? []).some((step, i, steps) => i + 1 < steps.length && hasFn(step) && hasFn(steps[i + 1])));
}
