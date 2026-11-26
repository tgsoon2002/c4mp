import { boardPage, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import type { ViewBoard, ViewBoardItem, ViewModel } from '../src/types';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B26c: the Timeline "By group" lanes in the fake DOM. Lanes = the Kanban groups of the board (same order, B.groupOf).

const groups = [{ id: 'todo', name: 'To do', status: 'planned' }, { id: 'doing', name: 'Doing', status: 'in-progress' }, { id: 'done', name: 'Done', status: 'done' }, { id: 'later', name: 'Later' }];
const item = (id: string, over: Partial<ViewBoardItem> = {}): ViewBoardItem =>
  ({ id, title: 'Title ' + id, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], linked: [], deadLinks: [], ...over });

function board(_m: ViewModel): ViewBoard {
  return {
    statuses: ['planned', 'in-progress', 'done', 'abandoned'], kinds: ['task', 'feature', 'issue', 'bug'], findings: [],
    boards: [{
      id: 'main', name: 'Main', groups,
      items: [
        item('A1', { start: '2026-10-19', due: '2026-10-23' }),                                       // planned: group To do by status
        item('A2', { start: '2026-10-12', due: '2026-10-14', parent: 'A1' }),                         // earlier start: sorted first, chip "↑ A1"
        item('D1', { status: 'in-progress', start: '2026-10-14', due: '2026-10-22' }),                // Doing by status
        item('L1', { status: 'done', group: 'later', start: '2026-10-25', due: '2026-10-26' }),       // own group wins over status
        item('U1', { status: 'done' }),                                                               // Done lane, no dates: Unscheduled only
        item('X1', { status: 'abandoned', start: '2026-10-27', due: '2026-10-28' }),                  // fits no group: a lane named by the status
      ],
    }],
  };
}

const FAKE_STORE = "(function(){const m={};window.localStorage={getItem:k=>(k in m?m[k]:null),setItem:(k,v)=>{m[k]=String(v);}};})();";

let p: BoardPage;
let B: any;
const host = () => (p.sandbox.document as any).getElementById('board-drawer-body') as FakeEl;
const all = (root: FakeEl, test: (n: FakeEl) => boolean): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && test(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: FakeEl, cls: string) => all(root, n => n.classList.contains(cls));
const labels = () => byClass(host(), 'tl-lab').map(l => serializeText(l).trim());
const slot = () => (p.sandbox.document as any).getElementById('board-slot-timeline') as FakeEl;
const switchBtn = (text: string) => all(slot(), n => (n as any).textContent === text)[0];
const barOf = (id: string) => all(host(), n => (n.classList.contains('tl-bar') || n.classList.contains('tl-ms')) && ((n as any).title || '').startsWith(id + ' ·'))[0];
const topOf = (id: string) => parseFloat(barOf(id).style.top);

beforeEach(() => {
  p = boardPage({ board, extraIds: ['board-slot-timeline'], prelude: FAKE_STORE });
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  B.open();
});

describe('P16-B26c timeline by group', () => {
  it('the switch By phase | By group sits in the bar slot, By phase is the default, the choice is kept in c4mp.boardTlGroup', () => {
    expect(switchBtn('By phase').getAttribute('aria-pressed')).toBe('true');
    expect(switchBtn('By group').getAttribute('aria-pressed')).toBe('false');
    switchBtn('By group').click();
    expect(p.sandbox.localStorage.getItem('c4mp.boardTlGroup')).toBe('group');
    expect(switchBtn('By group').getAttribute('aria-pressed')).toBe('true');
    switchBtn('By phase').click();
    expect(p.sandbox.localStorage.getItem('c4mp.boardTlGroup')).toBe('phase');
  });

  it('lanes follow the Kanban order, items inside are sorted by start, nesting is only a chip, empty lanes are skipped', () => {
    switchBtn('By group').click();
    const t = labels();
    const at = (s: string) => t.findIndex(x => x.includes(s));
    expect(byClass(host(), 'tl-sum').length).toBe(4);   // To do, Doing, Later, and the extra lane "abandoned"; Done has no dated item
    expect(at('To do')).toBeLessThan(at('Doing'));
    expect(at('Doing')).toBeLessThan(at('Later'));
    expect(at('Later')).toBeLessThan(at('abandoned'));
    expect(t.some(x => x.startsWith('Done') || x === 'Done')).toBe(false);
    expect(at('Title A2')).toBeGreaterThan(at('To do'));
    expect(at('Title A2')).toBeLessThan(at('Title A1'));   // starts earlier
    expect(t[at('Title A2')]).toContain('↑ A1');
    expect(t[at('Title A1')]).not.toContain('↑');
    expect(t.some(x => x.includes('Unscheduled (1)'))).toBe(true);
    expect(topOf('A2')).toBeLessThan(topOf('A1'));
  });

  it('a card\'s group change moves its bar to the other lane after a re-render', () => {
    switchBtn('By group').click();
    const doingY = () => topOf('D1');
    const before = topOf('A1');
    expect(before).toBeLessThan(doingY());   // A1 is in the To do lane, above Doing
    B.entry().items.find((i: any) => i.id === 'A1').group = 'later';
    B.drawer.render();
    expect(topOf('A1')).toBeGreaterThan(doingY());   // now in Later, below Doing
  });

  it('collapsing a lane and collapsing the Kanban column are the same state', () => {
    switchBtn('By group').click();
    const lane = all(host(), n => n.classList.contains('tl-lab') && serializeText(n).includes('To do'))[0];
    byClass(lane, 'tw')[0].click();
    expect(B.isCollapsed('main', 'todo')).toBe(true);
    expect(barOf('A1')).toBeUndefined();
    expect(barOf('D1')).toBeDefined();
    B.setView('kanban');
    const col = all(host(), n => n.classList && n.classList.contains('kb-col') && (n as any).dataset.gid === 'todo')[0];
    expect(col.classList.contains('closed')).toBe(true);
    B.toggleCollapsed('main', 'todo');   // expand from the Kanban side
    B.setView('timeline');
    expect(barOf('A1')).toBeDefined();
  });
});
