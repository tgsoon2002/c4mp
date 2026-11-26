import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import { checkPlan } from '../src/c4/check';
import { buildViewModel } from '../src/view/model';
import type { Snapshot } from '../src/types';

// Phase 26 T26-14b (D9): folder mode makes no component or container out of test folders, and a plan component or
// container holding only tests gets the info finding `test-only-component`.
// Fixture: root package.json with src/a (x.ts + colocated x.test.ts) and src/b; test/ (y.test.ts + helpers.ts);
// e2e/ a manifest folder holding only flow.spec.ts (a test project); tools/ a manifest folder with source.
// folder.c4 and claim.c4: container Web (components A, B, Tests -> test/), container E2E (Flows -> e2e/), Tools.
const ROOT = path.join(__dirname, 'fixtures/test-folders');
const snap = (config: object = {}): Snapshot => runSnapshot({ repo: ROOT, write: false, quiet: true, config });

describe('folder mode makes no test component or container (T26-14b)', () => {
  it.each([
    ['default test globs', {}, ['_root', 'tools'], ['_root/a', '_root/b', 'tools/_root']],
    ['no test files (tests.globs [])', { tests: { globs: [] } }, ['_root', 'e2e', 'tools'], ['_root/a', '_root/b', '_root/test', 'e2e/_root', 'tools/_root']],
  ])('%s', (_name, config, containers, components) => {
    const s = snap(config);
    expect(s.containers.map(c => c.id)).toEqual(containers);
    expect(s.components.map(c => c.id)).toEqual(components);
  });

  it('a test file keeps the component of its source folder, else componentId unassigned (no edge, no owner in the Files tab)', () => {
    const s = snap();
    expect(Object.fromEntries(s.files.filter(f => f.role === 'test').map(f => [f.file, f.componentId]))).toEqual({
      'e2e/flow.spec.ts': 'unassigned',
      'src/a/x.test.ts': '_root/a',
      'test/helpers.ts': 'unassigned',
      'test/y.test.ts': 'unassigned',
    });
    expect(s.componentEdges).toEqual([{ from: '_root/b', to: '_root/a', weight: 1 }]);
    const owners = Object.fromEntries(buildViewModel(s, 's').files.filter(f => f.role === 'test').map(f => [f.path, f.owners]));
    expect(owners).toEqual({ 'e2e/flow.spec.ts': [], 'src/a/x.test.ts': ['_root/a'], 'test/helpers.ts': [], 'test/y.test.ts': [] });
  });
});

describe('rule test-only-component (T26-14b)', () => {
  const message = (title: string) => `${title}: all its files are tests; tests now attach to the code they test (Phase 26), consider removing it`;

  it.each(['folder', 'claim'])('%s mode: the outermost test-only component or container, and no plan-unmatched for it', (mode) => {
    const plan = parsePlan(ROOT, [`${mode}.c4`]);
    const findings = checkPlan(plan, runSnapshot({ repo: ROOT, write: false, quiet: true, plan }), ROOT);
    expect(findings.filter(f => f.rule === 'test-only-component' || f.rule === 'plan-unmatched')).toEqual([
      { severity: 'info', rule: 'test-only-component', id: 'shop.e2e', message: message('E2E') },
      { severity: 'info', rule: 'test-only-component', id: 'shop.web.tests', message: message('Tests') },
    ]);
  });
});
