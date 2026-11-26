import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildView, renderViewHtml } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';
import { runViewerScripts } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';

// P13-T3a: left panel tree. Real headless Chrome (same binary as viewer-layout.test.ts; skipped when
// missing) plus a no-DOM guard check.

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-tree-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'tree-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Runs after load: reads the tree, clicks a twist, switches tabs, writes JSON into <pre id="__m">.
const DRIVE = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var o={};
  var rows=qa('#lt-arch .lt-row');
  o.rowsBefore=rows.length;
  o.firstTag=rows[0].querySelector('.lt-tag').textContent;
  o.firstKind=rows[0].dataset.kind;
  o.firstExpanded=rows[0].getAttribute('aria-expanded');
  o.archVisible=!q('#lt-arch').hidden; o.filesHidden=q('#lt-files').hidden; o.filesEmpty=q('#lt-files').children.length===0;
  // expand the first collapsed row that has a twist glyph
  var t=qa('#lt-arch .lt-row').filter(function(r){return r.getAttribute('aria-expanded')==='false'})[0];
  o.hadCollapsed=!!t;
  if(t){t.querySelector('.lt-twist').click(); o.rowsAfterExpand=qa('#lt-arch .lt-row').length;
    t.querySelector('.lt-twist').click(); o.collapsedAgain=t.getAttribute('aria-expanded');}
  qa('.lt-tab')[1].click();
  o.afterFilesTab={arch:q('#lt-arch').hidden,files:q('#lt-files').hidden};
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

// P13-T3b: row click -> flyTo+select; select(id) -> row highlighted, ancestors opened, row visible;
// no feedback loop (select count); search markup now lives in #header (b230).
const DRIVE_SYNC = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var o={}, M=window.C4PM_MAP, selects=[], order=[];
  var origSel=M.select, origFly=M.flyTo;
  M.select=function(id){selects.push(id);order.push('select');return origSel.apply(M,arguments)};
  M.flyTo=function(id){order.push('flyTo');return origFly.apply(M,arguments)};
  // 1. click a component row (expand its ancestors first so the row exists)
  var comp=null;
  (function walk(n){ if(!comp && n.kind==='component') comp=n; (n.children||[]).forEach(walk); })(window.C4PM_DATA.root);
  o.compName=comp.name;
  M.ancestorsOf(comp.id).forEach(function(a){var r=q('.lt-row[data-id="'+a+'"]'); if(r && r.getAttribute('aria-expanded')==='false') r.querySelector('.lt-twist').click();});
  var row=q('.lt-row[data-id="'+comp.id+'"]');
  o.rowFound=!!row;
  row.click();
  o.selectedAfterClick=M.selectedId()===comp.id;
  o.panelHasName=q('#panel').textContent.indexOf(comp.name)>=0;
  o.rowSelected=row.classList.contains('selected');
  o.order=order.slice();
  o.selectCallsAfterClick=selects.length;
  // 2. select the deepest node programmatically; tree must open ancestors and show the row
  var deep=null, best=-1;
  (function walk(n,d){ if(d>best){best=d;deep=n;} (n.children||[]).forEach(function(c){walk(c,d+1)}); })(window.C4PM_DATA.root,0);
  o.deepKind=deep.kind;
  var before=selects.length;
  M.select(deep.id);
  o.selectCallsForProgrammatic=selects.length-before; // exactly 1: tree did not re-select
  var drow=q('.lt-row[data-id="'+deep.id+'"]');
  o.deepRowFound=!!drow;
  o.deepSelected=!!drow && drow.classList.contains('selected');
  o.onlyOneSelected=qa('#lt-arch .lt-row.selected').length;
  o.oldDeselected=!row.classList.contains('selected');
  if(drow){var a=drow.getBoundingClientRect(), b=q('#lt-arch').getBoundingClientRect();
    o.deepVisible=a.height>0 && a.top>=b.top-1 && a.bottom<=b.bottom+1;}
  // 3. clearing selection removes the highlight
  M.select(null);
  o.clearedCount=qa('#lt-arch .lt-row.selected').length;
  // 4. b230: search markup sits in #header (top bar), not in #left or #panel-col
  var s=q('#search'); o.searchInHeader=!!q('#header #search'); o.searchNotInLeft=!q('#left #search');
  o.searchNotInPanelCol=!q('#panel-col #search');
  // the dropdown (#search-pop) shows only while the input has focus, so focus first
  s.focus();
  s.value=comp.name.charAt(0); s.dispatchEvent(new Event('input',{bubbles:true}));
  var res=q('#search-results'); o.resultCount=res.children.length; o.resultsInHeader=!!q('#header #search-results');
  var R=res.getBoundingClientRect(), S=s.getBoundingClientRect();
  o.resultsBelowInput=R.top>=S.bottom-1;
  o.dropdownInViewport=R.right<=window.innerWidth;
  console.debug('[T3b-test]', JSON.stringify(o));
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

