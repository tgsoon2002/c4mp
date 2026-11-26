import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessOpts, HarnessResult } from './helpers/viewer-harness';
import { loadSample, ioModel } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// P20-T5-0 (b254): the contracts of the IO-view setup: mode/openView/link stubs, the settings 'link' status line,
// the harness window fakes and the sample data. Wave-1 tasks (b255-b262) build on exactly these.

const IDS = ['btn-gear', 'settings-pop'];

function load(model: ViewModel, opts: HarnessOpts = {}): HarnessResult {
  return runViewerScripts(renderViewHtml(model), { extraIds: IDS, ...opts });
}
const win = (h: HarnessResult) => h.sandbox.window as any;

describe('C4PM_MODE stub', () => {
  it('starts in arch; has() reflects navView; set() fires onChange once per real change, in order', () => {
    const h = load(loadSample());
    const M = win(h).C4PM_MODE;
    expect(M.get()).toBe('arch');
    expect(M.has('arch')).toBe(true);
    expect(M.has('io')).toBe(true);
    expect(M.has('data')).toBe(false);
    const seen: string[] = [];
    M.onChange((m: string) => seen.push('a:' + m));
    M.onChange((m: string) => seen.push('b:' + m));
    M.set('io');
    M.set('io');
    expect(M.get()).toBe('io');
    expect(seen).toEqual(['a:io', 'b:io']);
    M.set('arch');
    expect(seen).toEqual(['a:io', 'b:io', 'a:arch', 'b:arch']);
  });

  it('has("io") is false without navView, and the stub loads no tree', () => {
    const m = loadSample();
    delete m.navView;
    const h = load(m);
    expect(win(h).C4PM_MODE.has('io')).toBe(false);
    expect(win(h).C4PM_MAP.nodeById('shop.web.cart')).toBeUndefined();
  });

  it('listener exceptions are not caught', () => {
    const M = win(load(loadSample())).C4PM_MODE;
    M.onChange(() => { throw new Error('boom'); });
    expect(() => M.set('io')).toThrow('boom');
  });

  it.each([
    ['#io', true, 'io'],
    ['#io&x=1', true, 'io'],
    ['#iotas', true, 'arch'],
    ['', true, 'arch'],
    ['#io', false, 'arch'],
  ])('start() with hash %j (navView %s) gives %s', (hash, withNav, want) => {
    const m = loadSample();
    if (!withNav) delete m.navView;
    const h = load(m, { globals: { location: { href: 'file:///x.html' + hash, hash } } });
    expect(win(h).C4PM_MODE.get()).toBe(want);
  });

  it('start() without a location stays in arch', () => {
    expect(win(load(loadSample())).C4PM_MODE.get()).toBe('arch');
  });
});

describe('C4PM_OPEN and C4PM_LINK stubs', () => {
  // P20-T5-G (b261) replaced the C4PM_OPEN stub; its behaviour is tested in viewer-open-view.test.ts.
  // P20-T5-H (b262) replaced the C4PM_LINK stub; its behaviour is tested in viewer-link.test.ts (no BroadcastChannel in this sandbox).
  it('open is a function; link has no channel here and send does nothing', () => {
    const w = win(load(loadSample()));
    expect(typeof w.C4PM_OPEN).toBe('function');
    expect(w.C4PM_LINK.status()).toBe('not available (each window works alone)');
    expect(w.C4PM_LINK.send('shop.web.cart')).toBeUndefined();
  });
});

describe('settings: Window link row with a status line', () => {
  it('DEF.link is on|off, default on, with status()', () => {
    const S = win(load(loadSample())).C4PM_SETTINGS;
    expect(S.DEF.link.label).toBe('Window link');
    expect(S.DEF.link.opts.map((o: string[]) => o[0])).toEqual(['on', 'off']);
    expect(S.get('link')).toBe('on');
    expect(S.DEF.link.status()).toBe('not available (each window works alone)');
    S.set('link', 'off');
    expect(S.get('link')).toBe('off');
  });

  it('the popup shows the status under the row and re-reads it when the gear is clicked', () => {
    const h = load(loadSample());
    const doc = h.sandbox.document as any;
    const pop = doc.getElementById('settings-pop');
    const lines = () => pop.children.filter((c: any) => c.className === 'set-status').map((c: any) => c.textContent);
    // the harness runs map.js's init at load (readyState 'complete'), before link.js exists: the row starts empty, the first open fills it
    expect(lines()).toEqual(['', expect.stringContaining('Kept in this browser')]);
    doc.getElementById('btn-gear').click();
    expect(lines()[0]).toBe('not available (each window works alone)');
    let text = '2 other windows';
    win(h).C4PM_LINK.status = () => text;
    doc.getElementById('btn-gear').click();
    expect(lines()[0]).toBe('2 other windows');
    text = 'no other window yet';
    doc.getElementById('btn-gear').click();
    expect(lines()[0]).toBe('no other window yet');
  });
});

