import { buildTree, isViewTreeTarget, levelOf } from '../src/query/treeModel';
import { parsePlanTexts } from '../src/plan/parser';
import { renderMermaid } from '../src/query/mermaid';
import type { Plan, PlanElement } from '../src/types';

// P18-T8: tree model over the plan. 1 system, 2 containers, 3 components, 2 planned functions, 4 relations.
const TEXT = `model {
  app = system 'App' {
    api = container 'Api' {
      auth = component 'Auth' {
        metadata { status 'done' owner 'K' }
        login = function 'login' { metadata { status 'planned' } }
        logout = function 'logout'
      }
      orders = component 'Orders'
    }
    web = container 'Web' {
      ui = component 'Ui'
    }
  }
  other = system 'Other'
  app.api.auth -> app.api.orders 'checks'
  app.api.orders -> app.web.ui
  app.api.orders -> other 'leaves'
  app.web.ui -> app.api.auth
  app.web.ui -> ghost
}
`;

const plan: Plan = parsePlanTexts('/nowhere', new Map([['plan/a.c4', TEXT]]));
const el = (id: string): PlanElement => plan.elements.find(e => e.id === id)!;
const OPTS = { levels: 1 as number | 'all', external: false, maxNodes: 120 };
const ok = (r: ReturnType<typeof buildTree>) => {
  if ('error' in r) throw new Error('unexpected ' + r.error);
  return r;
};
const ids = (r: ReturnType<typeof buildTree>) => ok(r).graph.nodes.map(n => n.id).sort();

describe('buildTree storage kinds (b210)', () => {
  it('records and fields appear under their store under the container', () => {
    const p = parsePlanTexts('/nowhere', new Map([['plan/s.c4', "model {\n  app = system 'A' {\n    api = container 'Api' {\n      db = store 'Db' {\n        technology 'postgres'\n        users = record 'Users' {\n          id = field 'id'\n        }\n      }\n    }\n  }\n}\n"]]));
    const r = ok(buildTree(p, p.elements.find(e => e.id === 'app.api')!, { ...OPTS, levels: 'all' }));
    expect(r.graph.nodes.map(n => [n.id, n.parent])).toEqual([
      ['app.api', undefined], ['app.api.db', 'app.api'], ['app.api.db.users', 'app.api.db'], ['app.api.db.users.id', 'app.api.db.users'],
    ]);
  });
});