function run(page: string, dir: string = tmp): Record<string, any> {
  const file = path.join(dir, 'tree-page.html');
  fs.writeFileSync(file, page);
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P13-T3a left panel tree', () => {
  it('tree.js is inlined after map.js and the page still has exactly two script tags', () => {
    expect(html.indexOf('window.C4PM_TREE')).toBeGreaterThan(html.indexOf('window.C4PM_MAP = {'));
    expect((html.match(/<script>/g) ?? []).length).toBe(2);
  });

  it('does nothing (no throw, no globals) when #left or C4PM_MAP is missing', () => {
    const src = fs.readFileSync(path.join(__dirname, '../viewer/tree.js'), 'utf8');
    const sandbox: any = {
      console: { debug: () => {} },
      document: { readyState: 'complete', getElementById: () => null, addEventListener: () => {} },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    expect(() => vm.runInContext(src, sandbox)).not.toThrow();
    expect(sandbox.C4PM_TREE).toBeUndefined();

    // #left present but C4PM_MAP missing: still untouched
    const left: any = { hidden: true, textContent: 'x' };
    sandbox.document.getElementById = (id: string) => (id === 'left' ? left : null);
    sandbox.C4PM_DATA = { root: { id: 'system', kind: 'system', name: 'S', children: [] } };
    expect(() => vm.runInContext(src, sandbox)).not.toThrow();
    expect(left.hidden).toBe(true);
    expect(left.textContent).toBe('x');
  });

  chromeIt('real browser: system row open, containers visible, expand/collapse and tabs work', () => {
    const m = run(html.replace('</body>', `<script>${DRIVE}</script></body>`));
    expect(m.firstTag).toBe('C1');
    expect(m.firstKind).toBe('system');
    expect(m.firstExpanded).toBe('true');
    expect(m.rowsBefore).toBeGreaterThan(1); // system + at least one container
    expect(m.archVisible).toBe(true);
    expect(m.filesHidden).toBe(true);
    expect(m.filesEmpty).toBe(false); // P13-T4: Files tab is filled from data.files
    if (m.hadCollapsed) {
      expect(m.rowsAfterExpand).toBeGreaterThan(m.rowsBefore);
      expect(m.collapsedAgain).toBe('false');
    }
    expect(m.afterFilesTab).toEqual({ arch: true, files: false });
  });

  chromeIt('P13-T3b real browser: row click selects (flyTo first), select(id) reveals row, no feedback loop, search moved', () => {
    const m = run(html.replace('</body>', `<script>${DRIVE_SYNC}</script></body>`));
    expect(m.rowFound).toBe(true);
    expect(m.selectedAfterClick).toBe(true);
    expect(m.panelHasName).toBe(true);
    expect(m.rowSelected).toBe(true);
    expect(m.order).toEqual(['flyTo', 'select']);
    expect(m.selectCallsAfterClick).toBe(1);
    expect(m.selectCallsForProgrammatic).toBe(1);
    expect(m.deepRowFound).toBe(true);
    expect(m.deepSelected).toBe(true);
    expect(m.onlyOneSelected).toBe(1);
    expect(m.oldDeselected).toBe(true);
    expect(m.deepVisible).toBe(true);
    expect(m.clearedCount).toBe(0);
    expect(m.searchInHeader).toBe(true);
    expect(m.searchNotInLeft).toBe(true);
    expect(m.searchNotInPanelCol).toBe(true);
    expect(m.resultCount).toBeGreaterThan(0);
    expect(m.resultsInHeader).toBe(true);
    expect(m.resultsBelowInput).toBe(true);
    expect(m.dropdownInViewport).toBe(true);
  });
});

