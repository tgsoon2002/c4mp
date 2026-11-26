import * as fs from 'fs';
import { parsePlanTexts } from '../src/plan/parser';
import { checkFoundation, FOUNDATION_SHARE } from '../src/c4/foundationCheck';
import { runCheck } from '../src/query/check';
import { makeRepo, runPlanCli, writeSource } from './helpers/planEditHarness';
import type { ComponentEdge, Plan, Snapshot } from '../src/types';

// b908: info foundation-candidate: a plan component used by MORE than half of the other components, not marked role 'foundation'.
const unitPlan = (uRole = ''): Plan => parsePlanTexts('/repo', new Map([['a.c4', [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      a = component 'A'",
  "      b = component 'B'",
  "      c = component 'C'",
  "      d = component 'D'",
  "      u = component 'U' {",
  uRole ? `        metadata { role '${uRole}' }` : '',
  '      }',
  '    }',
  '  }',
  '}',
].filter(Boolean).join('\n')]]));
const A = (id: string): string => `app.api.${id}`;
const E = (from: string, to: string): ComponentEdge => ({ from: A(from), to: A(to), weight: 1 });
const snap = (components: string[], edges: ComponentEdge[]): Snapshot => ({
  components: components.map((id) => ({ id, name: id, containerId: 'x', path: '', files: [] })),
  componentEdges: edges,
} as unknown as Snapshot);
const ALL = ['a', 'b', 'c', 'd', 'u'].map(A);
const run = (edges: ComponentEdge[], uRole = '', components = ALL) => checkFoundation(unitPlan(uRole), snap(components, edges));

describe('checkFoundation', () => {
  it('the share is one named constant: more than half', () => {
    expect(FOUNDATION_SHARE).toBe(0.5);
  });

  it('3 of 4 other components use it: one info finding with the set command in the message', () => {
    expect(run([E('a', 'u'), E('b', 'u'), E('c', 'u')])).toEqual([{
      severity: 'info', rule: 'foundation-candidate', id: A('u'),
      message: 'U is used by 3 of the 4 other components; mark it foundation and the map hides the arrows into it until it is hovered or selected: c4mp plan set app.api.u role=foundation',
    }]);
  });

  it.each([
    ['exactly half (2 of 4)', [E('a', 'u'), E('b', 'u')], '', ALL],
    ['already marked foundation', [E('a', 'u'), E('b', 'u'), E('c', 'u')], 'foundation', ALL],
    ['self edge and a duplicated edge count one user', [E('u', 'u'), E('a', 'u'), E('a', 'u')], '', ALL],
    ['an edge from a non-plan id is ignored', [E('a', 'u'), E('b', 'u'), { from: 'x/y', to: A('u'), weight: 1 }], '', ALL],
    ['folder mode: ids are folders', [{ from: 'api/src', to: 'api/lib', weight: 1 }], '', ['api/src', 'api/lib']],
    ['one component only', [], '', [A('u')]],
  ] as Array<[string, ComponentEdge[], string, string[]]>)('no finding: %s', (_n, edges, role, components) => {
    expect(run(edges, role, components)).toEqual([]);
  });
});

describe('foundation-candidate end to end (check, then plan set role=foundation)', () => {
  const PLAN = [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      a = component 'A' {",
    '        link ../../../../src/a.ts#a',
    '      }',
    "      b = component 'B' {",
    '        link ../../../../src/b.ts#b',
    '      }',
    "      u = component 'U' {",
    '        link ../../../../src/u.ts#u',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const SOURCES: Record<string, string> = {
    'src/u.ts': 'export function u(): number { return 1; }\n',
    'src/a.ts': "import { u } from './u';\nexport function a(): number { return u(); }\n",
    'src/b.ts': "import { u } from './u';\nexport function b(): number { return u(); }\n",
  };
  let root = '';
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists U, and after plan set role=foundation lists nothing', async () => {
    const r = makeRepo('c4pm-found-check-', { 'a.c4': PLAN });
    root = r.root;
    for (const [rel, text] of Object.entries(SOURCES)) writeSource(root, r.planDir, rel, text);
    const pick = () => runCheck(root, {}, {})!.findings.filter((f) => f.rule === 'foundation-candidate');
    const first = pick();
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('app.api.u');
    expect(first[0].message.startsWith('U is used by 2 of the 2 other components')).toBe(true);
    const set = await runPlanCli(['plan', 'set', 'app.api.u', 'role=foundation', '--repo', root, '--yes']);
    expect(set.code).toBe(0);
    expect(set.stderr).toBe('');
    expect(pick()).toEqual([]);
  });
});
