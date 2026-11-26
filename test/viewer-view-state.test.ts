import * as path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { simHtml } from './helpers/sim-view';
import { BOARD_EXTRA_IDS, sampleBoard } from './helpers/viewer-board-fixture';
import { storageModel, ENROLLMENTS, CLASS_ID } from './helpers/storage-view';
import type { ViewModel } from '../src/types';

// Phase 30 SV9a (b642 part 1): viewer/viewState.js keeps the view, the selection, the camera, the overlays, the search and
// the simulation of a tab across reloads (sessionStorage 'c4pm.view:' + repoPath) and puts the selection in the hash (sel=).
// A "reload" here = a second page on the same fake sessionStorage; the restore runs on the page's first timers.

const KEY = 'c4pm.view:/repo/shop';
const IDS = ['btn-gear', 'settings-pop', 'view-toast'];

function memStore(init: Record<string, string> = {}) {
  const m: Record<string, string> = { ...init };
  return { m, api: { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v); }, removeItem: (k: string) => { delete m[k]; } } };
}
interface Page { h: HarnessResult; w: any; loc: { href: string; hash: string } }
function load(hash: string, session: unknown, html = renderViewHtml(loadSample()), extraIds: string[] = []): Page {
  const loc = { href: 'file:///x.html' + hash, hash };
  const globals: Record<string, unknown> = { location: loc, localStorage: memStore().api };
  if (session !== undefined) globals.sessionStorage = session;
  const h = runViewerScripts(html, { extraIds: [...IDS, ...extraIds], globals });
  h.flushTimers();   // the restore (120 ms after load)
  return { h, w: h.sandbox.window as any, loc };
}
const kept = (s: { m: Record<string, string> }) => JSON.parse(s.m[KEY]);
// The world point at the screen centre, as offsets from node `id`'s centre in node widths / heights, and the zoom ratio to its fit.
function centreOn(p: Page, id: string) {
  const { map, nodeById } = p.w.C4PM_STATE;
  const n = nodeById[id], c = map.cam;
  const wx = (map.cw / 2 - c.tx) / c.s, wy = (map.ch / 2 - c.ty) / c.s;
  return { z: c.s / p.w.C4PM_CAM.fitCam(n).s, ox: (wx - (n.x + n.w / 2)) / n.w, oy: (wy - (n.y + n.h / 2)) / n.h };
}
// A camera centred on node `id` at `k` times its fit zoom, a quarter node width right of its centre.
function aimAt(p: Page, id: string, k: number) {
  const { map, nodeById } = p.w.C4PM_STATE;
  const n = nodeById[id];
  const s = p.w.C4PM_CAM.fitCam(n).s * k, cx = n.x + n.w * 0.75, cy = n.y + n.h / 2;
  map.cam = { s, tx: map.cw / 2 - cx * s, ty: map.ch / 2 - cy * s };
}

