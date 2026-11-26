import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T6b: "Depends on" / "Used by" chips (Decision 6) from data.edges. Real viewer/panel.js in a vm with a
// minimal fake DOM (same harness style as viewer-panel-plan.test.ts).

interface El {
  tag: string; children: El[]; _classes: Set<string>; _text: string; _html: string; style: Record<string, string>;
  onclick?: (ev?: unknown) => void; nodeType?: number; textContent: string; title: string;
  appendChild(c: El): El; addEventListener(t?: string, fn?: unknown): void; focus(): void; classList: { add(c: string): void }; className: string; innerHTML: string;
}

function el(tag: string): El {
  const e: El = {
    tag, children: [], _classes: new Set(), _text: '', _html: '', style: {}, title: '',
    appendChild(c) { e.children.push(c); return c; },
    addEventListener() {},
    focus() {},
    classList: { add: (c: string) => { e._classes.add(c); } },
    get className() { return [...e._classes].join(' '); },
    set className(v: string) { e._classes = new Set(v.split(/\s+/).filter(Boolean)); },
    get textContent() { return e._text; },
    set textContent(v: string) { e._text = String(v); e.children = []; },
    get innerHTML() { return e._html; },
    set innerHTML(v: string) { e._html = String(v); e.children = []; },
  };
  return e;
}

function all(root: El, pred: (e: El) => boolean, out: El[] = []): El[] {
  for (const c of root.children) { if (pred(c)) out.push(c); all(c, pred, out); }
  return out;
}
function text(e: El): string {
  return [e._text, ...e.children.map(c => (c.nodeType === 3 ? c._text : text(c)))].join(' ').replace(/\s+/g, ' ').trim();
}

const mk = (id: string, kind: string, name: string, children: any[], extra: object = {}): any =>
  ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra });

function fixture() {
  const fn = mk('shop.api.orders.f', 'function', 'f', []);
  const orders = mk('shop.api.orders', 'component', 'Orders', [fn]);
  const users = mk('shop.api.users', 'component', 'Users', []);
  const api = mk('shop.api', 'container', 'API', [orders, users]);
  const ui = mk('shop.web.ui', 'component', 'UI', []);
  const web = mk('shop.web', 'container', 'Web', [ui]);
  const store = mk('shop.db.store', 'component', 'Store', []);
  const db = mk('shop.db', 'container', 'DB', [store]);
  const root = mk('shop', 'system', 'Shop', [api, web, db]);
  const edges = [
    { from: 'shop.api.orders', to: 'shop.api.users', weight: 2 },    // internal to API
    { from: 'shop.api.orders', to: 'shop.db.store', weight: 3 },
    { from: 'shop.api.users', to: 'shop.db.store', weight: 1 },
    { from: 'shop.web.ui', to: 'shop.api.orders', weight: 4 },
    { from: 'shop.web.ui', to: 'shop.api.users', weight: 1 },
    { from: 'shop.api.orders', to: 'shop.api.orders', weight: 1 },   // self
  ];
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null, edges };
}

function run(mutate?: (d: any) => void) {
  const panel = el('div');
  const els: Record<string, El> = { panel, search: el('input'), 'search-results': el('div'), legend: el('div') };
  let onSelect: (n: unknown) => void = () => {};
  const selected: string[] = [];
  const sandbox: Record<string, any> = {
    console: { ...console, debug: () => {}, warn: () => {}, log: () => {} },
    Set, Map, Array, Object, String, Number, JSON, Math, RegExp,
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: (t: string) => el(t),
      createTextNode: (t: string) => { const n = el('#text'); n.nodeType = 3; n._text = t; return n; },
      head: el('head'),
      addEventListener: () => {},
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
  };
  sandbox.window = sandbox;
  sandbox.C4PM_DATA = fixture();
  if (mutate) mutate(sandbox.C4PM_DATA);
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: (id: string) => { selected.push(id); }, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  return { panel, data: sandbox.C4PM_DATA, selected, select: (n: unknown) => onSelect(n) };
}

const labels = (p: El) => all(p, e => e.className.includes('pn-label')).map(text);

/** chips of one section ("Depends on" / "Used by"): ["Name ×N", ...], or ["none"] */
function chips(p: El, label: string): string[] | null {
  const secs = all(p, e => e.className === 'pn-section');
  const sec = secs.find(s => s.children[0] && text(s.children[0]) === label);
  if (!sec) return null;
  const btns = all(sec, e => e.className.includes('pn-dep-chip'));
  if (btns.length) return btns.map(text);
  return all(sec, e => e.className.includes('pn-note')).map(text);
}

