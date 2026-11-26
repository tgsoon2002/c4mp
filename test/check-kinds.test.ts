import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { checkPlan } from '../src/c4/check';
import type { PlanElement, PlanFinding, PlanRelation } from '../src/types';

// P20-T2: screen-family elements need no code link when done; duplicate fqn is a finding.
const ROOT = path.join(__dirname, 'fixtures/level4');

const element = (id: string, kind: string, overrides: Partial<PlanElement> = {}, line = 1): PlanElement => ({
  id, kind, title: id, description: null, technology: null, links: [], metadata: { status: 'done', owner: 'K' },
  parent: null, source: { file: 'test.c4', line }, ...overrides,
});
const check = (elements: PlanElement[]): PlanFinding[] =>
  checkPlan({ files: [], elements, relations: [], issues: [] }, runSnapshot({ repo: ROOT, write: false, quiet: true }), ROOT);
const rules = (f: PlanFinding[], id: string) => f.filter(x => x.id === id).map(x => x.rule);

describe('missing-code by kind', () => {
  it.each(['screen', 'region', 'control', 'state', 'flow', 'journey', 'person', 'external'])('done %s without a link: no missing-code', (kind) => {
    expect(rules(check([element('x', kind)]), 'x')).not.toContain('missing-code');
  });

  it.each(['container', 'component'])('done %s without a link keeps the critical missing-code', (kind) => {
    const f = check([element('x', kind)]).find(x => x.id === 'x' && x.rule === 'missing-code');
    expect(f?.severity).toBe('critical');
  });

  it('a done screen whose link points nowhere still gets missing-code', () => {
    const link = { raw: './nope.ts', path: 'src/nope.ts', name: null, lines: null, title: null };
    expect(rules(check([element('x', 'screen', { links: [link] })]), 'x')).toContain('missing-code');
  });
});

describe('duplicate-fqn', () => {
  it('two elements with the same fqn give one warning naming both places', () => {
    const f = check([element('a.s', 'screen', {}, 3), element('a.s', 'screen', { source: { file: 'b.c4', line: 9 } })])
      .filter(x => x.rule === 'duplicate-fqn');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', id: 'a.s' });
    expect(f[0].message).toContain('test.c4:3');
    expect(f[0].message).toContain('b.c4:9');
  });

  it('unique fqns give none', () => {
    expect(check([element('a', 'screen'), element('b', 'screen')]).some(x => x.rule === 'duplicate-fqn')).toBe(false);
  });
});

describe('relation-target-missing (b130)', () => {
  const rel = (from: string, to: string): PlanRelation => ({ from, to, label: null, source: { file: 'test.c4', line: 7 } });
  const els = [
    element('w', 'container'), element('w.s', 'screen', { parent: 'w' }), element('w.s.c', 'control', { parent: 'w.s' }),
    element('w.s.c.st', 'state', { parent: 'w.s.c' }), element('w.k', 'component', { parent: 'w' }),
    element('w.k.f', 'function', { parent: 'w.k' }), element('w.k2', 'component', { parent: 'w' }),
  ];
  const run = (relations: PlanRelation[]) => checkPlan({ files: [], elements: els, relations, issues: [] }, runSnapshot({ repo: ROOT, write: false, quiet: true }), ROOT)
    .filter(x => x.rule === 'relation-target-missing');

  it.each(['w.s', 'w.s.c', 'w.s.c.st'])('from %s to an unknown fqn: one warning naming the place', (from) => {
    expect(run([rel(from, 'w.nope')])).toEqual([{ severity: 'warning', rule: 'relation-target-missing', id: from, message: `${from}: relation to 'w.nope' (test.c4:7) matches no plan element` }]);
  });

  it('existing component, function or screen targets: none', () => {
    expect(run([rel('w.s', 'w.k'), rel('w.s.c', 'w.k.f'), rel('w.s.c', 'w.s')])).toEqual([]);
  });

  it.each(['w.cmd', 'w.cmd.opts', 'w.cmd.opts.flag', 'w.sub', 'w.rt.body.p', 'w.tl.p'])('b266: from %s (command, route or tool part) to an unknown fqn: one warning', (from) => {
    const more = [
      element('w.cmd', 'command', { parent: 'w' }), element('w.cmd.opts', 'options', { parent: 'w.cmd' }), element('w.cmd.opts.flag', 'flag', { parent: 'w.cmd.opts' }),
      element('w.sub', 'command', { parent: 'w.cmd' }), element('w.rt', 'route', { parent: 'w' }), element('w.rt.body', 'body', { parent: 'w.rt' }),
      element('w.rt.body.p', 'param', { parent: 'w.rt.body' }), element('w.tl', 'tool', { parent: 'w' }), element('w.tl.p', 'param', { parent: 'w.tl' }),
    ];
    const findings = checkPlan({ files: [], elements: [...els, ...more], relations: [rel(from, 'w.nope'), rel(from, 'w.k')], issues: [] }, runSnapshot({ repo: ROOT, write: false, quiet: true }), ROOT)
      .filter(x => x.rule === 'relation-target-missing');
    expect(findings.map(f => f.id)).toEqual([from]);
  });

  it('a relation from a non-screen origin is not checked', () => {
    expect(run([rel('w.k', 'w.nope'), rel('w.k2', 'w.k')])).toEqual([]);
  });
});
