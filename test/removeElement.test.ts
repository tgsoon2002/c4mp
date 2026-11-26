import { parseC4 } from '../src/plan/parser';
import { planRemoval } from '../src/c4/removeElement';
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

const MAIN_LINES = [
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
  '',                                          // 11
  '  shop.api.auth -> shop.db \'reads\'',      // 12
  '  shop.api -> shop.db \'uses\'',            // 13
  '}',                                         // 14
];
const MAIN = MAIN_LINES.join('\n');

function ids(text: string): string[] {
  return parseC4(text, 'a.c4').elements.map(e => e.id).sort();
}

describe('planRemoval', () => {
  it('removes exactly the component block; other bytes identical', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const r = planRemoval(texts, plan, 'shop.api.menu');
    if (!r.ok || r.blocked) throw new Error('expected a removal');
    expect(r.files).toHaveLength(1);
    expect(r.files[0].oldText).toBe(MAIN);
    expect(r.files[0].newText).toBe([...MAIN_LINES.slice(0, 4), ...MAIN_LINES.slice(7)].join('\n'));
    expect(r.removedElements).toEqual(['shop.api.menu']);
    // round trip: the re-parsed plan is the old plan minus that element
    expect(ids(r.files[0].newText)).toEqual(ids(MAIN).filter(i => i !== 'shop.api.menu'));
    expect(texts.get('a.c4')).toBe(MAIN);   // input untouched
  });

  it('removing a container removes its nested components (same file)', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const r = planRemoval(texts, plan, 'shop.api');
    if (!r.ok || r.blocked) throw new Error('expected a removal');
    expect(r.files[0].newText).toBe([...MAIN_LINES.slice(0, 2), ...MAIN_LINES.slice(8)].join('\n'));
    expect(ids(r.files[0].newText)).toEqual(['shop', 'shop.db']);
  });

  it('blocked (extend block elsewhere) gives no diff; unknown fqn is ok:false', () => {
    const { texts, plan } = build({
      'a.c4': MAIN,
      'b.c4': ['extend shop.api {', '  extra = component \'Extra\'', '}'].join('\n'),
    });
    const r = planRemoval(texts, plan, 'shop.api');
    expect(r).toMatchObject({ ok: true, blocked: true, otherFileChildren: ['shop.api.extra'] });
    expect(r).not.toHaveProperty('files');
    expect(planRemoval(texts, plan, 'nope')).toMatchObject({ ok: false });
  });

  it('relations outside the block: kept without opts.relations; removed with it; manual one kept', () => {
    const { texts, plan } = build({ 'a.c4': MAIN });
    const keep = planRemoval(texts, plan, 'shop.db');
    if (!keep.ok || keep.blocked) throw new Error('expected a removal');
    expect(keep.files).toHaveLength(1);
    expect(keep.files[0].newText).toBe(MAIN_LINES.filter((_, i) => i !== 8).join('\n'));
    expect(keep.relations.map(x => x.line)).toEqual([12, 13]);

    const gone = planRemoval(texts, plan, 'shop.db', { relations: true });
    if (!gone.ok || gone.blocked) throw new Error('expected a removal');
    expect(gone.files[0].newText).toBe(MAIN_LINES.filter((_, i) => ![8, 11, 12].includes(i)).join('\n'));
    expect(gone.relations).toHaveLength(2);

    const man = build({
      'a.c4': ['model {', '  s = system \'S\' {', '    a = container \'A\'', '    b = container \'B\'', '  }', '  s.a -> s.b \'y\'', '  s.a -> s.b \'x\' {', '    style dashed', '  }', '}'].join('\n'),
    });
    const m = planRemoval(man.texts, man.plan, 's.b', { relations: true });
    if (!m.ok || m.blocked) throw new Error('expected a removal');
    // block line 4 and plain relation line 6 go; manual relation (lines 7-9) stays and stays listed
    expect(m.files[0].newText).toBe(['model {', '  s = system \'S\' {', '    a = container \'A\'', '  }', '  s.a -> s.b \'x\' {', '    style dashed', '  }', '}'].join('\n'));
    expect(m.relations.filter(x => x.manual)).toHaveLength(1);
  });

  it('relation in another file is removed in that file', () => {
    const { texts, plan } = build({ 'a.c4': MAIN, 'b.c4': ['model {', '  shop.db -> shop.api \'x\'', '}'].join('\n') });
    const r = planRemoval(texts, plan, 'shop.db', { relations: true });
    if (!r.ok || r.blocked) throw new Error('expected a removal');
    expect(r.files.map(f => f.file)).toEqual(['a.c4', 'b.c4']);
    expect(r.files[1].newText).toBe('model {\n}');
  });

  it('diff text equals this exact expected string', () => {
    const text = [
      '// plan',
      'model {',
      '  a = system \'A\' {',
      '    x = container \'X\'',
      '    y = container \'Y\' {',
      '      description \'d\'',
      '    }',
      '    z = container \'Z\'',
      '  }',
      '}',
    ].join('\n') + '\n';
    const { texts, plan } = build({ 'p.c4': text });
    const r = planRemoval(texts, plan, 'a.y');
    if (!r.ok || r.blocked) throw new Error('expected a removal');
    expect(r.files[0].diff).toBe(
      '--- a/p.c4\n' +
      '+++ b/p.c4\n' +
      '@@ -2,9 +2,6 @@\n' +
      ' model {\n' +
      '   a = system \'A\' {\n' +
      '     x = container \'X\'\n' +
      '-    y = container \'Y\' {\n' +
      '-      description \'d\'\n' +
      '-    }\n' +
      '     z = container \'Z\'\n' +
      '   }\n' +
      ' }\n');
  });

  it('deletion near the file start clips the context', () => {
    const lines = ['model {', '  s = system \'S\' {'];
    for (let i = 0; i < 12; i++) lines.push(`    c${i} = container 'C${i}'`);
    lines.push('  }', '}');
    const { texts, plan } = build({ 'p.c4': lines.join('\n') + '\n' });
    const two = planRemoval(texts, plan, 's.c0', { relations: true });
    if (!two.ok || two.blocked) throw new Error('expected a removal');
    expect(two.files[0].diff).toBe(
      '--- a/p.c4\n+++ b/p.c4\n@@ -1,6 +1,5 @@\n model {\n   s = system \'S\' {\n-    c0 = container \'C0\'\n' +
      '     c1 = container \'C1\'\n     c2 = container \'C2\'\n     c3 = container \'C3\'\n');
  });

  it('CRLF file keeps CRLF', () => {
    const crlf = MAIN_LINES.join('\r\n') + '\r\n';
    const { texts, plan } = build({ 'a.c4': crlf });
    const r = planRemoval(texts, plan, 'shop.api.auth');
    if (!r.ok || r.blocked) throw new Error('expected a removal');
    expect(r.files[0].newText).toBe(MAIN_LINES.filter((_, i) => i !== 3).join('\r\n') + '\r\n');
    expect(r.files[0].newText.includes('\n')).toBe(true);
    expect(r.files[0].newText.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
