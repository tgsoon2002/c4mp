import * as path from 'path';
import { privatePlanDir } from './helpers/privateRepo';
import { buildNav, navColumns, NO_CONTAINER } from '../src/view/navModel';
import { buildViewModel } from '../src/view/model';
import { parsePlan } from '../src/plan/parser';
import { listC4Files } from '../src/plan/files';
import type { Plan, PlanElement, PlanRelation, Snapshot } from '../src/types';

// P20-T4 (b126): navigation data for the IO view, from a fixture modelled on the demo's Shop.
// plan.elements is alphabetical in a real plan (parser.ts), so the fixture is sorted by id and the declaration
// order lives only in source.file / source.line.
let line = 0;
const el = (id: string, kind: string, over: Partial<PlanElement> = {}): PlanElement => ({
  id, kind, title: id.split('.').pop()!, description: null, technology: null, links: [],
  metadata: {}, parent: id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null,
  source: { file: 'shop.c4', line: ++line }, ...over,
});
const rel = (from: string, to: string, label: string | null = null): PlanRelation => ({ from, to, label, source: { file: 'shop.c4', line: ++line } });
const byId = (els: PlanElement[]): PlanElement[] => [...els].sort((a, b) => a.id.localeCompare(b.id));

function shop(): Plan {
  line = 0;
  const elements = [
    el('shop', 'system'),
    el('shop.web', 'container', { title: 'Web', technology: 'React' }),            // declared first, sorts last
    el('shop.web.pricing', 'component', { metadata: { uid: 'u-pricing' } }),
    el('shop.web.pricing.quote', 'function'),
    el('shop.web.home', 'screen', { title: 'Home', metadata: { uid: 'u-home', status: 'built' } }),
    el('shop.web.home.hero', 'region', { title: 'Hero' }),
    el('shop.web.home.hero.cta', 'control', { title: 'Shop now' }),
    el('shop.web.home.search_btn', 'control', { title: 'Search' }),
    el('shop.web.home.help_btn', 'control', { title: 'Help' }),
    el('shop.web.home.app_btn', 'control', { title: 'Get the app' }),
    el('shop.web.search', 'screen', { title: 'Search results' }),
    el('shop.web.search.pick', 'control', { title: 'Pick' }),
    el('shop.web.help', 'screen', { title: 'Help' }),
    el('shop.web.cart', 'screen', { title: 'Cart' }),
    el('shop.web.cart.empty', 'state', { title: 'Empty cart' }),
    el('shop.web.cart.checkout_btn', 'control', { title: 'Checkout' }),
    el('shop.web.cart.lost_btn', 'control', { title: 'Lost' }),
    el('shop.web.checkout', 'screen', { title: 'Checkout' }),
    el('shop.web.checkout.notes', 'control', { title: 'Notes' }),
    el('shop.web.checkout.pay', 'control', { title: 'Pay button' }),
    el('shop.web.done', 'screen', { title: 'Done' }),
    el('shop.web.done.again', 'control', { title: 'Again' }),
    el('shop.mobile', 'container', { title: 'Mobile', technology: 'Expo' }),
    el('shop.mobile.scan', 'screen', { title: 'Scan', metadata: { device: 'phone' } }),
    el('shop.mobile.mcart', 'screen', { title: 'Mobile cart' }),
  ];
  return {
    files: ['shop.c4'],
    elements: byId(elements),
    relations: [
      rel('shop.web.home.hero.cta', 'shop.web.cart'),                 // label from the control title
      rel('shop.web.home.search_btn', 'shop.web.search', 'Find'),     // explicit label wins
      rel('shop.web.home.help_btn', 'shop.web.help'),
      rel('shop.web.search.pick', 'shop.web.cart'),
      rel('shop.web.cart.checkout_btn', 'shop.web.checkout'),
      rel('shop.web.checkout.pay', 'shop.web.done'),
      rel('shop.web.done', 'shop.web.home'),                          // screen -> screen sketch
      rel('shop.web.done.again', 'shop.web.done'),                    // self loop
      rel('shop.web.checkout.notes', 'shop.web.pricing'),             // control -> component: not navigation
      rel('shop.web.cart.lost_btn', 'shop.web.nowhere'),              // unmatched target: dropped
      rel('shop.web.cart.checkout_btn', 'shop.web.pricing.quote', 'Price it'),   // control -> function (b130)
      rel('shop.web.cart', 'shop.web.pricing'),                       // screen -> component, no label (b130)
      rel('shop.web.home.app_btn', 'shop.mobile.scan'),               // cross group
      rel('shop.mobile.scan', 'shop.mobile.mcart'),
    ],
    issues: [],
  };
}

