import { buildKindWords } from '../src/view/kindWords';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView, fillTemplate, renderViewHtml, viewerDir } from '../src/page/html';
import { wireframeRules } from '../src/c4/wireframeHtml';
import { TOOL_VERSION } from '../src/constants';
import { CHROME, runChrome } from './helpers/chrome';
import { loadSample } from './helpers/nav-view';
import { makeRepo } from './helpers/planEditHarness';
import { runViewerScripts } from './helpers/viewer-harness';

// P13-BUG-html-inject: scanned source text that contains the template's own placeholders
// (e.g. when C4PM scans itself) used to be re-scanned by later String.replace calls, splicing
// scripts into the data JSON and blanking the page.

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

// Built at runtime so this file's own source holds no raw U+2028/2029.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const SEPS = new RegExp('[' + LS + PS + ']', 'g');
const NASTY = [
  '/*C4PM_SCRIPTS*/', '/*C4PM_STYLE*/', '/*C4PM_DATA*/null', '$&', "$'", '$`', '$$', '</script>', '<!--', LS, PS,
].join(' ');

const DATA_SCRIPT = /window\.C4PM_DATA = ([^\n]*);(?:<\/script>)?\n/; // JSON.stringify output has no raw newline

let tmp: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-inject-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'inject-demo' }));
  fs.writeFileSync(
    path.join(tmp, 'src', 'index.ts'),
    `// ${NASTY.replace(SEPS, ' ')}\nexport function a() { return ${JSON.stringify(NASTY)}; }\n`,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Loads the page in headless Chrome; returns window error messages and the left-tree row count.
function runInChrome(html: string, name: string): { errs: string[]; rows: number } {
  const probe = '<script>window.__errs=[];window.addEventListener("error",function(e){__errs.push(String(e.message))});</script>';
  const report = '<script>setTimeout(function(){var p=document.createElement("pre");p.id="__r";' +
    'p.textContent=JSON.stringify({errs:window.__errs,rows:document.getElementById("left").querySelectorAll(".lt-row").length});' +
    'document.body.appendChild(p)},400);</script>';
  const file = path.join(tmp, name);
  fs.writeFileSync(file, html.replace('<head>', '<head>' + probe).replace('</body>', report + '</body>'));
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
  const m = dom.match(/<pre id="__r">(.*?)<\/pre>/s);
  if (!m) throw new Error('report element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('fillTemplate', () => {
  it('substitutes once, never re-scans or interprets values', () => {
    const out = fillTemplate('a[X]b[Y]c', [['[X]', "[Y]$&$'$$"], ['[Y]', 'Z']]);
    expect(out).toBe("a[Y]$&$'$$bZc");
  });

  it('throws when a placeholder is missing, duplicated or out of order', () => {
    expect(() => fillTemplate('abc', [['[X]', '1']])).toThrow(/not found/);
    expect(() => fillTemplate('[X][X]', [['[X]', '1']])).toThrow(/more than once/);
    expect(() => fillTemplate('[Y][X]', [['[X]', '1'], ['[Y]', '2']])).toThrow(/not found/);
  });

  it('the real template has each placeholder exactly once', () => {
    const tpl = fs.readFileSync(path.join(viewerDir(), 'index.html'), 'utf8');
    for (const p of ['/*C4PM_GENERATOR*/', '/*C4PM_STYLE*/', '/*C4PM_DATA*/null', '/*C4PM_SCRIPTS*/']) {
      expect(tpl.split(p).length - 1).toBe(1);
    }
  });
});

describe('buildView with placeholder-like text in the scanned source', () => {
  let html: string;
  let model: any;
  beforeAll(() => {
    ({ html, model } = buildView({ repo: tmp }));
  });

  it('data JSON parses back identical and contains the nasty text', () => {
    const m = html.match(DATA_SCRIPT);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    // b142: the page data = the model + the kind table; W10 (b306): + the wireframe rule table; P33: + the c4pm version
    expect(parsed).toEqual(JSON.parse(JSON.stringify({ ...model, kindWords: buildKindWords(), wireframeRules: wireframeRules(), toolVersion: TOOL_VERSION })));
    expect(JSON.stringify(parsed)).toContain('C4PM_SCRIPTS');
  });

  it('no raw </script>, <!-- or line separators inside the data script', () => {
    const data = html.match(DATA_SCRIPT)![1];
    expect(data).not.toMatch(/<[/!]/);
    expect(data).not.toMatch(new RegExp('[' + LS + PS + ']'));
  });

  // P33: the page names the build that made it: C4PM_DATA.toolVersion and a generator meta in the head.
  it('the page carries the c4pm version: data toolVersion and <meta name="generator"> in the head', () => {
    expect(TOOL_VERSION).toMatch(/^c4mp@\d+\.\d+\.\d+/);
    expect(JSON.parse(html.match(DATA_SCRIPT)![1]).toolVersion).toBe(TOOL_VERSION);
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(`<meta name="generator" content="${TOOL_VERSION}">`);
    expect(html).not.toContain('C4PM_GENERATOR');
  });

  it('style and scripts appear exactly once, in their own tags', () => {
    const style = fs.readFileSync(path.join(viewerDir(), 'style.css'), 'utf8');
    const edit = fs.readFileSync(path.join(viewerDir(), 'edit.js'), 'utf8');
    const count = (sub: string) => html.split(sub).length - 1;
    expect(count(style)).toBe(1);
    // P16-B18: the board stylesheets are appended after style.css, in the same <style> tag.
    expect(html).toContain(`<style>${style}\n`);
    expect(html.indexOf('</style>', html.indexOf(`<style>${style}`))).toBeGreaterThan(html.indexOf(`<style>${style}`) + style.length);
    expect(count(edit)).toBe(1);
    // edit.js sits in the scripts tag, after the data script and any inline script before it.
    const at = html.indexOf(`${edit}\n`);
    expect(at).toBeGreaterThan(html.indexOf('window.C4PM_DATA'));
    expect(html.lastIndexOf('<script>', at)).toBeGreaterThan(html.indexOf('window.C4PM_DATA'));
    expect(html.indexOf('</script>', at)).toBeGreaterThan(at + edit.length);
    expect(html.match(DATA_SCRIPT)![1]).not.toContain('C4PM_MAP');
  });

  chromeIt('real browser: no script error and the left tree has rows', () => {
    const r = runInChrome(html, 'page.html');
    expect(r.errs).toEqual([]);
    expect(r.rows).toBeGreaterThan(0);
  });
});

describe('renderViewHtml with a hostile wireframe on a nav entry', () => {
  // W10 (b306, C7): wireframe html is repo text; the data script must stay inert.
  const EVIL = '</script><script>alert(1)</script><!--' + LS + PS;
  let html: string;
  let model: any;
  beforeAll(() => {
    model = loadSample();
    model.nav.groups[0].entries[0].wireframe = { file: 'wire/login.html', html: EVIL, refs: [], missing: [] };
    html = renderViewHtml(model);
  });

  it('no raw </script>, <!-- or line separators inside the data script', () => {
    const data = html.match(DATA_SCRIPT)![1];
    expect(data).not.toMatch(/<[/!]/);
    expect(data).not.toMatch(new RegExp('[' + LS + PS + ']'));
  });

  it('data JSON parses back identical', () => {
    const parsed = JSON.parse(html.match(DATA_SCRIPT)![1]);
    expect(parsed).toEqual(JSON.parse(JSON.stringify({ ...model, kindWords: buildKindWords(), wireframeRules: wireframeRules(), toolVersion: TOOL_VERSION })));
    expect(parsed.nav.groups[0].entries[0].wireframe.html).toBe(EVIL);
  });
});

describe('buildView with a store in the plan (STOR-5w b609)', () => {
  // Drizzle fixture in src/db: `users` is in the code, `ghost_table` only in the plan. The same plan without the store gives no storageView.
  const planText = (store: boolean) => [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      data = component 'Data' { link ../../../../src/db/ }",
    ...(store ? ["      main = store 'Main' { technology 'postgres'\n metadata { reader 'drizzle' source 'src/db' }\n users = record 'users'\n ghost_table = record 'ghost_table' }"] : []),
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const repos: string[] = [];
  const repo = (store: boolean): string => {
    const { root } = makeRepo('c4pm-inject-st-', { 'a.c4': planText(store) });
    fs.cpSync(path.join(__dirname, 'fixtures', 'schema-drizzle'), path.join(root, 'src', 'db'), { recursive: true });
    repos.push(root);
    return root;
  };
  afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });

  it('the page data carries the storage-view tree of the storage read; a plan-only record is planOnly', () => {
    const { html, model } = buildView({ repo: repo(true) });
    const parsed = JSON.parse(html.match(DATA_SCRIPT)![1]);
    expect(parsed.storageView).toEqual(JSON.parse(JSON.stringify(model.storageView)));
    const store = model.storageView!.root.children[0].children[0];
    expect([store.id, store.kind]).toEqual(['app.api.main', 'store']);
    expect(store.children.slice(0, 2).map((r) => [r.id, r.storage!.origin, r.planOnly ?? false])).toEqual([
      ['app.api.main.users', 'both', false],
      ['app.api.main.ghost_table', 'plan', true],
    ]);
  });

  it('a plan without a store: no storageView in the model or the page', () => {
    const { html, model } = buildView({ repo: repo(false) });
    expect('storageView' in model).toBe(false);
    expect(html.match(DATA_SCRIPT)![1]).not.toContain('storageView');
  });
});

