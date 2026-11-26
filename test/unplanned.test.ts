import { groupUnplanned, UNPLANNED_RULES } from '../src/query/unplanned';
import type { PlanFinding } from '../src/types';

// P18-T9: group unplanned-code findings.
const f = (rule: string, id: string, severity: PlanFinding['severity'] = 'critical', message = `${rule} ${id}`): PlanFinding => ({ severity, rule, id, message });

describe('groupUnplanned', () => {
  it('keeps only the 6 rules, in the fixed order, items sorted by id, empty groups omitted', () => {
    const groups = groupUnplanned([
      f('missing-code', 'app.x'),
      f('split-file', 'src/s.ts', 'info'),
      f('unassigned-code', 'src/b.ts#z'),
      f('parse-error', 'plan/a.c4', 'warning'),
      f('unassigned-code', 'src/a.ts#y'),
      f('unplanned-code', 'src/two.ts'),
      f('unplanned-code', 'src/one.ts'),
      f('shared-auto', 'src/c.ts#h', 'info'),
      f('component-claim-conflict', 'src/d.ts#k', 'warning'),
      f('invalid-metadata', 'app.y', 'warning'),
      f('test-only-code', 'src/e.ts#t', 'info'),
    ]);
    expect(groups.map(g => g.rule)).toEqual(['unplanned-code', 'unassigned-code', 'shared-auto', 'component-claim-conflict', 'split-file', 'test-only-code']);
    expect(groups[0].items.map(i => i.id)).toEqual(['src/one.ts', 'src/two.ts']);
    expect(groups[1].items.map(i => i.id)).toEqual(['src/a.ts#y', 'src/b.ts#z']);
    expect(groups[0].items[0]).toEqual({ id: 'src/one.ts', message: 'unplanned-code src/one.ts' });
    for (const g of groups) expect(g.hint).toBe(UNPLANNED_RULES.find(r => r.rule === g.rule)!.hint);
  });

  it('only the groups that have findings are returned; other rules alone give nothing', () => {
    expect(groupUnplanned([f('unplanned-code', 'a.ts')]).map(g => g.rule)).toEqual(['unplanned-code']);
    expect(groupUnplanned([f('missing-code', 'x'), f('line-link', 'y', 'info')])).toEqual([]);
    expect(groupUnplanned([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [f('unplanned-code', 'b.ts'), f('unplanned-code', 'a.ts')];
    const copy = JSON.parse(JSON.stringify(input));
    groupUnplanned(input);
    expect(input).toEqual(copy);
  });
});