describe('buildNav', () => {
  const nav = buildNav(shop())!;

  it('groups follow container declaration order, with title and technology', () => {
    expect(nav.groups.map(g => [g.fqn, g.title, g.technology])).toEqual([
      ['shop.web', 'Web', 'React'], ['shop.mobile', 'Mobile', 'Expo'],
    ]);
  });

  it('screens and the parts tree follow declaration order, not alphabetical', () => {
    const [web, mobile] = nav.groups;
    expect(web.entries.map(s => s.fqn)).toEqual(['shop.web.home', 'shop.web.search', 'shop.web.help', 'shop.web.cart', 'shop.web.checkout', 'shop.web.done']);
    expect(mobile.entries.map(s => s.fqn)).toEqual(['shop.mobile.scan', 'shop.mobile.mcart']);
    const home = web.entries[0];
    expect(home).toMatchObject({ uid: 'u-home', title: 'Home', status: 'built' });
    expect(home.parts.map(p => p.fqn)).toEqual(['shop.web.home.hero', 'shop.web.home.search_btn', 'shop.web.home.help_btn', 'shop.web.home.app_btn']);
    expect(home.parts[0]).toMatchObject({
      kind: 'region', uid: null, status: null,
      parts: [{ fqn: 'shop.web.home.hero.cta', kind: 'control', title: 'Shop now', parts: [] }],
    });
    expect(web.entries[3].parts.map(p => [p.kind, p.fqn])).toEqual([
      ['state', 'shop.web.cart.empty'], ['control', 'shop.web.cart.checkout_btn'], ['control', 'shop.web.cart.lost_btn'],
    ]);
  });

  it('edges: label, via, self, crossGroup; component targets and unmatched targets are not edges', () => {
    expect(nav.edges).toEqual([
      { from: 'shop.web.home', to: 'shop.web.cart', label: 'Shop now', via: 'shop.web.home.hero.cta' },
      { from: 'shop.web.home', to: 'shop.web.search', label: 'Find', labelled: true, via: 'shop.web.home.search_btn' },
      { from: 'shop.web.home', to: 'shop.web.help', label: 'Help', via: 'shop.web.home.help_btn' },
      { from: 'shop.web.search', to: 'shop.web.cart', label: 'Pick', via: 'shop.web.search.pick' },
      { from: 'shop.web.cart', to: 'shop.web.checkout', label: 'Checkout', via: 'shop.web.cart.checkout_btn' },
      { from: 'shop.web.checkout', to: 'shop.web.done', label: 'Pay button', via: 'shop.web.checkout.pay' },
      { from: 'shop.web.done', to: 'shop.web.home', label: null, via: null },
      { from: 'shop.web.done', to: 'shop.web.done', label: 'Again', via: 'shop.web.done.again', self: true },
      { from: 'shop.web.home', to: 'shop.mobile.scan', label: 'Get the app', via: 'shop.web.home.app_btn', crossGroup: true },
      { from: 'shop.mobile.scan', to: 'shop.mobile.mcart', label: null, via: null },
    ]);
  });

  it('screen metadata (device) reaches NavEntry.metadata', () => {
    expect(nav.groups[1].entries[0].metadata).toEqual({ device: 'phone' });
    expect(nav.groups[0].entries[0].metadata).toMatchObject({ uid: 'u-home', status: 'built' });
  });

  it('calls (b130): screen/part -> component/function, toComponent = parent component, label only when given', () => {
    expect(nav.calls).toEqual([
      { from: 'shop.web.checkout', via: 'shop.web.checkout.notes', to: 'shop.web.pricing', toKind: 'component', toTitle: 'pricing', toUid: 'u-pricing', toComponent: 'shop.web.pricing', label: null },
      { from: 'shop.web.cart', via: 'shop.web.cart.checkout_btn', to: 'shop.web.pricing.quote', toKind: 'function', toTitle: 'quote', toUid: null, toComponent: 'shop.web.pricing', label: 'Price it' },
      { from: 'shop.web.cart', via: null, to: 'shop.web.pricing', toKind: 'component', toTitle: 'pricing', toUid: 'u-pricing', toComponent: 'shop.web.pricing', label: null },
    ]);
    expect(nav.calls.some(c => c.to === 'shop.web.nowhere' || c.toKind === 'screen')).toBe(false);   // missing target: no call; screen target stays an edge
  });

  it('ranks and orders per group; the cycle edge, self loop and cross-group edge do not rank', () => {
    const ro = (g: number) => nav.groups[g].entries.map(s => [s.rank, s.order]);
    // web: home -> search/help -> cart -> checkout -> done; done -> home closes a cycle and is ignored
    expect(ro(0)).toEqual([[0, 0], [1, 0], [1, 1], [2, 0], [3, 0], [4, 0]]);
    expect(ro(1)).toEqual([[0, 0], [1, 0]]);
  });

  it('W14 (b310): columns by navigation steps per group; every web screen has an incoming arrow, so column 0 is the first (home)', () => {
    expect(nav.groups.map(g => g.entries.map(s => s.column))).toEqual([[0, 1, 1, 1, 2, 3], [0, 1]]);
  });
});