describe('save, then a fresh page restores', () => {
  it('view, selection, camera (same node centred, same zoom ratio), overlays and the search text', () => {
    const s = memStore();
    const a = load('', s.api);
    a.loc.hash = '#io';
    a.h.fireWindowEvent('hashchange');
    expect(a.w.C4PM_MODE.get()).toBe('io');
    const io = Object.keys(a.w.C4PM_STATE.nodeById).find(id => a.w.C4PM_STATE.nodeById[id].kind === 'screen')!;
    a.w.C4PM_MAP.select(io);
    aimAt(a, io, 2);
    a.w.C4PM_MAP.setOverlay('drift', false);
    a.h.search.value = 'order';
    a.h.fireWindowEvent('pagehide');
    const st = kept(s);
    expect(st).toMatchObject({ v: 1, view: 'io', sel: io, overlays: { drift: false, findings: true }, search: { q: 'order', mode: 'names' } });
    expect(st.cam).toMatchObject({ view: 'io', id: expect.any(String), px: a.w.C4PM_STATE.map.cam });

    const b = load('', s.api);   // the hash lost its view: the stored one comes back
    expect(b.w.C4PM_MODE.get()).toBe('io');
    expect(b.loc.hash.split('&')[0]).toBe('#io');
    expect(b.w.C4PM_MAP.selectedId()).toBe(io);
    expect(b.w.C4PM_STATE.overlays.drift).toBe(false);
    expect(b.h.search.value).toBe('order');
    const ca = centreOn(a, io), cb = centreOn(b, io);
    expect(cb.z).toBeCloseTo(ca.z, 6);
    expect(cb.ox).toBeCloseTo(ca.ox, 6);
    expect(cb.oy).toBeCloseTo(ca.oy, 6);
  });

  it('a node that moved in the new page stays centred (node-relative camera, not pixels)', () => {
    const s = memStore();
    const a = load('', s.api);
    aimAt(a, 'api/payments', 3);
    a.w.C4PM_VIEWSTATE.save();
    const before = centreOn(a, 'api/payments');
    const moved = loadSample() as ViewModel;
    const shift = (n: any) => { n.x += 20; n.y += 10; (n.children || []).forEach(shift); };
    shift(moved.root.children!.find(c => c.id === 'api')!);
    const b = load('', s.api, renderViewHtml(moved));
    const after = centreOn(b, 'api/payments');
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(after.ox).toBeCloseTo(before.ox, 6);
    expect(b.w.C4PM_STATE.map.cam.tx).not.toBeCloseTo(a.w.C4PM_STATE.map.cam.tx, 1);
  });

  it('the simulation selection and its step cursor', () => {
    const s = memStore();
    const a = load('', s.api, simHtml());
    a.w.C4PM_SIM.select('s-1', { fit: false });
    a.w.C4PM_SIM.go(2);
    expect(kept(s).sim).toEqual({ id: 's-1', step: 2 });
    const b = load('', s.api, simHtml());
    expect([b.w.C4PM_SIM.selected(), b.w.C4PM_SIM.step()]).toEqual(['s-1', 2]);
  });
});

describe('restore rules', () => {
  const seeded = (state: unknown) => memStore({ [KEY]: JSON.stringify(state) });

  it('a removed node falls back to px; nothing usable keeps the Fit camera', () => {
    const px = { s: 0.5, tx: 10, ty: 20 };
    const b = load('', seeded({ v: 1, view: 'arch', cam: { view: 'arch', id: 'gone', z: 2, ox: 0, oy: 0, px } }).api);
    expect(b.w.C4PM_STATE.map.cam).toEqual(px);
    const fit = load('', memStore().api).w.C4PM_STATE.map.cam;
    for (const cam of [{ id: 'gone', z: 2, ox: 0, oy: 0 }, { id: 'api', z: 'x' }, { px: { s: -1, tx: 0, ty: 0 } }, { view: 'io', px }, 'junk']) {
      const c = load('', seeded({ v: 1, cam }).api);
      expect(c.w.C4PM_STATE.map.cam).toEqual(fit);
    }
  });

  it('an id that no longer exists is skipped; a bad part never stops the others', () => {
    const b = load('', seeded({ v: 1, view: 'nope', sel: 'gone', overlays: { drift: false, toString: false }, search: 7 }).api);
    expect(b.w.C4PM_MODE.get()).toBe('arch');
    expect(b.w.C4PM_MAP.selectedId()).toBeNull();
    expect(b.w.C4PM_STATE.overlays.drift).toBe(false);
  });

  it('a hash sel wins over the stored one and flies there; the view in the hash wins over the stored view', () => {
    const b = load('#arch&sel=' + encodeURIComponent('api/routes'), seeded({ v: 1, view: 'io', sel: 'api/models', cam: { px: { s: 0.5, tx: 10, ty: 20 } } }).api);
    expect(b.w.C4PM_MODE.get()).toBe('arch');
    expect(b.w.C4PM_MAP.selectedId()).toBe('api/routes');
    expect(b.w.C4PM_STATE.map.cam).not.toEqual({ s: 0.5, tx: 10, ty: 20 });
  });

  it('no restore while the hash gives a simulation; later changes still save', () => {
    const s = seeded({ v: 1, sel: 'api/models' });
    const b = load('#arch&sim=s-1', s.api, simHtml());
    expect(b.w.C4PM_MAP.selectedId()).not.toBe('api/models');
    b.w.C4PM_MAP.select('api/routes');
    expect(kept(s).sel).toBe('api/routes');
  });

  it('nothing is saved before the restore ran (the first fit does not overwrite the kept state)', () => {
    const s = seeded({ v: 1, sel: 'api/models' });
    const loc = { href: 'file:///x.html', hash: '' };
    const h = runViewerScripts(renderViewHtml(loadSample()), { extraIds: IDS, globals: { location: loc, sessionStorage: s.api } });
    const w = h.sandbox.window as any;
    w.C4PM_VIEWSTATE.save();
    h.frames.runToCompletion();
    expect(kept(s).sel).toBe('api/models');
    h.flushTimers();
    expect(w.C4PM_MAP.selectedId()).toBe('api/models');
  });
});

