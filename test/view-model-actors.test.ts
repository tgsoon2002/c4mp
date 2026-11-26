import { buildViewModel } from '../src/view/model';
import { layoutView } from '../src/view/layout';
import type { Plan, PlanElement, Snapshot, ViewNode } from '../src/types';

// P20-T3: person and external are plan-only nodes on the architecture map, in folder and claim mode,
// and relations to and from them survive. Screens and other frontend kinds are not drawn here.
const el = (id: string, kind: string, over: Partial<PlanElement> = {}): PlanElement => ({
  id, kind, title: id, description: null, technology: null, links: [], metadata: {}, parent: null,
  source: { file: 'arch.c4', line: 1 }, ...over,
});

const ACTORS = [
  el('buyer', 'person', { title: 'Buyer', metadata: { status: 'planned' } }),
  el('mail', 'external', { title: 'Mail service', technology: 'SMTP' }),
  el('signin', 'screen', { title: 'Sign in' }),
];

const snapshotOf = (over: Partial<Snapshot>): Snapshot => ({
  schemaVersion: 2,
  meta: { tool: 'c4pm@test', repoPath: '/test/repo', repoName: 'app', createdAt: '2026-01-01T00:00:00.000Z', git: null },
  system: { id: 'app', name: 'app' },
  containers: [], components: [], files: [], componentEdges: [], fileEdges: [], externals: [],
  stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
  ...over,
});

const all = (n: ViewNode, out: ViewNode[] = []): ViewNode[] => { out.push(n); n.children.forEach(c => all(c, out)); return out; };

function expectActors(model: ReturnType<typeof buildViewModel>, target: string): void {
  const nodes = all(model.root);
  const buyer = nodes.find(n => n.id === 'buyer')!;
  const mail = nodes.find(n => n.id === 'mail')!;
  expect(buyer).toMatchObject({ kind: 'person', name: 'Buyer', planOnly: true, meta: { status: 'planned' } });
  expect(mail).toMatchObject({ kind: 'external', name: 'Mail service', detail: 'SMTP', planOnly: true });
  // C1-CTX: the root is the C1 context; the actors sit beside the system, outside it. C1 A1 (b828): persons, system, externals.
  expect(model.root).toMatchObject({ id: '__c1__', kind: 'context', name: 'app' });
  expect(model.root.children.map(n => `${n.kind}:${n.id}`)).toEqual(['person:buyer', 'system:app', 'external:mail']);
  expect(model.root.children).toContain(buyer);
  expect(model.root.children[1].children).not.toContain(buyer);
  expect(nodes.some(n => n.id === 'signin')).toBe(false);   // screens are not on this map
  const pairs = model.edges.map(e => `${e.from}>${e.to}`);
  expect(pairs).toContain(`buyer>${target}`);
  expect(pairs).toContain(`${target}>mail`);
  expect(pairs).toContain('buyer>mail');
  expect(model.relations!.map(r => `${r.from}>${r.to}`)).toEqual(expect.arrayContaining([`buyer>${target}`, `${target}>mail`, 'buyer>mail']));
}

