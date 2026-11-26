import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import { checkPlan } from '../src/c4/check';
import { buildViewModel } from '../src/view/model';
import type { Plan, PlanFinding, Snapshot } from '../src/types';

// Phase 26 T26-2: role-test files neither give nor take ownership; code reached only by tests is `test-only-code`.
// Fixture (no Tests component; default test globs): src/a.ts (claimed by app.core) -> src/used.ts;
// src/split.test.ts (functions claimed by app.core and app.other) -> src/used.ts; test/a.test.ts -> src/onlyTested.ts
// -> src/deep.ts, and -> test/helpers.ts; lonely.ts imported by nobody. claim.c4 links functions, folder.c4 links ./src/.
const ROOT = path.join(__dirname, 'fixtures/test-only');
const TEST_FILES = ['src/split.test.ts', 'test/a.test.ts', 'test/helpers.ts'];
const OWNERSHIP_RULES = ['shared-auto', 'unassigned-code', 'test-only-code', 'split-file', 'unplanned-code', 'component-claim-conflict'];

interface Run { plan: Plan; snapshot: Snapshot; findings: PlanFinding[] }
const runs: Record<string, Run> = {};

beforeAll(() => {
  for (const mode of ['claim', 'folder']) {
    const plan = parsePlan(ROOT, [`${mode}.c4`]);
    const snapshot = runSnapshot({ repo: ROOT, write: false, quiet: true, plan });
    runs[mode] = { plan, snapshot, findings: checkPlan(plan, snapshot, ROOT) };
  }
});

describe('role-test files and ownership (T26-2)', () => {
  it('the fixture marks exactly the test files with role test', () => {
    expect(runs.claim.snapshot.files.filter(f => f.role === 'test').map(f => f.file)).toEqual(TEST_FILES);
  });

  it.each([
    ['claim', 'src/used.ts#used', 'shared-auto', 'info', 'src/used.ts#used is unclaimed but used by app.core; treated as shared code'],
    ['claim', 'src/onlyTested.ts#onlyTested', 'test-only-code', 'info', 'src/onlyTested.ts#onlyTested is used only by tests: dead code, or tested but not wired in yet'],
    ['claim', 'src/deep.ts#deep', 'test-only-code', 'info', 'src/deep.ts#deep is used only by tests: dead code, or tested but not wired in yet'],
    ['claim', 'lonely.ts#lonely', 'unassigned-code', 'critical', 'no component claims lonely.ts#lonely and nothing calls it'],
    ['folder', 'lonely.ts', 'unplanned-code', 'critical', 'no .c4 element claims this file'],
  ])('%s mode: %s -> %s', (mode, id, rule, severity, message) => {
    expect(runs[mode].findings.filter(f => f.id === id && OWNERSHIP_RULES.includes(f.rule))).toEqual([{ severity, rule, id, message }]);
  });

  it.each(['claim', 'folder'])('%s mode: no ownership finding names a test file', (mode) => {
    const onTests = runs[mode].findings.filter(f => OWNERSHIP_RULES.includes(f.rule) && TEST_FILES.some(t => f.id.startsWith(t)));
    expect(onTests).toEqual([]);
  });

  it('view: test files get no ownership flag and are no importer of shared code', () => {
    const { plan, snapshot } = runs.claim;
    const model = buildViewModel(snapshot, 's', plan);
    expect(model.files.filter(f => TEST_FILES.includes(f.path)).map(f => f.flag)).toEqual([undefined, undefined, undefined]);
    const shared = model.root.children.find(c => c.kind === 'shared')!;
    expect(shared.children.map(c => [c.id, c.importedBy])).toEqual([
      ['src/used.ts#used', [{ file: 'src/a.ts', owner: 'app.core' }]],
    ]);
  });
});
