import { buildNavView, viewportOf } from '../src/view/navLayout';
import { DEVICE_VIEWPORT } from '../src/plan/ioWords';
import { loadSample } from './helpers/nav-view';
import type { NavEntry, NavModel, NavPart, ViewNode } from '../src/types';

// P20-T5-A (b255): NavModel -> laid-out IO-view tree.
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];

const sample = loadSample();
const nav = sample.nav as NavModel;

describe('buildNavView', () => {
  const view = buildNavView(nav);
  const nodes = all(view.root);
  const byId = new Map(nodes.map(n => [n.id, n]));

  it('builds root, groups and screens with the contract fields', () => {
    expect(view.root).toMatchObject({ id: '(io)', kind: 'system', name: 'IO view', detail: '' });
    expect(byId.get('shop.web')).toMatchObject({ kind: 'container', name: 'Web app', detail: 'React' });
    expect(byId.get('shop.mobile')!.detail).toBe('');
    expect(byId.get('shop.web.home')).toMatchObject({ kind: 'screen', name: 'Home', detail: '', weight: 1, children: [], uid: 'u-home', meta: { status: 'done' } });
  });

  it('omits uid and meta when absent', () => {
    const bare: NavModel = { groups: [{ fqn: 'g', title: 'G', technology: null, word: 'App', entries: [{ kind: 'screen', fqn: 'g.s', uid: null, title: 'S', status: null, rank: 0, order: 0, parent: null, parts: [] }] }], edges: [], calls: [] };
    const s = buildNavView(bare).root.children[0].children[0];
    expect(s.uid).toBeUndefined();
    expect(s.meta).toBeUndefined();
  });

  it('merges parallel edges by pair, drops self edges, keeps cross-group edges', () => {
    const two: NavModel = { groups: nav.groups, calls: [], edges: [
      { from: 'shop.web.login', to: 'shop.web.home', label: 'a', via: null },
      { from: 'shop.web.login', to: 'shop.web.home', label: 'b', via: null },
      { from: 'shop.web.home', to: 'shop.web.home', label: null, via: null, self: true },
      { from: 'shop.web.home', to: 'shop.mobile.mhome', label: null, via: null, crossGroup: true },
    ] };
    expect(buildNavView(two).edges).toEqual([
      { from: 'shop.web.login', to: 'shop.web.home', weight: 2 },
      { from: 'shop.web.home', to: 'shop.mobile.mhome', weight: 1 },
    ]);
  });

  it('matches the sample navView in ids, kinds and edges', () => {
    const shape = (n: ViewNode): unknown => ({ id: n.id, kind: n.kind, children: n.children.map(shape) });
    expect(shape(view.root)).toEqual(shape(sample.navView!.root));
    // b128: the fixture predates edge labels, so compare the pair data only
    const pair = (e: { from: string; to: string; weight: number }): unknown => ({ from: e.from, to: e.to, weight: e.weight });
    expect(view.edges.map(pair)).toEqual(sample.navView!.edges.map(pair));
  });
});