// C1 A3 (b830): the page names the system after the plan. Repo 'shop-site' (package.json), plan system `shop` titled 'Shop Site'
// (it maps by the id of its title, toId). The header, the tree row and the panel read the plan title; the summary line keeps the
// repo name (it is the same text as the CLI's Summary line).
describe('buildView: the system title comes from the plan (C1 A3 b830)', () => {
  let root: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-inject-title-')));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'plans'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop-site' }));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'plans', 'a.c4'), "model {\n  shop = system 'Shop Site' {\n    api = container 'Api' {\n    }\n  }\n}\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('the page data, the header and the tree row read the plan title; the summary keeps the repo name', () => {
    const { html, model } = buildView({ repo: root });
    const data = JSON.parse(html.match(DATA_SCRIPT)![1]);
    expect([data.title, data.root.kind, data.root.name]).toEqual(['Shop Site', 'system', 'Shop Site']);
    expect(model.summary.startsWith('shop-site — ')).toBe(true);
    const h = runViewerScripts(html, { globals: { location: { href: 'file:///x.html#arch', hash: '#arch' } } });
    const doc = (h.sandbox.window as any).document;
    expect(doc.getElementById('title').textContent).toBe('Shop Site');
    const row = (doc.getElementById('left').querySelectorAll('.lt-row') as any[]).find(r => r.dataset.id === data.root.id);
    expect(row.querySelector('.lt-name').textContent).toBe('Shop Site');
  });
});

