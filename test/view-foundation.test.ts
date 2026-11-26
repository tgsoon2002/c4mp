import * as fs from 'fs';
import { buildView } from '../src/page/html';
import { runCheck } from '../src/query/check';
import { makeRepo, writeSource } from './helpers/planEditHarness';
import type { ViewNode } from '../src/types';

// b908: a plan component with role 'foundation' reaches the page data as meta.role and usedByCount.
const PLAN = (uRole = '', extra = '', uLink = '../../../../src/u.ts#u'): string => [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      a = component 'A' {",
  `        link ${uLink.replace('u.ts#u', 'a.ts#a').replace('/u/', '/a/')}`,
  '      }',
  "      b = component 'B' {",
  `        link ${uLink.replace('u.ts#u', 'b.ts#b').replace('/u/', '/b/')}`,
  '      }',
  "      u = component 'U' {",
  `        link ${uLink}`,
  uRole ? `        metadata { role '${uRole}' }` : '',
  '      }',
  extra,
  '    }',
  '  }',
  '}',
].filter(Boolean).join('\n');

const FILES: Record<string, string> = {
  'src/u.ts': 'export function u(): number { return 1; }\n',
  'src/a.ts': "import { u } from './u';\nexport function a(): number { return u(); }\n",
  'src/b.ts': "import { u } from './u';\nexport function b(): number { return u(); }\n",
};
const FOLDER_FILES: Record<string, string> = {
  'src/u/u.ts': 'export function u(): number { return 1; }\n',
  'src/a/a.ts': "import { u } from '../u/u';\nexport function a(): number { return u(); }\n",
  'src/b/b.ts': "import { u } from '../u/u';\nexport function b(): number { return u(); }\n",
};

const roots: string[] = [];
function modelOf(plan: string, files: Record<string, string> = FILES): { root: string; nodes: ViewNode[] } {
  const r = makeRepo('c4pm-view-found-', { 'a.c4': plan });
  roots.push(r.root);
  for (const [rel, text] of Object.entries(files)) writeSource(r.root, r.planDir, rel, text);
  const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
  return { root: r.root, nodes: all(buildView({ repo: r.root }).model.root) };
}
const byId = (nodes: ViewNode[], id: string) => nodes.find((n) => n.id === id)!;
afterAll(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('attachFoundation (page data)', () => {
  it('role foundation: meta.role and usedByCount on that component only', () => {
    const { nodes } = modelOf(PLAN('foundation'));
    const u = byId(nodes, 'app.api.u');
    expect(u.meta).toMatchObject({ role: 'foundation' });
    expect(u.usedByCount).toBe(2);
    for (const id of ['app.api.a', 'app.api.b']) {
      expect(byId(nodes, id).usedByCount).toBeUndefined();
      expect(byId(nodes, id).meta?.role).toBeUndefined();
    }
  });

  it('no role: no node has usedByCount or meta.role', () => {
    const { nodes } = modelOf(PLAN());
    expect(nodes.some((n) => 'usedByCount' in n)).toBe(false);
    expect(nodes.some((n) => n.meta?.role !== undefined)).toBe(false);
  });

  it('another role value is not copied; check says invalid-metadata', () => {
    const { root, nodes } = modelOf(PLAN('base'));
    expect(nodes.some((n) => n.meta?.role !== undefined)).toBe(false);
    const bad = runCheck(root, {}, {})!.findings.filter((f) => f.rule === 'invalid-metadata');
    expect(bad.map((f) => f.message)).toEqual([expect.stringContaining("U: role 'base' should be foundation")]);
  });

  it('folder mode: the stand-in of the plan component gets the role and the count', () => {
    const { nodes } = modelOf(PLAN('foundation', '', '../../../../src/u/'), FOLDER_FILES);
    const u = nodes.find((n) => n.planId === 'app.api.u')!;
    expect(u).toBeDefined();
    expect(u.meta).toMatchObject({ role: 'foundation' });
    expect(u.usedByCount).toBe(2);
  });

  it('a plan relation counts: the badge counts the drawn arrows', () => {
    const plan = PLAN('foundation', "      c = component 'C'").replace(/\n\}$/, "\n  app.api.c -> app.api.u 'uses'\n}");
    const { nodes } = modelOf(plan);
    expect(byId(nodes, 'app.api.u').usedByCount).toBe(3);
  });
});