// P13-T4: Files tab. Claim-mode repo so ViewFile has real owners/flags (split file, plan file).
const TREE_SRC = fs.readFileSync(path.join(__dirname, '../viewer/tree.js'), 'utf8');

const DRIVE_FILES = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var o={}, M=window.C4PM_MAP, D=window.C4PM_DATA;
  function expandAll(){var t; while((t=qa('#lt-files .lt-row[data-dir][aria-expanded="false"]')[0])) t.querySelector('.lt-twist').click();}
  var tab=qa('.lt-tab')[1];
  o.tabHidden=tab.hidden; o.dataFiles=D.files.length;
  tab.click(); o.filesBodyVisible=!q('#lt-files').hidden;
  expandAll();
  o.leaves=qa('#lt-files .lt-row[data-path]').length;
  o.dirClickable=qa('#lt-files .lt-row[data-dir]').every(function(r){return !r.onclick});
  o.flags=qa('#lt-files .lt-row[data-path]').map(function(r){var f=r.querySelector('.lt-flag');return r.dataset.path+':'+(f?f.textContent:'')});
  // 1. no C4PM_PANEL yet: clicking a source file must not throw and still selects the slice
  var split=D.files.filter(function(f){return f.flag==='split'})[0];
  o.splitPath=split.path; o.splitOwners=split.owners;
  var sliceId=split.owners[0]+'::slice::'+split.path;
  var calls=[]; 
  q('.lt-row[data-path="'+split.path+'"]').click();
  o.selectedWithoutPanel=M.selectedId()===sliceId;
  // 2. with C4PM_PANEL: showFile first, then select; tab stays on Files
  M.select(null);
  window.C4PM_PANEL={showFile:function(p){calls.push('showFile:'+p+':sel='+M.selectedId())}};
  q('.lt-row[data-path="'+split.path+'"]').click();
  o.calls=calls.slice(); o.selectedSlice=M.selectedId()===sliceId;
  o.filesStillVisible=!q('#lt-files').hidden && q('#lt-arch').hidden;
  o.fileRowSelected=q('.lt-row[data-path="'+split.path+'"]').classList.contains('selected');
  // 3. plan file: showFile only, selection untouched
  M.select(null); calls.length=0;
  var plan=D.files.filter(function(f){return f.kind==='plan'})[0];
  o.planPath=plan.path;
  q('.lt-row[data-path="'+plan.path+'"]').click();
  o.planCalls=calls.slice(); o.planSelected=M.selectedId();
  // 4. synthetic data: '../' group, unknown slice id, no owner, empty list
  var host=function(files){D.files=files; (0,eval)(window.__TREE_SRC);};
  host([{path:'../up/plan.c4',kind:'plan',owners:[],flag:'c4'},{path:'src/ghost.ts',kind:'source',owners:['nope']},{path:'src/none.ts',kind:'source',owners:[],flag:'unassigned'}]);
  qa('.lt-tab')[1].click();
  var g=qa('#lt-files .lt-row[data-dir]').map(function(r){return r.dataset.dir});
  o.synthDirs=g;
  var pr=q('#lt-files .lt-row[data-path="../up/plan.c4"]');
  o.planInGroup=!!pr && !!pr.closest('.lt-children').previousSibling && pr.closest('.lt-children').previousSibling.dataset.dir==='/plan';
  var s0=M.selectedId(); calls.length=0;
  expandAll();
  var ghost=q('#lt-files .lt-row[data-path="src/ghost.ts"]');
  try{ghost.click(); o.ghostOk=true;}catch(e){o.ghostOk=String(e)}
  o.ghostCalls=calls.slice(); o.ghostSelectionKept=M.selectedId()===s0;
  var none=q('#lt-files .lt-row[data-path="src/none.ts"]'); calls.length=0; none.click(); o.noneCalls=calls.slice(); o.noneSelectionKept=M.selectedId()===s0;
  host([]);
  o.emptyTabHidden=qa('.lt-tab')[1].hidden; o.emptyBody=q('#lt-files').children.length;
  host(undefined);
  o.missingTabHidden=qa('.lt-tab')[1].hidden;
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

