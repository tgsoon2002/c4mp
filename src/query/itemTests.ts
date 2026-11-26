import type { PlanElement, ViewNode } from '../types';
import { testsReport, treeIdOfPlan } from '../c4/testAttach';
import type { TestRef, TestsReport } from '../c4/testAttach';
import type { QueryContext } from './context';
import { testsOfContext } from './testsContext';
import type { TestsBinding } from './testsContext';
import { mergeTestsReports } from '../board/query';

// Phase 26 (T26-11, ATTACH-DESIGN.md section C): the tests of one c-item for `plan show`, `show` and MCP: tests to run
// (attached to it or below it) with run commands, tests to write (plan test blocks no case matches yet) and tests that
// touch it. The attachment rules live in c4/testAttach.ts (one source); this file binds the scan, the runners and the text.

/** A test of a report; `noRun` says why `run` is null (no runner found, or the file is in no container). */
export interface ShownTestRef extends TestRef { noRun?: string }
export interface ShownTestsReport extends Omit<TestsReport, 'run' | 'touches'> { run: ShownTestRef[]; touches: ShownTestRef[] }

const bindings = new WeakMap<QueryContext, TestsBinding>();

/** testsOfContext once per context, so the MCP server detects each container's runner once per scan. */
function bindingOf(ctx: QueryContext): TestsBinding {
  let b = bindings.get(ctx);
  if (!b) {
    b = testsOfContext(ctx);
    bindings.set(ctx, b);
  }
  return b;
}

function reportOf(ctx: QueryContext, treeId: string, planEl: PlanElement | null): ShownTestsReport {
  const { index, runOf, runnerOf } = bindingOf(ctx);
  const r = testsReport(index, treeId, ctx.plan, planEl, runOf);
  const shown = (t: TestRef): ShownTestRef => {
    if (t.run) return t;
    const runner = runnerOf(t.file);
    return runner.id === null ? { ...t, noRun: runner.reason } : t;
  };
  return { ...r, run: r.run.map(shown), touches: r.touches.map(shown) };
}

/**
 * The tests of a plan element, or null when it is no c-item of the map (a store, a screen, ...). Tree id: treeIdOfPlan,
 * else the view node found for it (folder mode); a subregion has no tests of its own, so its report is its components'.
 */
export function planElementTests(ctx: QueryContext, el: PlanElement, node?: ViewNode): ShownTestsReport | null {
  const ix = bindingOf(ctx).index;
  const treeId = treeIdOfPlan(ix, el) ?? (node && ix.tree.kindOf(node.id) !== undefined ? node.id : null);
  if (treeId !== null) return reportOf(ctx, treeId, el);
  if (el.kind !== 'subregion' || !ctx.plan) return null;
  const parts = ctx.plan.elements.filter((c) => c.parent === el.id && c.kind === 'component');
  // A subregion = its components' reports merged (each test once, to run wins over touching).
  return mergeTestsReports<ShownTestRef>(parts.flatMap((c) => {
    const id = treeIdOfPlan(ix, c);
    return id === null ? [] : [reportOf(ctx, id, c)];
  }));
}

/** The tests of a scanned code element (`file#name`), or null when it is not on the tree (a test case, a test helper). */
export function codeElementTests(ctx: QueryContext, file: string, name: string): ShownTestsReport | null {
  const ix = bindingOf(ctx).index;
  const id = `${file}#${name}`;
  if (ix.tree.kindOf(id) !== 'element') return null;
  // A plan function block for this code carries its tests to write (D16).
  const planEl = ctx.plan?.elements.find((e) => e.tests !== undefined && treeIdOfPlan(ix, e) === id) ?? null;
  return reportOf(ctx, id, planEl);
}
