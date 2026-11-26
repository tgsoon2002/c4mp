import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildView } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';
import { loadPanelScripts } from './helpers/panelScripts';

// P14-T44b: a plan-only node (ViewNode.planOnly, set by T44a) says "planned (no code yet)" in the
// panel header and in the tree row, and shows no size bar. Panel: real viewer/panel.js in a vm with a
// minimal fake DOM (harness copied from viewer-panel-plan.test.ts). Tree: real headless Chrome.

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

const LABEL = 'planned (no code yet)';

// system (weight 10)
//   api  container, planOnly (weight 1, placeholder)
//     orders component, planOnly (weight 1, placeholder)
//   web  container, weight 4, has code
//     auth component, weight 2, has code (a child function: an empty component hides its bar, T12c)
function fixture() {
  const orders = mk('shop.api.orders', 'component', 'Orders', [], { planOnly: true });
  const api = mk('shop.api', 'container', 'API', [orders], { planOnly: true });
  const login = mk('shop.web.auth.login', 'function', 'login', [], { weight: 2 });
  const auth = mk('shop.web.auth', 'component', 'Auth', [login], { weight: 2 });
  const web = mk('shop.web', 'container', 'Web', [auth], { weight: 4 });
  const root = mk('shop', 'system', 'Shop', [api, web], { weight: 10 });
  return { schemaVersion: 1, root, files: [], planFindings: [], drift: null };
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
  return { panel, data: sandbox.C4PM_DATA, select: (n: unknown) => onSelect(n) };
}

describe('P14-T44b: "planned (no code yet)" label in the panel', () => {
  test('planOnly node shows the label in the header', () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);   // orders (planOnly component)
    expect(all(h.panel, e => e.className === 'pn-planned').map(text)).toEqual([LABEL]);
    h.select(h.data.root.children[0]);                // api (planOnly container)
    expect(all(h.panel, e => e.className === 'pn-planned').map(text)).toEqual([LABEL]);
  });

  test('non-planOnly node does not show the label', () => {
    const h = run();
    h.select(h.data.root.children[1].children[0]);   // auth (has code)
    expect(text(h.panel)).not.toContain(LABEL);
    expect(all(h.panel, e => e.className === 'pn-planned')).toHaveLength(0);
    h.select(h.data.root);                            // system
    expect(text(h.panel)).not.toContain(LABEL);
  });

  test('planOnly node shows no size bar; a node with code still does', () => {
    const h = run();
    h.select(h.data.root.children[0].children[0]);
    expect(all(h.panel, e => e.className === 'pn-bar-section')).toHaveLength(0);
    h.select(h.data.root.children[1].children[0]);
    expect(all(h.panel, e => e.className === 'pn-bar-section')).toHaveLength(1);
  });
});

// ---- tree row label (real browser) ----

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

// Folder-mode greenfield: one plan file, no code, so every container/component is planOnly (T44a).
const GREENFIELD = [
  'model {',
  "  shop = system 'Shop' {",
  "    api = container 'API' {",
  "      technology 'Node.js'",
  "      orders = component 'Orders' {",
  '      }',
  '    }',
  "    web = container 'Web' {",
  "      cart = component 'Cart' {",
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-greenfield-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'plans'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'plans', 'shop.c4'), GREENFIELD);
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'greenfield-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Runs after load: expands the path to shop.api.orders, reads the row texts, selects it.
const DRIVE = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)};
  var M=window.C4PM_MAP, o={};
  M.ancestorsOf('shop.api.orders').forEach(function(a){var r=q('.lt-row[data-id="'+a+'"]'); if(r && r.getAttribute('aria-expanded')==='false') r.querySelector('.lt-twist').click();});
  var rowText=function(id){var r=q('.lt-row[data-id="'+id+'"]'); return r ? r.textContent : null;};
  o.orderRow=rowText('shop.api.orders');
  o.apiRow=rowText('shop.api');
  o.rootRow=rowText(window.C4PM_DATA.root.id);
  o.orderPlanned=!!(q('.lt-row[data-id="shop.api.orders"] .lt-flag') && q('.lt-row[data-id="shop.api.orders"] .lt-flag').textContent==='${LABEL}');
  M.select('shop.api.orders');
  o.panelLabel=q('#panel').textContent.indexOf('${LABEL}')>=0;
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

function runPage(page: string): Record<string, any> {
  const file = path.join(tmp, 'greenfield-page.html');
  fs.writeFileSync(file, page);
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P14-T44b: "planned (no code yet)" label in the tree', () => {
  it('view html carries planOnly nodes for the greenfield plan (precondition)', () => {
    expect(html).toContain('"planOnly":true');
  });

  chromeIt('real browser: planOnly rows show the label, the system row does not; panel label appears on select', () => {
    const m = runPage(html.replace('</body>', `<script>${DRIVE}</script></body>`));
    expect(m.orderRow).toContain(LABEL);
    expect(m.orderPlanned).toBe(true);
    expect(m.apiRow).toContain(LABEL);
    expect(m.rootRow).not.toContain(LABEL);
    expect(m.panelLabel).toBe(true);
  });
});
