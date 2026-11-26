import type { Plan, PlanElement, ViewNode, ViewPlannedTest, ViewTestCase, ViewTestRunner, ViewTests, ViewTestTable } from '../types';
import { testsOf, testsReport, type TestIndex } from '../c4/testAttach';
import { plannedTestsUnder } from '../c4/planTests';
import { testRunCommand, type RunnerOf, type TestRunner } from '../languages/testRunner';
import { subregionMembers } from './tree';
import { log } from '../log';

// Phase 26 (T26-10, D8): the tests on the map. Each node gets the tests attached to it, below it and touching it
// (testsOf, c4/testAttach.ts: one source of the D-rules), as indexes into one case table that carries what the
// panel shows (level, run command). C4PM_DATA holds no test box and no per-test text beyond the id and command (C31).

const ascending = (a: number, b: number): number => a - b;

/**
 * Fills `ViewNode.tests` on every node of `root` (its layers too) and returns the case table, or null when no case
 * is attached and no test is to write (the page then has no test data at all). Cases with level 'none' are left out.
 * With `plan` (T26-12): a node with a uid also lists the tests to write of its plan element (testsReport), a layer
 * those of its components.
 */
export function attachViewTests(root: ViewNode, ix: TestIndex, runnerOf: RunnerOf, plan: Plan | null = null): ViewTestTable | null {
  const cases: ViewTestCase[] = [];
  const runners: ViewTestRunner[] = [];
  const runnerIndex = new Map<TestRunner, number>();
  const indexOf = new Map<string, number>();
  for (const c of ix.cases.values()) {
    const a = ix.attachments.get(c.id)!;
    if (a.level === 'none') continue;
    const runner = runnerOf(c.file);
    if (!runnerIndex.has(runner)) {
      runnerIndex.set(runner, runners.length);
      runners.push(runner.id === null ? { reason: runner.reason } : { cwd: runner.cwd });
    }
    const run = testRunCommand(runner, c.file, c.name);
    indexOf.set(c.id, cases.length);
    cases.push({ id: c.id, line: c.line, level: a.level, runner: runnerIndex.get(runner)!, ...(run ? { run: run.command } : {}) });
  }
  const hasPlanned = plan !== null && plan.elements.some((e) => (e.tests ?? []).some((t) => t.case === null));
  if (cases.length === 0 && !hasPlanned) return null;
  const idx = (ids: string[]): number[] => ids.map((id) => indexOf.get(id)!);

  // T26-12: tests to write, once per plan block, on a node whose uid names a plan element with blocks to write.
  const toWrite: ViewPlannedTest[] = [];
  const toWriteIndex = new Map<string, number>();
  const byUid = new Map<string, PlanElement>();
  if (hasPlanned) for (const e of plan!.elements) if (e.metadata.uid && !byUid.has(e.metadata.uid)) byUid.set(e.metadata.uid, e);
  const toWriteOf = (n: ViewNode): number[] => {
    const el = n.uid === undefined ? undefined : byUid.get(n.uid);
    if (!el || !plannedTestsUnder(plan!, el).some((p) => p.test.case === null)) return [];
    return testsReport(ix, n.id, plan, el, () => null).toWrite.map((p) => {
      const key = `${p.source.file}:${p.source.line}`;
      if (!toWriteIndex.has(key)) { toWriteIndex.set(key, toWrite.length); toWrite.push({ name: p.name, parent: p.parent }); }
      return toWriteIndex.get(key)!;
    });
  };

  const set = (n: ViewNode, own: number[], children: number[], touches: number[], write: number[]): void => {
    if (own.length + children.length + touches.length + write.length === 0) return;
    const tests: ViewTests = {
      count: own.length + children.length, ids: own,
      ...(children.length ? { children } : {}), ...(touches.length ? { touches } : {}), ...(write.length ? { toWrite: write } : {}),
    };
    n.tests = tests;
  };
  /** A grouping node (no c-item of its own): what its parts carry, each test listed once; `own` = its own tests to write. */
  const union = (n: ViewNode, parts: ViewNode[], own: number[] = []): void => {
    const below = new Set<number>();
    for (const p of parts) for (const i of [...(p.tests?.ids ?? []), ...(p.tests?.children ?? [])]) below.add(i);
    const touches = new Set<number>();
    for (const p of parts) for (const i of p.tests?.touches ?? []) if (!below.has(i)) touches.add(i);
    const write = new Set<number>(own);
    for (const p of parts) for (const i of p.tests?.toWrite ?? []) write.add(i);
    set(n, [], [...below].sort(ascending), [...touches].sort(ascending), [...write].sort(ascending));
  };

  let onTree = 0;
  const walk = (n: ViewNode): void => {
    n.children.forEach(walk);
    if (ix.tree.kindOf(n.id) !== undefined) {
      const t = testsOf(ix, n.id, { children: true, touches: true });
      set(n, idx(t.own), idx(t.children), idx(t.touches), toWriteOf(n));
      onTree += t.own.length;
    } else {
      union(n, n.children, n.planOnly ? toWriteOf(n) : []);   // plan-only: no code, so every block of it is to write
    }
    for (const sub of n.subregions ?? []) union(sub, subregionMembers(n, sub.id));   // a subregion's tests are its components' (D4)
  };
  walk(root);
  // A case attached to code the map does not draw (e.g. test-only code) still counts on its ancestors (testsOf).
  log('view-tests', 'attached', { cases: cases.length, runners: runners.length, ownOnMap: onTree, notDrawn: cases.length - onTree, toWrite: toWrite.length });
  if (cases.length === 0 && toWrite.length === 0) return null;
  return { cases, runners, ...(toWrite.length ? { toWrite } : {}) };
}
