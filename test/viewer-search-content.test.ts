import path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import type { ViewNode } from '../src/types';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import { BOARD_EXTRA_IDS, sampleBoard } from './helpers/viewer-board-fixture';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';

// b144: the search box also searches content (the function source and plan-file text the page already holds).
// Fixture: sample-v2 with source lines set on a few nodes by hand (so the test does not depend on files on disk).

const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };

const MARKUP = '<img src=x onerror=alert(1)> payTotal()';
const MANY = Array.from({ length: 60 }, (_, i) => `const needle${i} = 1;`);
const IDS = ['search-mode', 'search-hint'];
const NAMES_HINT = 'Names: what it is called';
const CONTENT_HINT = 'Content: what it says (functions, plan text and b-items the page holds; use `c4mp search` for the whole repo)';

// `board`: SRCH-1 (b235): the page also holds the sample board, b1's description says "computeTotal" (a word in a's body too)
function setup(globals: Record<string, unknown> = {}, board = false) {
  const { model } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  const fnNodes: ViewNode[] = [];
  walk(model.root, n => { if (n.kind === 'function' || n.kind === 'method') fnNodes.push(n); });
  fnNodes[0].file = 'src/a.ts'; fnNodes[0].line = 10;
  fnNodes[0].code = ['function a() {', '  return computeTotal(1);', '}', MARKUP];
  fnNodes[1].file = 'src/b.ts'; fnNodes[1].line = 5;
  fnNodes[1].code = MANY;
  if (board) {
    model.board = sampleBoard(model);
    model.board.boards[0].items[0].description = 'Uses computeTotal for the sum.';
  }
  const h = runViewerScripts(renderViewHtml(model), { extraIds: board ? [...IDS, ...BOARD_EXTRA_IDS] : IDS, globals });
  return { h, a: fnNodes[0] };
}

const el = (h: HarnessResult, id: string): FakeEl => (h.sandbox.document as any).getElementById(id);
const modeBtn = (h: HarnessResult, label: string): FakeEl => el(h, 'search-mode').children.find(c => c.textContent === label)!;
const hint = (h: HarnessResult) => el(h, 'search-hint').textContent;
const type = (h: HarnessResult, q: string, flush = true) => {
  h.search.value = q;
  h.search.dispatch('input', { target: h.search });
  if (flush) h.flushTimers();
};
const rows = (h: HarnessResult) => h.searchResults.querySelectorAll('.pn-search-result');

describe('b144 search Content mode', () => {
  it('Names is the default and unchanged: a body text finds nothing, a name finds the node', () => {
    const { h } = setup();
    expect(hint(h)).toBe(NAMES_HINT);
    type(h, 'computeTotal');
    expect(serializeText(h.searchResults)).toContain('No results');
    type(h, 'routes');
    expect(rows(h).length).toBeGreaterThan(0);
  });

  it('Content finds a text inside a function body (case-insensitive), shows name, file:line and the highlighted line', () => {
    const { h, a } = setup();
    modeBtn(h, 'Content').click();
    expect(hint(h)).toBe(CONTENT_HINT);
    type(h, 'COMPUTETOTAL');
    const r = rows(h);
    expect(r.length).toBe(1);
    const t = serializeText(r[0]);
    expect(t).toContain(a.name);
    expect(t).toContain('src/a.ts:11');
    const mark = r[0].querySelectorAll('mark');
    expect(mark.length).toBe(1);
    expect(mark[0].textContent).toBe('computeTotal');
  });

  it('source markup is shown as text, never parsed', () => {
    const { h } = setup();
    modeBtn(h, 'Content').click();
    type(h, 'onerror');
    const r = rows(h);
    expect(r.length).toBe(1);
    const t = serializeText(r[0]);   // serializeText puts spaces between pieces; the markup characters themselves stay text
    expect(t).toContain('<img src=x');
    expect(t).toContain('alert(1)>');
    expect(r[0].querySelectorAll('mark')[0].textContent).toBe('onerror');
    expect(r[0].querySelectorAll('img').length).toBe(0);
  });

  it('needs 2 characters, waits for the debounce, and caps at 50 rows plus a "+N more" row', () => {
    const { h } = setup();
    modeBtn(h, 'Content').click();
    type(h, 'n');
    expect(rows(h).length).toBe(0);
    type(h, 'needle', false);
    expect(rows(h).length).toBe(0);   // debounce not yet fired
    h.flushTimers();
    expect(rows(h).length).toBe(50);
    expect(h.searchResults.querySelectorAll('.pn-search-more')[0].textContent).toBe('+10 more');
  });

  it('a click selects the node on the map like a Names result; Escape clears; Enter takes the first row', () => {
    const { h, a } = setup();
    const map = h.sandbox.C4PM_MAP as any;
    const sel: string[] = [];
    const orig = map.select;
    map.select = (id: string) => { sel.push(id); return orig(id); };
    modeBtn(h, 'Content').click();
    type(h, 'computeTotal');
    rows(h)[0].click();
    expect(sel).toEqual([a.id]);
    expect(h.search.value).toBe('');
    type(h, 'computeTotal');
    h.search.dispatch('keydown', { key: 'Escape', target: h.search });
    expect(rows(h).length).toBe(0);
    type(h, 'computeTotal');
    h.search.dispatch('keydown', { key: 'Enter', target: h.search });
    expect(sel).toEqual([a.id, a.id]);
  });

  it('SRCH-1: with a board, Content shows the function hits, then the board rows under their label', () => {
    const { h, a } = setup({}, true);
    modeBtn(h, 'Content').click();
    type(h, 'computeTotal');
    const kids = h.searchResults.children;
    expect(kids.map(k => k.className)).toEqual(['pn-search-result pn-search-content', 'bd-search-label', 'bd-search-result']);
    expect(serializeText(kids[0])).toContain(a.name);
    expect(kids[1].textContent).toBe('Board items');
    expect(serializeText(kids[2])).toContain('b1');
  });

  it('SRCH-1: Enter takes a map row before a board row; Escape clears both', () => {
    const { h, a } = setup({}, true);
    const map = h.sandbox.C4PM_MAP as any;
    const sel: string[] = [];
    const orig = map.select;
    map.select = (id: string) => { sel.push(id); return orig(id); };
    const B = h.sandbox.C4PM_BOARD as any;
    modeBtn(h, 'Content').click();
    type(h, 'computeTotal');
    h.search.dispatch('keydown', { key: 'Enter', target: h.search });
    expect(sel).toEqual([a.id]);
    expect(B.selectedId()).toBeNull();
    type(h, 'computeTotal');
    h.search.dispatch('keydown', { key: 'Escape', target: h.search });
    expect(h.searchResults.children.length).toBe(0);
    expect(h.search.value).toBe('');
  });

  it('plan-file text held by the page is searched too', () => {
    const { model } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
    const pf = { path: 'arch/x.c4', kind: 'plan' as const, owners: [], lines: ['system x {', '  uniqueplanword', '}'] };
    model.files.push(pf);
    const h = runViewerScripts(renderViewHtml(model), { extraIds: IDS });
    modeBtn(h, 'Content').click();
    type(h, 'uniqueplanword');
    expect(serializeText(rows(h)[0])).toContain(pf.path + ':2');
  });

  it('remembers the mode in localStorage; blocked storage still works', () => {
    const store: Record<string, string> = {};
    const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    modeBtn(setup({ localStorage: ls }).h, 'Content').click();
    expect(JSON.parse(store['c4mp.settings']).search).toBe('content');   // P20-T11: one settings object
    expect(hint(setup({ localStorage: ls }).h)).toBe(CONTENT_HINT);   // restored
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const b = setup({ localStorage: blocked }).h;
    expect(() => modeBtn(b, 'Content').click()).not.toThrow();
    type(b, 'computeTotal');
    expect(rows(b).length).toBe(1);
  });
});