describe('the hash', () => {
  it('a selection adds sel=<id> after the other extras; clearing removes it', () => {
    const p = load('#io&bare&seqonly', memStore().api);
    const id = Object.keys(p.w.C4PM_STATE.nodeById).find(k => p.w.C4PM_STATE.nodeById[k].kind === 'screen')!;
    p.w.C4PM_MAP.select(id);
    p.h.flushTimers();
    expect(p.loc.hash).toBe('#io&bare&seqonly&sel=' + encodeURIComponent(id));
    expect(p.w.C4PM_MODE.bare()).toBe(true);
    p.w.C4PM_MAP.select(null);
    p.h.flushTimers();
    expect(p.loc.hash).toBe('#io&bare&seqonly');
  });

  it('an empty hash gets the view as its first part; a fresh page leaves the hash alone', () => {
    const p = load('', memStore().api);
    expect(p.loc.hash).toBe('');
    p.w.C4PM_MAP.select('api/routes');
    p.h.flushTimers();
    expect(p.loc.hash).toBe('#arch&sel=api%2Froutes');
  });

  it('a hashchange that brings a sel selects it', () => {
    const p = load('', memStore().api);
    p.loc.hash = '#arch&sel=' + encodeURIComponent('api/models');
    p.h.fireWindowEvent('hashchange');
    expect(p.w.C4PM_MAP.selectedId()).toBe('api/models');
  });

  it('uses history.replaceState when there is one (no history entry)', () => {
    const calls: string[] = [];
    const loc = { href: 'file:///x.html#io', hash: '#io' };
    const history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => { calls.push(url); loc.href = url; loc.hash = url.slice(url.indexOf('#')); } };
    const h = runViewerScripts(renderViewHtml(loadSample()), { extraIds: IDS, globals: { location: loc, history, sessionStorage: memStore().api } });
    h.flushTimers();
    const w = h.sandbox.window as any;
    const id = Object.keys(w.C4PM_STATE.nodeById).find(k => w.C4PM_STATE.nodeById[k].kind === 'screen')!;
    w.C4PM_MAP.select(id);
    h.flushTimers();
    expect(calls).toEqual(['file:///x.html#io&sel=' + encodeURIComponent(id)]);
  });
});

describe('storage blocked or missing', () => {
  const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  it.each([['throws', throwing], ['absent', undefined]])('sessionStorage %s: the page works and nothing throws', (_, session) => {
    const p = load('', session);
    expect(p.w.C4PM_VIEWSTATE).toBeDefined();
    expect(() => { p.w.C4PM_MAP.select('api/routes'); p.w.C4PM_VIEWSTATE.save(); p.h.fireWindowEvent('pagehide'); p.h.flushTimers(); }).not.toThrow();
    expect(p.w.C4PM_MAP.selectedId()).toBe('api/routes');
    expect(p.w.C4PM_MODE.get()).toBe('arch');
  });
});