// W14 (b310): navColumns (K3 / D4). Screens are given by index; order = their source line here (the plan order in buildNav).
describe('navColumns', () => {
  const scr = (n: number): PlanElement[] => Array.from({ length: n }, (_, i) => el(`s.web.x${i}`, 'screen', { source: { file: 'shop.c4', line: i + 1 } }));
  const byLine = (a: PlanElement, b: PlanElement) => a.source.line - b.source.line;
  const P = (...p: [number, number][]) => p.map(([from, to]) => ({ from, to }));

  it.each([
    ['a chain a -> b -> c', 3, P([0, 1], [1, 2]), [0, 1, 2]],
    ['the nearest source wins (a -> b -> c, d -> c)', 4, P([0, 1], [1, 2], [3, 2]), [0, 1, 1, 0]],
    ['screens nothing reaches stand in column 0', 3, P([0, 1]), [0, 1, 0]],
    ['every screen reached (a cycle): the first by order is column 0', 3, P([1, 2], [2, 0], [0, 1]), [0, 1, 2]],
    ['a cycle unreachable from a source starts at 0 (a alone, b <-> c)', 3, P([1, 2], [2, 1]), [0, 0, 1]],
    ['a cycle behind a chain: its first screen joins column 0 (a -> b; c <-> d)', 4, P([0, 1], [2, 3], [3, 2]), [0, 1, 0, 1]],
    ['self pairs are ignored', 2, P([0, 0], [0, 1]), [0, 1]],
    ['no screens', 0, [], []],
  ])('%s', (_name, n, pairs, want) => {
    expect(navColumns(scr(n as number), pairs as { from: number; to: number }[], byLine)).toEqual(want);
  });

  it('the first by order comes from the comparator, not the array position', () => {
    const reverse = (a: PlanElement, b: PlanElement) => b.source.line - a.source.line;
    expect(navColumns(scr(3), P([0, 1], [1, 2], [2, 0]), reverse)).toEqual([1, 2, 0]);
  });

  it('a pair outside the screens throws', () => {
    expect(() => navColumns(scr(2), P([0, 2]), byLine)).toThrow(/outside the 2 screens/);
  });

  it('only screens get a column: a command in the group has no column key', () => {
    const plan = shop();
    plan.elements = byId([...plan.elements, el('shop.web.cli', 'command', { source: { file: 'shop.c4', line: 99 } })]);
    const web = buildNav(plan)!.groups[0];
    expect(web.entries.filter(e => e.kind === 'command').map(e => 'column' in e)).toEqual([false]);
    expect(web.entries.filter(e => e.kind === 'screen').map(e => e.column)).toEqual([0, 1, 1, 1, 2, 3]);
  });

  // Private plan only: the public tree has no ../.c4mp, so the test skips there (b963).
  (privatePlanDir() ? it : it.skip)('the plan of C4PM itself: columns [map_page], [io_view, own_window]', () => {
    const planDir = privatePlanDir()!;
    const nav = buildNav(parsePlan(planDir, listC4Files(planDir)))!;
    const cols: string[][] = [];
    nav.groups.flatMap(g => g.entries).filter(e => e.kind === 'screen').forEach(e => { (cols[e.column!] = cols[e.column!] || []).push(e.fqn); });
    expect(cols).toEqual([['c4mp.c4mp.map_page'], ['c4mp.c4mp.io_view', 'c4mp.c4mp.own_window']]);
  });
});

