import vm from 'vm';
import { loadPanelScripts } from './helpers/panelScripts';

// P14-T16: panel uid row, "Copy uid", "Copy remove command", uid in search.
// Real viewer/panel.js in a vm with a minimal fake DOM (harness copied from viewer-panel-plan.test.ts).

interface El {
  tag: string; children: El[]; _classes: Set<string>; _text: string; _html: string; style: Record<string, string>;
  onclick?: (ev?: unknown) => void; nodeType?: number; textContent: string; value?: string; _l: Record<string, ((ev: unknown) => void)[]>;
  appendChild(c: El): El; addEventListener(t: string, fn: (ev: unknown) => void): void; focus(): void; select(): void;
  classList: { add(c: string): void }; className: string; innerHTML: string;
}

function el(tag: string): El {
  const e: El = {
    tag, children: [], _classes: new Set(), _text: '', _html: '', style: {}, _l: {},
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, fn) { (e._l[t] = e._l[t] || []).push(fn); },
    focus() {},
    select() {},
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

const UID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

function fixture() {
  const comp = mk('shop.api.orders', 'component', 'Orders', [], { uid: UID, origin: { kind: 'plan' }, claims: [{ kind: 'file', path: 'a.ts' }] });
  const planCont = mk('shop.api', 'container', 'API', [comp], { origin: { kind: 'plan' } });
  const scannedCont = mk('shop.worker', 'container', 'Worker', [], { origin: { kind: 'scanned', folder: 'worker', manifest: 'worker/package.json' } });
  const bareCont = mk('shop.bare', 'container', 'Bare', [], {});
  const fileNode = mk('src/a.ts', 'file', 'a.ts', [], { file: 'src/a.ts' });
  const fnNode = mk('src/a.ts#run', 'function', 'run', [], { file: 'src/a.ts', line: 3 });
  const root = mk('shop', 'system', 'Shop', [planCont, scannedCont, bareCont, fileNode, fnNode], { origin: { kind: 'plan' } });
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null, repoPath: '/r/my repo' };
}

interface Harness {
  panel: El; search: El; results: El; data: any; select: (n: unknown) => void;
  copied: () => string | undefined; execCalls: string[]; body: El[];
}