describe('part()', () => {
  it('a part added later round-trips; one added after the restore gets its kept value at once; bad specs throw', () => {
    const s = memStore();
    const a = load('', s.api);
    let x = 'one';
    a.w.C4PM_VIEWSTATE.part('extra', { get: () => x, set: (v: string) => { x = v; } });
    a.w.C4PM_VIEWSTATE.save();
    expect(kept(s).extra).toBe('one');
    x = 'two';
    const b = load('', s.api);
    expect(kept(s).extra).toBe('one');   // its owner is absent on this page: the value is kept as it was
    b.w.C4PM_VIEWSTATE.part('extra', { get: () => x, set: (v: string) => { x = v; } });
    expect(x).toBe('one');
    expect(() => b.w.C4PM_VIEWSTATE.part('extra', { get() {}, set() {} })).toThrow(/already/);
    expect(() => b.w.C4PM_VIEWSTATE.part('', { get() {}, set() {} })).toThrow(/name/);
    expect(() => b.w.C4PM_VIEWSTATE.part('y', {})).toThrow(/get\(\) and set\(\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase 30 SV9b (b642 part 2): the parts the owning scripts add (tree.js, panel.js, board-drawer.js, board-timeline.js,
// ioView.js, storageView.js). They load before viewState.js and add their part at DOMContentLoaded (here: a loaded page,
// so on the first timer, before the restore timer).
const SAMPLE_KEY = 'c4pm.view:/repo/shop';
const keyOf = (p: Page) => 'c4pm.view:' + (p.w.C4PM_DATA.repoPath || '');
const keptOf = (s: { m: Record<string, string> }, p: Page) => JSON.parse(s.m[keyOf(p)]);
const seed = (key: string, state: unknown) => memStore({ [key]: JSON.stringify(state) });
const byId = (p: Page, id: string) => (p.h.sandbox.document as any).getElementById(id);
const treeRow = (p: Page, id: string) => byId(p, 'left').querySelectorAll('.lt-row').find((r: any) => r.dataset.id === id);
const tabs = (p: Page) => byId(p, 'left').querySelectorAll('.lt-tab');
const treeBody = (p: Page, k: string) => byId(p, 'left').querySelectorAll('.lt-body').find((b: any) => b.id === 'lt-' + k);
const shownTab = (p: Page) => tabs(p).findIndex((b: any) => b.classList.contains('active'));
const NO_EV = { stopPropagation() {} };
let boardPageHtml: string | null = null;
function boardHtml(): string {   // the sample-v2 map with the board fixture (2 boards, b-items with dates)
  if (boardPageHtml) return boardPageHtml;
  const model = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') }).model;
  model.board = sampleBoard(model);
  return (boardPageHtml = renderViewHtml(model));
}

describe('SV9b parts: each round-trips through a reload', () => {
  it('tree: the expanded rows, the active tab and the scroll of its body', () => {
    const s = memStore();
    const a = load('', s.api);
    treeRow(a, 'api').children[0].onclick(NO_EV);   // the twist opens the row
    tabs(a)[1].onclick();
    treeBody(a, 'files').scrollTop = 140;
    a.w.C4PM_VIEWSTATE.save();
    expect(kept(s).tree).toEqual({ view: 'arch', open: expect.arrayContaining(['sample-shop', 'api']), tab: 'files', top: 140 });
    const b = load('', s.api);
    expect(Array.from(b.w.C4PM_TREE.expanded).sort()).toEqual(Array.from(a.w.C4PM_TREE.expanded).sort());
    expect(treeRow(b, 'api').getAttribute('aria-expanded')).toBe('true');
    expect(treeRow(b, 'api/utils')).toBeDefined();   // its children rows are drawn
    expect(shownTab(b)).toBe(1);
    expect(treeBody(b, 'files').scrollTop).toBe(140);
  });

  it('panel: the scroll of #panel-col for the same selection, and a file view', () => {
    const s = memStore();
    const a = load('', s.api);
    a.w.C4PM_MAP.select('api/routes');
    byId(a, 'panel-col').scrollTop = 220;
    a.w.C4PM_VIEWSTATE.save();
    expect(kept(s).panel).toEqual({ id: 'api/routes', b: null, file: null, top: 220 });
    expect(byId(load('', s.api), 'panel-col').scrollTop).toBe(220);

    const file = 'api/src/server.ts';
    const f = load('', s.api);
    f.w.C4PM_MAP.select(null);
    f.w.C4PM_PANEL.showFile(file);
    byId(f, 'panel-col').scrollTop = 90;
    f.w.C4PM_VIEWSTATE.save();
    expect(kept(s).panel).toEqual({ id: null, b: null, file, top: 90 });
    const g = load('', s.api);
    expect(g.w.C4PM_PANEL_PARTS.file.viewPath()).toBe(file);
    expect(byId(g, 'panel-col').scrollTop).toBe(90);
  });

  it('board drawer: open and minimized (the board, the view and the height stay in localStorage)', () => {
    const s = memStore();
    const a = load('', s.api, boardHtml(), BOARD_EXTRA_IDS);
    a.w.C4PM_VIEWSTATE.save();
    expect(keptOf(s, a).board).toEqual({ open: false, min: false });
    a.w.C4PM_BOARD.open();
    a.w.C4PM_BOARD.drawer.minimize(true);
    a.w.C4PM_VIEWSTATE.save();
    expect(keptOf(s, a).board).toEqual({ open: true, min: true });
    const b = load('', s.api, boardHtml(), BOARD_EXTRA_IDS);
    expect([b.w.C4PM_BOARD.isOpen(), b.w.C4PM_BOARD.drawer.isMinimized(), byId(b, 'board-drawer').hidden]).toEqual([true, true, false]);
    b.w.C4PM_BOARD.close();
    b.w.C4PM_VIEWSTATE.save();
    expect(load('', s.api, boardHtml(), BOARD_EXTRA_IDS).w.C4PM_BOARD.isOpen()).toBe(false);
  });

  it('timeline: the zoom and the scroll (as the day at the left edge), drawn again at once when shown', () => {
    const s = memStore();
    const a = load('', s.api, boardHtml(), BOARD_EXTRA_IDS);
    const B = a.w.C4PM_BOARD;
    B.open();
    B.setView('timeline');
    B.timeline.setDayWidth(40);   // the zoom ("+" sits in a bar slot the fake DOM cannot look up by id)
    B.drawer.render();
    const body = byId(a, 'board-drawer-body');
    const sc = body.querySelector('.tl-scroll'), rows = body.querySelector('.tl');
    sc.scrollLeft = 300; sc.dispatch('scroll');
    rows.scrollTop = 60; rows.dispatch('scroll');
    a.w.C4PM_VIEWSTATE.save();
    const tl = keptOf(s, a).timeline;
    expect(tl.dayW).toBe(B.timeline.dayWidth());
    expect(tl.dayW).toBe(40);
    expect(tl.boards).toEqual([[B.boardId(), expect.any(Number), 60]]);
    const b = load('', s.api, boardHtml(), BOARD_EXTRA_IDS);
    expect(b.w.C4PM_BOARD.timeline.dayWidth()).toBe(tl.dayW);
    const bb = byId(b, 'board-drawer-body');
    expect(bb.querySelector('.tl-scroll').scrollLeft).toBeCloseTo(300, 6);
    expect(bb.querySelector('.tl').scrollTop).toBe(60);
  });

  it('io: a camera that does not show the kept screen is fitted to it; one that does is left alone', () => {
    const io = 'shop.web.cart';
    const p = load('#io', seed(SAMPLE_KEY, { v: 1, view: 'io', io: { id: io } }).api);
    expect(p.w.C4PM_STATE.map.cam).toEqual(p.w.C4PM_CAM.fitCam(p.w.C4PM_IOVIEW.rect(io)));
    const s = memStore();
    const a = load('#io', s.api);
    aimAt(a, 'shop.web.home', 1.5);
    a.w.C4PM_VIEWSTATE.save();
    expect(kept(s).io).toEqual({ id: a.w.C4PM_IOVIEW.focus().id });
    const b = load('#io', s.api);
    const ca = centreOn(a, 'shop.web.home'), cb = centreOn(b, 'shop.web.home');
    expect(cb.z).toBeCloseTo(ca.z, 6);
    expect(cb.ox).toBeCloseTo(ca.ox, 6);
  });

  it('storage: the selected field comes back; a field that is gone falls back to its record', () => {
    const html = renderViewHtml(storageModel());
    const s = memStore();
    const a = load('#storage', s.api, html);
    a.w.C4PM_MAP.select(CLASS_ID);
    a.w.C4PM_VIEWSTATE.save();
    expect(keptOf(s, a).storage).toEqual({ id: CLASS_ID, rec: ENROLLMENTS });
    expect(load('#storage', s.api, html).w.C4PM_MAP.selectedId()).toBe(CLASS_ID);
    const old = CLASS_ID + '_old';
    const gone = load('#storage', seed(keyOf(a), { v: 1, view: 'storage', sel: old, storage: { id: old, rec: ENROLLMENTS } }).api, html);
    expect(gone.w.C4PM_MAP.selectedId()).toBe(ENROLLMENTS);
  });
});

describe('SV9b restore rules', () => {
  it('a missing id or a changed tree never throws; the other parts still come back', () => {
    const bad = { v: 1, view: 'arch', sel: 'api/routes',
      tree: { view: 'arch', open: ['gone', 7, null, 'api/utils'], tab: 'nope', top: -5 },
      panel: { id: 'api/routes', b: null, file: 'gone.ts', top: 50 },
      io: { id: 'gone' }, storage: { id: 'gone', rec: 'gone' } };
    const p = load('', seed(SAMPLE_KEY, bad).api);
    expect(p.w.C4PM_MAP.selectedId()).toBe('api/routes');
    expect(p.w.C4PM_TREE.expanded.has('api/utils')).toBe(true);
    expect(p.w.C4PM_TREE.expanded.has('gone')).toBe(false);
    expect(shownTab(p)).toBe(0);
    expect(byId(p, 'panel-col').scrollTop || 0).toBe(0);   // the kept file view is gone: its scroll is not used
    for (const junk of [7, 'x', null, [], { open: 'x', tab: 3, id: 5 }]) {
      const q = load('', seed(SAMPLE_KEY, { v: 1, sel: 'api/models', tree: junk, panel: junk, io: junk, storage: junk, board: junk, timeline: junk }).api);
      expect(q.w.C4PM_MAP.selectedId()).toBe('api/models');
    }
    const fresh = load('', memStore().api, boardHtml(), BOARD_EXTRA_IDS);
    const b = load('', seed(keyOf(fresh), { v: 1, sel: 'api/routes', board: { open: 'yes' }, timeline: { dayW: 'x', boards: [[1, 2, 3], ['sprint', NaN, 0], 'junk'] } }).api, boardHtml(), BOARD_EXTRA_IDS);
    expect(b.w.C4PM_BOARD.isOpen()).toBe(false);
    expect(b.w.C4PM_BOARD.timeline.dayWidth()).toBe(fresh.w.C4PM_BOARD.timeline.dayWidth());
    expect(b.w.C4PM_MAP.selectedId()).toBe('api/routes');
  });

  it("another view's kept rows and another selection's panel scroll are not applied", () => {
    const p = load('', seed(SAMPLE_KEY, { v: 1, view: 'arch', sel: 'api/models',
      tree: { view: 'io', open: ['shop.web'], tab: 'arch', top: 0 }, panel: { id: 'api/routes', b: null, file: null, top: 80 } }).api);
    expect(p.w.C4PM_TREE.expanded.has('shop.web')).toBe(false);
    expect(byId(p, 'panel-col').scrollTop || 0).toBe(0);
    expect(p.w.C4PM_MAP.selectedId()).toBe('api/models');
  });

  it('a part whose owner is absent (no board on the page) is kept as it was; io and storage stay kept in another view', () => {
    const board = { open: true, min: false }, timeline = { dayW: 40, boards: [['sprint', 20700, 10]] };
    const io = { id: 'shop.web.cart' }, storage = { id: 'x.y', rec: 'x' };
    const s = seed(SAMPLE_KEY, { v: 1, view: 'arch', board, timeline, io, storage });
    const p = load('', s.api);
    expect(p.w.C4PM_BOARD).toBeUndefined();
    p.w.C4PM_MAP.select('api/routes');
    p.w.C4PM_VIEWSTATE.save();
    expect(kept(s)).toMatchObject({ board, timeline, io, sel: 'api/routes' });
    expect(kept(s).storage).toEqual(storage);
  });

  it('storage blocked: a page with every part works as before', () => {
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
    const p = load('', throwing, boardHtml(), BOARD_EXTRA_IDS);
    expect(() => { p.w.C4PM_BOARD.open(); p.w.C4PM_VIEWSTATE.save(); p.h.fireWindowEvent('pagehide'); p.h.flushTimers(); }).not.toThrow();
    expect(p.w.C4PM_BOARD.isOpen()).toBe(true);
    expect(p.w.C4PM_TREE).toBeDefined();
  });

  it('a restore that changes the map size (the drawer opens) applies the camera again when the map takes it', () => {
    // ResizeObservers that run only when the test says so, in the order they were made (as in a browser).
    type Obs = { cb: (e: unknown[]) => void; on: boolean; t: unknown[] };
    const fakeRO = () => {
      const all: Obs[] = [];
      class RO {
        o: Obs;
        constructor(cb: (e: unknown[]) => void) { this.o = { cb, on: true, t: [] }; all.push(this.o); }
        observe(t: unknown) { this.o.t.push(t); }
        unobserve() {}
        disconnect() { this.o.on = false; }
      }
      return { RO, fire: () => all.slice().forEach(o => { if (o.on && o.t.length) o.cb(o.t.map(target => ({ target }))); }) };
    };
    const s = memStore();
    const run = (r: ReturnType<typeof fakeRO>): Page => {
      const loc = { href: 'file:///x.html', hash: '' };
      const h = runViewerScripts(boardHtml(), { extraIds: [...IDS, ...BOARD_EXTRA_IDS], globals: { location: loc, localStorage: memStore().api, sessionStorage: s.api, ResizeObserver: r.RO } });
      const p: Page = { h, w: h.sandbox.window as any, loc };
      const wrap = byId(p, 'map-wrap');
      p.w.C4PM_BOARD.onChange(() => { wrap.clientHeight = p.w.C4PM_BOARD.isOpen() ? 500 : 800; });   // the drawer takes 300 px
      r.fire();          // the map takes its first size
      h.flushTimers();   // the restore
      return p;
    };
    const ra = fakeRO();
    const a = run(ra);
    a.w.C4PM_BOARD.open();
    ra.fire();
    expect(a.w.C4PM_STATE.map.ch).toBe(500);
    const id = 'api/payments';
    aimAt(a, id, 1.7);
    a.w.C4PM_VIEWSTATE.save();
    const rb = fakeRO();
    const b = run(rb);
    expect(b.w.C4PM_BOARD.isOpen()).toBe(true);
    expect(b.w.C4PM_STATE.map.ch).toBe(800);   // the map has not taken the new size yet
    rb.fire();
    expect(b.w.C4PM_STATE.map.ch).toBe(500);
    const ca = centreOn(a, id), cb = centreOn(b, id);
    expect(cb.z).toBeCloseTo(ca.z, 6);
    expect(cb.ox).toBeCloseTo(ca.ox, 6);
    expect(cb.oy).toBeCloseTo(ca.oy, 6);
  });
});
