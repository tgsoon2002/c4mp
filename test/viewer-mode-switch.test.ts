import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { ViewModel } from '../src/types';
import { withFakeView, FAKE_STORAGE_ROOT } from './helpers/fake-view';

// P20-T5-B (b256): the #io mode switch. mode.js picks the tree, map.js loadTree swaps what the engine reads.

const SCREENS = ['shop.web.login', 'shop.web.home', 'shop.web.cart', 'shop.mobile.mhome'];

function load(model: ViewModel, hash: string, page: (html: string) => string = x => x): { h: HarnessResult; loc: { href: string; hash: string } } {
  const loc = { href: 'file:///x.html' + hash, hash };
  const h = runViewerScripts(page(renderViewHtml(model)), { extraIds: ['btn-gear', 'settings-pop'], globals: { location: loc } });
  return { h, loc };
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const walk = (n: any): string[] => [n.id, ...(n.children || []).flatMap(walk)];

describe('mode switch (#io)', () => {
  it('loads the io tree from #io: screens in nodeById, arch components gone, data is the navView', () => {
    const { h } = load(loadSample(), '#io');
    const w = win(h);
    const ids = Object.keys(w.C4PM_STATE.nodeById);
    SCREENS.forEach(s => expect(ids).toContain(s));
    const io = walk(w.C4PM_DATA.navView.root);
    walk(w.C4PM_DATA.root).filter(id => !io.includes(id)).forEach(id => expect(ids).not.toContain(id));
    expect(w.C4PM_STATE.data.root).toBe(w.C4PM_DATA.navView.root);
    expect(w.C4PM_STATE.data.edges).toBe(w.C4PM_DATA.navView.edges);
    expect(w.C4PM_STATE.data.title).toBe(w.C4PM_DATA.title);   // the rest of C4PM_DATA is inherited
    expect(w.C4PM_MAP.nodeById('shop.web.cart').parent.id).toBe('shop.web');
    expect(w.C4PM_MODE.get()).toBe('io');
    expect((h.sandbox as any).document.documentElement.attrs['data-mode']).toBe('io');
  });

  it('hashchange back to arch: nodes restored, same nodeById object, cam refit, selection cleared, state reset', () => {
    const { h, loc } = load(loadSample(), '#io');
    const w = win(h);
    const st = w.C4PM_STATE;
    const byId = st.nodeById;
    const seen: any[] = [];
    w.C4PM_MAP.onSelect((n: any) => seen.push(n));
    w.C4PM_MAP.select('shop.web.cart');
    st.map.cam = { s: 9, tx: 1, ty: 1 };
    st.map.cw = 800; st.map.ch = 600;
    st.map.lockDepth = 2; st.map.opens = ['x']; st.map.hi = new Set(['a']);
    st.map.history.undo.push({});
    seen.length = 0;
    loc.hash = '';
    h.fireWindowEvent('hashchange');
    expect(st.nodeById).toBe(byId);
    expect(Object.keys(st.nodeById)).not.toContain('shop.web.cart');
    expect(st.nodeById[w.C4PM_DATA.root.id]).toBe(w.C4PM_DATA.root);
    expect(st.data).toBe(w.C4PM_DATA);
    expect(st.map.cam).not.toBeNull();
    expect(st.map.cam.s).not.toBe(9);
    expect(st.map.selectedId).toBeNull();
    expect(seen).toEqual([null]);
    expect(st.map.lockDepth).toBe(-1);
    expect(st.map.opens).toEqual([]);
    expect(st.map.history).toEqual({ undo: [], redo: [] });
    expect(st.map.hi).toBeNull();
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect((h.sandbox as any).document.documentElement.attrs['data-mode']).toBe('arch');
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(Object.keys(st.nodeById)).toContain('shop.web.cart');
  });

  it('cam is null until the map is sized (the first resize refits)', () => {
    const { h, loc } = load(loadSample(), '');
    const st = win(h).C4PM_STATE;
    st.map.cw = 0;
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(st.map.cam).toBeNull();
  });

  it('#io without navView stays arch and fires nothing', () => {
    const m = loadSample();
    delete m.navView;
    const { h } = load(m, '#io');
    const w = win(h);
    const seen: string[] = [];
    w.C4PM_MODE.onChange((x: string) => seen.push(x));
    h.fireWindowEvent('hashchange');
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(seen).toEqual([]);
    expect(Object.keys(w.C4PM_STATE.nodeById)).not.toContain('shop.web.cart');
  });

  it('onChange fires once per real change, after the tree is loaded', () => {
    const { h, loc } = load(loadSample(), '');
    const w = win(h);
    const seen: Array<[string, boolean]> = [];
    w.C4PM_MODE.onChange((m: string) => seen.push([m, !!w.C4PM_STATE.nodeById['shop.web.cart']]));
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    h.fireWindowEvent('hashchange');   // no real change
    loc.hash = '#io&x=1';
    h.fireWindowEvent('hashchange');   // still io
    loc.hash = '#other';
    h.fireWindowEvent('hashchange');
    expect(seen).toEqual([['io', true], ['arch', false]]);
  });

  it('set() of a mode the plan does not have throws instead of falling back', () => {
    const { h } = load(loadSample(), '');
    expect(() => win(h).C4PM_MODE.set('data')).toThrow('no mode');
    expect(win(h).C4PM_MODE.get()).toBe('arch');
  });

  it('origRects keep the ORIGINAL rects of a tree across a round trip', () => {
    const { h, loc } = load(loadSample(), '');
    const w = win(h);
    const root = w.C4PM_DATA.root;
    const x0 = root.x;
    root.x = x0 + 50;   // an in-memory edit
    loc.hash = '#io'; h.fireWindowEvent('hashchange');
    loc.hash = ''; h.fireWindowEvent('hashchange');
    expect(w.C4PM_STATE.origRects[root.id].x).toBe(x0);
  });
});

describe('VIEW-0 view registry (C4PM_VIEWS)', () => {
  it('a real page registers arch, io, storage; has("storage") is false without storageView; renderer() is null in arch, the IO renderer in io', () => {
    const { h, loc } = load(loadSample(), '');
    const w = win(h);
    expect(Object.keys(w.C4PM_VIEWS)).toEqual(['arch', 'io', 'storage']);   // STOR-6a (b339): storageView.js registers 'storage' on every page
    expect(w.C4PM_MODE.has('storage')).toBe(false);
    expect(w.C4PM_MODE.has('toString')).toBe(false);
    expect(w.C4PM_MODE.renderer()).toBeNull();
    loc.hash = '#storage';
    h.fireWindowEvent('hashchange');
    expect(w.C4PM_MODE.get()).toBe('arch');
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(w.C4PM_MODE.renderer()).toBe(w.C4PM_IOVIEW);
  });

  it('a second registration of the same name throws; a bad spec throws', () => {
    const { h } = load(loadSample(), '');
    const M = win(h).C4PM_MODE;
    const spec = { label: 'X view', short: 'X', tree: () => null, renderer: () => null };
    expect(() => M.registerView('io', spec)).toThrow('already registered');
    expect(() => M.registerView('x', { ...spec, tree: undefined })).toThrow('tree() and renderer()');
    expect(() => M.registerView('x', { ...spec, label: undefined })).toThrow('label and short');
  });

  it('#storage of a registered view with data loads its tree; hashchange back to arch restores the arch tree', () => {
    const { h, loc } = load(loadSample(), '#storage', withFakeView);
    const w = win(h);
    expect(w.C4PM_MODE.has('storage')).toBe(true);
    expect(w.C4PM_MODE.get()).toBe('storage');
    expect(w.C4PM_STATE.data.root.id).toBe(FAKE_STORAGE_ROOT.id);
    expect(Object.keys(w.C4PM_STATE.nodeById).sort()).toEqual(['(storage)', 'db.users']);
    expect((h.sandbox as any).document.documentElement.attrs['data-mode']).toBe('storage');
    expect(w.C4PM_MODE.renderer()).toBe(w.C4PM_STORAGEVIEW);   // STOR-6a (b339): the storage view's own renderer
    loc.hash = '';
    h.fireWindowEvent('hashchange');
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(w.C4PM_STATE.data).toBe(w.C4PM_DATA);
    expect(w.C4PM_STATE.nodeById[w.C4PM_DATA.root.id]).toBe(w.C4PM_DATA.root);
    expect(Object.keys(w.C4PM_STATE.nodeById)).not.toContain('db.users');
  });

  it('a view whose tree is null is not there: ignored in the hash, set() throws, its segment disabled', () => {
    const { h, loc } = load(loadSample(), '#storage');   // STOR-6a (b339): a real page has the storage view, the sample no storageView
    const w = win(h);
    expect(w.C4PM_MODE.has('storage')).toBe(false);
    expect(w.C4PM_MODE.get()).toBe('arch');
    loc.hash = '#io'; h.fireWindowEvent('hashchange');
    loc.hash = '#storage'; h.fireWindowEvent('hashchange');
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(() => w.C4PM_MODE.set('storage')).toThrow('no mode');
    const seg = (h.sandbox as any).document.getElementById('view-switch').children.find((b: any) => b.getAttribute('data-mode') === 'storage');
    expect(seg.disabled).toBe(true);
    expect(seg.getAttribute('title')).toBe('Nothing for the Storage view in the plan yet');
  });

  // LAY-12b (b382): mode.js names no later script; map.js registers loadTree through setTreeLoader. No loader: a clear error, no fallback.
  it('set() throws when no tree loader is registered; setTreeLoader receives the view tree', () => {
    const sandbox: any = { console, C4PM_DATA: { root: { id: 'r' }, edges: [] }, document: { documentElement: { setAttribute: () => {} } } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/mode.js'), 'utf8'), sandbox, { filename: 'mode.js' });
    const mode = sandbox.C4PM_MODE;
    mode.registerView('other', { label: 'Other', short: 'O', tree: (d: any) => ({ root: d.root, edges: d.edges }), renderer: () => null });
    expect(() => mode.set('other')).toThrow('no tree loader registered');
    expect(() => mode.setTreeLoader('x' as any)).toThrow('fn must be a function');
    const got: any[] = [];
    mode.setTreeLoader((t: any) => got.push(t));
    mode.set('other');
    expect(got).toEqual([{ root: { id: 'r' }, edges: [] }]);
    expect(mode.get()).toBe('other');
  });
});