function run(opts: { clipboard?: 'ok' | 'none' | 'reject'; execReturn?: boolean } = {}): Harness {
  const panel = el('div');
  const search = el('input');
  const results = el('div');
  const els: Record<string, El> = { panel, search, 'search-results': results, legend: el('div') };
  let onSelect: (n: unknown) => void = () => {};
  let copied: string | undefined;
  const execCalls: string[] = [];
  const body: El[] = [];
  const navigator: Record<string, any> = {};
  if (opts.clipboard !== 'none') {
    navigator.clipboard = {
      writeText: (s: string) => {
        if (opts.clipboard === 'reject') return Promise.reject(new Error('blocked'));
        copied = s;
        return Promise.resolve();
      },
    };
  }
  const sandbox: Record<string, any> = {
    console: { ...console, debug: () => {}, warn: () => {}, log: () => {} },
    Set, Map, Array, Object, String, Number, JSON, Math, RegExp, Error, Promise,
    navigator,
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: (t: string) => el(t),
      createTextNode: (t: string) => { const n = el('#text'); n.nodeType = 3; n._text = t; return n; },
      head: el('head'),
      body: {
        appendChild: (c: El) => { body.push(c); return c; },
        removeChild: (c: El) => { body.splice(body.indexOf(c), 1); return c; },
      },
      execCommand: (cmd: string) => {
        if (cmd === 'copy') execCalls.push(body.map(b => b.value || '').join('|'));
        return opts.execReturn !== false;
      },
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
  return {
    panel, search, results, data: sandbox.C4PM_DATA,
    select: (n: unknown) => onSelect(n),
    copied: () => copied,
    execCalls,
    body,
  };
}

const uidRows = (p: El) => all(p, e => e.className.includes('pn-uid'));
const buttons = (p: El) => all(p, e => e.tag === 'button');
const buttonByText = (p: El, t: string) => buttons(p).find(b => text(b) === t);
const flush = () => new Promise(r => setImmediate(r));

describe('P14-T16: panel uid row and copy buttons', () => {
  test('component with uid shows "uid <uuid>" and Copy uid copies exactly the uuid', async () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);
    const rows = uidRows(h.panel);
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toContain('uid ' + UID);
    const copyBtn = buttonByText(h.panel, 'Copy uid');
    expect(copyBtn).toBeDefined();
    copyBtn!.onclick!();
    await flush();
    expect(h.copied()).toBe(UID);
    expect(text(buttonByText(h.panel, 'Copied')!)).toBe('Copied');
  });

  test('Copy remove command copies "c4mp plan remove <uuid> --repo \'/r/my repo\'"', async () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);
    buttonByText(h.panel, 'Copy remove command')!.onclick!();
    await flush();
    expect(h.copied()).toBe("c4mp plan remove " + UID + " --repo '/r/my repo'");
  });

  test('scanned-only node (origin.kind scanned, no uid) shows the folder-mode note and its command uses the node id', async () => {
    const h = run();
    h.select(h.data.root.children[1]);
    const rows = uidRows(h.panel);
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toContain('not on the map in folder mode — run c4mp plan show Worker');
    expect(buttonByText(h.panel, 'Copy uid')).toBeUndefined();
    buttonByText(h.panel, 'Copy remove command')!.onclick!();
    await flush();
    expect(h.copied()).toBe("c4mp plan remove shop.worker --repo '/r/my repo'");
  });

  test('plan node without uid shows "run c4mp plan ids"', () => {
    const h = run();
    h.select(h.data.root.children[0]);
    expect(text(uidRows(h.panel)[0])).toContain('uid: none yet (run c4mp plan ids)');
    expect(buttonByText(h.panel, 'Copy uid')).toBeUndefined();
  });

  test('file and function nodes get no uid row', () => {
    const h = run();
    h.select(h.data.root.children[3]);
    expect(uidRows(h.panel)).toHaveLength(0);
    h.select(h.data.root.children[4]);
    expect(uidRows(h.panel)).toHaveLength(0);
  });

  test('search by a uid fragment finds the node', () => {
    const h = run();
    const input = h.search._l.input;
    expect(input).toBeDefined();
    input.forEach(fn => fn({ target: { value: '3f2b8c1e' } }));
    expect(text(h.results)).toContain('Orders');
    expect(text(h.results)).not.toContain('No results');
  });

  test('clipboard blocked (navigator.clipboard undefined) uses the textarea fallback', () => {
    const h = run({ clipboard: 'none' });
    h.select(h.data.root.children[0].children[0]);
    buttonByText(h.panel, 'Copy uid')!.onclick!();
    expect(h.execCalls).toEqual([UID]);
    expect(h.body).toHaveLength(0);
    expect(buttonByText(h.panel, 'Copied')).toBeDefined();
  });

  test('clipboard write rejected falls back to the textarea', async () => {
    const h = run({ clipboard: 'reject' });
    h.select(h.data.root.children[0].children[0]);
    buttonByText(h.panel, 'Copy uid')!.onclick!();
    await flush();
    expect(h.execCalls).toEqual([UID]);
    expect(buttonByText(h.panel, 'Copied')).toBeDefined();
  });

  test('failed fallback copy sets "Copy failed" (no silent success)', () => {
    const h = run({ clipboard: 'none', execReturn: false });
    h.select(h.data.root.children[0].children[0]);
    buttonByText(h.panel, 'Copy uid')!.onclick!();
    expect(buttonByText(h.panel, 'Copy failed')).toBeDefined();
    expect(buttonByText(h.panel, 'Copied')).toBeUndefined();
  });

  test('uid-row buttons do not use the breadcrumb class pn-crumb', () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);
    const uidButtons = uidRows(h.panel).flatMap(r => buttons(r));
    expect(uidButtons.map(text)).toEqual(['Copy uid', 'Copy remove command']);
    uidButtons.forEach(b => expect(b.className.split(/\s+/)).not.toContain('pn-crumb'));
  });
});