describe('plan-only person and external nodes', () => {
  it('claim mode: nodes and edges to a component', () => {
    const comp = el('app.web.handler', 'component', {
      parent: 'app.web',
      links: [{ raw: './h.ts#on', path: 'h.ts', name: 'on', lines: null, title: null }],
    });
    const plan: Plan = {
      files: ['arch.c4'],
      elements: [el('app.web', 'container', { parent: 'app' }), comp, ...ACTORS],
      relations: ['buyer>app.web.handler', 'app.web.handler>mail', 'buyer>mail'].map(s => {
        const [from, to] = s.split('>');
        return { from, to, label: null, source: { file: 'arch.c4', line: 5 } };
      }),
      issues: [],
    };
    const snapshot = snapshotOf({
      components: [{
        id: 'app.web.handler', name: 'handler', containerId: 'app.web', path: 'h.ts', files: [], mode: 'claim',
        claims: [{ kind: 'function', path: 'h.ts', fn: 'on', elementId: 'app.web.handler', claimIndex: 0 }], source: 'arch.c4', meta: {},
      }],
    });
    expectActors(buildViewModel(snapshot, 's', plan), 'app.web.handler');
  });

  it('folder mode: nodes and edges to a scanned container', () => {
    const plan: Plan = {
      files: ['arch.c4'],
      elements: [el('app.api', 'container', { parent: 'app' }), ...ACTORS],
      relations: ['buyer>app.api', 'app.api>mail', 'buyer>mail'].map(s => {
        const [from, to] = s.split('>');
        return { from, to, label: null, source: { file: 'arch.c4', line: 5 } };
      }),
      issues: [],
    };
    const snapshot = snapshotOf({ containers: [{ id: 'api', name: 'Api', path: 'api', tech: 'Node.js', manifest: null }] });
    expectActors(buildViewModel(snapshot, 's', plan), 'api');
  });

  it('a plan without actors is unchanged', () => {
    const plan: Plan = { files: ['arch.c4'], elements: [el('signin', 'screen')], relations: [], issues: [] };
    const model = buildViewModel(snapshotOf({}), 's', plan);
    expect(all(model.root).map(n => n.kind)).toEqual(['system']);
  });
});

