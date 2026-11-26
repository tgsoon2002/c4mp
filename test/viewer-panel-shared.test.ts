import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T9a: shared node "used by X, Y" under each child; unassigned node rows "file#fn" + line count.
// Real viewer/panel.js in a vm with a minimal fake DOM (same harness style as viewer-panel-deps.test.ts).

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
  const orders = mk('shop.api.orders', 'component', 'Orders', []);
  const users = mk('shop.api.users', 'component', 'Users', []);
  const api = mk('shop.api', 'container', 'API', [orders, users]);
  const fmt = mk('shop::shared.fmt', 'function', 'fmt', [], { file: 'src/util.ts', line: 1, endLine: 5, weight: 5, usedBy: ['shop.api.orders', 'shop.api.users'] });
  const log = mk('shop::shared.log', 'function', 'log', [], { file: 'src/log.ts', line: 3, endLine: 4, weight: 2, usedBy: ['shop.api.orders', 'ghost.unresolved'] });
  const lone = mk('shop::shared.lone', 'function', 'lone', [], { file: 'src/lone.ts', line: 1, endLine: 1, weight: 1, usedBy: [] });
  const noUsedBy = mk('shop::shared.none', 'function', 'none', [], { file: 'src/none.ts', line: 1, endLine: 1, weight: 1 });
  const shared = mk('shop::shared', 'shared', 'Shared', [fmt, log, lone, noUsedBy]);
  const dead = mk('shop::unassigned.dead', 'function', 'dead', [], { file: 'src/dead.ts', line: 10, endLine: 19, weight: 10 });
  const noEnd = mk('shop::unassigned.noEnd', 'function', 'noEnd', [], { file: 'src/x.ts', line: 4, weight: 7 });
  const unassigned = mk('shop::unassigned', 'unassigned', 'Unassigned', [dead, noEnd]);
  const imp = mk('shop::shared.imp', 'function', 'imp', [], { file: 'src/imp.ts', line: 1, endLine: 2, weight: 2, importedBy: [{ file: 'src/a.ts', owner: 'shop.api.orders' }, { file: 'src/b.ts', owner: 'ghost.owner' }] });
  shared.children.push(imp);
  const origins = [{ folder: 'src', files: ['src/dead.ts', 'src/x.ts'] }, { folder: 'lib/deep', files: ['lib/deep/e.ts'] }];
  unassigned.origins = origins;
  unassigned.emptyFiles = ['lib/deep/e.ts'];
  const unassigned2 = mk('shop::unassigned2', 'unassigned', 'Unassigned', [], { origins: [{ folder: 'pub', files: ['pub/a.js', 'pub/b.js'] }], emptyFiles: ['pub/a.js', 'pub/b.js'] });
  const root = mk('shop', 'system', 'Shop', [api, shared, unassigned, unassigned2]);
  return { schemaVersion: 1, root, files: [{ path: 'src/dead.ts', kind: 'source', lines: [] }], planFindings: [], drift: null, edges: [] };
}

function run() {
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
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: (id: string) => { selected.push(id); }, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  return { panel, data: sandbox.C4PM_DATA, selected, select: (n: unknown) => onSelect(n) };
}

const usedByLines = (p: El) => all(p, e => e.className === 'pn-used-by').map(text);

describe('P13-T9a: shared node panel', () => {
  test('"used by" line under each child; none for empty/absent usedBy; static paragraph kept', () => {
    const h = run();
    h.select(h.data.root.children[1]);
    expect(usedByLines(h.panel)).toEqual(['used by Orders , Users', 'used by Orders , ghost.unresolved']);
    expect(text(h.panel)).toContain('To make it permanent');
  });

  test('resolved names are buttons that goTo; unresolved ids are plain text', () => {
    const h = run();
    h.select(h.data.root.children[1]);
    const links = all(h.panel, e => e.className === 'pn-used-by-link');
    expect(links.map(l => l.tag)).toEqual(['button', 'button', 'button']);
    links[1].onclick!();
    expect(h.selected).toEqual(['shop.api.users']);
    const raw = all(h.panel, e => e.className === 'pn-used-by-raw');
    expect(raw.map(text)).toEqual(['ghost.unresolved']);
    expect(raw[0].onclick).toBeUndefined();
  });
});

describe('P13-T9a: unassigned node panel', () => {
  test('rows are file#fn + line count (endLine-line+1, else weight); no used-by lines', () => {
    const h = run();
    h.select(h.data.root.children[2]);
    const rows = all(h.panel, e => e.className === 'pn-child-row');
    expect(rows.map(text)).toEqual(['src/dead.ts#dead 10 lines', 'src/x.ts#noEnd 7 lines']);
    expect(usedByLines(h.panel)).toEqual([]);
    expect(text(h.panel)).toContain('dead code');
  });
});

describe('P14-T15: Shared/Unassigned files by folder', () => {
  const rowsOf = (p: El) => all(p, e => e.className.includes('pn-folder-row')).map(text);
  const filesOf = (p: El) => all(p, e => e.className === 'pn-file-link');

  test('unassigned: folder rows with counts, file buttons, (no functions) suffix', () => {
    const h = run();
    h.select(h.data.root.children[2]);
    expect(rowsOf(h.panel)).toEqual(['src (2)', 'lib/deep (1)']);
    expect(filesOf(h.panel).map(text)).toEqual(['src/dead.ts', 'src/x.ts', 'lib/deep/e.ts (no functions)']);
    expect(text(h.panel)).toContain('Files by folder');
    expect(text(h.panel)).not.toContain('No function is unassigned');
  });

  test('clicking a file button opens the file panel (h2 = path)', () => {
    const h = run();
    h.select(h.data.root.children[2]);
    filesOf(h.panel)[0].onclick!();
    const h2 = all(h.panel, e => e.tag === 'h2');
    expect(h2.map(text)).toEqual(['src/dead.ts']);
  });

  test('empty unassigned explains itself', () => {
    const h = run();
    h.select(h.data.root.children[3]);
    expect(text(h.panel)).toContain('No function is unassigned. These 2 files have no parsed functions');
    expect(filesOf(h.panel).length).toBe(2);
  });

  test('folder row with no owning container does nothing', () => {
    const h = run();
    h.select(h.data.root.children[2]);
    all(h.panel, e => e.className.includes('pn-folder-row'))[0].onclick!();
    expect(h.selected).toEqual([]);
  });

  test('shared child with importedBy: "imported by file (owner name)", raw id when unresolved', () => {
    const h = run();
    h.select(h.data.root.children[1]);
    const lines = all(h.panel, e => e.className === 'pn-imported-by').map(text);
    expect(lines).toEqual(['imported by src/a.ts (Orders), src/b.ts (ghost.owner)']);
  });
});