describe('buildTree', () => {
  it('fixture parses clean', () => {
    expect(plan.issues).toEqual([]);
    expect(plan.relations).toHaveLength(5);
  });

  it('default depth 1 at a container: itself and its components only (no planned code)', () => {
    const r = ok(buildTree(plan, el('app.api'), OPTS));
    expect(ids(r)).toEqual(['app.api', 'app.api.auth', 'app.api.orders']);
    expect(r.truncated).toBe(true);   // auth has planned functions below
    expect(r.graph.nodes.find(n => n.id === 'app.api')!.parent).toBeUndefined();
    expect(r.graph.nodes.find(n => n.id === 'app.api.auth')).toMatchObject({ parent: 'app.api', status: 'done', owner: 'K', kind: 'component', label: 'Auth' });
    // declared relation with both ends shown
    expect(r.graph.edges).toEqual([{ from: 'app.api.auth', to: 'app.api.orders', label: 'checks' }]);
  });

  it("all at the system: everything below, relations with both ends shown", () => {
    const r = ok(buildTree(plan, el('app'), { ...OPTS, levels: 'all' }));
    expect(ids(r)).toEqual(['app', 'app.api', 'app.api.auth', 'app.api.auth.login', 'app.api.auth.logout', 'app.api.orders', 'app.web', 'app.web.ui']);
    expect(r.truncated).toBe(false);
    expect(r.graph.edges.map(e => `${e.from}>${e.to}`).sort()).toEqual([
      'app.api.auth>app.api.orders', 'app.api.orders>app.web.ui', 'app.web.ui>app.api.auth',
    ]);
    expect(r.outside).toBe(1);   // orders -> other; the relation to the missing 'ghost' is ignored
  });

  it('levels: 2 and levels: 0', () => {
    expect(ids(buildTree(plan, el('app'), { ...OPTS, levels: 2 }))).toEqual(['app', 'app.api', 'app.api.auth', 'app.api.orders', 'app.web', 'app.web.ui']);
    expect(ids(buildTree(plan, el('app'), { ...OPTS, levels: 0 }))).toEqual(['app']);
    expect(ok(buildTree(plan, el('app'), { ...OPTS, levels: 0 })).truncated).toBe(true);
  });

  it('component target: children are its planned code', () => {
    const r = ok(buildTree(plan, el('app.api.auth'), OPTS));
    expect(ids(r)).toEqual(['app.api.auth', 'app.api.auth.login', 'app.api.auth.logout']);
    expect(r.graph.nodes.find(n => n.id === 'app.api.auth.login')).toMatchObject({ kind: 'function', status: 'planned', parent: 'app.api.auth' });
    expect(r.truncated).toBe(false);
  });

  it('outside count without external: no stubs, no dashed edges', () => {
    const r = ok(buildTree(plan, el('app.api'), OPTS));
    expect(r.outside).toBe(3);   // orders->ui, orders->other, ui->auth
    expect(r.graph.nodes.some(n => n.outside)).toBe(false);
    expect(r.graph.edges.some(e => e.dashed)).toBe(false);
  });

  it('external: a stub node per outside element and dashed edges, graph renders', () => {
    const r = ok(buildTree(plan, el('app.api'), { ...OPTS, external: true }));
    // P20-T9: a stub keeps the real kind of the outside element
    const stubs = r.graph.nodes.filter(n => n.outside).map(n => [n.id, n.label, n.kind]);
    expect(stubs).toEqual([['app.web.ui', 'Ui', 'component'], ['other', 'Other', 'system']]);
    expect(r.graph.edges.filter(e => e.dashed).map(e => `${e.from}>${e.to}`).sort()).toEqual([
      'app.api.orders>app.web.ui', 'app.api.orders>other', 'app.web.ui>app.api.auth',
    ]);
    expect(r.outside).toBe(3);
    expect(() => renderMermaid(r.graph)).not.toThrow();
  });

  it('too many nodes returns the count (stubs included)', () => {
    expect(buildTree(plan, el('app'), { ...OPTS, levels: 'all', maxNodes: 2 })).toEqual({ error: 'too-many-nodes', count: 8 });
    expect(buildTree(plan, el('app.api'), { ...OPTS, external: true, maxNodes: 4 })).toEqual({ error: 'too-many-nodes', count: 5 });
  });

  it('a parent cycle in a broken plan does not loop', () => {
    const a = { ...el('app'), id: 'x', parent: 'y' } as PlanElement;
    const b = { ...el('app'), id: 'y', parent: 'x' } as PlanElement;
    const cyc: Plan = { ...plan, elements: [a, b], relations: [] };
    expect(ids(buildTree(cyc, a, { ...OPTS, levels: 'all' }))).toEqual(['x', 'y']);
  });
});

describe('levelOf', () => {
  it.each([['system', 'c1'], ['container', 'c2'], ['component', 'c3'], ['function', null], ['person', null]])('%s -> %s', (kind, lvl) => {
    expect(levelOf(kind)).toBe(lvl);
  });
});

describe('isViewTreeTarget (b273: --view io|storage starts at a container or an element of that view)', () => {
  it.each([
    ['container', 'storage', true], ['store', 'storage', true], ['field', 'storage', true],
    ['component', 'storage', false], ['system', 'io', false], ['store', 'io', false], ['screen', 'io', true],
  ] as const)('%s with --view %s -> %s', (kind, view, ok) => {
    expect(isViewTreeTarget(kind, view)).toBe(ok);
  });
});
