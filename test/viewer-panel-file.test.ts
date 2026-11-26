import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P13-T8a: window.C4PM_PANEL.showFile(path). Runs the REAL viewer/panel.js in a vm against a minimal
// fake DOM and a stub C4PM_MAP; asserts on the DOM panel.js builds. (Layout is not visible here.)

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

const f = (name: string, severity = 'warning') => ({ severity, rule: 'r-' + name, message: 'msg ' + name });
function fn(id: string, name: string, file: string, line: number, endLine: number, extra: object = {}): any {
  return { id, kind: 'function', name, detail: '', weight: 1, children: [], x: 0, y: 0, w: 0, h: 0, file, line, endLine, callsAvailable: false, ...extra };
}

function fixture() {
  const shared = fn('a.ts#foo', 'foo', 'a.ts', 1, 5);
  const bar = fn('a.ts#bar', 'bar', 'a.ts', 10, 20, { findings: [f('bar')] });
  const baz = fn('a.ts#baz', 'baz', 'a.ts', 30, 40);
  const mk = (id: string, kind: string, name: string, children: any[], extra: object = {}): any =>
    ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra });
  const fileNode = mk('a.ts', 'file', 'a.ts', [shared, bar, baz], { file: 'a.ts', findings: [f('file')] });
  const sliceA = mk('A::slice::a.ts', 'slice', 'a.ts', [shared, bar], { file: 'a.ts', findings: [f('file')] });   // distinct finding obj, same content
  const sliceB = mk('B::slice::a.ts', 'slice', 'a.ts', [baz], { file: 'a.ts' });
  const compA = mk('A', 'component', 'Alpha', [sliceA]);
  const compB = mk('B', 'component', 'Beta', [sliceB]);
  const cont = mk('c', 'container', 'Cont', [compA, compB]);
  const root = mk('system', 'system', 'Sys', [cont]);
  // folder-mode style file nodes directly under a component
  const solo = fn('s.ts#only', 'only', 's.ts', 3, 3);
  const soloFile = mk('s.ts', 'file', 's.ts', [solo], { file: 's.ts', findings: [f('solo')] });
  const compC = mk('C', 'component', 'Gamma', [soloFile]);
  cont.children.push(compC);
  const files = [
    { path: 'a.ts', kind: 'source', owners: ['A', 'B'], flag: 'split' },
    { path: 's.ts', kind: 'source', owners: ['C'] },
    { path: 'u.ts', kind: 'source', owners: [], flag: 'unassigned' },
    { path: 'p.c4', kind: 'plan', owners: [], flag: 'c4' },
  ];
  return { schemaVersion: 1, root, files, planFindings: [], drift: null };
}

function run(mutate?: (d: any) => void) {
  const panel = el('div');
  const els: Record<string, El> = { panel, search: el('input'), 'search-results': el('div'), legend: el('div') };
  const calls: string[] = [];
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
    flyTo: (id: string) => calls.push('fly:' + id),
    select: (id: string) => calls.push('sel:' + id),
    overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  return { sandbox, panel, calls, data: sandbox.C4PM_DATA, select: (n: unknown) => onSelect(n) };
}