// C1-CTX (with b328 EXT-2a): persons and externals are drawn at C1 beside the system; an external holds its containers.
describe('C1 system context root', () => {
  const rel = (s: string) => {
    const [from, to] = s.split('>');
    return { from, to, label: null, source: { file: 'arch.c4', line: 9 } };
  };
  // system app (scanned container `web`), person buyer, external cloud holding cloud.web and cloud.db
  const planOf = (relations: string[], extra: PlanElement[] = []): Plan => ({
    files: ['arch.c4'],
    elements: [
      el('app', 'system'),
      el('app.web', 'container', { parent: 'app' }),
      el('buyer', 'person'),
      el('cloud', 'external', { title: 'Cloud' }),
      el('cloud.web', 'container', { parent: 'cloud', title: 'Cloud web' }),
      el('cloud.db', 'container', { parent: 'cloud', title: 'Cloud db' }),
      ...extra,
    ],
    relations: relations.map(rel),
    issues: [],
  });
  const scannedWeb = { containers: [{ id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: null }] };
  const claimComp = (id: string, containerId: string, fn: string) => ({
    id, name: id, containerId, path: 'h.ts', files: [], mode: 'claim' as const,
    claims: [{ kind: 'function' as const, path: 'h.ts', fn, elementId: id, claimIndex: 0 }], source: 'arch.c4', meta: {},
  });
  const claimPlan = (relations: string[]): Plan => planOf(relations, [
    el('app.web.handler', 'component', { parent: 'app.web', links: [{ raw: './h.ts#on', path: 'h.ts', name: 'on', lines: null, title: null }] }),
  ]);

  function expectContext(model: ReturnType<typeof buildViewModel>, ours: string, kept: string[]): void {
    expect(model.root).toMatchObject({ id: '__c1__', kind: 'context', name: 'app' });
    expect(model.root.children.map(n => n.kind).sort()).toEqual(['external', 'person', 'system']);
    const system = model.root.children.find(n => n.kind === 'system')!;
    const cloud = model.root.children.find(n => n.id === 'cloud')!;
    expect(system.id).toBe('app');
    expect(cloud.children.map(n => n.id).sort()).toEqual(['cloud.db', 'cloud.web']);
    expect(cloud.children.every(n => n.kind === 'container')).toBe(true);
    expect(all(system).some(n => n.id.startsWith('cloud'))).toBe(false);
    expect(all(system).some(n => n.id === ours)).toBe(true);
    expect(model.root.weight).toBe(model.root.children.reduce((s, n) => s + n.weight, 0));
    const pairs = model.relations!.map(r => `${r.from}>${r.to}`);
    expect(pairs).toEqual(kept);
    expect(model.edges.map(e => `${e.from}>${e.to}`)).toEqual(expect.arrayContaining(kept));
  }

  it('(a) folder mode: system, person, external with 2 containers; person -> our container, our container -> external container', () => {
    const model = buildViewModel(snapshotOf(scannedWeb), 's', planOf(['buyer>app.web', 'app.web>cloud.db']));
    expectContext(model, 'web', ['buyer>web', 'web>cloud.db']);
    expect(model.root.children.find(n => n.id === 'cloud')!.children.every(n => n.planOnly)).toBe(true);
  });

  it('(a) claim mode: the same, and a component of an external container is kept inside it', () => {
    const plan = claimPlan(['buyer>app.web.handler', 'app.web.handler>cloud.db']);
    plan.elements.push(el('cloud.db.store', 'component', { parent: 'cloud.db', links: [{ raw: './h.ts#put', path: 'h.ts', name: 'put', lines: null, title: null }] }));
    const snapshot = snapshotOf({ ...scannedWeb, components: [claimComp('app.web.handler', 'web', 'on'), claimComp('cloud.db.store', 'cloud.db', 'put')] });
    const model = buildViewModel(snapshot, 's', plan);
    expectContext(model, 'app.web.handler', ['buyer>app.web.handler', 'app.web.handler>cloud.db']);
    const db = model.root.children.find(n => n.id === 'cloud')!.children.find(n => n.id === 'cloud.db')!;
    expect(db.children.map(n => n.id)).toEqual(['cloud.db.store']);
  });

  it('(b) a plan with no actor: the root is the system, as before', () => {
    const plan: Plan = { files: ['arch.c4'], elements: [el('app', 'system'), el('app.web', 'container', { parent: 'app' })], relations: [rel('app.web>app.web')], issues: [] };
    const model = buildViewModel(snapshotOf(scannedWeb), 's', plan);
    expect(model.root).toMatchObject({ id: 'app', kind: 'system' });
    expect(all(model.root).map(n => `${n.kind}:${n.id}`)).toEqual(['system:app', 'container:web']);
  });

  it.each(['folder', 'claim'])('(c) %s mode: an external container with the local id of a scanned container is not merged', (mode) => {
    const relations = ['cloud.web>cloud.db', 'buyer>cloud.web'];
    const model = mode === 'folder'
      ? buildViewModel(snapshotOf(scannedWeb), 's', planOf(relations))
      : buildViewModel(snapshotOf({ ...scannedWeb, components: [claimComp('app.web.handler', 'web', 'on')] }), 's', claimPlan(relations));
    const system = model.root.children.find(n => n.kind === 'system')!;
    const cloud = model.root.children.find(n => n.id === 'cloud')!;
    const web = system.children.find(n => n.id === 'web')!;
    expect(web).toBeDefined();
    expect(web.name).not.toBe('Cloud web');   // the scanned (claim mode: our plan's) title, not the external's
    expect(cloud.children.find(n => n.id === 'cloud.web')).toMatchObject({ name: 'Cloud web', kind: 'container' });
    expect(model.relations!.map(r => `${r.from}>${r.to}`)).toEqual(['cloud.web>cloud.db', 'buyer>cloud.web']);
  });

  it('the context id is qualified when a plan element already uses it', () => {
    const model = buildViewModel(snapshotOf({}), 's', { files: ['arch.c4'], elements: [el('__c1__', 'person')], relations: [], issues: [] });
    expect(model.root).toMatchObject({ id: '__c1__::system', kind: 'context' });
    expect(model.root.children.map(n => n.id)).toEqual(['__c1__', 'app']);   // C1 A1: the person, then the system
  });
});