describe('buildView with s-items in the project (UI2 b752)', () => {
  // UI0's demo Shop (test/fixtures/sim-demo-shop, project id 'shop'): s-1 (flow, 9 steps) and s-2 (journey). The check
  // marks s-1 steps 7-8 unverified (the planned charge has no code) and steps 2-3, 6-7 unconnected (board b783).
  const SIM_DIR = path.join('.c4pm', 'projects', 'shop', 'sim');
  const repos: string[] = [];
  const repo = (edit?: (root: string) => void): string => {
    const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-inject-sim-'))), 'shop');
    fs.cpSync(path.join(__dirname, 'fixtures', 'sim-demo-shop'), root, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    edit?.(root);
    repos.push(path.dirname(root));
    return root;
  };
  afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });

  it('the page data carries the resolved s-items: steps, findings on the second step of a pair, io nodes and storage records', () => {
    const { html, model } = buildView({ repo: repo() });
    const parsed = JSON.parse(html.match(DATA_SCRIPT)![1]);
    expect(parsed.sims).toEqual(JSON.parse(JSON.stringify(model.sims)));
    expect(model.sims!.map((s) => [s.id, s.kind, s.file])).toEqual([
      ['s-1', 'flow', '.c4pm/projects/shop/sim/s-1.json'],
      ['s-2', 'journey', '.c4pm/projects/shop/sim/s-2.json'],
    ]);
    const s1 = model.sims![0];
    expect(s1.steps).toHaveLength(9);
    expect(s1.steps.filter((st) => st.unverified).map((st) => st.n)).toEqual([8]);
    // b783: steps 3 and 7 connect through call.from (cart_store, router)
    expect(s1.steps.filter((st) => st.unconnected).map((st) => st.n)).toEqual([]);
    const steps = model.sims!.flatMap((s) => s.steps);
    const io = steps.flatMap((st) => st.targets).filter((t) => t.view === 'io');
    expect(io.length).toBeGreaterThan(0);
    expect(io.filter((t) => t.nodeId === null)).toEqual([]);
    const rows = steps.flatMap((st) => st.rows ?? []);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.recordId === null)).toEqual([]);
  });

  it('a project without sim/: no sims in the model or the page', () => {
    const { html, model } = buildView({ repo: repo((root) => fs.rmSync(path.join(root, SIM_DIR), { recursive: true })) });
    expect('sims' in model).toBe(false);
    expect('sims' in JSON.parse(html.match(DATA_SCRIPT)![1])).toBe(false);
  });

  it('a caption with </script>, <!-- and line separators is escaped in the data script and parses back the same', () => {
    const caption = `ends here </script><!-- ${LS}${PS} $& /*C4PM_DATA*/null`;
    const { html } = buildView({ repo: repo((root) => {
      const file = path.join(root, SIM_DIR, 's-1.json');
      const sim = JSON.parse(fs.readFileSync(file, 'utf8'));
      sim.steps[0].caption = caption;
      fs.writeFileSync(file, JSON.stringify(sim, null, 2) + '\n');
    }) });
    const data = html.match(DATA_SCRIPT)![1];
    expect(data).not.toMatch(/<[/!]/);
    expect(data).not.toMatch(new RegExp('[' + LS + PS + ']'));
    expect(JSON.parse(data).sims[0].steps[0].caption).toBe(caption);
  });

  it('s-1 lanes: the web app is one lane (the IO group shop.web finds the merged arch container web through the plan uid)', () => {
    // b751 follow-up: the nav group shop.web has no uid and the merged arch container `web` has no planId, so the lane rule
    // resolves the group id through keysOf; before, a fallback lane shop.web stood beside web.
    const { model } = buildView({ repo: repo() });
    const s1 = model.sims![0];
    const lanes = s1.lanes.map((l) => l.id);
    expect(lanes).toEqual(['customer', 'web', 'api', 'shop.db']);   // in the order the path first reaches them (the demo's lanes), not the arch order
    expect(new Set(s1.lanes.map((l) => l.name)).size).toBe(lanes.length);
    expect(lanes).not.toContain('shop.web');
    const io = s1.steps.filter((st) => st.targets.some((t) => t.view === 'io'));
    expect(io.map((st) => st.n)).toEqual([1, 2, 6, 9]);
    for (const st of io) {
      for (const t of st.targets) expect([st.call!.fromLane, st.call!.toLane]).toContain(t.lane);
    }
    expect(model.sims![1].lanes.slice(0, 2).map((l) => l.id)).toEqual(['customer', 'outside']);   // s-2: the person, then Outside
  });
});

describe('C4PM scanning itself', () => {
  chromeIt('real browser: the Project repo renders without errors', () => {
    const { html } = buildView({ repo: path.resolve(__dirname, '..') });
    const m = html.match(DATA_SCRIPT)!;
    expect(() => JSON.parse(m[1])).not.toThrow();
    expect(m[1]).toContain('C4PM_SCRIPTS');
    const r = runInChrome(html, 'self.html');
    expect(r.errs).toEqual([]);
    expect(r.rows).toBeGreaterThan(0);
  }, 120000);
});
