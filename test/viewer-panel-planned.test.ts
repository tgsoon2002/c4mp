import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildView } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';
import { loadPanelScripts } from './helpers/panelScripts';

// P14-L4-5b: panel "Plan" block for ViewNode.planned, ghost nodes show no code, tree "planned only" filter.
// Panel: real viewer/panel.js in a vm with a minimal fake DOM (same harness style as viewer-panel-shared.test.ts).
// Tree filter: real headless Chrome on a copy of test/fixtures/level4 (skipped when Chrome is missing).

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

const PLAN_SRC = { file: 'c4/plan.c4', line: 12 };

// billing (component) -> planFn: ghost (planned, no file, no code); buildInvoice: real function with code, status done.
function fixture() {
  const ghost = mk('billing.plan_fn', 'function', 'planFn', [], {
    builtState: 'planned',
    planned: { status: 'planned', signature: 'planFn(): void', purpose: 'does the planned thing', source: PLAN_SRC },
  });
  const built = mk('src/built.ts::buildInvoice', 'function', 'buildInvoice', [], {
    file: 'src/built.ts', line: 1, endLine: 3, weight: 3, code: ['export function buildInvoice() {', '  return 1;', '}'],
    builtState: 'built', planned: { status: 'done', source: PLAN_SRC },
  });
  const planOnlyBox = mk('billing.future', 'container', 'Future', [], { planOnly: true });
  const billing = mk('billing', 'component', 'Billing', [ghost, built, planOnlyBox]);
  const root = mk('shop', 'system', 'Shop', [billing]);
  return { schemaVersion: 1, repoPath: '/repo', root, files: [], planFindings: [], drift: null, edges: [], ghost, built, planOnlyBox, billing };
}