// C1 A1 (b828): the context is a holder (never drawn, no tree row; kindWords `holder`). Its children are the persons, the system,
// then the externals, each group in plan order. The system subtree does not depend on the actors around it.
describe('C1 A1 (b828): the context holder', () => {
  const rel = (s: string) => {
    const [from, to] = s.split('>');
    return { from, to, label: null, source: { file: 'arch.c4', line: 9 } };
  };
  const link = (fn: string) => [{ raw: `./h.ts#${fn}`, path: 'h.ts', name: fn, lines: null, title: null }];
  const SYSTEM_ELEMENTS = [
    el('app', 'system'),
    el('app.web', 'container', { parent: 'app' }),
    el('app.api', 'container', { parent: 'app' }),
    el('app.web.handler', 'component', { parent: 'app.web', links: link('on') }),
    el('app.api.store', 'component', { parent: 'app.api', links: link('put') }),
    el('app.api.auth', 'component', { parent: 'app.api', links: link('login') }),
  ];
  // plan order on purpose: an external first, persons and externals mixed, ids not sorted
  const ACTOR_ELEMENTS = [el('ext_b', 'external'), el('p_z', 'person'), el('ext_a', 'external'), el('p_a', 'person')];
  const SYSTEM_RELATIONS = ['app.web.handler>app.api.store', 'app.api.store>app.api.auth'];
  const ACTOR_RELATIONS = ['p_z>app.web.handler', 'p_a>app.api.auth', 'app.api.store>ext_b', 'p_a>ext_a'];
  const claimComp = (id: string, containerId: string, fn: string) => ({
    id, name: id, containerId, path: 'h.ts', files: [], mode: 'claim' as const,
    claims: [{ kind: 'function' as const, path: 'h.ts', fn, elementId: id, claimIndex: 0 }], source: 'arch.c4', meta: {},
  });
  const snapshot = (): Snapshot => snapshotOf({
    containers: [
      { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: null },
      { id: 'api', name: 'Api', path: 'api', tech: 'Node.js', manifest: null },
    ],
    components: [claimComp('app.web.handler', 'web', 'on'), claimComp('app.api.store', 'api', 'put'), claimComp('app.api.auth', 'api', 'login')],
    componentEdges: [{ from: 'app.web.handler', to: 'app.api.store', weight: 3 }, { from: 'app.api.store', to: 'app.api.auth', weight: 1 }],
  });
  const planOf = (withActors: boolean): Plan => ({
    files: ['arch.c4'],
    elements: withActors ? [...ACTOR_ELEMENTS.slice(0, 2), ...SYSTEM_ELEMENTS, ...ACTOR_ELEMENTS.slice(2)] : SYSTEM_ELEMENTS,
    relations: (withActors ? [...SYSTEM_RELATIONS, ...ACTOR_RELATIONS] : SYSTEM_RELATIONS).map(rel),
    issues: [],
  });

  it('children: the persons, the system, then the externals, each group in plan order (not by weight or id)', () => {
    const model = buildViewModel(snapshot(), 's', planOf(true));
    expect(model.root).toMatchObject({ id: '__c1__', kind: 'context', name: 'app' });
    expect(model.root.children.map(n => `${n.kind}:${n.id}`)).toEqual(['person:p_z', 'person:p_a', 'system:app', 'external:ext_b', 'external:ext_a']);
  });

  it('guard: the system subtree (rects relative to the system, bubbles, edges inside it) is the same with or without actors', () => {
    const withActors = layoutView(buildViewModel(snapshot(), 's', planOf(true)));
    const alone = layoutView(buildViewModel(snapshot(), 's', planOf(false)));
    const sysWith = withActors.root.children.find(n => n.kind === 'system')!;
    expect(alone.root.kind).toBe('system');
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    // every node of the subtree in the system's frame: offset and size divided by the system's size. The system's own bubble
    // is left out: it is its closed shape among its siblings (the root has none to be among), so it belongs to the C1 layout (B1).
    const shape = (sys: ViewNode) => all(sys).map(n => {
      const rel = (r: { x: number; y: number; w: number; h: number }) => [r6((r.x - sys.x) / sys.w), r6((r.y - sys.y) / sys.h), r6(r.w / sys.w), r6(r.h / sys.h)];
      return { id: n.id, kind: n.kind, region: rel(n), bubble: n !== sys && n.bubble ? rel(n.bubble) : null, children: n.children.map(c => c.id) };
    });
    expect(shape(sysWith)).toEqual(shape(alone.root));
    expect(all(alone.root).filter(n => n.kind === 'component')).toHaveLength(3);   // C3 boxes are in the comparison
    const inside = (m: ReturnType<typeof buildViewModel>, sys: ViewNode) => {
      const ids = new Set(all(sys).map(n => n.id));
      return m.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => `${e.from}>${e.to}:${e.weight}`).sort();
    };
    expect(inside(withActors, sysWith)).toEqual(inside(alone, alone.root));
    expect(inside(alone, alone.root).length).toBeGreaterThan(0);
  });
});

