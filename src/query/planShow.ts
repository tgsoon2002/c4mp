import type { ParseIssue, Plan, PlanElement, PlanRelation, ViewNode } from '../types';
import { openProject } from '../scan/project';
import { planFor } from '../scan/planScan';
import { viewOfKind } from '../plan/kinds';
import type { ViewName } from '../plan/kinds';
import type { QueryContext } from './context';
import { getModel } from './elements';
import { QueryError } from './errors';
import { closestItems, lookupElement, pickOne } from '../util/lookup';
import type { LookupItem } from '../util/lookup';
import { collectItems, formatPlanElement, planElementJson, storeCodeOf } from './showElement';
import { recordShow, storageOf } from './storage';
import type { RecordShow } from './storage';
import { planItems } from '../plan/planItems';
import type { StoreCode } from './showElement';
import { planElementTests } from './itemTests';
import { formatTestsBlock } from './format';
import type { ShownTestsReport } from './itemTests';

// T26-11: `plan show <target>` (moved from bin/cli.ts, shared by the CLI and the MCP tool `plan_show`). One plan
// element found by uid, fqn, local id or name, with what the scan adds: origin and claims (view node), what a store's
// reader finds, and the element's tests (to run, to write, touching).

export interface PlanShowResult {
  el: PlanElement;
  plan: Plan;
  node?: ViewNode;
  code?: StoreCode;
  /** STOR-4 (b336): a plan record's matched code record and its fields; absent for other kinds and an unmatched record. */
  record?: RecordShow;
  /** Absent for an element that is no c-item of the map (a store, a screen, ...). */
  tests?: ShownTestsReport;
}

export const NO_PLAN_MESSAGE = 'no .c4 files found; run c4mp plan generate to start a plan';
const NO_UID = '(no uid)';
const candidateText = (m: LookupItem): string => `${m.uid ?? NO_UID}  ${m.fqn ?? m.id}  ${m.title}`;

/**
 * One plan element and its extras. Errors: not-found (no plan, or no match: candidates = the closest elements as
 * `uid  fqn  title`), ambiguous (candidates = the matches, same form).
 */
export function showPlanElement(ctx: QueryContext, target: string): PlanShowResult {
  const plan = ctx.plan;
  if (!plan) throw new QueryError('not-found', NO_PLAN_MESSAGE);
  const entries = planItems(plan);
  const items = entries.map((e) => e.item);
  const picked = pickOne(lookupElement(target, items));
  if (!picked.ok) {
    if (picked.reason === 'none') throw new QueryError('not-found', `no element matches '${target}'`, closestItems(target, items, 5).map(candidateText));
    throw new QueryError('ambiguous', `'${target}' matches ${picked.matches.length} elements, use a uid`, picked.matches.map(candidateText));
  }
  const el = entries.find((e) => e.item === picked.item)!.el;
  // Origin and claims: only a view node with the same id or uid; folder-mode plan elements may have none.
  const node = collectItems(getModel(ctx).root)
    .find((f) => f.node.id === el.id || (el.metadata.uid !== undefined && f.node.uid === el.metadata.uid))?.node;
  // b275: a store also shows what its reader finds in the code; STOR-4: a record its code record and fields. Both from the
  // one storage read of the context (storageOf), whose store entries are the plan's stores.
  const storage = el.kind === 'store' || el.kind === 'record' ? storageOf(ctx) : null;
  const code = el.kind === 'store' ? storeCodeOf(storage!.stores.find((s) => s.element.id === el.id)!) : undefined;
  const record = el.kind === 'record' && storage ? recordShow(storage, el, plan) ?? undefined : undefined;
  const tests = planElementTests(ctx, el, node) ?? undefined;
  return { el, plan, ...(node ? { node } : {}), ...(code ? { code } : {}), ...(record ? { record } : {}), ...(tests ? { tests } : {}) };
}

/** `plan show` without a target: the plan's elements and relations (of one view, or all) and its parse issues. */
export interface PlanOverview {
  /** Number of .c4 files read. */
  fileCount: number;
  elements: PlanElement[];
  /** With a view: only the relations whose two ends are both shown. */
  relations: PlanRelation[];
  issues: ParseIssue[];
}

/**
 * ARR-CL-2: the plan of `repoRoot` (its config, no CLI overrides; opened and read by Project & scan). `view` null =
 * every element; a view = only the elements of that view's kinds (b273). Null when the repo has no .c4 files. Errors
 * (config, parse) are thrown as they come.
 */
export function planOverview(repoRoot: string, view: ViewName | null): PlanOverview | null {
  const { config } = openProject(repoRoot);
  const plan = planFor(repoRoot, config);
  if (!plan) return null;
  const fileCount = plan.files.length;
  if (view === null) return { fileCount, elements: plan.elements, relations: plan.relations, issues: plan.issues };
  const elements = plan.elements.filter(el => viewOfKind(el.kind) === view);
  const shownIds = new Set(elements.map(el => el.id));
  const relations = plan.relations.filter(r => shownIds.has(r.from) && shownIds.has(r.to));
  return { fileCount, elements, relations, issues: plan.issues };
}

/** The `--json` object (and the MCP `plan_show` result): the element's fields plus `tests` when it has a place on the map. */
export function planShowJson(r: PlanShowResult): object {
  return { ...planElementJson(r.el, r.plan, r.node, r.code, r.record), ...(r.tests ? { tests: r.tests } : {}) };
}

/** Text: the element block, then the tests block (each list cut to the first 10 tests unless `all`). */
export function formatPlanShow(r: PlanShowResult, o: { all?: boolean } = {}): string {
  const lines = [formatPlanElement(r.el, r.plan, r.node, r.code, r.record)];
  if (r.tests) lines.push(...formatTestsBlock(r.tests, { limit: o.all ? Infinity : undefined, more: '--all lists every test' }));
  return lines.join('\n');
}

/** Text of a not-found or ambiguous error, as `plan show` prints it on stdout: the message, then one candidate per line. */
export function formatPlanShowError(e: QueryError): string {
  const ambiguous = e.code === 'ambiguous';
  const lines = [ambiguous ? `${e.message}:` : e.message, ...(e.candidates ?? []).map((c) => `  ${c}`)];
  if (ambiguous && e.candidates?.some((c) => c.startsWith(NO_UID))) lines.push('run c4mp plan ids to give every element a uid');
  return lines.join('\n');
}
