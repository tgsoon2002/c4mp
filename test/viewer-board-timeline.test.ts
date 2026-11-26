import { boardPage, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import type { ViewBoard, ViewBoardItem, ViewModel } from '../src/types';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B26b: the Timeline view in the fake DOM. 2 phases (P1, P2), 5 dated items (K1..K5, K2 is one day), 3 dependencies that
// can be drawn (K2<-K1, K3<-K2, K5<-K4), one dependency on an item of another board, one undated item, one hostile title.

const groups = [{ id: 'planned', name: 'Planned', status: 'planned' }, { id: 'in-progress', name: 'In progress', status: 'in-progress' }, { id: 'done', name: 'Done', status: 'done' }];
const item = (id: string, over: Partial<ViewBoardItem> = {}): ViewBoardItem =>
  ({ id, title: 'Title ' + id, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], linked: [], deadLinks: [], ...over });

function board(_m: ViewModel): ViewBoard {
  return {
    statuses: ['planned', 'in-progress', 'done', 'abandoned'], kinds: ['task', 'feature', 'issue', 'bug'], findings: [],
    boards: [
      {
        id: 'main', name: 'Main', groups,
        items: [
          item('P1', { kind: 'feature' }),
          item('K1', { parent: 'P1', status: 'done', start: '2026-10-12', due: '2026-10-15' }),
          item('K2', { parent: 'P1', status: 'in-progress', start: '2026-10-16', due: '2026-10-16', dependsOn: ['K1'] }),   // one day: a diamond
          item('K3', { parent: 'P1', start: '2026-10-19', due: '2026-10-23', dependsOn: ['K2', 'X1'] }),                    // X1 is on another board
          item('P2', { kind: 'feature' }),
          item('K4', { parent: 'P2', status: 'in-progress', start: '2026-10-14', due: '2026-10-22' }),
          item('K5', { parent: 'P2', start: '2026-10-21', due: '2026-10-28', dependsOn: ['K4'] }),
          item('U1', { title: '<img src=x onerror=alert(1)>', owner: '<b>o</b>' }),                                        // no dates
          item('O1', { parent: 'P2', status: 'in-progress', start: '2026-10-01', due: '2026-10-02' }),                       // overdue on TODAY: no, counted below
        ],
      },
      { id: 'other', name: 'Other', groups, items: [item('X1', { start: '2026-10-12', due: '2026-10-13' })] },
    ],
  };
}

let p: BoardPage;
let B: any;
const host = () => (p.sandbox.document as any).getElementById('board-drawer-body') as FakeEl;
const all = (root: FakeEl, test: (n: FakeEl) => boolean): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && test(c)) out.push(c); walk(c); });   // text nodes have no children
  walk(root);
  return out;
};
const byClass = (root: FakeEl, cls: string) => all(root, n => n.classList.contains(cls));
const rowsText = () => byClass(host(), 'tl-lab').map(l => serializeText(l).trim());
const barOf = (id: string) => all(host(), n => (n.classList.contains('tl-bar') || n.classList.contains('tl-ms')) && ((n as any).title || '').startsWith(id + ' ·'))[0];
const labelOf = (id: string) => byClass(host(), 'tl-lab').find(l => serializeText(l).includes('Title ' + id))!;
const todayLeft = () => parseFloat(byClass(host(), 'tl-today')[0].style.left);

beforeEach(() => {
  p = boardPage({ board, extraIds: ['board-slot-timeline'] });   // the fake DOM finds the slot by id only when it is declared
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);   // 2026-10-21
  B.open();
});