describe('buildNav edge cases', () => {
  it('a screen outside a container goes in a trailing (no container) group', () => {
    line = 0;
    const plan: Plan = {
      files: ['shop.c4'],
      elements: byId([el('shop', 'system'), el('shop.web', 'container'), el('shop.web.a', 'screen'), el('shop.loose', 'screen', { title: 'Loose' })]),
      relations: [], issues: [],
    };
    const nav = buildNav(plan)!;
    expect(nav.groups.map(g => [g.fqn, g.title, g.technology, g.entries.map(s => s.fqn)])).toEqual([
      ['shop.web', 'web', null, ['shop.web.a']], [NO_CONTAINER, NO_CONTAINER, null, ['shop.loose']],
    ]);
  });

  it('declaration order follows plan.files first, then line', () => {
    line = 0;
    const plan: Plan = {
      files: ['z.c4', 'a.c4'],
      elements: byId([
        el('s', 'system', { source: { file: 'z.c4', line: 1 } }),
        el('s.web', 'container', { source: { file: 'z.c4', line: 2 } }),
        el('s.web.late', 'screen', { source: { file: 'a.c4', line: 1 } }),
        el('s.web.early', 'screen', { source: { file: 'z.c4', line: 9 } }),
      ]),
      relations: [], issues: [],
    };
    expect(buildNav(plan)!.groups[0].entries.map(s => s.fqn)).toEqual(['s.web.early', 's.web.late']);
  });

  it('throws on an element whose file is not in plan.files', () => {
    const plan: Plan = { files: [], elements: [el('s.a', 'screen')], relations: [], issues: [] };
    expect(() => buildNav(plan)).toThrow(/not in plan.files/);
  });
});

describe('ViewModel.nav', () => {
  const snapshot: Snapshot = {
    schemaVersion: 2,
    meta: { tool: 'c4pm@test', repoPath: '/test/repo', repoName: 'app', createdAt: '2026-01-01T00:00:00.000Z', git: null },
    system: { id: 'app', name: 'app' },
    containers: [], components: [], files: [], componentEdges: [], fileEdges: [], externals: [],
    stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
  };

  it('is present when the plan has screens', () => {
    const model = buildViewModel(snapshot, 's', shop());
    expect(model.nav).toEqual(buildNav(shop()));
  });

  it('has no nav key when the plan has no screens, or no plan is given', () => {
    line = 0;
    const plan: Plan = { files: ['shop.c4'], elements: [el('shop', 'system'), el('shop.web', 'container')], relations: [], issues: [] };
    expect('nav' in buildViewModel(snapshot, 's', plan)).toBe(false);
    expect(buildNav(plan)).toBeNull();
    expect('nav' in buildViewModel(snapshot, 's')).toBe(false);
  });
});