describe('P13-T8a: C4PM_PANEL.showFile', () => {
  test('panel.js exposes window.C4PM_PANEL.showFile', () => {
    expect(typeof run().sandbox.C4PM_PANEL.showFile).toBe('function');
  });

  test('split file: crumb, path, owners sentence, functions with line ranges + owner, deduped findings', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('a.ts');
    const t = text(h.panel);
    expect(t).toContain('source file');
    expect(t).toContain('a.ts');
    expect(t).toContain('split between Alpha and Beta');
    // all three functions, sorted by line, with ranges
    const rows = all(h.panel, e => e.className.includes('pn-child-row'));
    expect(rows.map(r => text(r))).toEqual([
      'foo() L1–L5 Alpha',
      'bar() L10–L20 Alpha',
      'baz() L30–L40 Beta',
    ]);
    // findings: bar's + file node's (+ slice's equal-content but distinct object -> counted; identity dedupe only)
    const msgs = all(h.panel, e => e.className.includes('pn-finding-message')).map(e => text(e));
    expect(msgs).toEqual(expect.arrayContaining(['msg bar', 'msg file']));
    expect(msgs.filter(m => m === 'msg bar')).toHaveLength(1);
  });

  test('owner names are clickable and route through goTo (flyTo + select)', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('a.ts');
    const betaBtn = all(h.panel, e => e.tag === 'button' && text(e) === 'Beta')[0];
    betaBtn.onclick!({ stopPropagation() {} });
    expect(h.calls).toEqual(['fly:B', 'sel:B']);
    h.calls.length = 0;
    const row = all(h.panel, e => e.className.includes('pn-child-row') && text(e).startsWith('bar()'))[0];
    row.onclick!();
    expect(h.calls).toEqual(['fly:a.ts#bar', 'sel:a.ts#bar']);
  });

  test('single-owner folder-mode file: "owned by X" and its own file-node finding', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('s.ts');
    const t = text(h.panel);
    expect(t).toContain('owned by Gamma');
    expect(t).toContain('msg solo');
    expect(t).toContain('only() L3');
  });

  test('ownerless source file and unknown path degrade without throwing', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('u.ts');
    expect(text(h.panel)).toContain('no owner');
    expect(all(h.panel, e => e.className.includes('pn-child-row'))).toHaveLength(0);
    h.sandbox.C4PM_PANEL.showFile('nope.ts');
    expect(text(h.panel)).toContain('not in the scan');
  });

  test('plan file without embedded lines: crumb, path, note, says text not embedded', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('p.c4');
    const t = text(h.panel);
    expect(t).toContain('plan file');
    expect(t).toContain('p.c4');
    expect(t).toContain('The architecture lives here, not inside the code folders');
    expect(t).toContain('not embedded');
    expect(t).not.toContain('owned by');
    expect(all(h.panel, e => e.className.includes('pn-ln'))).toHaveLength(0);
  });

  test('P13-T8b plan file with lines: numbered code block, c4 colouring, escaping, no truncation row', () => {
    const h = run();
    const pf = h.data.files.find((x: any) => x.path === 'p.c4');
    pf.lines = ['// a <b> comment', 'model {', '  system s "Big & <x>" // tail', '}'];
    h.sandbox.C4PM_PANEL.showFile('p.c4');
    const rows = all(h.panel, e => e.className.includes('pn-ln'));
    expect(rows).toHaveLength(4);
    expect(text(rows[3])).toBe('4');   // fake DOM does not expose innerHTML as text
    expect(rows[3].children[1]._html).toBe('}');
    expect(all(rows[0], e => e.className.includes('pn-no')).map(text)).toEqual(['1']);
    const html = (r: El) => r.children[1]._html;
    expect(html(rows[0])).toBe('<span class="pn-cm">// a &lt;b&gt; comment</span>');
    expect(html(rows[1])).toBe('<span class="pn-kw">model</span> {');
    expect(html(rows[2])).toBe('  <span class="pn-kw">system</span> s <span class="pn-str">&quot;Big &amp; &lt;x&gt;&quot;</span> <span class="pn-cm">// tail</span>');
    expect(text(h.panel)).not.toContain('more lines');
  });

  test('P13-BUG-id-collision: system and container sharing an id do not loop (breadcrumb, owner label, load)', () => {
    const h = run(d => {
      const mk = (id: string, kind: string, name: string, children: any[]): any =>
        ({ id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false });
      const f1 = fn('a.ts#foo', 'foo', 'a.ts', 1, 5);
      const comp = mk('comp', 'component', 'Comp', [mk('comp::slice::a.ts', 'slice', 'a.ts', [f1])]);
      const cont = mk('files-demo', 'container', 'Demo container', [comp]);
      d.root = mk('files-demo', 'system', 'Demo system', [cont]);   // same id as its child
      d.files = [{ path: 'a.ts', kind: 'source', owners: ['comp'] }];
    });
    const root = h.data.root;
    h.select(root);                                   // would hang before the guard
    expect(text(h.panel)).toContain('Demo system');
    h.select(root.children[0]);                       // container with the shared id
    expect(text(h.panel)).toContain('Demo container');
    const fnode = root.children[0].children[0].children[0].children[0];
    h.select(fnode);                                  // function: breadcrumb + owner label walk
    expect(text(h.panel)).toContain('Comp');
    h.sandbox.C4PM_PANEL.showFile('a.ts');
    expect(text(h.panel)).toContain('owned by Comp');
  });

  test('P13-T8b truncated plan file shows "… N more lines" row; "//" inside a string is not a comment', () => {
    const h = run();
    const pf = h.data.files.find((x: any) => x.path === 'p.c4');
    pf.lines = ['link "http://x.y"'];
    pf.truncated = 314;
    h.sandbox.C4PM_PANEL.showFile('p.c4');
    expect(text(h.panel)).toContain('… 314 more lines');
    const row = all(h.panel, e => e.className.includes('pn-ln'))[0];
    expect(row.children[1]._html).toBe('<span class="pn-kw">link</span> <span class="pn-str">&quot;http://x.y&quot;</span>');
  });

  test('slice select of the same file (tree.js flyTo+select) keeps the file view; other selection restores normal', () => {
    const h = run();
    const alpha = h.data.root.children[0].children[0];
    h.sandbox.C4PM_PANEL.showFile('a.ts');
    h.select(alpha.children[0]);   // A::slice::a.ts
    expect(text(h.panel)).toContain('split between Alpha and Beta');
    h.select(alpha.children[0]);   // still the same file
    expect(text(h.panel)).toContain('split between');
    h.select(alpha);               // different node clears the marker
    expect(text(h.panel)).not.toContain('split between');
    h.select(alpha.children[0]);   // marker gone: slice now renders normally
    expect(text(h.panel)).not.toContain('split between');
    // a slice of a different file does not keep it
    h.sandbox.C4PM_PANEL.showFile('s.ts');
    h.select(alpha.children[0]);
    expect(text(h.panel)).not.toContain('owned by Gamma');
  });

  test('selecting a map node afterwards restores the normal node panel', () => {
    const h = run();
    h.sandbox.C4PM_PANEL.showFile('a.ts');
    expect(text(h.panel)).toContain('split between');
    h.select(h.data.root.children[0].children[0]);   // component Alpha
    const t = text(h.panel);
    expect(t).not.toContain('split between');
    expect(t).toContain('Alpha');
  });
});