// C1 A3 (b830): with opts.planTitle (the page), the system node, the context holder and ViewModel.title take the title of the
// plan element the system maps to (mapNodeToElement: its id, or the id of its title); the repo name when none maps. Without it
// (the queries: CLI and MCP) the repo name stays.
describe('C1 A3 (b830): the system title comes from the plan', () => {
  const plan = (system: PlanElement): Plan => ({ files: ['arch.c4'], elements: [system, ...ACTORS], relations: [], issues: [] });
  const names = (m: ReturnType<typeof buildViewModel>) =>
    [m.title, m.root.name, m.root.children.find(n => n.kind === 'system')!.name];

  it('the page: the plan system title on the system, the context and the header', () => {
    const m = buildViewModel(snapshotOf({}), 's', plan(el('app', 'system', { title: 'App Store' })), undefined, { planTitle: true });
    expect(names(m)).toEqual(['App Store', 'App Store', 'App Store']);
    expect(m.root.children.find(n => n.kind === 'system')!.id).toBe('app');   // the id stays the repo id
  });

  it('the page: a system that maps by the id of its title (repo acme-english-center, plan system acme)', () => {
    const snap = snapshotOf({ meta: { ...snapshotOf({}).meta, repoName: 'acme-english-center' }, system: { id: 'acme-english-center', name: 'acme-english-center' } });
    const m = buildViewModel(snap, 's', plan(el('acme', 'system', { title: 'Acme English Center' })), undefined, { planTitle: true });
    expect(names(m)).toEqual(['Acme English Center', 'Acme English Center', 'Acme English Center']);
  });

  it('the page: the repo name when no plan system maps to ours, or its title is empty', () => {
    const other = buildViewModel(snapshotOf({}), 's', plan(el('bank', 'system', { title: 'Bank' })), undefined, { planTitle: true });
    expect(names(other)).toEqual(['app', 'app', 'app']);
    const empty = buildViewModel(snapshotOf({}), 's', plan(el('app', 'system', { title: '' })), undefined, { planTitle: true });
    expect(names(empty)).toEqual(['app', 'app', 'app']);
    expect(buildViewModel(snapshotOf({}), 's', undefined, undefined, { planTitle: true }).title).toBe('app');   // no plan
  });

  it('the queries (no planTitle): the repo name stays, so CLI and MCP titles do not change', () => {
    const m = buildViewModel(snapshotOf({}), 's', plan(el('app', 'system', { title: 'App Store' })));
    expect(names(m)).toEqual(['app', 'app', 'app']);
  });
});

