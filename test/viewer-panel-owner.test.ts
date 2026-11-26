import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T9c: function panel owner button + "how claimed" line. Real viewer/panel.js in a vm with a minimal fake DOM.

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
const fn = (id: string, name: string, file: string) => mk(id, 'function', name, [], { file, line: 2, endLine: 4 });

function fixture() {
  const fnClaimed = fn('o.fnA', 'a', 'src/a.ts');
  const fnFile = fn('o.fnB', 'b', 'src/a.ts');
  const fnFolder = fn('o.fnC', 'c', 'lib/c.ts');
  const fnMethod = fn('o.fnM', 'run', 'src/m.ts');
  const orders = mk('shop.orders', 'component', 'Orders', [fnClaimed, fnFile, fnFolder, fnMethod], {
    source: 'arch/sub/main.c4',
    claims: [
      { kind: 'folder', path: 'src/', fn: null, ownedCount: 0 },
      { kind: 'file', path: 'src/a.ts', fn: null, ownedCount: 1 },
      { kind: 'function', path: 'src/a.ts', fn: 'a', ownedCount: 1 },
      { kind: 'folder', path: 'lib/', fn: null, ownedCount: 1 },
      { kind: 'function', path: 'src/m.ts', fn: 'Svc.run', ownedCount: 1 },
    ],
  });
  const folderFn = fn('f.fn', 'x', 'p/x.ts');
  const folderComp = mk('shop.folder', 'component', 'Folder', [folderFn]);
  const shFn = fn('s.fn', 'fmt', 'src/u.ts');
  const shared = mk('shop::shared', 'shared', 'Shared', [shFn]);
  const unFn = fn('u.fn', 'dead', 'src/d.ts');
  const unassigned = mk('shop::unassigned', 'unassigned', 'Unassigned', [unFn]);
  const root = mk('shop', 'system', 'Shop', [orders, folderComp, shared, unassigned]);
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null, edges: [] };
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
  const kids = sandbox.C4PM_DATA.root.children;
  const open = (n: any) => onSelect(n);
  return { panel, selected, open, orders: kids[0], folder: kids[1], shared: kids[2], unassigned: kids[3] };
}

const howLine = (p: El) => all(p, e => e.className.includes('pn-owner-how')).map(text);
const ownerBtns = (p: El) => all(p, e => e.className === 'pn-owner').flatMap(w => all(w, e => e.tag === 'button'));

describe('P13-T9c: function panel owner', () => {
  test('claim-mode owner is a button to the component id; most specific claim wins', () => {
    const h = run();
    h.open(h.orders.children[0]);
    const btns = ownerBtns(h.panel);
    expect(btns).toHaveLength(1);
    btns[0].onclick!();
    expect(h.selected).toEqual(['shop.orders']);
    expect(howLine(h.panel)).toEqual(['claimed by function link src/a.ts#a in main.c4']);
  });

  test.each([
    [1, 'claimed by file link src/a.ts in main.c4'],
    [2, 'claimed by folder link lib/ in main.c4'],
    [3, 'claimed by function link src/m.ts#Svc.run in main.c4'],
  ])('child %i how-claimed text', (idx, expected) => {
    const h = run();
    h.open(h.orders.children[idx]);
    expect(howLine(h.panel)).toEqual([expected]);
  });

  test('folder-mode component (no claims): owner button, no how-claimed line', () => {
    const h = run();
    h.open(h.folder.children[0]);
    expect(ownerBtns(h.panel).map(b => b.textContent)).toEqual(['Folder']);
    expect(howLine(h.panel)).toEqual([]);
  });

  test('shared / unassigned owner: no link, explanatory text', () => {
    const h = run();
    h.open(h.shared.children[0]);
    expect(ownerBtns(h.panel)).toHaveLength(0);
    expect(all(h.panel, e => e.className === 'pn-owner').map(text)).toEqual(['owner: Shared auto: used by other components']);
    expect(howLine(h.panel)).toEqual(['auto: used by other components']);
    h.panel.children.length = 0;
    h.open(h.unassigned.children[0]);
    expect(ownerBtns(h.panel)).toHaveLength(0);
    expect(howLine(h.panel)).toEqual(['nothing claims it']);
  });
});
