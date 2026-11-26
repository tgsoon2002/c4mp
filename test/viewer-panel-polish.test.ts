import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { buildKindWords } from '../src/view/kindWords';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T12b: panel polish (summary counts, breadcrumb chips, meta pills, claim counts, Owns list).
// Real viewer/panel.js in a vm with a minimal fake DOM.

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
const byClass = (p: El, cls: string) => all(p, e => e._classes.has(cls));

const mk = (id: string, kind: string, name: string, children: any[], extra: object = {}): any =>
  ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra });
const fn = (id: string, name: string, file: string) => mk(id, 'function', name, [], { file, line: 2, endLine: 4 });

function fixture() {
  const fa = fn('o.fa', 'alpha', 'src/a.ts');
  const fb = fn('o.fb', 'beta', 'src/a.ts');
  const fc = fn('o.fc', 'gamma', 'src/c.ts');
  const sliceA = mk('shop.orders::slice::src/a.ts', 'slice', 'a.ts', [fa, fb], { file: 'src/a.ts' });
  const sliceC = mk('shop.orders::slice::src/c.ts', 'slice', 'c.ts', [fc], { file: 'src/c.ts' });
  const orders = mk('shop.orders', 'component', 'Orders', [sliceA, sliceC], {
    meta: { status: 'In Progress', owner: 'kim', sprint: 'S4' },
    claims: [
      { kind: 'file', path: 'src/a.ts', fn: null, ownedCount: 2 },
      { kind: 'file', path: 'src/c.ts', fn: null, ownedCount: 1 },
      { kind: 'file', path: 'src/lost.ts', fn: null, ownedCount: 0 },
      { kind: 'function', path: 'src/z.ts', fn: 'zed', ownedCount: 0 },
    ],
    lostClaims: [
      { path: 'src/lost.ts', fn: 'one', lostTo: 'shop.billing' },
      { path: 'src/z.ts', fn: 'zed', lostTo: 'ghost.id' },
    ],
    findings: [{ severity: 'warning', rule: 'r1', message: 'warn msg' }],
  });
  const billing = mk('shop.billing', 'component', 'Billing', [], {});
  const api = mk('shop.api', 'container', 'Api', [orders, billing], { detail: 'Node.js / TypeScript', meta: { priority: 'P1' } });
  const root = mk('shop', 'system', 'Shop', [api]);
  return {
    schemaVersion: 1, title: 'Shop', subtitle: 'sub', summary: 'sum', root, files: [], drift: null, edges: [],
    planFindings: [{ severity: 'critical', rule: 'pf', message: 'plan crit' }],
  };
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
  sandbox.C4PM_DATA = { ...fixture(), kindWords: buildKindWords() };   // b142: the chips come from the injected kind table (mode.js)
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: () => {}, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox, { mode: true });
  const api = sandbox.C4PM_DATA.root.children[0];
  const orders = api.children[0];
  const open = (n: any) => { panel.children.length = 0; onSelect(n); };
  return { panel, open, api, orders };
}

describe('P13-T12b: panel polish', () => {
  test('summary: how-built paragraph + counts from data', () => {
    const h = run();
    h.open(null);
    expect(byClass(h.panel, 'pn-how').map(text)[0]).toContain('How this map is built');
    expect(byClass(h.panel, 'pn-count').map(text)).toEqual([
      '1 container', '2 components', '3 functions', '1 critical', '1 warning', '0 info',
    ]);
  });

  test('breadcrumb: level chip before each crumb', () => {
    const h = run();
    h.open(h.orders);
    expect(byClass(h.panel, 'pn-crumb-chip').map(text)).toEqual(['C1', 'C2', 'C3']);
    expect(byClass(h.panel, 'pn-crumb').map(text)).toEqual(['Shop', 'Api', 'Orders']);
  });

  test('component meta: status pill + Owner/Sprint, nothing invented', () => {
    const h = run();
    h.open(h.orders);
    expect(byClass(h.panel, 'pn-status').map(text)).toEqual(['In Progress']);
    expect(byClass(h.panel, 'pn-status')[0]._classes.has('pn-status-in-progress')).toBe(true);
    expect(byClass(h.panel, 'pn-meta-pills').map(text)).toEqual(['In Progress Owner: kim Sprint: S4']);
  });

  test('container meta: Priority + Tech from detail; component without meta shows no pills', () => {
    const h = run();
    h.open(h.api);
    expect(byClass(h.panel, 'pn-meta-pills').map(text)).toEqual(['Priority: P1 Tech: Node.js / TypeScript']);
    h.open(h.api.children[1]);
    expect(byClass(h.panel, 'pn-meta-pills')).toHaveLength(0);
  });

  test('claims: "N fn" and "0 · lost to X" (title resolved, else id)', () => {
    const h = run();
    h.open(h.orders);
    expect(byClass(h.panel, 'pn-claim-meta').map(text)).toEqual([
      '2 fn', '1 fn', '0 fn · lost to Billing', '0 fn · lost to ghost.id',
    ]);
    expect(byClass(h.panel, 'pn-claim-lost')).toHaveLength(2);
  });

  test('Owns: one row per file with function names', () => {
    const h = run();
    h.open(h.orders);
    expect(byClass(h.panel, 'pn-owns-file').map(text)).toEqual(['src/a.ts alpha, beta', 'src/c.ts gamma']);
  });

  test('warning finding no longer uses the light-blue accent background', () => {
    const src = fs.readFileSync(path.join(__dirname, '../viewer/panel.css'), 'utf8');
    const m = /\.pn-finding-warning \{([^}]*)\}/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain('accentSoft');
    expect(m![1]).toContain('color: var(--ink)');
  });
});
