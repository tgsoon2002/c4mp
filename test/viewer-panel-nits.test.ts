import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T12c: right-panel nits (summary list vs chips, container count/plurals, empty-container placeholders,
// duplicate weight text, plan code block CSS). Real viewer/panel.js in a vm with a minimal fake DOM.

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
  return [e._text, e._html, ...e.children.map(c => (c.nodeType === 3 ? c._text : text(c)))].join(' ').replace(/\s+/g, ' ').trim();
}
const byClass = (p: El, cls: string) => all(p, e => e._classes.has(cls));

const mk = (id: string, kind: string, name: string, children: any[], extra: object = {}): any =>
  ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra });

function fixture() {
  const f1 = mk('c.f1', 'function', 'big', [], { file: 'src/a.ts', line: 1, endLine: 438, weight: 438, detail: '438 lines',
    findings: [{ severity: 'critical', rule: 'r-node', message: 'node crit' }] });
  const f2 = mk('c.f2', 'function', 'tiny', [], { file: 'src/a.ts', line: 500, endLine: 500, weight: 1, detail: '1 line' });
  const comp = mk('s.api.comp', 'component', 'Comp', [f1, f2], { weight: 439 });
  const api = mk('s.api', 'container', 'Api', [comp], { detail: 'Node.js', weight: 439 });
  const empty = mk('s.empty', 'container', 'Empty', [], { detail: 'no parsed code', weight: 1 });
  const unk = mk('s.unk', 'container', 'Unk', [], { detail: 'Unknown', weight: 1 });
  const root = mk('s', 'system', 'Sys', [api, empty, unk], { weight: 441 });
  // 20 plan findings (critical) on top of 1 node finding -> list capped at 15 with "... N more"
  const planFindings = Array.from({ length: 20 }, (_, i) => ({ severity: 'critical', rule: 'pf', message: 'plan ' + i }));
  return {
    schemaVersion: 1, title: 'Sys', subtitle: 'sub', root, files: [], drift: null, edges: [], planFindings,
    summary: 'Sys — 3 containers, 1 components, 1 files, 1 code elements, 1 component edges, 1 unresolved imports',
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
  sandbox.C4PM_DATA = fixture();
  let selected: string | null = null;
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: (id: string) => { selected = id; }, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  const root = sandbox.C4PM_DATA.root;
  const open = (n: any) => { panel.children.length = 0; onSelect(n); };
  return { panel, open, root, api: root.children[0], comp: root.children[0].children[0], empty: root.children[1], unk: root.children[2], selected: () => selected };
}

describe('P13-T12c: panel nits', () => {
  test('1: summary list shows what the chips count (node + plan findings), capped with "… N more"', () => {
    const h = run();
    h.open(null);
    expect(byClass(h.panel, 'pn-count').map(text)).toContain('21 critical');
    const titles = byClass(h.panel, 'pn-summary-title').map(text);
    expect(titles).toContain('Critical (21)');
    expect(byClass(h.panel, 'pn-finding-critical')).toHaveLength(15);
    expect(byClass(h.panel, 'pn-finding-more').map(text)).toEqual(['… 6 more']);
  });

  test('1: node finding in the list links to its node', () => {
    const h = run();
    h.open(null);
    const links = byClass(h.panel, 'pn-finding-node');
    expect(links.map(text)).toEqual(['big']);
    links[0].onclick!();
    expect(h.selected()).toBe('c.f1');
  });

  test('2/3: header line count matches chip, correct singular/plural', () => {
    const h = run();
    h.open(null);
    expect(byClass(h.panel, 'pn-count').map(text).slice(0, 3)).toEqual(['3 containers', '1 component', '2 functions']);
    const header = all(h.panel, e => e._text.startsWith('Sys — '))[0];
    expect(header._text).toBe('Sys — 3 containers, 1 component, 1 file, 1 code element, 1 component edge, 1 unresolved import');
  });

  test('3: weight bar and child rows say "1 line"', () => {
    const h = run();
    h.open(h.comp.children[1]);
    const label = byClass(h.panel, 'pn-bar-label')[0]._html;
    expect(label).toContain('<span>1 line</span>');
    expect(label).not.toContain('1 lines');
    h.open(h.comp);
    expect(byClass(h.panel, 'pn-child-weight').map(text)).toEqual(['438 lines', '1 line']);
  });

  test('5: empty / unknown container hides weight bar and Tech pill; known tech still shows', () => {
    const h = run();
    h.open(h.empty);
    expect(byClass(h.panel, 'pn-bar-section')).toHaveLength(0);
    expect(byClass(h.panel, 'pn-meta-pills')).toHaveLength(0);
    h.open(h.unk);
    expect(byClass(h.panel, 'pn-meta-pills')).toHaveLength(0);
    h.open(h.api);
    expect(byClass(h.panel, 'pn-meta-pills').map(text)).toEqual(['Tech: Node.js']);
    expect(byClass(h.panel, 'pn-bar-section')).toHaveLength(1);
  });

  test('6: child row does not repeat "N lines" in name and weight column', () => {
    const h = run();
    h.open(h.comp);
    const rows = byClass(h.panel, 'pn-child-row').map(text);
    expect(rows).toEqual(['big() 438 lines', 'tiny() 1 line']);
    expect(byClass(h.panel, 'pn-child-name').map(text)).toEqual(['big()', 'tiny()']);
  });

  test('4/7: css for used-by links and scrollable plan code block', () => {
    const src = fs.readFileSync(path.join(__dirname, '../viewer/panel.css'), 'utf8');
    expect(src).toMatch(/\.pn-used-by-link \{[^}]*text-decoration: underline/);
    expect(src).toMatch(/\.pn-used-by \{[^}]*padding: 4px 12px 8px/);
    const code = /\.pn-code \{([^}]*)\}/.exec(src)![1];
    expect(code).toContain('overflow-x: auto');
    expect(Number(/max-height: (\d+)px/.exec(code)![1])).toBeGreaterThanOrEqual(30 * 18.4);
  });
});