// C1 D1 (b835): a plan relation with a person or external at either end carries its label onto the arrow (finalizeEdges); the
// labels of one pair are kept distinct, in plan order (the viewer shows the first plus " +N", K's Q1). Relations inside the
// system stay unlabelled with today's weights (Q3). An actor matches only by its exact id (makeEndpointResolver): an IO control
// with the local id `google` (Acme's sign-in buttons) is not the external `google`.
describe('C1 D1 (b835): relation labels on actor edges; actors by exact id', () => {
  const link = (fn: string) => [{ raw: `./h.ts#${fn}`, path: 'h.ts', name: fn, lines: null, title: null }];
  const rel = (from: string, to: string, label: string | null) => ({ from, to, label, source: { file: 'arch.c4', line: 9 } });
  const claimComp = (id: string, containerId: string, fn: string) => ({
    id, name: id, containerId, path: 'h.ts', files: [], mode: 'claim' as const,
    claims: [{ kind: 'function' as const, path: 'h.ts', fn, elementId: id, claimIndex: 0 }], source: 'arch.c4', meta: {},
  });
  const ELEMENTS = [
    el('buyer', 'person'),
    el('clerk', 'person'),
    el('app', 'system'),
    el('app.web', 'container', { parent: 'app' }),
    el('app.api', 'container', { parent: 'app' }),
    el('app.web.handler', 'component', { parent: 'app.web', links: link('on') }),
    el('app.api.store', 'component', { parent: 'app.api', links: link('put') }),
    el('app.web.login', 'screen', { parent: 'app.web' }),
    el('app.web.login.google', 'control', { parent: 'app.web.login', title: 'Sign in with Google' }),
    el('google', 'external', { title: 'Google' }),
    el('mail', 'external', { title: 'Mail' }),
  ];
  const RELATIONS = [
    rel('buyer', 'app.web.handler', 'Browses'),
    rel('buyer', 'app.web.handler', 'Buys'),
    rel('buyer', 'app.web.handler', 'Browses'),          // the same label again: kept once
    rel('clerk', 'app.api.store', null),                 // an actor relation with no label
    rel('app.api.store', 'mail', 'Sends mail'),
    rel('app.api.store', 'mail', null),                  // an unlabelled one beside a labelled one: the label stays
    rel('app.web.handler', 'app.api.store', 'calls'),    // inside the system: no label (C2/C3 unchanged)
    rel('app.api.store', 'google', 'OIDC sign-in'),      // the external by its exact id
    rel('app.web.login.google', 'app.api.store', 'Sign in'),   // a control whose local id is `google`: not the external
  ];
  const snapshot = (): Snapshot => snapshotOf({
    containers: [
      { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: null },
      { id: 'api', name: 'Api', path: 'api', tech: 'Node.js', manifest: null },
    ],
    components: [claimComp('app.web.handler', 'web', 'on'), claimComp('app.api.store', 'api', 'put')],
    componentEdges: [{ from: 'app.web.handler', to: 'app.api.store', weight: 3 }],
  });
  const model = () => buildViewModel(snapshot(), 's', { files: ['arch.c4'], elements: ELEMENTS, relations: RELATIONS, issues: [] });
  const edge = (m: ReturnType<typeof buildViewModel>, from: string, to: string) => m.edges.find(e => e.from === from && e.to === to);

  it('a labelled actor relation keeps its label on the edge', () => {
    const m = model();
    expect(edge(m, 'app.api.store', 'google')).toEqual({ from: 'app.api.store', to: 'google', weight: 1, label: 'OIDC sign-in', labelled: true });
    expect(edge(m, 'app.api.store', 'mail')).toEqual({ from: 'app.api.store', to: 'mail', weight: 1, label: 'Sends mail', labelled: true });
  });

  it('several relations on one pair: one edge (weight 1, as before), every distinct label in plan order', () => {
    expect(edge(model(), 'buyer', 'app.web.handler')).toEqual({
      from: 'buyer', to: 'app.web.handler', weight: 1, label: 'Browses', labelled: true, labels: ['Browses', 'Buys'],
    });
  });

  it('an unlabelled actor relation and a relation inside the system carry no label; the code weight stays', () => {
    const m = model();
    expect(edge(m, 'clerk', 'app.api.store')).toEqual({ from: 'clerk', to: 'app.api.store', weight: 1 });
    expect(edge(m, 'app.web.handler', 'app.api.store')).toEqual({ from: 'app.web.handler', to: 'app.api.store', weight: 4 });
  });

  it('an IO control with the local id `google` does not resolve to the external `google` (edges and relations)', () => {
    const m = model();
    expect(m.edges.filter(e => e.from === 'google' || e.to === 'google').map(e => `${e.from}>${e.to}`)).toEqual(['app.api.store>google']);
    expect(m.relations!.filter(r => r.from === 'google' || r.to === 'google').map(r => `${r.from}>${r.to}:${r.label}`))
      .toEqual(['app.api.store>google:OIDC sign-in']);
  });
});