// b266: commands, routes and tools are entries like screens.
describe('buildNav: CLI, API and MCP entries', () => {
  function surfaces(): Plan {
    line = 0;
    const elements = [
      el('app', 'system'),
      el('app.cli', 'container', { title: 'Cli', technology: 'Node / commander' }),
      el('app.cli.plan', 'command', { title: 'plan' }),
      el('app.cli.plan.show', 'command', { title: 'plan show', metadata: { uid: 'u-show' } }),
      el('app.cli.plan.show.opts', 'options', { title: 'Output' }),
      el('app.cli.plan.show.opts.json', 'flag', { title: '--json' }),
      el('app.cli.plan.show.target', 'arg', { title: '<target>' }),
      el('app.cli.core', 'component'),
      el('app.api', 'container', { title: 'Api', technology: 'Express' }),
      el('app.api.get', 'route', { title: 'GET /orders/:id' }),
      el('app.api.get.id', 'param', { title: 'id', metadata: { in: 'path', type: 'uuid', required: 'true' } }),
      el('app.api.get.expand', 'param', { title: 'expand' }),
      el('app.api.post', 'route', { title: 'POST /orders' }),
      el('app.api.post.body', 'body', { title: 'Body' }),
      el('app.api.post.body.sku', 'param', { title: 'sku', metadata: { type: 'string' } }),
      el('app.mcp', 'container', { title: 'Mcp', technology: 'MCP' }),
      el('app.mcp.find', 'tool', { title: 'find_product' }),
      el('app.mcp.find.query', 'param', { title: 'query', metadata: { type: 'string' } }),
      el('app.mcp.find.limit', 'param', { title: 'limit' }),
      el('app.web', 'container', { title: 'Web', technology: 'React' }),
      el('app.web.home', 'screen', { title: 'Home' }),
    ];
    return {
      files: ['shop.c4'], elements: byId(elements), issues: [],
      relations: [
        rel('app.cli.plan.show.opts.json', 'app.cli.core', 'reads'),   // a flag -> component: a call from the command
        rel('app.cli.plan.show', 'app.cli.plan'),                       // command -> command: not navigation, dropped
        rel('app.api.post.body.sku', 'app.cli.core'),
      ],
    };
  }
  const nav = buildNav(surfaces())!;

  it('one group per app, with the app word from its technology; entries in declaration order, subcommands in the same app', () => {
    expect(nav.groups.map(g => [g.fqn, g.word, g.entries.map(e => [e.kind, e.fqn, e.title])])).toEqual([
      ['app.cli', 'CLI', [['command', 'app.cli.plan', 'plan'], ['command', 'app.cli.plan.show', 'plan show']]],
      ['app.api', 'API', [['route', 'app.api.get', 'GET /orders/:id'], ['route', 'app.api.post', 'POST /orders']]],
      ['app.mcp', 'MCP', [['tool', 'app.mcp.find', 'find_product']]],
      ['app.web', 'App', [['screen', 'app.web.home', 'Home']]],
    ]);
  });

  it('parent = the nearest ancestor that is an entry (a subcommand\'s command), null for a top-level entry', () => {
    expect(nav.groups.map(g => g.entries.map(e => [e.fqn, e.parent]))).toEqual([
      [['app.cli.plan', null], ['app.cli.plan.show', 'app.cli.plan']],
      [['app.api.get', null], ['app.api.post', null]],
      [['app.mcp.find', null]],
      [['app.web.home', null]],
    ]);
  });

  it('parts keep kind and title as written, with meta only when set', () => {
    const show = nav.groups[0].entries[1];
    expect(show.parts.map(p => [p.kind, p.title, p.parts.map(c => [c.kind, c.title])])).toEqual([
      ['options', 'Output', [['flag', '--json']]], ['arg', '<target>', []],
    ]);
    const get = nav.groups[1].entries[0];
    expect(get.parts.map(p => [p.title, p.meta])).toEqual([['id', { in: 'path', type: 'uuid', required: 'true' }], ['expand', undefined]]);
    expect(nav.groups[1].entries[1].parts[0].parts[0]).toMatchObject({ kind: 'param', title: 'sku', meta: { type: 'string' } });
  });

  it('a relation from a command part to a component is a call of the command; command -> command is dropped; edges stay empty', () => {
    expect(nav.edges).toEqual([]);
    expect(nav.calls).toEqual([
      { from: 'app.cli.plan.show', via: 'app.cli.plan.show.opts.json', to: 'app.cli.core', toKind: 'component', toTitle: 'core', toUid: null, toComponent: 'app.cli.core', label: 'reads' },
      { from: 'app.api.post', via: 'app.api.post.body.sku', to: 'app.cli.core', toKind: 'component', toTitle: 'core', toUid: null, toComponent: 'app.cli.core', label: null },
    ]);
  });

  it('screens are unchanged by entries of other kinds: a plan with only a command still gets a nav', () => {
    line = 0;
    const plan: Plan = { files: ['shop.c4'], elements: byId([el('a', 'system'), el('a.c', 'container'), el('a.c.x', 'command')]), relations: [], issues: [] };
    expect(buildNav(plan)!.groups.map(g => [g.word, g.entries.map(e => e.kind)])).toEqual([['App', ['command']]]);
  });
});
