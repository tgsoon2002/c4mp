import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P14-T14: panel "Where from" section, empty-box reason, KIND_NOTE says "imports".
// Real viewer/panel.js in a vm with a minimal fake DOM (same harness style as viewer-panel-shared.test.ts).

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

function text(e: El): string {
  return [e._text, ...e.children.map(c => (c.nodeType === 3 ? c._text : text(c)))].join(' ').replace(/\s+/g, ' ').trim();
}

const mk = (id: string, kind: string, name: string, children: any[], extra: object = {}): any =>
  ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra });

function fixture() {
  const comp = mk('shop.api.orders', 'component', 'Orders', [mk('f', 'file', 'a.ts', [])]);
  const scanned = mk('shop.api', 'container', 'API', [comp], { origin: { kind: 'scanned', folder: 'api', manifest: 'api/package.json' } });
  const plan = mk('shop.web', 'container', 'Web', [mk('g', 'file', 'b.ts', [])], { origin: { kind: 'plan', planFile: 'c4/architecture.c4', planLine: 10, planEndLine: 12 } });
  const both = mk('shop.db', 'container', 'Db', [mk('h', 'file', 'c.ts', [])], { origin: { kind: 'both', folder: 'db', manifest: 'db/package.json', planFile: 'c4/architecture.c4', planLine: 13, planEndLine: 13 } });
  const rootBox = mk('_root', 'container', 'Root', [], { origin: { kind: 'scanned', folder: '.', rule: 'no manifest folder holds these files' } });
  const planEmpty = mk('shop.ghost', 'container', 'Ghost', [], { origin: { kind: 'plan', planFile: 'c4/architecture.c4', planLine: 20 } });
  const shared = mk('shop::shared', 'shared', 'Shared', [], { origin: { kind: 'synthetic', rule: 'files imported by claimed code' } });
  const unassigned = mk('shop::unassigned', 'unassigned', 'Unassigned', [], { origin: { kind: 'synthetic', rule: 'no claim' } });
  const bare = mk('shop.bare', 'container', 'Bare', []);
  const root = mk('shop', 'system', 'Shop', [scanned, plan, both, rootBox, planEmpty, shared, unassigned, bare]);
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null, edges: [] };
}

function run() {
  const panel = el('div');
  const els: Record<string, El> = { panel, search: el('input'), 'search-results': el('div'), legend: el('div') };
  let onSelect: (n: unknown) => void = () => {};
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
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: () => {}, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  const kid = (i: number) => sandbox.C4PM_DATA.root.children[i];
  return { panel, kid, show: (i: number) => { onSelect(kid(i)); return text(panel); } };
}

describe('P14-T14: panel "Where from"', () => {
  test('(a) scanned container: folder and manifest', () => {
    const t = run().show(0);
    expect(t).toContain('Where from');
    expect(t).toContain('Found by scanning the code. Folder: api. Manifest: api/package.json');
    expect(t).not.toContain('Empty:');
  });

  test('(b) plan container: file:line-endLine', () => {
    expect(run().show(1)).toContain('Declared in the plan: c4/architecture.c4:10-12');
  });

  test('(c) both: scan line and plan line; equal end line is not repeated', () => {
    const t = run().show(2);
    expect(t).toContain('Found by scanning the code. Folder: db');
    expect(t).toContain('Declared in the plan: c4/architecture.c4:13');
    expect(t).not.toContain('13-13');
  });

  test('(d) _root-style node: rule printed as Note, folder "." is the repo root; (e) empty scanned reason', () => {
    const t = run().show(3);
    expect(t).toContain('Note: no manifest folder holds these files');
    expect(t).toContain('Empty: no source files were parsed in the repo root.');
  });

  test('empty plan-only container: nothing links to code', () => {
    expect(run().show(4)).toContain('Empty: nothing in the plan links to code yet.');
  });

  test('synthetic shared: automatically + rule; (f) notes say imports, not calls it', () => {
    const h = run();
    const shared = h.show(5);
    expect(shared).toContain('Made by C4PM automatically (not in any .c4 file). Rule: files imported by claimed code');
    expect(shared).toContain("isn't written in any .c4 file");
    expect(shared).toContain('files owned by other components import');
    const un = h.show(6);
    expect(un).toContain('imports');
    expect(un).not.toContain('calls it');
    expect(un).toMatch(/No component claims/);
    expect(un).toContain('unplanned code');
    expect(un).toContain('dead code');
  });

  test('(g) node without origin: no Where from section', () => {
    expect(run().show(7)).not.toContain('Where from');
  });
});
