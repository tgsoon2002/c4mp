import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';

// P16-B25: the Kanban view of the board drawer, static part (fake DOM).

let p: BoardPage;
let B: any;

const body = () => (p.sandbox.document as any).getElementById('board-drawer-body');
// own tree walk: the harness querySelector trips over text nodes
const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: any, cls: string) => find(root, n => n.classList.contains(cls));
const cols = () => byClass(body(), 'kb-col');
const col = (gid: string) => cols().find((c: any) => c.dataset.gid === gid);
const cardIds = (gid: string) => byClass(col(gid), 'kb-card').map((c: any) => c.dataset.id);
const head = (gid: string) => byClass(col(gid), 'kb-head')[0];
const draw = (entry: any) => B.views.kanban(body(), entry);
const item = (over: any) => ({ ...sampleBoard(p.model).boards[0].items[3], dependsOn: [], deadLinks: [], parent: undefined, ...over });

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
});

describe('P16-B25 kanban view', () => {
  it('registers; one column per group in order; items fall into the group of their status', () => {
    B.open();
    B.setView('kanban');
    expect(cols().map((c: any) => c.dataset.gid)).toEqual(['planned', 'in-progress', 'done']);
    expect(cardIds('planned')).toEqual(['b3', 'b4', 'b6']);
    expect(cardIds('in-progress')).toEqual(['b1']);
    expect(cardIds('done')).toEqual(['b2']);
    expect(byClass(head('planned'), 'kb-count')[0].textContent).toBe('3');
  });

  it('b910: a card with no owner shows a faint "unassigned" tag; an owned card shows the name only', () => {
    const e = sampleBoard(p.model).boards[0];
    e.items = [item({ id: 'a', title: 'A', status: 'planned', owner: undefined }), item({ id: 'c', title: 'C', status: 'planned', owner: 'kim' })];
    draw(e);
    const card = (id: string) => byClass(col('planned'), 'kb-card').find((c: any) => c.dataset.id === id);
    const tags = byClass(card('a'), 'bd-unassigned');
    expect(tags.map((t: any) => t.textContent)).toEqual(['unassigned']);
    expect(byClass(card('c'), 'bd-unassigned')).toEqual([]);
    expect(byClass(card('c'), 'bd-sub')[0].children[0].textContent).toBe('kim');
  });

  it('an item with a valid `group` goes there, whatever its status; a dangling group falls back to status', () => {
    const e = sampleBoard(p.model).boards[0];
    e.groups.push({ id: 'triage', name: 'Needs triage' });
    e.items = [item({ id: 'a', title: 'A', status: 'planned', group: 'triage' }), item({ id: 'c', title: 'C', status: 'done', group: 'gone' })];
    draw(e);
    expect(cols().map((c: any) => c.dataset.gid)).toEqual(['planned', 'in-progress', 'done', 'triage']);
    expect(cardIds('triage')).toEqual(['a']);
    expect(cardIds('done')).toEqual(['c']);
    expect(B.groupOf(e, e.items[0])).toBe('triage');
    expect(B.groupOf(e, e.items[1])).toBe('done');
  });

  it('a status no group shows gets an extra column, only when it has items', () => {
    const e = sampleBoard(p.model).boards[0];
    draw(e);
    expect(cols().length).toBe(3);   // no abandoned items: no extra column
    e.items.push(item({ id: 'x', title: 'X', status: 'abandoned' }));
    draw(e);
    expect(cols().map((c: any) => c.dataset.gid)).toEqual(['planned', 'in-progress', 'done', 'status:abandoned']);
    expect(cardIds('status:abandoned')).toEqual(['x']);
    expect(col('status:abandoned').classList.contains('extra')).toBe(true);
    expect(B.groupOf(e, e.items[e.items.length - 1])).toBeNull();
  });

  it('card shows kind, id, title, owner, due chip, parent id, linked count', () => {
    draw(sampleBoard(p.model).boards[0]);
    const c = byClass(col('planned'), 'kb-card')[0];   // b3
    const t = serializeText(c);
    expect(t).toContain('b3');
    expect(t).toContain('Build makeQuiz');
    expect(t).toContain('due 10-20');
    expect(t).toContain('↑ b1');
    expect(t).toContain('⛓ 0');
    const b1 = byClass(col('in-progress'), 'kb-card')[0];
    expect(serializeText(b1)).toContain('kim');
    expect(byClass(b1, 'bd-kind')[0].textContent).toBe('F');
    expect(serializeText(b1)).toContain('⛓ 1');
  });

  it('the due chip is red only when overdue', () => {
    B.setToday('2026-10-21');
    draw(sampleBoard(p.model).boards[0]);
    const over = (gid: string, id: string) => byClass(byClass(col(gid), 'kb-card').find((c: any) => c.dataset.id === id), 'bd-due')[0].classList.contains('over');
    expect(over('planned', 'b4')).toBe(true);
    expect(over('planned', 'b3')).toBe(true);
    expect(byClass(byClass(col('done'), 'kb-card')[0], 'bd-due')[0].classList.contains('over')).toBe(false);   // done
  });

  it('blocked mark only when a dependency (any board) is not done', () => {
    B.open();
    B.setView('kanban');
    const blocked = (gid: string, id: string) => byClass(byClass(col(gid), 'kb-card').find((c: any) => c.dataset.id === id), 'kb-blocked').length;
    expect(blocked('planned', 'b3')).toBe(0);   // depends on b2 which is done
    B.setBoard('backlog');
    expect(blocked('planned', 'b5')).toBe(1);   // depends on b3 (other board, planned)
    const title = byClass(byClass(col('planned'), 'kb-card')[0], 'kb-blocked')[0].title;
    expect(title).toBe('waits for b3');
    const e = sampleBoard(p.model).boards[1];
    e.items[0].dependsOn = ['b2', 'nope'];   // done + unknown id: not blocked
    draw(e);
    expect(blocked('planned', 'b5')).toBe(0);
  });

  it('column head click collapses to a strip, keeps the cards, shares the state with isCollapsed; click again expands', () => {
    B.open();
    B.setView('kanban');
    expect(col('planned').classList.contains('closed')).toBe(false);
    head('planned').click();
    expect(B.isCollapsed('sprint', 'planned')).toBe(true);
    expect(col('planned').classList.contains('closed')).toBe(true);
    expect(cardIds('planned')).toEqual(['b3', 'b4', 'b6']);   // cards stay in the DOM
    expect(head('planned').getAttribute('aria-expanded')).toBe('false');
    expect(byClass(head('planned'), 'kb-count')[0].textContent).toBe('3');
    expect(col('in-progress').classList.contains('closed')).toBe(false);
    head('planned').click();
    expect(col('planned').classList.contains('closed')).toBe(false);
    // the other direction: the shared setter closes the column
    B.toggleCollapsed('sprint', 'done');
    expect(col('done').classList.contains('closed')).toBe(true);
    // another board is not affected
    B.setBoard('backlog');
    expect(col('done').classList.contains('closed')).toBe(false);
  });

  it('heads and cards are focusable with labels; Enter works on both', () => {
    B.open();
    B.setView('kanban');
    expect(head('done').tabIndex).toBe(0);
    expect(head('done').getAttribute('aria-label')).toBe('Done, 1 item, expanded');
    head('done').dispatch('keydown', { key: 'Enter', preventDefault() {} });
    expect(B.isCollapsed('sprint', 'done')).toBe(true);
    const c = byClass(col('in-progress'), 'kb-card')[0];
    expect(c.tabIndex).toBe(0);
    c.dispatch('keydown', { key: 'Enter', target: c, preventDefault() {} });
    expect(B.selectedId()).toBe('b1');
  });

  it('a card click selects it and the card gets class selected; double click zooms', () => {
    B.open();
    B.setView('kanban');
    const zoom = jest.fn();
    B.zoomToLinked = zoom;
    byClass(col('in-progress'), 'kb-card')[0].click();
    expect(B.selectedId()).toBe('b1');
    expect(byClass(col('in-progress'), 'kb-card')[0].classList.contains('selected')).toBe(true);
    byClass(col('planned'), 'kb-card')[1].dispatch('dblclick');
    expect(B.selectedId()).toBe('b4');
    expect(zoom).toHaveBeenCalledTimes(1);
  });

  it('markup in title, owner and group names stays text; ids such as __proto__ work', () => {
    B.open();
    B.setView('kanban');
    const c = byClass(col('planned'), 'kb-card').find((x: any) => x.dataset.id === 'b6');
    expect(byClass(c, 'kb-ct')[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(find(body(), n => n.tagName === 'IMG' || n.tagName === 'I' || n.tagName === 'B').length).toBe(0);
    const e = sampleBoard(p.model).boards[0];
    e.groups.push({ id: 'x', name: '<img src=x onerror=alert(2)>' });
    e.items = [item({ id: '__proto__', title: 'P', group: 'x' }), item({ id: 'k', title: 'K', parent: '__proto__' })];
    draw(e);
    expect(cardIds('x')).toEqual(['__proto__']);
    expect(byClass(col('x'), 'kb-name')[0].textContent).toBe('<img src=x onerror=alert(2)>');
    expect(find(body(), n => n.tagName === 'IMG').length).toBe(0);
  });
});