describe('harness window fakes', () => {
  it('fireWindowEvent calls the recorded listeners; removeEventListener drops one', () => {
    const h = load(loadSample());
    const w = win(h);
    const got: unknown[] = [];
    const fn = (e: unknown) => got.push(e);
    w.addEventListener('hashchange', fn);
    expect(h.windowListeners.hashchange).toContain(fn);
    h.fireWindowEvent('hashchange');
    h.fireWindowEvent('hashchange', { type: 'hashchange', n: 2 });
    expect(got).toEqual([{ type: 'hashchange' }, { type: 'hashchange', n: 2 }]);
    w.removeEventListener('hashchange', fn);
    h.fireWindowEvent('hashchange');
    expect(got).toHaveLength(2);
    h.fireWindowEvent('nothing-listens');
  });

  it('location comes from opts.globals', () => {
    const h = load(loadSample(), { globals: { location: { href: 'file:///a.html#io', hash: '#io' } } });
    expect(win(h).location.hash).toBe('#io');
  });
});

describe('sample data helpers', () => {
  it('loadSample returns an independent deep copy of a complete ViewModel', () => {
    const a = loadSample();
    a.title = 'changed';
    a.navView!.root.children = [];
    const b = loadSample();
    expect(b.title).toBe('sample-shop');
    expect(b.navView!.root.children).toHaveLength(2);
    expect(b.schemaVersion).toBe(1);
    for (const k of ['title', 'subtitle', 'summary', 'repoPath', 'root', 'edges', 'drift', 'planFindings', 'files', 'nav', 'navView'] as const) {
      expect(b).toHaveProperty(k);
    }
    expect(b.root.id).not.toBe('(io)');
  });

  it('navView holds the io tree: groups, screens, positions, edges', () => {
    const nv = loadSample().navView!;
    expect(nv.root).toMatchObject({ id: '(io)', kind: 'system', name: 'IO view' });
    expect(nv.root.children.map(g => [g.id, g.kind, g.name])).toEqual([['shop.web', 'container', 'Web app'], ['shop.mobile', 'container', 'Shop mobile app']]);
    const screens = nv.root.children.flatMap(g => g.children);
    expect(screens.map(s => s.id)).toEqual(['shop.web.login', 'shop.web.home', 'shop.web.cart', 'shop.mobile.mhome']);
    for (const s of screens) {
      expect(s.kind).toBe('screen');
      expect(s.uid).toBeTruthy();
      expect(s.meta?.status).toBeTruthy();
      expect(s.w).toBeGreaterThan(0);
      expect(s.h).toBeGreaterThan(0);
      expect(s.bubble).toBeDefined();
    }
    expect(nv.edges).toHaveLength(4);
  });

  it('ioModel replaces root/edges by navView and keeps nav and navView', () => {
    const s = loadSample();
    const f = ioModel(s);
    expect(f.root.id).toBe('(io)');
    expect(f.edges).toEqual(s.navView!.edges);
    expect(f.nav).toEqual(s.nav);
    expect(f.navView).toEqual(s.navView);
    expect(s.root.id).not.toBe('(io)');   // the source is untouched
    expect(() => ioModel({ ...s, navView: undefined })).toThrow('no navView');
  });

  it('the sample loads in the page (arch) and ioModel(sample) selects the screen', () => {
    const arch = load(loadSample());
    arch.frames.runToCompletion();
    expect(win(arch).C4PM_MAP.select('shop.web.cart')).toBe(false);   // not in the arch tree

    const io = load(ioModel(loadSample()));
    io.frames.runToCompletion();
    expect(win(io).C4PM_MAP.select('shop.web.cart')).toBe(true);
    expect(win(io).C4PM_MAP.selectedId()).toBe('shop.web.cart');
  });
});