function run() {
  const panel = el('div');
  const els: Record<string, El> = { panel, search: el('input'), 'search-results': el('div'), legend: el('div') };
  let onSelect: (n: unknown) => void = () => {};
  const data = fixture();
  const sandbox: Record<string, any> = {
    console: { ...console, debug: () => {}, warn: () => {}, log: () => {} },
    Set, Map, Array, Object, String, Number, JSON, Math, RegExp, encodeURI,
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
  sandbox.C4PM_DATA = data;
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: () => true, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  return { panel, data, select: (n: unknown) => onSelect(n) };
}

describe('P14-L4-5b: panel Plan block', () => {
  test('ghost node: Plan block with status chip, signature in code, purpose, plan source link', () => {
    const h = run();
    h.select(h.data.ghost);
    expect(all(h.panel, e => e.className.includes('pn-status')).map(text)).toEqual(['planned']);
    expect(all(h.panel, e => e.tag === 'code').map(text)).toContain('planFn(): void');
    expect(text(h.panel)).toContain('does the planned thing');
    const links = all(h.panel, e => e.className === 'pn-vscode-link');
    expect(links.map(text)).toEqual(['c4/plan.c4:12']);
    expect((links[0] as any).href).toBe('vscode://file/' + encodeURI('/repo/c4/plan.c4') + ':12');
  });

  test('ghost node shows no code: no Source block and no Open in VS Code link for the file', () => {
    const h = run();
    h.select(h.data.ghost);
    expect(text(h.panel)).not.toContain('Source');
    expect(all(h.panel, e => e.className === 'pn-code')).toEqual([]);
    expect(text(h.panel)).not.toContain('Open in VS Code');
  });

  test('built node with planned keeps the real Source block next to the Plan block', () => {
    const h = run();
    h.select(h.data.built);
    expect(text(h.panel)).toContain('Source');
    expect(text(h.panel)).toContain('Open in VS Code');
    expect(all(h.panel, e => e.className.includes('pn-status')).map(text)).toEqual(['done']);
  });

  test('node without planned gets no Plan block', () => {
    const h = run();
    h.select(h.data.billing);
    expect(all(h.panel, e => e.className.includes('pn-status'))).toEqual([]);
  });
});

// P14-L4-10: ghost (planned, no file) and planOnly rows show no size; real nodes keep the bar and the line count.
describe('P14-L4-10: no size for ghost and plan-only nodes', () => {
  test('ghost node opens with no size bar', () => {
    const h = run();
    h.select(h.data.ghost);
    expect(all(h.panel, e => e.className === 'pn-bar-section')).toEqual([]);
  });

  test('real function node with code keeps its size bar', () => {
    const h = run();
    h.select(h.data.built);
    expect(all(h.panel, e => e.className === 'pn-bar-section').length).toBe(1);
  });

  test('parent children list: ghost row has no line count, built row keeps 3 lines', () => {
    const h = run();
    h.select(h.data.billing);
    expect(all(h.panel, e => e.className === 'pn-child-weight').map(text)).toEqual(['3 lines']);
  });

  test('planOnly container keeps no bar', () => {
    const h = run();
    h.select(h.data.planOnlyBox);
    expect(all(h.panel, e => e.className === 'pn-bar-section')).toEqual([]);
    h.select(h.data.billing);
    const futureRow = all(h.panel, e => e.className === 'pn-child-row').find(r => text(r).includes('Future'));
    expect(futureRow).toBeDefined();
    expect(all(futureRow as El, e => e.className === 'pn-child-weight')).toEqual([]);
  });
});

// ---- real Chrome: tree "planned only" filter on the level4 fixture copy ----

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-planned-')));
  fs.cpSync(path.join(__dirname, 'fixtures/level4'), tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, '.git'));
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// After load: count planned/stub and built nodes from the data, toggle the filter on and off, record rows.
const DRIVE = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var o={}, kept=[], built=[], billing=null;
  (function walk(n){
    if(n.name==='Billing') billing=n;
    if(n.builtState==='planned'||n.builtState==='stub') kept.push(n.id);
    if(n.builtState==='built') built.push(n.id);
    (n.children||[]).forEach(walk);
  })(window.C4PM_DATA.root);
  o.keptCount=kept.length; o.builtCount=built.length;
  o.billingOrigin=billing&&billing.origin?billing.origin.kind:null;
  var rowOf=function(id){return q('#lt-arch .lt-row[data-id="'+id+'"]')};
  o.allRowsBefore=qa('#lt-arch .lt-row').length;
  q('#lt-planned-only').click();
  o.checkedOn=q('#lt-planned-only').checked;
  o.keptRows=kept.filter(function(id){return !!rowOf(id)}).length;
  o.builtRowsOn=built.filter(function(id){return !!rowOf(id)}).length;
  o.ghostRowsOn=qa('#lt-arch .lt-row[data-kind="function"]').filter(function(r){return r.querySelector('.lt-name').textContent==='planFn'}).length;
  o.allRowsOn=qa('#lt-arch .lt-row').length;
  q('#lt-planned-only').click();
  o.checkedOff=q('#lt-planned-only').checked;
  o.allRowsOff=qa('#lt-arch .lt-row').length;
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

function run2(page: string, dir: string): Record<string, any> {
  const file = path.join(dir, 'planned-page.html');
  fs.writeFileSync(file, page);
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P14-L4-5b: tree planned-only filter (real Chrome)', () => {
  chromeIt('filter keeps planned/stub nodes and their ancestors, hides built rows; toggling off restores the rows', () => {
    const page = html.replace('</body>', `<script>${DRIVE}</script></body>`);
    const o = run2(page, tmp);
    // Visible in the test output for the billing-origin report (not asserted: see report).
    // eslint-disable-next-line no-console
    console.info('[P14-L4-5b] billing origin kind', o.billingOrigin);
    expect(o.keptCount).toBeGreaterThanOrEqual(2);
    expect(o.checkedOn).toBe(true);
    expect(o.keptRows).toBe(o.keptCount);
    expect(o.ghostRowsOn).toBe(1);
    expect(o.builtRowsOn).toBe(0);
    expect(o.checkedOff).toBe(false);
    expect(o.allRowsOff).toBeGreaterThanOrEqual(o.allRowsOn);
  });
});