describe('P13-T6b: Depends on / Used by', () => {
  test('component: chips per other component, label = title, xN = summed weights; self and none handled', () => {
    const h = run();
    const orders = h.data.root.children[0].children[0];
    h.select(orders);
    expect(chips(h.panel, 'Depends on')).toEqual(['Users ×2', 'Store ×3']);   // self edge excluded
    expect(chips(h.panel, 'Used by')).toEqual(['UI ×4']);
    h.select(h.data.root.children[1].children[0]);   // UI: nothing uses it
    expect(chips(h.panel, 'Used by')).toEqual(['none']);
  });

  test('component: weights of repeated edges to the same target are summed', () => {
    const h = run(d => { d.edges.push({ from: 'shop.web.ui', to: 'shop.api.orders', weight: 5 }); });
    h.select(h.data.root.children[1].children[0]);
    expect(chips(h.panel, 'Depends on')).toEqual(['Orders ×9', 'Users ×1']);
  });

  test('container: rolled up to container level, internal edges excluded, chips are containers', () => {
    const h = run();
    h.select(h.data.root.children[0]);   // API
    expect(chips(h.panel, 'Depends on')).toEqual(['DB ×4']);
    expect(chips(h.panel, 'Used by')).toEqual(['Web ×5']);
    h.select(h.data.root.children[1]);   // Web
    expect(chips(h.panel, 'Depends on')).toEqual(['API ×5']);
    expect(chips(h.panel, 'Used by')).toEqual(['none']);
  });

  test('container-to-container edge (claim-mode plan relation) is honoured', () => {
    const h = run(d => { d.edges.push({ from: 'shop.db', to: 'shop.web', weight: 1 }); });
    h.select(h.data.root.children[2]);   // DB
    expect(chips(h.panel, 'Depends on')).toEqual(['Web ×1']);
    expect(chips(h.panel, 'Used by')).toEqual(['API ×4']);
  });

  test('system: every edge is internal -> none / none', () => {
    const h = run();
    h.select(h.data.root);
    expect(chips(h.panel, 'Depends on')).toEqual(['none']);
    expect(chips(h.panel, 'Used by')).toEqual(['none']);
  });

  test('chips are buttons that goTo the target id', () => {
    const h = run();
    h.select(h.data.root.children[0]);
    const btn = all(h.panel, e => e.className.includes('pn-dep-chip'))[0];
    expect(btn.tag).toBe('button');
    btn.onclick!();
    expect(h.selected).toEqual(['shop.db']);
  });

  test('function node: section omitted', () => {
    const h = run();
    h.select(h.data.root.children[0].children[0].children[0]);
    expect(labels(h.panel).some(l => l === 'Depends on' || l === 'Used by')).toBe(false);
  });

  test('missing data.edges: no throw, none / none', () => {
    const h = run(d => { delete d.edges; });
    h.select(h.data.root.children[0].children[0]);
    expect(chips(h.panel, 'Depends on')).toEqual(['none']);
    expect(chips(h.panel, 'Used by')).toEqual(['none']);
  });

  test('duplicate node id in a different branch does not break the section', () => {
    const h = run(d => { d.root.children[1].children.push({ ...d.root.children[0].children[1], children: [] }); });
    h.select(h.data.root.children[0]);
    expect(chips(h.panel, 'Depends on')).not.toBeNull();
  });
});

/** rows of the "Declared relations" section as text, or null when the section is absent */
function relRows(p: El): string[] | null {
  const sec = all(p, e => e.className === 'pn-section').find(s => s.children[0] && text(s.children[0]) === 'Declared relations');
  return sec ? all(sec, e => e.className === 'pn-rel').map(text) : null;
}

describe('P13-T6c: Declared relations', () => {
  const rel = (from: string, to: string, label: string | null) => ({ from, to, label, file: 'a.c4', line: 1 });
  const withRels = (d: any) => {
    d.relations = [
      rel('shop.api.orders', 'shop.db.store', 'writes to'),
      rel('shop.web.ui', 'shop.api.orders', null),
      rel('shop.api.orders', 'shop.api.users', 'looks up'),
      rel('shop.api', 'shop.db', 'persists'),
      rel('shop.api.orders', 'shop.missing', 'ghost'),   // target not in tree: row skipped
    ];
  };

  test('component: own relations only, file order, "-> target - label"; no label -> no dash', () => {
    const h = run(withRels);
    h.select(h.data.root.children[0].children[0]);   // Orders
    expect(relRows(h.panel)).toEqual(['→ Store — writes to', '→ Users — looks up']);
    h.select(h.data.root.children[1].children[0]);   // UI
    expect(relRows(h.panel)).toEqual(['→ Orders']);
  });

  test('container: its own relations; placed after "Used by"', () => {
    const h = run(withRels);
    h.select(h.data.root.children[0]);   // API
    expect(relRows(h.panel)).toEqual(['→ DB — persists']);
    const order = labels(h.panel);
    expect(order.indexOf('Declared relations')).toBeGreaterThan(order.indexOf('Used by'));
  });

  test('none / missing data.relations / system / function: section omitted', () => {
    const h = run(withRels);
    h.select(h.data.root.children[0].children[1]);   // Users: no own relations
    expect(relRows(h.panel)).toBeNull();
    h.select(h.data.root);
    expect(relRows(h.panel)).toBeNull();
    h.select(h.data.root.children[0].children[0].children[0]);
    expect(relRows(h.panel)).toBeNull();
    const h2 = run();   // no relations key
    h2.select(h2.data.root.children[0].children[0]);
    expect(relRows(h2.panel)).toBeNull();
  });

  test('target name is a button that goTo the target id', () => {
    const h = run(withRels);
    h.select(h.data.root.children[0].children[0]);
    const btn = all(h.panel, e => e.className === 'pn-rel-target')[0];
    expect(btn.tag).toBe('button');
    btn.onclick!();
    expect(h.selected).toEqual(['shop.db.store']);
  });
});

describe('P13-T6c: buildParentMap visited guard', () => {
  test('same id in two branches: no throw, panel still renders', () => {
    const h = run(d => {
      const dup = () => mk('shop.api.orders', 'component', 'Orders', [mk('shop.api.orders.f', 'function', 'f', [])]);
      d.root.children[1].children.push(dup());   // second copy under Web
    });
    h.select(h.data.root.children[0].children[0]);
    expect(chips(h.panel, 'Depends on')).not.toBeNull();
  });

  test('id repeated as its own descendant (cycle-shaped): no throw', () => {
    const h = run(d => {
      d.root.children[0].children[0].children.push(mk('shop.api', 'container', 'API again', []));
    });
    h.select(h.data.root.children[0]);
    expect(chips(h.panel, 'Used by')).not.toBeNull();
  });
});
