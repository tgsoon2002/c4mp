import { parseC4 } from '../src/plan/parser';
import { planRemovalScope } from '../src/c4/removeScope';
import type { Plan } from '../src/types';

function build(files: Record<string, string>): { texts: Map<string, string>; plan: Plan } {
  const texts = new Map(Object.entries(files));
  const elements: Plan['elements'] = [];
  const relations: Plan['relations'] = [];
  const issues: Plan['issues'] = [];
  for (const [f, t] of texts) {
    const r = parseC4(t, f);
    elements.push(...r.elements);
    relations.push(...r.relations);
    issues.push(...r.issues);
  }
  return { texts, plan: { files: [...texts.keys()].sort(), elements, relations, issues } };
}

const MAIN = [
  'model {',                                   // 1
  '  shop = system \'Shop\' {',                // 2
  '    api = container \'API\' {',             // 3
  '      auth = component \'Auth\'',           // 4
  '      menu = component \'Menu\' {',         // 5
  '        description \'the menu\'',          // 6
  '      }',                                   // 7
  '    }',                                     // 8
  '    db = container \'DB\'',                 // 9
  '  }',                                       // 10
  '  shop.api.auth -> shop.db \'reads\'',      // 11
  '  shop.api -> shop.db \'uses\'',            // 12
  '}',                                         // 13
].join('\n');

describe('planRemovalScope', () => {
  it('block range is source.line..endLine of the component', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const r = planRemovalScope(texts, plan, 'shop.api.menu');
    expect(r).toMatchObject({ ok: true, blocked: false, block: { file: 'a.c4', startLine: 5, endLine: 7 }, removedElements: ['shop.api.menu'] });
    const leaf = planRemovalScope(texts, plan, 'shop.api.auth');
    expect(leaf).toMatchObject({ ok: true, block: { startLine: 4, endLine: 4 } });
  });

  it('removing a container lists its nested components (same file)', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const r = planRemovalScope(texts, plan, 'shop.api');
    expect(r).toMatchObject({ ok: true, blocked: false, block: { startLine: 3, endLine: 8 } });
    if (r.ok) expect([...r.removedElements].sort()).toEqual(['shop.api', 'shop.api.auth', 'shop.api.menu']);
  });

  it('children in another file (extend block) give blocked:true', () => {
    const { texts, plan } = build({
      'a.c4': MAIN,
      'b.c4': ['extend shop.api {', '  extra = component \'Extra\'', '}'].join('\n'),
    });
    const r = planRemovalScope(texts, plan, 'shop.api');
    expect(r).toMatchObject({ ok: true, blocked: true, otherFileChildren: ['shop.api.extra'] });
  });

  it('relations inside and outside the block are listed with insideBlock', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const r = planRemovalScope(texts, plan, 'shop.api');
    if (!r.ok) throw new Error(r.reason);
    // exact text only: 'shop.api.auth -> shop.db' and 'shop.api -> shop.db' both start with 'shop.api'
    expect(r.relations.map(x => [x.from, x.to, x.line, x.insideBlock, x.manual])).toEqual([
      ['shop.api.auth', 'shop.db', 11, false, false],
      ['shop.api', 'shop.db', 12, false, false],
    ]);
    const inner = build({ 'a.c4': ['model {', '  s = system \'S\' {', '    a = container \'A\' {', '      -> s.b', '    }', '    b = container \'B\'', '  }', '}'].join('\n') });
    const r2 = planRemovalScope(inner.texts, inner.plan, 's.b');
    if (!r2.ok) throw new Error(r2.reason);
    expect(r2.relations).toEqual([{ from: 's.a', to: 's.b', file: 'a.c4', line: 4, insideBlock: false, manual: false }]);
    const r3 = planRemovalScope(inner.texts, inner.plan, 's.a');
    if (!r3.ok) throw new Error(r3.reason);
    expect(r3.relations).toEqual([{ from: 's.a', to: 's.b', file: 'a.c4', line: 4, insideBlock: true, manual: false }]);
  });

  it('multi-line relation is marked manual', () => {
    const { texts, plan } = build({
      'a.c4': ['model {', '  s = system \'S\' {', '    a = container \'A\'', '    b = container \'B\'', '  }', '  s.a -> s.b \'x\' {', '    style dashed', '  }', '}'].join('\n'),
    });
    const r = planRemovalScope(texts, plan, 's.b');
    if (!r.ok) throw new Error(r.reason);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ line: 6, manual: true });
  });

  it('block sharing a line with other text returns ok:false; unknown fqn returns ok:false', () => {
    const shared = build({ 'a.c4': ['model {', '  s = system \'S\' {', '    a = container \'A\' { } b = container \'B\'', '  }', '}'].join('\n') });
    expect(planRemovalScope(shared.texts, shared.plan, 's.a')).toEqual({ ok: false, reason: 'block shares a line with other text' });
    const before = build({ 'a.c4': ['model {', '  s = system \'S\' {', '    a = container \'A\' }', '}'].join('\n') });
    expect(planRemovalScope(before.texts, before.plan, 's.a')).toMatchObject({ ok: false });
    const { texts, plan } = build({ 'a.c4': MAIN });
    expect(planRemovalScope(texts, plan, 'nope')).toMatchObject({ ok: false });
    expect(planRemovalScope(new Map(), plan, 'shop.db')).toMatchObject({ ok: false });
  });
});
