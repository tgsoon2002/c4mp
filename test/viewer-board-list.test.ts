import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';

// P16-B24: the List view of the board drawer (fake DOM).

let p: BoardPage;
let B: any;

const body = () => (p.sandbox.document as any).getElementById('board-drawer-body');
// own tree walk: the harness querySelector trips over the text nodes the view appends (createTextNode has no classList)
const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: any, cls: string) => find(root, n => n.classList.contains(cls));
const byTag = (root: any, tag: string) => find(root, n => n.tagName === tag.toUpperCase());
const tbl = () => byClass(body(), 'bd-tbl')[0];
const rows = () => byClass(tbl(), 'r');
const cell = (tr: any, i: number) => tr.children[i];
const idOf = (tr: any) => cell(tr, 1).textContent;
const draw = (entryId = 'sprint') => B.views.list(body(), B.data.boards.find((b: any) => b.id === entryId));

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
});

describe('P16-B24 list view', () => {
  it('registers itself and the drawer shows it on the List tab', () => {
    expect(typeof B.views.list).toBe('function');
    B.open();
    B.setView('list');
    expect(rows().map(idOf)).toEqual(['b1', 'b2', 'b3', 'b4', 'b6']);
  });

  it('b910: the Owner cell of an item with no owner holds a faint "unassigned" tag; an owner shows as before', () => {
    const entry = sampleBoard(p.model).boards[0];
    entry.items = [{ ...entry.items[0], id: 'o1', owner: 'kim', parent: undefined, dependsOn: [] }, { ...entry.items[0], id: 'o2', owner: undefined, parent: undefined, dependsOn: [] }];
    B.views.list(body(), entry);
    const [r1, r2] = rows();
    expect(cell(r1, 4).textContent).toBe('kim');
    expect(byClass(cell(r1, 4), 'bd-unassigned')).toEqual([]);
    expect(byClass(cell(r2, 4), 'bd-unassigned').map((t: any) => t.textContent)).toEqual(['unassigned']);
  });

  it('header has the eight labeled columns', () => {
    draw();
    const ths = byTag(tbl(), 'th').map((t: any) => t.textContent);
    expect(ths).toEqual(['Kind', 'ID', 'Title', 'Status', 'Owner', 'Start', 'Due', 'C-items']);
  });

  it('nested items follow their parent, indented by depth (depth 2 included)', () => {
    const entry = sampleBoard(p.model).boards[0];
    entry.items.push({ ...entry.items[2], id: 'b7', title: 'Grandchild', parent: 'b3', dependsOn: [] });
    entry.items.push({ ...entry.items[3], id: 'b8', title: 'Late root', parent: undefined, deadLinks: [] });
    B.views.list(body(), entry);
    expect(rows().map(idOf)).toEqual(['b1', 'b2', 'b3', 'b7', 'b4', 'b6', 'b8']);
    const pad = (id: string) => cell(rows().find((r: any) => idOf(r) === id), 2).style.paddingLeft;
    expect(pad('b1')).toBe('10px');
    expect(pad('b3')).toBe('28px');
    expect(pad('b7')).toBe('46px');
  });

  it('a child listed before its parent, a foreign parent and a nest cycle still show every item once', () => {
    const base = sampleBoard(p.model).boards[0].items[0];
    const mk = (id: string, parent?: string) => ({ ...base, id, title: id, parent, dependsOn: [], linked: [], links: [] });
    const entry = { id: 'x', name: 'X', groups: [], items: [mk('c', 'p'), mk('p'), mk('o', 'nowhere'), mk('y', 'z'), mk('z', 'y')] };
    B.views.list(body(), entry);
    expect(rows().map(idOf)).toEqual(['p', 'c', 'o', 'y', 'z']);
  });

  it('cells: kind letter, status, owner, dates, c-item count', () => {
    draw();
    const r1 = rows()[0];
    expect(cell(r1, 0).children[0].textContent).toBe('F');
    expect(cell(r1, 3).children[1].textContent).toBe('in-progress');
    expect(cell(r1, 4).textContent).toBe('kim');
    expect(cell(r1, 5).textContent).toBe('2026-10-12');
    expect(cell(r1, 7).textContent).toBe('⛓ 1');
    expect(cell(rows()[3], 0).children[0].textContent).toBe('B');
  });

  it('the overdue chip appears only for a not-done item past its due date', () => {
    B.setToday('2026-10-21');
    draw();
    const chip = (id: string) => cell(rows().find((r: any) => idOf(r) === id), 6).children[0];
    expect(chip('b4').classList.contains('over')).toBe(true);    // due 10-01, planned
    expect(chip('b2').classList.contains('over')).toBe(false);   // due 10-14 but done
    expect(chip('b1').classList.contains('over')).toBe(false);   // due 10-30, future
    expect(chip('b3').classList.contains('over')).toBe(true);    // planned, due 10-20 is before today
    B.setToday('2026-10-20');
    draw();
    expect(cell(rows().find((r: any) => idOf(r) === 'b3'), 6).children[0].classList.contains('over')).toBe(false);   // due today is not overdue
    expect(cell(rows().find((r: any) => idOf(r) === 'b6'), 6).children.length).toBe(0);   // no due date, no chip
  });

  it('click selects the item and the selected row has class sel; double click also zooms', () => {
    B.open();
    B.setView('list');
    const zoom = jest.fn();
    B.zoomToLinked = zoom;
    rows()[0].click();
    expect(B.selectedId()).toBe('b1');
    expect(rows()[0].classList.contains('sel')).toBe(true);
    expect(rows()[1].classList.contains('sel')).toBe(false);
    rows()[3].dispatch('dblclick');
    expect(B.selectedId()).toBe('b4');
    expect(zoom).toHaveBeenCalledTimes(1);
    expect(rows()[3].classList.contains('sel')).toBe(true);
  });

  it('rows are focusable and Enter selects', () => {
    draw();
    expect(rows().every((r: any) => r.tabIndex === 0)).toBe(true);
    const prevented = jest.fn();
    rows()[1].dispatch('keydown', { key: 'Enter', preventDefault: prevented });
    expect(B.selectedId()).toBe('b2');
    rows()[2].dispatch('keydown', { key: 'a' });
    expect(B.selectedId()).toBe('b2');
  });

  it('board text is set as text: markup in title, owner and ids never becomes elements', () => {
    draw();
    const r = rows().find((x: any) => idOf(x) === 'b6');
    expect(cell(r, 2).textContent).toBe('<img src=x onerror=alert(1)>');
    expect(cell(r, 4).textContent).toBe('<i>o</i>');
    expect(serializeText(tbl())).toContain('<img src=x onerror=alert(1)>');
    const anyHtml = byTag(tbl(), 'img').length + byTag(tbl(), 'i').length;
    expect(anyHtml).toBe(0);
    // innerHTML is never used by the view
    expect(rows().every((x: any) => x.innerHTML === '')).toBe(true);
  });

  it('an empty board says so; a __proto__ id works', () => {
    const base = sampleBoard(p.model).boards[0].items[0];
    B.views.list(body(), { id: 'e', name: 'E', groups: [], items: [] });
    expect(serializeText(body())).toContain('This board has no items.');
    B.views.list(body(), { id: 'e', name: 'E', groups: [], items: [{ ...base, id: '__proto__', title: 'P', parent: undefined }, { ...base, id: 'k', title: 'K', parent: '__proto__' }] });
    expect(rows().map(idOf)).toEqual(['__proto__', 'k']);
  });

  it('the page without a board does not define the view', () => {
    const q = boardPage({ board: false });
    expect(q.sandbox.C4PM_BOARD).toBeUndefined();
  });
});
