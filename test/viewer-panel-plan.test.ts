import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T7: "The plan" section (ViewNode.planBlock). Real viewer/panel.js in a vm with a minimal fake DOM
// (same harness style as viewer-panel-file.test.ts).

interface El {
  tag: string; children: El[]; _classes: Set<string>; _text: string; _html: string; style: Record<string, string>;
  onclick?: (ev?: unknown) => void; nodeType?: number; textContent: string;
  appendChild(c: El): El; addEventListener(t?: string, fn?: unknown): void; focus(): void; classList: { add(c: string): void }; className: string; innerHTML: string;
}

function el(tag: string): El {
  const e: El = {
    tag, children: [], _classes: new Set(), _text: '', _html: '', style: {},
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

const PLAN = { file: 'arch/main.c4', startLine: 4, endLine: 6, lines: ['  extend shop.api {', '    // the "orders" part', '  }'] };

function fixture() {
  const comp = mk('shop.api.orders', 'component', 'Orders', [], { claims: [{ kind: 'file', path: 'a.ts' }], source: 'arch/main.c4', planBlock: PLAN });
  const cont = mk('shop.api', 'container', 'API', [comp], { planBlock: PLAN });
  const emptyCont = mk('shop.web', 'container', 'Web', [], { planBlock: { file: 'arch/main.c4', startLine: 9, endLine: 9, lines: ['  web = container "Web"'] } });
  const bareCont = mk('shop.bare', 'container', 'Bare', [], {});   // no planBlock (folder mode / ambiguous id)
  const root = mk('shop', 'system', 'Shop', [cont, emptyCont, bareCont], { planBlock: { file: 'arch/main.c4', startLine: 2, endLine: 12, lines: ['  shop = system "Shop"'] } });
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null };
}

function run(mutate?: (d: any) => void) {
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
  if (mutate) mutate(sandbox.C4PM_DATA);
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: () => {}, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  return { panel, data: sandbox.C4PM_DATA, select: (n: unknown) => onSelect(n) };
}

const labels = (p: El) => all(p, e => e.className.includes('pn-label')).map(text);

describe('P13-T7: "The plan" section', () => {
  test('component: section after Claims with file, L<start>–L<end>, numbered c4-coloured lines from startLine', () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);
    const ls = labels(h.panel);
    expect(ls.indexOf('Claims arch/main.c4')).toBeGreaterThanOrEqual(0);
    expect(ls.findIndex(l => l.startsWith('The plan'))).toBe(ls.indexOf('Claims arch/main.c4') + 1);
    expect(ls).toContain('The plan arch/main.c4');
    expect(text(h.panel)).toContain('L4–L6');
    const rows = all(h.panel, e => e.className.includes('pn-ln'));
    expect(rows).toHaveLength(3);
    expect(all(rows[0], e => e.className.includes('pn-no')).map(text)).toEqual(['4']);
    expect(all(rows[2], e => e.className.includes('pn-no')).map(text)).toEqual(['6']);
    expect(rows[0].children[1]._html).toBe('  <span class="pn-kw">extend</span> shop.api {');
    expect(rows[1].children[1]._html).toBe('    <span class="pn-cm">// the &quot;orders&quot; part</span>');
    expect(text(h.panel)).not.toContain('No code mapped yet');   // components never get the hint
  });

  test('container/system with children: plan shown, no template hint', () => {
    const h = run();
    h.select(h.data.root.children[0]);
    expect(labels(h.panel)).toContain('The plan arch/main.c4');
    expect(text(h.panel)).not.toContain('No code mapped yet');
    h.select(h.data.root);
    expect(text(h.panel)).toContain('L2–L12');
    expect(text(h.panel)).not.toContain('No code mapped yet');
  });

  test('container with zero children: template hint uses real `extend <fqn> { … }` spelling', () => {
    const h = run();
    h.select(h.data.root.children[1]);
    expect(text(h.panel)).toContain('L9–L9');
    expect(text(h.panel)).toContain('No code mapped yet. Add an `extend <system-id>.<container-id> { … }` block with components that link to code.');
  });

  test('absent planBlock (folder mode / ambiguous id): section omitted, no throw', () => {
    const h = run();
    h.select(h.data.root.children[2]);
    expect(labels(h.panel).some(l => l.startsWith('The plan'))).toBe(false);
    expect(text(h.panel)).not.toContain('No code mapped yet');
    expect(text(h.panel)).toContain('Bare');
  });

  test('malformed planBlock (empty / non-array lines) is treated as absent', () => {
    const h = run(d => {
      d.root.children[0].planBlock = { file: 'x.c4', startLine: 1, endLine: 1, lines: [] };
      d.root.children[1].planBlock = { file: 'x.c4', startLine: 1, endLine: 1 };
    });
    h.select(h.data.root.children[0]);
    expect(labels(h.panel).some(l => l.startsWith('The plan'))).toBe(false);
    h.select(h.data.root.children[1]);
    expect(labels(h.panel).some(l => l.startsWith('The plan'))).toBe(false);
  });
});
