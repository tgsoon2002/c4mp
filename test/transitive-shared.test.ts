import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import { checkPlan } from '../src/c4/check';
import type { PlanFinding } from '../src/types';

// b226: code reached only through unclaimed files from claimed code is shared-auto, not unassigned.
// Fixture: a.ts (claimed by app.core) -> b.ts -> c.ts; orphanRoot.ts -> orphanDep.ts with no claimed
// ancestor; lonely.ts imported by nobody; broken.ts (does not parse) imports lost.ts.
const ROOT = path.join(__dirname, 'fixtures/transitive-shared');

describe('transitive shared-auto (b226)', () => {
  let findings: PlanFinding[];
  beforeAll(() => {
    const plan = parsePlan(ROOT, ['src/architecture.c4']);
    const snapshot = runSnapshot({ repo: ROOT, write: false, quiet: true });
    findings = checkPlan(plan, snapshot, ROOT);
  });

  const of = (id: string) => findings.filter(f => f.id === id && ['shared-auto', 'unassigned-code'].includes(f.rule));

  it.each([
    ['src/b.ts#stepB', 'shared-auto', 'info', 'src/b.ts#stepB is unclaimed but used by app.core; treated as shared code'],
    ['src/c.ts#stepC', 'shared-auto', 'info', 'src/c.ts#stepC is unclaimed but used by app.core; treated as shared code'],
    ['src/lonely.ts#lonely', 'unassigned-code', 'critical', 'no component claims src/lonely.ts#lonely and nothing calls it'],
    ['src/orphanRoot.ts#orphanRoot', 'unassigned-code', 'critical', 'no component claims src/orphanRoot.ts#orphanRoot and nothing calls it'],
    ['src/orphanDep.ts#orphanDep', 'unassigned-code', 'critical', 'no component claims src/orphanDep.ts#orphanDep; it is imported only by unclaimed code (src/orphanRoot.ts)'],
    ['src/lost.ts#lost', 'unassigned-code', 'warning', 'no component claims src/lost.ts#lost; unverified: src/broken.ts failed to parse and imports it, so its use cannot be confirmed'],
  ])('%s -> %s (%s)', (id, rule, severity, message) => {
    expect(of(id)).toEqual([{ severity, rule, id, message }]);
  });
});