// b128 (T6): the generic IO card as data on each screen leaf.
describe('buildNavView io cards', () => {
  const part = (fqn: string, kind: string, title: string, parts: NavPart[] = [], status: string | null = null): NavPart => ({ fqn, uid: null, kind, title, status, parts });
  const screen = (fqn: string, title: string, parts: NavPart[] = [], metadata?: Record<string, string>): NavEntry =>
    ({ kind: 'screen', fqn, uid: null, title, status: null, rank: 0, order: 0, parent: null, parts, ...(metadata ? { metadata } : {}) });
  const one = (s: NavEntry, tech: string | null = null, gtitle = 'G', edges: NavModel['edges'] = []): ViewNode =>
    buildNavView({ groups: [{ fqn: 'g', title: gtitle, technology: tech, word: 'App', entries: [s] }], edges, calls: [] }).root.children[0].children[0];

  it('flattens parts depth-first with depth, status and nav from via (label only when labelled)', () => {
    const s = screen('g.s', 'S', [
      part('g.s.nav', 'region', 'Nav', [part('g.s.nav.go', 'control', 'Go'), part('g.s.nav.back', 'control', 'Back')]),
      part('g.s.err', 'state', 'Error', [], 'planned'),
    ]);
    const edges: NavModel['edges'] = [
      { from: 'g.s', to: 'g.t', label: 'Go', via: 'g.s.nav.go' },
      { from: 'g.s', to: 'g.u', label: 'Return', labelled: true, via: 'g.s.nav.back' },
    ];
    expect(one(s, null, 'G', edges).io!.rows).toEqual([
      { id: 'g.s.nav', kind: 'region', title: 'Nav', depth: 0 },
      { id: 'g.s.nav.go', kind: 'control', title: 'Go', depth: 1, nav: { to: 'g.t' } },
      { id: 'g.s.nav.back', kind: 'control', title: 'Back', depth: 1, nav: { to: 'g.u', label: 'Return' } },
      { id: 'g.s.err', kind: 'state', title: 'Error', depth: 0, status: 'planned' },
    ]);
  });

  it('carries labelled edge labels on the pair: joined distinct, unlabelled ignored', () => {
    const e = (label: string | null, labelled?: true): NavModel['edges'][number] => ({ from: 'shop.web.login', to: 'shop.web.home', label, ...(labelled ? { labelled } : {}), via: null });
    const edges = buildNavView({ groups: nav.groups, calls: [], edges: [e('a', true), e('b', true), e('a', true), e('fallback')] }).edges;
    expect(edges).toEqual([{ from: 'shop.web.login', to: 'shop.web.home', weight: 4, label: 'a, b', labelled: true }]);
  });

  it.each(['mobile', 'ios', 'android', 'phone', 'flutter', 'react native', 'swift', 'kotlin'])('keyword %s in the container technology gives a phone', kw => {
    expect(one(screen('g.s', 'S'), `Dart / ${kw.toUpperCase()}`).io!.device).toBe('phone');
  });

  it('applies the device rule: container title, screen title/fqn, default web, explicit wins, invalid is logged', () => {
    expect(one(screen('g.s', 'S'), 'React', 'Shop mobile app').io!.device).toBe('phone');
    expect(one(screen('g.s', 'Android home')).io!.device).toBe('phone');
    expect(one(screen('g.ios.s', 'S')).io!.device).toBe('phone');
    expect(one(screen('g.s', 'S'), 'React').io!.device).toBe('web');
    expect(one(screen('g.s', 'S', [], { device: 'web' }), 'Flutter').io!.device).toBe('web');
    expect(one(screen('g.s', 'S', [], { device: 'phone' }), 'React').io!.device).toBe('phone');
    // invalid value: falls through to the keyword rule (the log line itself goes to the logger)
    expect(one(screen('g.s', 'S', [], { device: 'tablet' }), 'Kotlin').io!.device).toBe('phone');
    expect(one(screen('g.s', 'S', [], { device: 'tablet' }), 'React').io!.device).toBe('web');
  });

  it('passes metadata.design through untouched and omits it when absent', () => {
    expect(one(screen('g.s', 'S', [], { design: ' https://x/y.png ' })).io!.design).toBe(' https://x/y.png ');
    expect(one(screen('g.s', 'S', [], { design: 'design/home.png' })).io!.design).toBe('design/home.png');
    expect(one(screen('g.s', 'S')).io).not.toHaveProperty('design');
  });

  // W6 (b302): the frame size, from metadata viewport or the device (DEVICE_VIEWPORT); a bad value is logged and the device size used.
  it('viewportOf: metadata viewport wins, a bad value logs once and uses the device size, none uses the device size', () => {
    expect(viewportOf(screen('g.s', 'S', [], { viewport: '1440x900' }), 'web')).toEqual({ w: 1440, h: 900, source: 'metadata' });
    expect(viewportOf(screen('g.s', 'S'), 'phone')).toEqual({ ...DEVICE_VIEWPORT.phone, source: 'device' });
    expect(viewportOf(screen('g.s', 'S'), 'web')).toEqual({ ...DEVICE_VIEWPORT.web, source: 'device' });
    const prev = process.env.C4PM_DEBUG;
    process.env.C4PM_DEBUG = 'view-nav';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(viewportOf(screen('g.s', 'S', [], { viewport: 'abc' }), 'phone')).toEqual({ ...DEVICE_VIEWPORT.phone, source: 'device' });
      const lines = spy.mock.calls.map(c => String(c[0])).filter(l => l.includes('invalid screen viewport'));
      expect(lines).toEqual(['[view-nav] invalid screen viewport, using the device size {"screen":"g.s","viewport":"abc"}']);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.C4PM_DEBUG;
      else process.env.C4PM_DEBUG = prev;
    }
  });

  it('buildNavView sets io.viewport on screens from their device or viewport', () => {
    expect(one(screen('g.s', 'S'), 'Flutter').io!.viewport).toEqual({ ...DEVICE_VIEWPORT.phone, source: 'device' });
    expect(one(screen('g.s', 'S', [], { viewport: '1024x768' }), 'React').io!.viewport).toEqual({ w: 1024, h: 768, source: 'metadata' });
  });

});