describe('P16-B26b timeline view', () => {
  it('registers as the default view and draws 2 summary lines, 5 bars (1 diamond + 1 overdue), 3 arrows and 1 Today line', () => {
    expect(typeof B.views.timeline).toBe('function');
    expect(B.view()).toBe('timeline');
    expect(byClass(host(), 'tl-sum').length).toBe(2);
    expect(all(host(), n => n.classList.contains('tl-bar') || n.classList.contains('tl-ms')).length).toBe(6);   // K1..K5, plus O1 (the overdue one)
  });

  it('exactly one diamond (K2) and three arrows', () => {
    expect(byClass(host(), 'tl-ms').length).toBe(1);
    expect((barOf('K2') as any).classList.contains('tl-ms')).toBe(true);
    expect(byClass(host(), 'tl-dep').length).toBe(3);
    expect(byClass(host(), 'tl-tip').length).toBe(3);
    expect(byClass(host(), 'tl-today').length).toBe(1);
  });

  it('status and overdue classes: done is faded, planned dashed, a past due date shows the red edge and a late badge', () => {
    expect(barOf('K1').classList.contains('done')).toBe(true);
    expect(barOf('K4').classList.contains('in-progress')).toBe(true);
    expect(barOf('K5').classList.contains('planned')).toBe(true);
    expect(barOf('O1').classList.contains('over')).toBe(true);
    expect(barOf('K4').classList.contains('over')).toBe(false);
    expect(barOf('K2').classList.contains('over')).toBe(true);   // in progress, due 10-16
    expect(barOf('K1').classList.contains('over')).toBe(false);  // done: never late
    expect(byClass(host(), 'tl-late').length).toBe(2);           // K2 and O1
    expect(serializeText(labelOf('O1'))).toContain('late');
  });

  it('an item with no dates is listed only under Unscheduled; hostile text stays text', () => {
    const texts = rowsText();
    expect(texts.some(t => t.includes('Unscheduled (1)'))).toBe(true);
    const u = byClass(host(), 'unsched');
    expect(u.length).toBe(1);
    expect(serializeText(u[0])).toContain('<img src=x onerror=alert(1)>');
    expect(serializeText(u[0])).toContain('no dates');
    expect(all(host(), n => n.tagName === 'IMG' || n.tagName === 'B').length).toBe(0);
    expect(all(host(), n => ((n as any).title || '').includes('U1')).length).toBe(0);   // no bar for it
    // row order: phase, its dated children, next phase and its children
    expect(texts.filter(t => /Title (P1|K1|K2|K3|P2|K4|O1|K5)/.test(t)).map(t => /Title (\w+)/.exec(t)![1])).toEqual(['P1', 'K1', 'K2', 'K3', 'P2', 'K4', 'K5', 'O1']);   // file order inside a phase
  });

  it('a dependency on another board draws no arrow but a chip on the dependent row', () => {
    const chips = byClass(labelOf('K3'), 'tl-ext');
    expect(chips.map(c => c.textContent)).toEqual(['↗ X1']);
    expect((chips[0] as any).title).toBe('X1 (other board: Other)');
    expect(byClass(host(), 'tl-dep').length).toBe(3);   // K2<-K1, K3<-K2, K5<-K4 only
  });

  it('collapsing a phase removes its child rows and the arrows to them, and the Unscheduled list stays', () => {
    const tw = byClass(labelOf('P1'), 'tw')[0];
    expect(tw.textContent).toBe('▾');
    tw.click();
    expect(B.isCollapsed('main', 'p:P1')).toBe(true);
    expect(barOf('K1')).toBeUndefined();
    expect(barOf('K2')).toBeUndefined();
    expect(byClass(host(), 'tl-dep').length).toBe(1);   // only K5<-K4 is left
    expect(byClass(host(), 'tl-sum').length).toBe(2);   // the summary line stays
    expect(byClass(labelOf('P1'), 'tw')[0].textContent).toBe('▸');
    expect(rowsText().some(t => t.includes('Unscheduled (1)'))).toBe(true);
    byClass(labelOf('P1'), 'tw')[0].click();
    expect(barOf('K1')).toBeDefined();
    expect(byClass(host(), 'tl-dep').length).toBe(3);
  });

  it('a click on a bar or a label selects the item; the selected bar and label get sel; a double click also zooms the map', () => {
    barOf('K4').click();
    expect(B.selectedId()).toBe('K4');
    expect(barOf('K4').classList.contains('sel')).toBe(true);
    expect(barOf('K5').classList.contains('sel')).toBe(false);
    expect(labelOf('K4').classList.contains('sel')).toBe(true);
    // arrows touching the selected item are marked
    expect(byClass(host(), 'hot').length).toBe(2);   // path + head of K5<-K4
    let zoomed = 0;
    B.zoomToLinked = () => { zoomed++; return true; };
    labelOf('K1').click();
    expect(B.selectedId()).toBe('K1');
    expect(zoomed).toBe(0);
    labelOf('K1').dispatch('dblclick');
    expect(zoomed).toBe(1);
    barOf('K3').dispatch('dblclick');
    expect(B.selectedId()).toBe('K3');
    expect(zoomed).toBe(2);
    byClass(host(), 'unsched')[0].click();
    expect(B.selectedId()).toBe('U1');
  });

  it('setToday moves the Today line by days times the day width', () => {
    const before = todayLeft();
    B.setToday('2026-10-25');
    B.drawer.render();
    expect(todayLeft() - before).toBe(4 * B.timeline.dayWidth());
  });

  it('zoom: + and - change the day width by 1.3 within 10..70 and keep the day at the left edge', () => {
    const slot = (p.sandbox.document as any).getElementById('board-slot-timeline') as FakeEl;
    const [out, inn] = slot.children;
    expect([out.textContent, inn.textContent]).toEqual(['−', '+']);
    expect(B.timeline.dayWidth()).toBe(26);
    const scroller = () => byClass(host(), 'tl-scroll')[0] as any;
    scroller().scrollLeft = 260;   // 10 days from the grid start
    scroller().dispatch('scroll');
    slot.children[1].click();
    expect(B.timeline.dayWidth()).toBe(34);
    expect(scroller().scrollLeft).toBeCloseTo(340, 5);   // still 10 days from the start
    for (let n = 0; n < 12; n++) slot.children[1].click();
    expect(B.timeline.dayWidth()).toBe(70);
    for (let n = 0; n < 20; n++) slot.children[0].click();
    expect(B.timeline.dayWidth()).toBe(10);
    B.timeline.setDayWidth(26);
  });

  it('scroll: the first draw puts Today in view, a redraw keeps the scroll position', () => {
    const TLm = p.sandbox.C4PM_BOARD_TL;
    const lo = TLm.weekStarts(TLm.dayOf('2026-10-01') - 3, TLm.dayOf('2026-10-28') + 6)[0];
    const scroller = () => byClass(host(), 'tl-scroll')[0] as any;
    expect(scroller().scrollLeft).toBe((TLm.dayOf(TODAY) - lo) * 26 - 220);
    scroller().scrollLeft = 123;
    scroller().dispatch('scroll');
    B.select('K4');   // redraws the whole view
    expect(scroller().scrollLeft).toBe(123);
  });

  it('a board with no items says so; the page without a board has no timeline', () => {
    const q = boardPage({ board: m => ({ ...board(m), boards: [{ id: 'e', name: 'Empty', groups, items: [] }] }) });
    q.sandbox.C4PM_BOARD.open();
    expect(serializeText((q.sandbox.document as any).getElementById('board-drawer-body'))).toContain('No items on this board.');
    expect(boardPage({ board: false }).sandbox.C4PM_BOARD).toBeUndefined();
  });
});
