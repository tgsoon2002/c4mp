import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';

// P16-B27: the Dashboard view of the board drawer (fake DOM).

let p: BoardPage;
let B: any;

const body = () => (p.sandbox.document as any).getElementById('board-drawer-body');
const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: any, cls: string) => find(root, n => n.classList.contains(cls));
const draw = (entry?: any) => B.views.dashboard(body(), entry || B.data.boards.find((b: any) => b.id === 'sprint'));
// section title -> { row label -> count }
const counts = (title: string): Record<string, number> => {
  const sec = byClass(body(), 'bdb-sec').find((s: any) => s.getAttribute('aria-label') === title);
  const out: Record<string, number> = {};
  if (!sec) return out;
  byClass(sec, 'bdb-row').forEach((r: any) => { out[byClass(r, 'bdb-lbl')[0].textContent] = Number(byClass(r, 'bdb-n')[0].textContent); });
  return out;
};
const stat = (label: string) => Number(byClass(body(), 'bdb-stat').find((s: any) => byClass(s, 'bdb-slbl')[0].textContent === label).children[0].textContent);

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
});

describe('P16-B27 dashboard view', () => {
  it('registers itself and the drawer shows it on the Dashboard tab', () => {
    expect(typeof B.views.dashboard).toBe('function');
    B.open();
    B.setView('dashboard');
    expect(byClass(body(), 'bdb').length).toBe(1);
  });

  it('counts per status, kind, owner and tag of the sample board', () => {
    draw();
    expect(counts('Status')).toEqual({ planned: 3, 'in-progress': 1, done: 1, abandoned: 0 });
    expect(counts('Kind')).toEqual({ task: 3, feature: 1, issue: 0, bug: 1 });
    expect(counts('Owner')).toEqual({ 'no owner': 3, kim: 1, '<i>o</i>': 1 });
    expect(counts('Tag')).toEqual({ api: 1, quiz: 1, '<b>x</b>': 1 });
    expect(counts('Group')).toEqual({});   // default groups all carry a status: no Group block
  });

  it('overdue and blocked counts', () => {
    draw();
    expect(stat('items')).toBe(5);
    expect(stat('overdue')).toBe(2);   // b3 (due 10-20) and b4 (due 10-01); b2 is done
    expect(stat('blocked')).toBe(0);   // b3 waits for b2, which is done
    B.item('b2').status = 'planned';   // B.item reads the page's own data
    draw();
    expect(stat('blocked')).toBe(1);   // b3 waits for the now-planned b2
  });

  it('custom groups get a Group block; an item of no group counts as other', () => {
    const entry = sampleBoard(p.model).boards[0];
    entry.groups = [{ id: 'crit', name: 'Critical' }, { id: 'rest', name: 'Non-critical' }, { id: 'done', name: 'Done', status: 'done' }];
    entry.items[0].group = 'crit';
    draw(entry);
    expect(counts('Group')).toEqual({ Critical: 1, 'Non-critical': 0, Done: 1, other: 3 });
  });

  it('tags are cut to the top 12, biggest first', () => {
    const entry = sampleBoard(p.model).boards[0];
    entry.items[0].tags = Array.from({ length: 15 }, (_, i) => 't' + String(i).padStart(2, '0'));
    entry.items[1].tags = ['t14'];
    draw(entry);
    const tags = counts('Tag (top 12)');
    expect(Object.keys(tags).length).toBe(12);
    expect(Object.keys(tags)[0]).toBe('t14');
    expect(tags.t14).toBe(2);
  });

  it('empty board says so; 200 items draw; markup stays text; blocks are focusable', () => {
    draw({ id: 'e', name: 'E', groups: [], items: [] });
    expect(serializeText(body())).toContain('This board has no items.');
    const base = sampleBoard(p.model).boards[0].items[0];
    const items = Array.from({ length: 200 }, (_, i) => ({ ...base, id: 'x' + i, title: 'x', parent: undefined, status: i % 2 ? 'done' : 'planned', due: undefined }));
    draw({ id: 'big', name: 'Big', groups: [], items });
    expect(counts('Status').planned).toBe(100);
    expect(byClass(body(), 'bdb-bar').some((b: any) => b.style.width === '50%')).toBe(true);
    draw();
    expect(find(body(), n => n.tagName === 'I' || n.tagName === 'B').length).toBe(0);
    expect(byClass(body(), 'bdb-sec').every((s: any) => s.tabIndex === 0)).toBe(true);
  });
});
