import { boardPage, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// P16-B28b: board drawer behaviour (open, minimize, close, resize, board select, view tabs, top-bar chip) in the fake DOM.

let p: BoardPage;
let B: any;
let renders: Array<{ view: string; container: any; entryId: string }>;

const $ = (id: string) => (p.sandbox.document as any).getElementById(id);
const bar = () => $('board-drawer-bar');
const tabBtns = () => bar().children.find((c: any) => c.classList.contains('bd-seg')).children;
const tabNames = () => tabBtns().map((b: any) => b.textContent);
const load = (pre?: string) => {
  p = boardPage(pre ? { prelude: pre } : {});
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  renders = [];
  for (const v of ['kanban', 'list', 'timeline']) B.views[v] = (container: any, entry: any) => renders.push({ view: v, container, entryId: entry.id });
};
// a working fake localStorage
const STORE = `var __s = {}; window.localStorage = { getItem: function (k) { return k in __s ? __s[k] : null; }, setItem: function (k, v) { __s[k] = String(v); }, __s: __s };`;
const THROWS = `window.localStorage = { getItem: function () { throw new Error('blocked'); }, setItem: function () { throw new Error('blocked'); } };`;

beforeEach(() => load());

describe('P16-B28b drawer', () => {
  it('closed by default; open shows it and renders the default view with the current entry; close hides it', () => {
    expect($('board-drawer').hidden).not.toBe(false);
    B.open();
    expect($('board-drawer').hidden).toBe(false);
    expect(renders.map(r => [r.view, r.entryId])).toEqual([['timeline', 'sprint']]);
    expect(renders[0].container).toBe($('board-drawer-body'));
    B.close();
    expect($('board-drawer').hidden).toBe(true);
  });

  it('tabs: one per registered view, in the order timeline, kanban, list, dashboard; unregistered ones have none', () => {
    B.open();
    expect(tabNames()).toEqual(['Timeline', 'Kanban', 'List', 'Dashboard']);
    expect(tabBtns().map((b: any) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    delete B.views.dashboard;
    B.drawer.render();
    expect(tabNames()).toEqual(['Timeline', 'Kanban', 'List']);
  });

  it('clicking a tab changes the view and draws it once; the hint line follows the view', () => {
    B.open();
    renders.length = 0;
    tabBtns()[1].click();
    expect(B.view()).toBe('kanban');
    expect(renders.map(r => r.view)).toEqual(['kanban']);
    expect(bar().children.find((c: any) => c.classList.contains('bd-hint')).textContent).toContain('drag a card');
    renders.length = 0;
    tabBtns()[1].click();   // same tab again: still drawn once
    expect(renders.length).toBe(1);
  });

  it('view slots: the Kanban slot shows only in Kanban, the Timeline slot only in Timeline', () => {
    B.open();
    const slot = (n: string) => $('board-drawer-bar').children.find((c: any) => c.id === 'board-slot-' + n);
    expect(slot('timeline').hidden).toBe(false);
    expect(slot('kanban').hidden).toBe(true);
    B.setView('kanban');
    expect(slot('timeline').hidden).toBe(true);
    expect(slot('kanban').hidden).toBe(false);
  });

  it('the board select lists non-archived boards and switching redraws with the new entry', () => {
    B.open();
    const sel = bar().children.find((c: any) => c.tagName === 'SELECT');
    expect(sel.children.map((o: any) => o.value)).toEqual(['sprint', 'backlog']);
    renders.length = 0;
    sel.value = 'backlog';
    sel.dispatch('change');
    expect(B.boardId()).toBe('backlog');
    expect(renders.map(r => r.entryId)).toEqual(['backlog']);
  });

  it('switching board deselects a selected b-item that belongs to another board', () => {
    B.select('b1');
    B.open();
    const sel = bar().children.find((c: any) => c.tagName === 'SELECT');
    sel.value = 'backlog';
    sel.dispatch('change');
    expect(B.selectedId()).toBeNull();
  });

  it('minimize keeps only the bar (class, arrow) and does not draw the view; restore draws it again', () => {
    B.open();
    renders.length = 0;
    const min = bar().children.find((c: any) => c.classList.contains('bd-end')).children[0];
    min.click();
    expect($('board-drawer').classList.contains('bd-min')).toBe(true);
    expect(min.textContent).toBe('▴');
    expect(renders.length).toBe(0);
    expect($('board-drawer').hidden).toBe(false);
    min.click();
    expect($('board-drawer').classList.contains('bd-min')).toBe(false);
    expect(min.textContent).toBe('▾');
    expect(renders.length).toBe(1);
  });

  it('the x button closes it', () => {
    B.open();
    bar().children.find((c: any) => c.classList.contains('bd-end')).children[1].click();
    expect(B.isOpen()).toBe(false);
    expect($('board-drawer').hidden).toBe(true);
  });

  it('with no registered view the body says so; a view that throws is reported in the body, not swallowed', () => {
    B.views.timeline = () => { throw new Error('boom'); };
    delete B.views.kanban; delete B.views.list; delete B.views.dashboard;
    const errs: unknown[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      B.open();
    } finally { console.error = real; }
    expect(errs.length).toBe(1);
    expect($('board-drawer-body').children[0].textContent).toContain('boom');
    delete B.views.timeline;
    B.drawer.render();
    expect($('board-drawer-body').children[0].textContent).toBe('No board view is available.');
  });

  it('board names and titles are shown as text, never as markup', () => {
    const q = boardPage({ board: m => { const b = require('./helpers/viewer-board-fixture').sampleBoard(m); b.boards[0].name = '<img src=x onerror=alert(1)>'; return b; } });
    (q.sandbox.C4PM_BOARD as any).views.list = () => {};
    const qd = (q.sandbox.document as any).getElementById.bind(q.sandbox.document);
    const opt = qd('board-drawer-bar').children.find((c: any) => c.tagName === 'SELECT').children[0];
    expect(opt.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(opt._html).toBe('');
    expect(qd('board-chips').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('P16-B28b resize', () => {
  const drag = (y0: number, y1: number) => {
    const edge = $('board-drawer-edge');
    edge.dispatch('pointerdown', { clientY: y0, pointerId: 1 });
    edge.dispatch('pointermove', { clientY: y1, pointerId: 1 });
    edge.dispatch('pointerup', { clientY: y1, pointerId: 1 });
  };

  it('dragging up grows it, dragging down shrinks it; clamped to min 120 and max 78% of #center', () => {
    load(STORE);
    B.open();
    $('center').clientHeight = 1000;
    $('board-drawer').clientHeight = 300;
    drag(500, 400);   // up 100 px
    expect($('board-drawer').style['--board-h']).toBe('400px');
    drag(500, 900);   // way down
    expect($('board-drawer').style['--board-h']).toBe('120px');
    drag(500, -5000); // way up
    expect($('board-drawer').style['--board-h']).toBe('780px');
    expect(B.drawer.height()).toBe(780);
    expect(B.drawer.setHeight(50)).toBe(120);
    expect(B.drawer.setHeight(NaN)).toBe(120);
  });

  it('the height is saved after a drag and restored on the next load', () => {
    load(STORE);
    B.open();
    $('center').clientHeight = 1000;
    $('board-drawer').clientHeight = 300;
    drag(500, 450);
    expect(p.sandbox.localStorage.__s['c4mp.boardH']).toBe('350');   // Phase 35 C: written to the new key only
    // ... and the old key of an earlier version is still read at load (C4PM_STORE)
    const again = boardPage({ prelude: `var __s = { 'c4pm.boardH': '333' }; window.localStorage = { getItem: function (k) { return k in __s ? __s[k] : null; }, setItem: function () {} };` });
    expect((again.sandbox.document as any).getElementById('board-drawer').style['--board-h']).toBe('333px');
  });

  it('a minimized drawer does not resize', () => {
    load(STORE);
    B.open();
    B.drawer.minimize(true);
    drag(500, 400);
    expect($('board-drawer').style['--board-h']).toBeUndefined();
  });

  it('storage that throws breaks nothing: open, drag, board and view switching still work', () => {
    load(THROWS);
    B.open();
    $('center').clientHeight = 1000;
    $('board-drawer').clientHeight = 300;
    expect(() => drag(500, 400)).not.toThrow();
    expect($('board-drawer').style['--board-h']).toBe('400px');
    expect(B.setBoard('backlog')).toBe(true);
    expect(B.setView('list')).toBe(true);
    expect(renders[renders.length - 1].view).toBe('list');
  });
});

describe('P16-B28b top bar chip', () => {
  it('shows board name, done/total and overdue; is visible with a board and follows the board', () => {
    const chip = $('board-chips');
    B.drawer.render();   // the chip was first filled with the real clock; today() is fixed to TODAY in beforeEach
    expect(chip.textContent).toBe('Sprint S12 · 1/5 done · 2 overdue');   // b2 done; overdue: b3 (due Oct 20) and b4 (due Oct 1)
    expect(chip.hidden).toBe(false);
    B.setBoard('backlog');
    expect(chip.textContent).toBe('Backlog · 0/1 done');
  });
});

describe('P16-B28c scroll memory', () => {
  it('a redraw of the same view puts the body scroll offsets back; another view starts at the top', () => {
    // the view resets the scroll like a replaced scroller would
    B.views.list = (container: any) => { container.scrollTop = 0; container.scrollLeft = 0; };
    B.open();
    B.setView('list');
    const b = $('board-drawer-body');
    b.scrollTop = 120; b.scrollLeft = 30;
    B.select('b1');   // every select redraws the active view
    expect([b.scrollTop, b.scrollLeft]).toEqual([120, 30]);
    B.views.kanban = (container: any) => { container.scrollTop = 0; };
    B.setView('kanban');
    expect(b.scrollTop).toBe(0);   // a different view is not given the list's offsets
  });
});