// b837 (K 2026-11-16, option a): a second plan system is outside at C1, like an external: a plan-only 'system' node beside ours
// (children: persons, our system, the other systems, the externals; plan order inside each group), its containers inside it
// (never merged into ours), and relations to it or what it holds resolved by exact id and labelled (C1 D1). Ours is the plan
// system the snapshot maps to (mapNodeToElement, as planSystemTitle); when none maps, no system is outside (as before).
describe('b837: another plan system is drawn beside ours at C1', () => {
  const link = (fn: string) => [{ raw: `./h.ts#${fn}`, path: 'h.ts', name: fn, lines: null, title: null }];
  const rel = (from: string, to: string, label: string | null) => ({ from, to, label, source: { file: 'arch.c4', line: 9 } });
  const claimComp = (id: string, containerId: string, fn: string) => ({
    id, name: id, containerId, path: 'h.ts', files: [], mode: 'claim' as const,
    claims: [{ kind: 'function' as const, path: 'h.ts', fn, elementId: id, claimIndex: 0 }], source: 'arch.c4', meta: {},
  });
  const SHOP = [
    el('shop', 'system', { title: 'Shop' }),
    el('shop.api', 'container', { parent: 'shop', title: 'API' }),
    el('shop.web', 'container', { parent: 'shop', title: 'Web' }),
  ];
  const BANK = [el('bank', 'system', { title: 'Bank' }), el('bank.ledger', 'container', { parent: 'bank', title: 'Ledger' })];
  const RELATIONS = [rel('shop.api', 'bank', 'posts'), rel('shop.web', 'bank.ledger', 'reads')];
  // the persons and the external of this file (ACTORS), and bank declared BEFORE shop: ours still comes first among the systems
  const planOf = (elements: PlanElement[], relations = RELATIONS): Plan => ({ files: ['arch.c4'], elements, relations, issues: [] });
  const container = (id: string) => ({ id, name: id, path: id, tech: 'Node.js', manifest: null });
  const shopSnap = (over: Partial<Snapshot> = {}): Snapshot =>
    snapshotOf({ meta: { ...snapshotOf({}).meta, repoName: 'shop' }, system: { id: 'shop', name: 'shop' }, containers: [container('api'), container('web')], ...over });
  const kids = (n: ViewNode) => n.children.map(c => `${c.kind}:${c.id}`);
  const edge = (m: ReturnType<typeof buildViewModel>, from: string, to: string) => m.edges.find(e => e.from === from && e.to === to);

  function expectBank(m: ReturnType<typeof buildViewModel>, api: string, web: string): void {
    expect(m.root).toMatchObject({ id: '__c1__', kind: 'context' });
    expect(kids(m.root)).toEqual(['person:buyer', 'system:shop', 'system:bank', 'external:mail']);
    const shop = m.root.children[1];
    const bank = m.root.children[2];
    expect(bank).toMatchObject({ kind: 'system', name: 'Bank', planOnly: true, origin: { kind: 'plan', planFile: 'arch.c4' } });
    expect(shop.planOnly).toBeUndefined();
    expect(kids(bank)).toEqual(['container:bank.ledger']);
    expect(bank.children[0]).toMatchObject({ kind: 'container', name: 'Ledger' });
    expect(all(shop).some(n => n.id.startsWith('bank'))).toBe(false);
    expect(edge(m, api, 'bank')).toMatchObject({ weight: 1, label: 'posts', labelled: true });
    expect(edge(m, web, 'bank.ledger')).toMatchObject({ weight: 1, label: 'reads', labelled: true });
    expect(m.relations!.map(r => `${r.from}>${r.to}:${r.label}`)).toEqual([`${api}>bank:posts`, `${web}>bank.ledger:reads`]);
  }

  it('folder mode: the holder children, bank holds its ledger, both edges with their labels', () => {
    const m = buildViewModel(shopSnap(), 's', planOf([...ACTORS, ...BANK, ...SHOP]));
    expectBank(m, 'api', 'web');
    expect(m.root.children[2].children[0].planOnly).toBe(true);   // no code: a plan-only container, as an external's (EXT-2a)
  });

  it('claim mode: the same, and a component of the other system stays inside its container', () => {
    const plan = planOf([
      ...ACTORS, ...BANK, ...SHOP,
      el('shop.api.handler', 'component', { parent: 'shop.api', links: link('on') }),
      el('shop.web.page', 'component', { parent: 'shop.web', links: link('show') }),
      el('bank.ledger.book', 'component', { parent: 'bank.ledger', links: link('put') }),
    ], [rel('shop.api.handler', 'bank', 'posts'), rel('shop.web.page', 'bank.ledger', 'reads')]);
    const snapshot = shopSnap({ components: [claimComp('shop.api.handler', 'api', 'on'), claimComp('shop.web.page', 'web', 'show'), claimComp('bank.ledger.book', 'bank.ledger', 'put')] });
    const m = buildViewModel(snapshot, 's', plan);
    expectBank(m, 'shop.api.handler', 'shop.web.page');
    expect(kids(m.root.children[2].children[0])).toEqual(['component:bank.ledger.book']);
  });

  it.each(['folder', 'claim'])('%s mode: our scanned container with the local id of the other system\'s container is not merged with it', (mode) => {
    const extra = mode === 'claim' ? [el('shop.api.handler', 'component', { parent: 'shop.api', links: link('on') })] : [];
    const snapshot = shopSnap({
      containers: [container('api'), container('web'), container('ledger')],
      ...(mode === 'claim' ? { components: [claimComp('shop.api.handler', 'api', 'on')] } : {}),
    });
    const m = buildViewModel(snapshot, 's', planOf([...ACTORS, ...BANK, ...SHOP, ...extra]));
    const [shop, bank] = [m.root.children[1], m.root.children[2]];
    // Phase 34 F1: in claim mode a scanned container with no code and no plan element is not drawn; in folder mode it is.
    if (mode === 'folder') expect(shop.children.find(n => n.id === 'ledger')).toMatchObject({ kind: 'container', name: 'ledger' });
    else expect(shop.children.find(n => n.id === 'ledger')).toBeUndefined();
    expect(kids(bank)).toEqual(['container:bank.ledger']);
    expect(m.relations!.map(r => `${r.from}>${r.to}`)).toContain('web>bank.ledger');
  });

  it('an endpoint whose local id is `bank` does not resolve to the other system (exact id only, as an actor)', () => {
    const m = buildViewModel(shopSnap(), 's', planOf([...ACTORS, ...BANK, ...SHOP], [...RELATIONS, rel('buyer', 'shop.web.bank', 'x')]));
    expect(m.relations!.filter(r => r.from === 'buyer')).toEqual([]);
    expect(m.edges.filter(e => e.from === 'buyer')).toEqual([]);
  });

  it('another system and no actor: the holder is made (our system, then the other)', () => {
    const m = buildViewModel(shopSnap(), 's', planOf([...BANK, ...SHOP]));
    expect(m.root).toMatchObject({ id: '__c1__', kind: 'context' });
    expect(kids(m.root)).toEqual(['system:shop', 'system:bank']);
  });

  it('unchanged: one plan system and no actor returns the system; one system with actors keeps persons, system, externals', () => {
    const alone = buildViewModel(shopSnap(), 's', planOf(SHOP, []));
    expect(alone.root).toMatchObject({ id: 'shop', kind: 'system' });
    expect(all(alone.root).filter(n => n.kind === 'system')).toHaveLength(1);
    const actors = buildViewModel(shopSnap(), 's', planOf([...ACTORS, ...SHOP], []));
    expect(kids(actors.root)).toEqual(['person:buyer', 'system:shop', 'external:mail']);
  });

  it('no plan system maps to ours (repo app, systems shop and bank): no system is outside, the map as before b837', () => {
    const m = buildViewModel(snapshotOf({}), 's', planOf([...BANK, ...SHOP]));
    expect(m.root).toMatchObject({ id: 'app', kind: 'system' });
    expect(all(m.root).filter(n => n.kind === 'system').map(n => n.id)).toEqual(['app']);
  });
});