describe('P13-T4 Files tab', () => {
  let repo: string;
  let claimHtml: string;
  let claimFiles: any[];

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-tree-files-')));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'files-demo' }));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function fa() { return 1; }\nexport function fb() { return 2; }\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export function fc() { return 3; }\n');
    fs.writeFileSync(path.join(repo, 'src', 'deep', 'd.ts'), 'export function fd() { return 4; }\n');
    fs.writeFileSync(path.join(repo, 'arch.c4'), `model {
  app = system 'App' {
    api = container 'API' {
      one = component 'One' {
        link ./src/a.ts#fa
        link ./src/b.ts#fc
      }
      two = component 'Two' {
        link ./src/a.ts#fb
      }
    }
  }
}
`);
    const built = buildView({ repo });
    claimHtml = built.html;
    claimFiles = built.model.files;
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fixture sanity: split file, c4 plan file and an unowned file exist in the model', () => {
    expect(claimFiles.some(f => f.flag === 'split')).toBe(true);
    expect(claimFiles.some(f => f.kind === 'plan' && f.flag === 'c4')).toBe(true);
    expect(claimFiles.find(f => f.path === 'src/deep/d.ts').owners).toEqual([]);
  });

  chromeIt('real browser: leaves = files, flags shown, dirs inert, clicks per Decision 7, ../ group, empty hides tab', () => {
    const page = claimHtml.replace('</body>', `<script>window.__TREE_SRC=${JSON.stringify(TREE_SRC)};</script><script>${DRIVE_FILES}</script></body>`);
    const m = run(page, repo);
    expect(m.tabHidden).toBe(false);
    expect(m.filesBodyVisible).toBe(true);
    expect(m.leaves).toBe(claimFiles.length);
    expect(m.dirClickable).toBe(true);
    expect(m.flags).toContain('arch.c4:c4');
    expect(m.flags).toContain('src/a.ts:split');
    expect(m.flags).toContain('src/deep/d.ts:unassigned');
    expect(m.flags).toContain('src/b.ts:');
    // click behaviour
    expect(m.selectedWithoutPanel).toBe(true);
    expect(m.calls).toEqual([`showFile:src/a.ts:sel=null`]);
    expect(m.selectedSlice).toBe(true);
    expect(m.filesStillVisible).toBe(true);
    expect(m.fileRowSelected).toBe(true);
    expect(m.planCalls).toEqual([`showFile:${m.planPath}:sel=null`]);
    expect(m.planSelected).toBeNull();
    // synthetic data
    expect(m.synthDirs).toContain('/plan');
    expect(m.planInGroup).toBe(true);
    expect(m.ghostOk).toBe(true);
    expect(m.ghostCalls).toEqual([expect.stringContaining('showFile:src/ghost.ts')]);
    expect(m.ghostSelectionKept).toBe(true);
    expect(m.noneCalls).toEqual([expect.stringContaining('showFile:src/none.ts')]);
    expect(m.noneSelectionKept).toBe(true);
    expect(m.emptyTabHidden).toBe(true);
    expect(m.emptyBody).toBe(0);
    expect(m.missingTabHidden).toBe(true);
  });

  chromeIt('P14-T17 Files rows show a reason', () => {
    const drive = `(function(){setTimeout(function(){
  var qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var o={}, D=window.C4PM_DATA;
  var host=function(files){D.files=files; (0,eval)(window.__TREE_SRC);};
  host([{path:'src/e.ts',kind:'source',noFunctions:true,flag:'unassigned',owners:[]},{path:'src/u.ts',kind:'source',flag:'unassigned'},{path:'src/s.ts',kind:'source',flag:'shared'},{path:'src/p.ts',kind:'source',flag:'split'},{path:'src/ok.ts',kind:'source'}]);
  qa('.lt-tab')[1].click();
  var t; while((t=qa('#lt-files .lt-row[data-dir][aria-expanded="false"]')[0])) t.querySelector('.lt-twist').click();
  o.rows=qa('#lt-files .lt-row[data-path]').map(function(r){var a=r.querySelector('.lt-reason'),f=r.querySelector('.lt-flag');return r.dataset.path+'|'+(a?a.textContent:'')+'|'+(f?f.textContent:'')+'|'+(a&&a.classList.contains('lt-flag'))});
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;
    const page = claimHtml.replace('</body>', `<script>window.__TREE_SRC=${JSON.stringify(TREE_SRC)};</script><script>${drive}</script></body>`);
    const m = run(page, repo);
    expect(m.rows).toEqual([
      'src/e.ts|no functions|unassigned|false',
      'src/ok.ts|||null',
      'src/p.ts|owned by 2+ components|split|false',
      'src/s.ts|shared code|shared|false',
      'src/u.ts|unassigned code|unassigned|false',
    ]);
  });
});

// STOR-6b (b340): the left tree in the storage view (fake DOM): the storage root, zones open one level, kind chip + word.
describe('STOR-6b storage tree', () => {
  function load(hash: string) {
    const h = runViewerScripts(renderViewHtml(storageModel()), { extraIds: ['btn-gear', 'settings-pop'], globals: { location: { href: 'file:///x.html' + hash, hash } } });
    const w = h.sandbox.window as any;
    const rowEls = () => (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).filter(r => r.dataset.id);
    const rows = () => rowEls().map(r => ({ id: r.dataset.id, kind: r.dataset.kind, open: r.getAttribute('aria-expanded'), tag: r.children[1].textContent, name: r.children[2].textContent, word: r.children[3] ? r.children[3].textContent : null }));
    return { w, rows };
  }

  it("'#storage': the tree root is the storage root, its zones are open, a store shows its chip and word", () => {
    const { w, rows } = load('#storage');
    const r = rows();
    expect(r[0]).toMatchObject({ id: '(storage)', open: 'true' });
    expect(r[1]).toMatchObject({ id: 'app.api', kind: 'container', open: 'true' });
    expect(r[2]).toMatchObject({ id: 'app.api.db', kind: 'store', tag: 'STORE', name: 'Main DB', word: 'database', open: 'false' });
    expect(r).toHaveLength(3);   // the store is closed at start: its records are not drawn yet
    const store = (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).find((x: any) => x.dataset.id === 'app.api.db');
    store.children[0].onclick({ stopPropagation() {} });
    const rec = rows().find(x => x.id === 'app.api.db.classes')!;
    expect(rec).toMatchObject({ kind: 'record', tag: 'record', word: 'table' });
  });

  it('arch and io trees are unchanged by it: the arch root, no word flags', () => {
    const { w, rows } = load('');
    expect(rows()[0].id).toBe(w.C4PM_DATA.root.id);
    expect(rows().every(x => x.word === null || ['auto', 'unassigned', 'planned (no code yet)'].includes(x.word))).toBe(true);
    w.C4PM_MODE.set('io');
    expect(rows()[0].id).toBe(w.C4PM_DATA.navView.root.id);
  });
});

// b612: a deep row at the default 270px left panel. The plan-only record 'ghost' (3 levels deep, word + 'planned (no code yet)')
// and its field 'owner' keep their whole name; the flags give way (ellipsized, never under their stub); a row that fits keeps its
// flag whole; no row runs past the panel. Real Chrome, '#storage', every row opened.
describe('b612 deep tree rows keep their name', () => {
  const MEASURE = `(function(){setTimeout(function(){
  var qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))}, o={rows:{}};
  for (var i=0;i<12;i++) qa('#lt-arch .lt-row[aria-expanded="false"] .lt-twist').forEach(function(t){t.click()});
  var panel=document.getElementById('left').getBoundingClientRect();
  o.panelW=panel.width; o.over=qa('#lt-arch .lt-row').filter(function(r){return r.lastElementChild.getBoundingClientRect().right>panel.right+0.5}).length;
  qa('#lt-arch .lt-row[data-id]').forEach(function(r){
    var n=r.querySelector('.lt-name'), rg=document.createRange(); rg.selectNodeContents(n);
    o.rows[r.dataset.id]={box:n.getBoundingClientRect().width, text:rg.getBoundingClientRect().width,
      flags:Array.prototype.slice.call(r.querySelectorAll('.lt-flag')).map(function(f){return {w:f.getBoundingClientRect().width, cut:f.scrollWidth>f.clientWidth}})};
  });
  var p=document.createElement('pre');p.id='__m';p.textContent=encodeURIComponent(JSON.stringify(o));document.body.appendChild(p);
},400)})();`;

  chromeIt('real browser: ghost and owner names whole, flags ellipsized to at least a stub, nothing past the panel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b612-'));
    try {
      const file = path.join(dir, 'page.html');
      fs.writeFileSync(file, renderViewHtml(storageModel()).replace('</body>', () => `<script>${MEASURE}</script></body>`));
      const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}#storage`]);
      const m = JSON.parse(decodeURIComponent(dom.match(/<pre id="__m">(.*?)<\/pre>/s)![1]));
      expect(m.panelW).toBe(270);
      expect(m.over).toBe(0);
      for (const id of ['app.api.db.ghost', 'app.api.db.ghost.owner']) {
        const r = m.rows[id];
        expect({ id, whole: r.text <= r.box + 0.01 }).toEqual({ id, whole: true });
        expect(r.flags.some((f: any) => f.cut)).toBe(true);
        expect(r.flags.every((f: any) => f.w >= 13)).toBe(true);
      }
      expect(m.rows['app.api.db.classes'].flags).toEqual([expect.objectContaining({ cut: false })]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

// C1 A1 (b828): the C1 context is a holder (kindWords `holder`, C4PM_MODE.isHolder). The page of the demo fixture
// (test/fixtures/sim-demo-shop: persons Customer and Staff, system Shop, external Payment gateway), fake DOM:
// no tree row, no crumb and no search hit for the holder; it is never drawn, never hit, never the focus; depth -1.
describe('C1 A1 (b828): the context holder in the viewer', () => {
  let repo: string;
  let page: string;
  beforeAll(() => {
    repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-holder-'))), 'shop');
    fs.cpSync(path.join(__dirname, 'fixtures', 'sim-demo-shop'), repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    page = buildView({ repo }).html;
  });
  afterAll(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

  function load() {
    const h = runViewerScripts(page, { extraIds: ['btn-gear', 'settings-pop'], globals: { location: { href: 'file:///x.html#arch', hash: '#arch' } } });
    h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) h.frames.flush();
    const w = h.sandbox.window as any;
    const rowEls = () => (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).filter(r => r.dataset.id);
    const rows = () => rowEls().map(r => ({ id: r.dataset.id, kind: r.dataset.kind, depth: (parseInt(r.style.paddingLeft, 10) - 8) / 14, open: r.getAttribute('aria-expanded') ?? null }));
    return { h, w, rows };
  }

  it('the tree: no holder row; the top rows are Customer, Staff, Shop (open, its containers below), Payment gateway', () => {
    const { w, rows } = load();
    const root = w.C4PM_DATA.root;
    expect(root).toMatchObject({ kind: 'context' });
    const r = rows();
    expect(r.some(x => x.kind === 'context' || x.id === root.id)).toBe(false);
    expect(r.filter(x => x.depth === 0).map(x => x.id)).toEqual(['customer', 'staff', 'shop', 'payment_gateway']);
    expect(r.find(x => x.id === 'shop')).toMatchObject({ kind: 'system', open: 'true' });
    const system = root.children.find((n: any) => n.kind === 'system');
    expect(r.filter(x => x.depth === 1).map(x => x.id)).toEqual(system.children.map((n: any) => n.id));   // C2 rows, as before
    expect(system.children.length).toBeGreaterThanOrEqual(7);
  });

  it('the map: depth -1, never drawn (no frame, header or bubble), not an open region, never hit, never the focus', () => {
    const { h, w } = load();
    const root = w.C4PM_DATA.root, MAP = w.C4PM_MAP, CAM = w.C4PM_CAM, map = MAP.state;
    const system = root.children.find((n: any) => n.kind === 'system');
    expect([root.depth, system.depth]).toEqual([-1, 0]);
    h.fillTextLog.length = 0;
    MAP.draw();
    expect(h.fillTextLog.filter(t => /SYSTEM CONTEXT/.test(t))).toEqual([]);
    expect(h.fillTextLog).toEqual(expect.arrayContaining(['Shop', 'Customer', 'Staff', 'Payment gateway']));
    expect(map.opens).not.toContain(root);
    expect(map.alpha[root.id]).toBe(1);   // rep() and the sim overlay still walk through it
    expect(CAM.openness(root)).toBe(1);
    expect(CAM.focusNode()).not.toBe(root);
    // C1 C1 (b833): the system is open at the C1 Fit on any window shape (camera.js openness), so the focus is the system, as
    // in the real browser (the chrome test below); before C1 C1 this fake window kept it closed and read 'C1 · System context'
    expect(w.document.getElementById('hud-level').textContent).toBe('C1 · System');
    // a point inside the holder's rect but on no child: nothing is hit; the system's centre hits the system
    const R = root._R, inBox = (b: any, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    let empty: [number, number] | null = null;
    for (let x = Math.ceil(R.x) + 1; x < R.x + R.w && !empty; x += 7) {
      for (let y = Math.ceil(R.y) + 1; y < R.y + R.h && !empty; y += 7) {
        if (!root.children.some((c: any) => inBox(c._R, x, y))) empty = [x, y];
      }
    }
    expect(empty).not.toBeNull();
    expect(CAM.hitTest(empty![0], empty![1])).toBeNull();
    const S = system._R;
    // C1 C1 (b833): the system is open at Fit, so its centre may hit one of its containers; its top-left corner hits the system
    expect(CAM.hitTest(S.x + 3, S.y + 3) === system).toBe(true);
    // Auto level off at Fit: the lock takes the focus, the system (depth 0, C1 C1 b833: open at Fit), so the system stays open;
    // the holder (depth -1) is open whatever the lock
    MAP.setAutoLevel(false);
    expect(map.lockDepth).toBe(0);
    expect([CAM.openness(root), CAM.openness(system)]).toEqual([1, 1]);
  });

  // C1 C1 (b833): at the C1 Fit the system is open (the focus), so the pill reads the system's C1 word, as the demo's "C1 System"
  it('the HUD pill at the C1 Fit: the C1 word on the C1 colour, from the first camera on (before any frame runs)', () => {
    const h = runViewerScripts(page, { extraIds: ['btn-gear', 'settings-pop'], globals: { location: { href: 'file:///x.html#arch', hash: '#arch' } } });
    const pill = (h.sandbox.window as any).document.getElementById('hud-level');
    expect({ text: pill.textContent, bg: pill.style.background }).toEqual({ text: 'C1 · System', bg: 'var(--c1)' });   // no frame flushed yet
    h.frames.runToCompletion();
    expect({ text: pill.textContent, bg: pill.style.background }).toEqual({ text: 'C1 · System', bg: 'var(--c1)' });
    // the stylesheet gives the pill the C1 colour too, so its white text is never on the bare map
    expect(page).toMatch(/#hud-level \{[^}]*background: var\(--c1\);/);
  });

  // Real Chrome: the pill's computed background at Fit is the C1 colour (not transparent) in the light and the dark theme.
  chromeIt('real browser: the HUD pill at the holder level is opaque C1 in light and dark', () => {
    const PROBE = `(function(){setTimeout(function(){var h=document.getElementById('hud-level'),o={};
      ['light','dark'].forEach(function(t){document.documentElement.setAttribute('data-theme',t);o[t]={text:h.textContent,bg:getComputedStyle(h).backgroundColor,c1:getComputedStyle(document.documentElement).getPropertyValue('--c1').trim()};});
      var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);},400)})();`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-hud-'));
    try {
      const file = path.join(dir, 'page.html');
      fs.writeFileSync(file, page.replace('</body>', () => `<script>${PROBE}</script></body>`));
      const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1600,1000', `file://${file}#arch`]);
      const m = JSON.parse(dom.match(/<pre id="__m">(.*?)<\/pre>/s)![1]);
      const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
      for (const t of ['light', 'dark']) {
        // C1 B1 (b831): at Fit the system is open (persons above, externals below, as the demo), so the focus is the system:
        // the pill reads the system's C1 word, as the demo's "C1 System" (before B1 the system was a closed bubble: the holder's word)
        expect(m[t].text).toBe('C1 · System');
        expect(m[t].bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(m[t].bg).toBe(rgb(m[t].c1));
      }
      expect(m.light.c1).not.toBe(m.dark.c1);   // each theme its own C1 colour
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);

  it('the breadcrumb and the search: no holder crumb, no holder hit', () => {
    const { h, w } = load();
    w.C4PM_MAP.select('api');
    expect(h.panel.querySelectorAll('.pn-crumb').map((c: any) => c.textContent)).toEqual(['Shop', 'API']);
    h.search.value = 'Shop';
    h.search.dispatch('input', { target: h.search });
    const names = h.searchResults.querySelectorAll('.pn-search-result').map((r: any) => r.children[0].textContent);
    expect(names.filter((n: string) => n === 'Shop')).toHaveLength(1);   // the system only, not the holder of the same name
  });
});

// C1 A2 (b829): "planned (no code yet)" only on a plan-only node of a kind that needs code (C4PM_MODE.needsCode, KIND_TABLE's
// needsCode on the arch kind rows). Folder-mode greenfield plan, no code: the person and the external are plan-only but need no
// code (no flag); the container and the component are plan-only and need code (flag). Fake DOM: tree rows and panel header.
describe('C1 A2 (b829): no "planned (no code yet)" on kinds that need no code', () => {
  const NO_CODE = 'planned (no code yet)';
  const IDS = ['buyer', 'bank', 'shop.api', 'shop.api.orders'];
  const PLAN = [
    'model {',
    "  buyer = person 'Buyer' {",
    '  }',
    "  shop = system 'Shop' {",
    "    api = container 'API' {",
    "      orders = component 'Orders' {",
    '      }',
    '    }',
    '  }',
    "  bank = external 'Bank' {",
    '  }',
    '  buyer -> shop.api.orders',
    '  shop.api.orders -> bank',
    '}',
  ].join('\n');
  let dir: string;
  let page: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nocode-')));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'plans'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'plans', 'shop.c4'), PLAN);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'nocode-demo' }));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function a() { return 1; }\n');
    page = buildView({ repo: dir }).html;
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function load() {
    const h = runViewerScripts(page, { extraIds: ['btn-gear', 'settings-pop'], globals: { location: { href: 'file:///x.html#arch', hash: '#arch' } } });
    h.frames.runToCompletion();
    const w = h.sandbox.window as any;
    w.C4PM_MAP.select('shop.api.orders');   // opens the rows down to the component
    const row = (id: string) => (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).find(r => r.dataset.id === id);
    const flags = (id: string) => (row(id).querySelectorAll('.lt-flag') as any[]).map(f => f.textContent);
    const planned = () => (h.panel.querySelectorAll('.pn-planned') as any[]).map(e => e.textContent);
    return { w, flags, planned };
  }
  const nodeOf = (n: any, id: string): any => (n.id === id ? n : n.children.map((c: any) => nodeOf(c, id)).find(Boolean));

  it('precondition: all four are plan-only nodes', () => {
    const { w } = load();
    expect(IDS.map(id => nodeOf(w.C4PM_DATA.root, id)).map((n: any) => [n.kind, n.planOnly]))
      .toEqual([['person', true], ['external', true], ['container', true], ['component', true]]);
  });

  it('the tree: no flag on the person and the external; the container and the component keep it', () => {
    const { flags } = load();
    expect(IDS.map(id => flags(id).includes(NO_CODE))).toEqual([false, false, true, true]);
  });

  it('the panel: no flag on the person and the external; the container and the component keep it', () => {
    const { w, planned } = load();
    expect(IDS.map(id => { w.C4PM_MAP.select(id); return planned(); })).toEqual([[], [], [NO_CODE], [NO_CODE]]);
  });
});