// STOR-6b (b340): the 'storage' search provider (S7) in the storage view; none of its rows in the architecture view.
describe('STOR-6b search in the storage view', () => {
  const STORAGE_HINT = 'Content: what it says (field types, notes and descriptions of the storage tree)';
  // The sample page with the Drizzle fixture's storage tree; one function holds words that are also a storage type and a record name.
  function storagePage(hash: string) {
    const m = storageModel();
    const fn = (function find(n: ViewNode): ViewNode | null { return n.kind === 'function' ? n : n.children.map(find).find(Boolean) || null; })(m.root)!;
    fn.file = 'src/a.ts'; fn.line = 10;
    fn.code = ['const at: timestamptz = 1;', 'enrollments();'];
    const h = runViewerScripts(renderViewHtml(m), { extraIds: [...IDS, 'btn-gear', 'settings-pop'], globals: { location: { href: 'file:///x.html' + hash, hash } } });
    return { h, w: h.sandbox.window as any, fn };
  }
  const names = (h: HarnessResult) => rows(h).map(r => r.children[0].textContent);

  it('Content finds a field type word; each row names what matched; no function source line', () => {
    const { h, w } = storagePage('#storage');
    expect(w.C4PM_MODE.get()).toBe('storage');
    modeBtn(h, 'Content').click();
    expect(hint(h)).toBe(STORAGE_HINT);
    type(h, 'timestamptz');
    const r = rows(h);
    expect(r.length).toBeGreaterThan(0);
    r.forEach(x => expect(serializeText(x)).toContain('type: timestamptz'));
    expect(h.searchResults.querySelectorAll('.pn-search-line').length).toBe(0);
    expect(h.searchResults.querySelectorAll('.pn-search-loc').length).toBe(0);
    expect(serializeText(h.searchResults)).not.toContain('src/a.ts');
    r[0].click();
    expect(w.C4PM_STATE.nodeById[w.C4PM_MAP.selectedId()].meta.type).toBe('timestamptz');
  });

  it('Names finds a record once (the provider row, not a node-index row too); (storage) is never a hit', () => {
    const { h } = storagePage('#storage');
    type(h, 'enrollments');
    expect(names(h).filter(n => n === 'enrollments')).toHaveLength(1);
    expect(names(h)).toEqual(['enrollments']);   // its fields' ids hold the word too, but only the last id segment is a name
    type(h, '(storage)');
    expect(names(h)).not.toContain('Storage view');
    type(h, 'storage view');
    expect(names(h)).not.toContain('Storage view');
  });

  it('Enter takes the first storage row', () => {
    const { h, w } = storagePage('#storage');
    type(h, 'enrollments');
    h.search.dispatch('keydown', { key: 'Enter', target: h.search });
    expect(w.C4PM_MAP.selectedId()).toBe('db/schema/enrollment.ts#enrollments');
  });

  it('architecture view: no storage rows, and the source-line search as today', () => {
    const { h, w, fn } = storagePage('');
    expect(w.C4PM_MODE.get()).toBe('arch');
    type(h, 'enrollments');
    expect(names(h)).not.toContain('enrollments');
    modeBtn(h, 'Content').click();
    expect(hint(h)).toBe(CONTENT_HINT);
    type(h, 'timestamptz');
    const r = rows(h);
    expect(r.length).toBe(1);
    expect(serializeText(r[0])).toContain(fn.name);
    expect(serializeText(r[0])).toContain('src/a.ts:10');
  });
});
