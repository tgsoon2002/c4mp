import type { C4pmConfig, RunCommand, Snapshot } from '../types';
import { testIndexOf } from '../c4/testAttach';
import type { TestCase, TestIndex } from '../c4/testAttach';
import { testRunCommand, testRunnerOf } from '../languages/testRunner';
import type { RunnerOf } from '../languages/testRunner';
import type { QueryContext } from './context';

/**
 * The attachment index of one scan and the run command of each case (null when no runner is found); `runnerOf` gives
 * the runner of a test file, with the reason when there is none (T26-11: `noRun` in plan show, show and MCP).
 */
export interface TestsBinding { index: TestIndex; runOf: (t: TestCase) => RunCommand | null; runnerOf: RunnerOf }

/** The run half of a TestsBinding: the runner of each test file and the run command of each case. */
export type TestsRunBinding = Pick<TestsBinding, 'runOf' | 'runnerOf'>;

/**
 * b506 (row G5): the run half of the tests binding of one scan, the runner of each test file's container (testRunnerOf
 * on the scanned repo, detected once per container and language; config `tests.command` wins) and the run command of
 * each case. One binding for the map page (src/page/html.ts buildView) and the query readers (testsOfContext).
 */
export function testsBinding(snapshot: Snapshot, config: C4pmConfig): TestsRunBinding {
  const runnerOf = testRunnerOf(snapshot.meta.repoPath, snapshot.containers, config.languages, config.tests?.command);
  return {
    runOf: (t) => testRunCommand(runnerOf(t.file), t.file, t.name),
    runnerOf,
  };
}

/**
 * Phase 26 (T26-12): the test engine bound to a query context for the readers that list tests (board show
 * --with-tests; T26-11: plan show, show, MCP): testIndexOf (c4/testAttach.ts, memoised per snapshot) and testsBinding.
 * ctx.repoRoot is the resolved repo the scan ran on, so it equals ctx.snapshot.meta.repoPath (both path.resolve).
 */
export function testsOfContext(ctx: QueryContext): TestsBinding {
  const index = testIndexOf({ snapshot: ctx.snapshot, plan: ctx.plan, ownership: ctx.ownership, tests: ctx.config.tests });
  return { index, ...testsBinding(ctx.snapshot, ctx.config) };
}
