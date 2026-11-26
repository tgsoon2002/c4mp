import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { isBoardDate } from '../src/board/dates';

// P16-B22: board.js core (state, select, Esc, shared collapsed state, views registry) in the fake DOM.

let p: BoardPage;
let B: any;
let M: any;
let calls: Array<string[] | null>;

function key(target: unknown, k = 'Escape') { (p.h.sandbox.document as any).dispatch('keydown', { key: k, target }); }

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  M = p.sandbox.C4PM_MAP;
  calls = [];
  const real = M.setHighlight;
  M.setHighlight = (ids: string[] | null) => { calls.push(ids); return real(ids); };
  B.setToday(TODAY);
});

describe('P16-B22 board.js core', () => {
  it('no board in the data: C4PM_BOARD is not defined and the Board button is not touched', () => {
    const none = boardPage({ board: false });
    expect(none.sandbox.C4PM_BOARD).toBeUndefined();
    expect((none.sandbox.document as any).getElementById('btn-board').hidden).not.toBe(false);
    expect(p.html).toContain('<button class="edge-toggle" id="btn-board" type="button" aria-pressed="false" hidden');   // hidden in the page itself
  });

  it('with a board the Board tab is shown: closed -> open; with the drawer loaded a second click minimizes it (B20b)', () => {
    const btn = (p.sandbox.document as any).getElementById('btn-board');
    expect(btn.hidden).toBe(false);
    const seen: boolean[] = [];
    B.onChange(() => seen.push(B.isOpen()));
    btn.click();
    expect(B.isOpen()).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('▼');
    btn.click();   // the drawer is loaded: the tab minimizes instead of closing
    expect(B.isOpen()).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.textContent).toBe('▲');
    btn.click();   // restore
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    B.close();
    expect(B.isOpen()).toBe(false);
    expect(btn.textContent).toBe('▲');
    B.open(); B.open(); B.close();
    expect(seen).toEqual([true, false, true, false]);   // a repeated open does not notify again; minimize/restore are not open/close
  });

  it('views: unregistered names are ignored; default is timeline if registered else the first registered', () => {
    // the real list, kanban and timeline views (P16-B24/B25/B26b) register themselves now: start from an empty registry
    Object.keys(B.views).forEach(k => { delete B.views[k]; });
    expect(B.view()).toBeNull();
    expect(B.setView('x')).toBe(false);
    expect(B.setView('toString')).toBe(false);
    B.views.list = () => {};
    expect(B.view()).toBe('list');
    B.views.timeline = () => {};
    expect(B.view()).toBe('timeline');
    expect(B.setView('list')).toBe(true);
    expect(B.view()).toBe('list');
    expect(B.setView('nope')).toBe(false);
    expect(B.view()).toBe('list');
  });

  it('boards() hides archived boards; setBoard ignores unknown and archived ids; item/entryOf search all boards', () => {
    expect(B.boards().map((b: any) => b.id)).toEqual(['sprint', 'backlog']);
    expect(B.boardId()).toBe('sprint');
    expect(B.setBoard('backlog')).toBe(true);
    expect(B.boardId()).toBe('backlog');
    expect(B.setBoard('nope')).toBe(false);
    expect(B.setBoard('old')).toBe(false);
    expect(B.boardId()).toBe('backlog');
    expect(B.item('b5').title).toBe('Batch translate');
    expect(B.item('b9').title).toBe('Archived item');
    expect(B.entryOf('b9').id).toBe('old');
    expect(B.item('zzz')).toBeNull();
    expect(B.entryOf('zzz')).toBeNull();
  });

  it('select(b1) lights exactly its own node ids plus its children, de-duplicated', () => {
    expect(B.litNodeIds('b1')).toEqual(['api/routes', 'api/payments']);   // b1 own, b2 child; b3 child has none
    expect(B.select('b1')).toBe(true);
    expect(calls[calls.length - 1]).toEqual(['api/routes', 'api/payments']);
    expect(B.selectedId()).toBe('b1');
    expect(M.highlightInfo().lit).toBe(2);
  });

  it('an item with no links passes null; an unknown id is ignored', () => {
    expect(B.select('b3')).toBe(true);
    expect(calls[calls.length - 1]).toBeNull();
    expect(B.select('nope')).toBe(false);
    expect(B.selectedId()).toBe('b3');
  });

  it('select switches to the board of the item and notifies once', () => {
    let n = 0;
    B.onChange(() => n++);
    B.select('b5');
    expect(B.boardId()).toBe('backlog');
    expect(n).toBe(1);
  });

  it('selecting a b-item deselects the c-item; selecting a c-item clears the b-item', () => {
    M.select('api/services');
    B.select('b1');
    expect(M.selectedId()).toBeNull();
    expect(B.selectedId()).toBe('b1');
    M.select('api/routes');
    expect(B.selectedId()).toBeNull();
    expect(M.state.hi).toBeNull();
    expect(M.selectedId()).toBe('api/routes');   // the c-item stays selected: no loop back into select(null)
  });

  it('selecting a b-item shows the panel summary (map listeners saw select(null))', () => {
    const seen: Array<string | null> = [];
    M.onSelect((n: any) => seen.push(n ? n.id : null));
    B.select('b1');
    expect(seen).toEqual([null]);
  });

  it('Esc clears the b-item; Esc in an INPUT, TEXTAREA, SELECT or editable element does not; other keys do not', () => {
    B.select('b1');
    key({ tagName: 'INPUT' });
    key({ tagName: 'TEXTAREA' });
    key({ tagName: 'SELECT' });
    key({ tagName: 'DIV', isContentEditable: true });
    key({ tagName: 'DIV' }, 'Enter');
    expect(B.selectedId()).toBe('b1');
    key({ tagName: 'DIV' });
    expect(B.selectedId()).toBeNull();
    expect(M.state.hi).toBeNull();
  });

  it('Esc with no b-item leaves a selected c-item alone; select(null) with nothing selected is a no-op', () => {
    M.select('api/routes');
    key({ tagName: 'DIV' });
    B.select(null);
    expect(M.selectedId()).toBe('api/routes');
  });

  it('collapsed state is one set shared by every view and keyed without collisions', () => {
    expect(B.isCollapsed('sprint', 'planned')).toBe(false);
    expect(B.toggleCollapsed('sprint', 'planned')).toBe(true);
    expect(B.isCollapsed('sprint', 'planned')).toBe(true);
    expect(B.isCollapsed('sprint', 'done')).toBe(false);
    B.toggleCollapsed('a:b', 'c');
    expect(B.isCollapsed('a', 'b:c')).toBe(false);
    expect(B.toggleCollapsed('sprint', 'planned')).toBe(false);
  });

  it('ids such as __proto__ are plain item ids', () => {
    const q = boardPage({ board: m => { const b = sampleBoard(m); b.boards[0].items[0].id = '__proto__'; b.boards[0].items[1].parent = '__proto__'; return b; } });
    const Q = q.sandbox.C4PM_BOARD as any;
    expect(Q.item('__proto__').title).toBe('Quiz generator');
    expect(Q.litNodeIds('__proto__')).toEqual(['api/routes', 'api/payments']);
    expect(Q.item('constructor')).toBeNull();
  });

  it('relations: children, dependents, overdue', () => {
    expect(B.children('b1').map((i: any) => i.id)).toEqual(['b2', 'b3']);
    expect(B.dependents('b3').map((i: any) => i.id)).toEqual(['b5']);   // across boards
    expect(B.dependents('b2').map((i: any) => i.id)).toEqual(['b3']);
    expect(B.isOverdue(B.item('b4'))).toBe(true);
    expect(B.isOverdue(B.item('b2'))).toBe(false);   // done
    expect(B.isOverdue(B.item('b5'))).toBe(false);   // no due
    expect(B.isOverdue({ due: '2020-01-01', status: 'abandoned' })).toBe(false);
  });

  describe('date helpers (same table as test/board-dates.test.ts)', () => {
    it.each([
      ['2026-10-21', true], ['2024-02-29', true], ['2026-13-40', false], ['2026-02-30', false], ['2026-02-29', false],
      ['Oct 5', false], ['', false], ['20261021', false], ['2026-10-21 ', false], [20261021, false], [null, false], [undefined, false],
    ])('validDate(%p) = %p, equal to isBoardDate', (input, expected) => {
      expect(B.validDate(input)).toBe(expected);
      expect(isBoardDate(input)).toBe(expected);
    });

    it('today() is the browser clock until setToday; a bad value is refused; null resets', () => {
      expect(B.today()).toBe(TODAY);
      expect(B.setToday('2026-02-30')).toBe(false);
      expect(B.today()).toBe(TODAY);
      expect(B.setToday(null)).toBe(true);
      expect(isBoardDate(B.today())).toBe(true);
      const d = new Date();
      expect(B.today()).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    });

    it('dayDiff counts whole days', () => {
      expect(B.dayDiff('2026-10-21', '2026-10-30')).toBe(9);
      expect(B.dayDiff('2026-10-21', '2026-10-01')).toBe(-20);
      expect(B.dayDiff('2026-10-25', '2026-11-01')).toBe(7);
    });
  });
});