// b266: command, route and tool cards: no device, kind and method on the card, size from the row count.
describe('buildNavView CLI, API and MCP cards', () => {
  const part = (fqn: string, kind: string, title: string, parts: NavPart[] = [], meta?: Record<string, string>): NavPart => ({ fqn, uid: null, kind, title, status: null, parts, ...(meta ? { meta } : {}) });
  const entry = (kind: string, fqn: string, title: string, parts: NavPart[] = []): NavEntry => ({ kind, fqn, uid: null, title, status: null, rank: 0, order: 0, parent: null, parts });
  const view = (entries: NavEntry[], technology = 'Express') =>
    buildNavView({ groups: [{ fqn: 'g', title: 'G', technology, word: 'API', entries }], edges: [], calls: [] });

  it('a route card: kind, method from the title, no device, param rows with in defaults and the Field word under a body', () => {
    const v = view([
      entry('route', 'g.get', 'GET /orders/:id', [part('g.get.id', 'param', 'id', [], { in: 'path' }), part('g.get.expand', 'param', 'expand')]),
      entry('route', 'g.post', 'POST /orders', [part('g.post.b', 'body', 'Body', [part('g.post.b.sku', 'param', 'sku', [], { type: 'string' })])]),
    ]);
    const [get, post] = v.root.children[0].children;
    expect(v.root.children[0].word).toBe('API');
    expect(get.io).toEqual({
      kind: 'route', method: 'GET',
      rows: [
        { id: 'g.get.id', kind: 'param', title: 'id', depth: 0, meta: { in: 'path' } },
        { id: 'g.get.expand', kind: 'param', title: 'expand', depth: 0, meta: { in: 'query' } },
      ],
    });
    expect(get.io).not.toHaveProperty('device');
    expect(post.io!.method).toBe('POST');
    expect(post.io!.rows).toEqual([
      { id: 'g.post.b', kind: 'body', title: 'Body', depth: 0 },
      { id: 'g.post.b.sku', kind: 'param', title: 'sku', depth: 1, word: 'Field', meta: { in: 'body', type: 'string' } },
    ]);
  });

  it('a tool param has no default in; a command has neither device nor method', () => {
    const v = view([
      entry('tool', 'g.t', 'find_product', [part('g.t.q', 'param', 'query', [], { type: 'string' })]),
      entry('command', 'g.c', 'plan show', [part('g.c.o', 'options', 'Output', [part('g.c.o.j', 'flag', '--json')])]),
    ]);
    const [tool, cmd] = v.root.children[0].children;
    expect(tool.io!.rows).toEqual([{ id: 'g.t.q', kind: 'param', title: 'query', depth: 0, meta: { type: 'string' } }]);
    expect(cmd.io).toEqual({
      kind: 'command',
      rows: [{ id: 'g.c.o', kind: 'options', title: 'Output', depth: 0 }, { id: 'g.c.o.j', kind: 'flag', title: '--json', depth: 1 }],
    });
  });
});

describe('buildNavView parts as nodes', () => {
  const mk = (kind: string, fqn: string, parts: NavPart[], parent: string | null = null): NavEntry => ({ kind, fqn, uid: null, title: fqn.split('.').pop()!, status: null, rank: 0, order: 0, parent, parts });
  const p = (fqn: string, kind: string, parts: NavPart[] = [], extra: Partial<NavPart> = {}): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts, ...extra });
  const model: NavModel = { edges: [], calls: [], groups: [{ fqn: 'g', title: 'G', technology: 'commander', word: 'CLI', entries: [
    mk('command', 'g.run', [p('g.run.opts', 'options', [p('g.run.opts.file', 'flag', [], { uid: 'u-f', status: 'planned', meta: { type: 'path', required: 'true' } })])]),
    mk('command', 'g.run.sub', [p('g.run.sub.body', 'body', [p('g.run.sub.body.q', 'param')])], 'g.run'),
    mk('command', 'g.orphan', [], 'g.elsewhere'),
  ] }] };
  const view = buildNavView(model);
  const byId = new Map(all(view.root).map(n => [n.id, n]));

  it('a part is a child of its entry or parent part with its kind, title, uid, status, type / in / required', () => {
    expect(byId.get('g.run.opts')).toMatchObject({ kind: 'options', name: 'opts' });
    expect(byId.get('g.run')!.children.map(c => c.id)).toEqual(['g.run.opts', 'g.run.sub']);
    expect(byId.get('g.run.opts.file')).toMatchObject({ kind: 'flag', uid: 'u-f', meta: { status: 'planned', type: 'path', required: 'true' } });
    expect(byId.get('g.run.sub.body.q')!.meta).toEqual({ in: 'body' });   // a param's `in` defaults by its parent
    expect(byId.get('g.run.sub.body.q')!.word).toBe('Field');
  });

  it('a subcommand sits under its command, not under the app; an unknown parent keeps it under the app; io is unchanged', () => {
    expect(byId.get('g')!.children.map(c => c.id)).toEqual(['g.run', 'g.orphan']);
    expect(byId.get('g.run')!.io!.rows.map(r => r.id)).toEqual(['g.run.opts', 'g.run.opts.file']);
    expect(byId.get('g')!.weight).toBe(3);
  });

  it('an entry description becomes the node detail (the box header says it); none: empty', () => {
    const m: NavModel = { edges: [], calls: [], groups: [{ fqn: 'g', title: 'G', technology: null, word: 'CLI', entries: [{ ...mk('command', 'g.a', []), description: 'Load products from a file' }, mk('command', 'g.b', [])] }] };
    const v = buildNavView(m).root.children[0].children;
    expect(v.map(n => n.detail)).toEqual(['Load products from a file', '']);
  });
});
