import { attachBoard } from '../src/board/view';
import { BOARD_KINDS, BOARD_SIZES, BOARD_STATUSES, PLAN_PRIORITIES } from '../src/constants';
import type { BoardFile, BoardItem, PlanFinding, ViewKind, ViewModel, ViewNode } from '../src/types';

const U_WEB = '00000000-0000-4000-8000-000000000002';
const U_AUTH = '00000000-0000-4000-8000-000000000003';
const U_NEW = '00000000-0000-4000-8000-000000000004';

function node(id: string, kind: ViewKind, extra: Partial<ViewNode> = {}, children: ViewNode[] = []): ViewNode {
  return { id, kind, name: id.toUpperCase(), detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra };
}
function model(): ViewModel {
  const auth = node('app.web.auth', 'component', { uid: U_AUTH, meta: { status: 'done', owner: 'jay' }, findings: [{ rule: 'r', severity: 'warning', message: 'm' } as never] });
  const fresh = node('app.web.new', 'component', { uid: U_NEW, planOnly: true });
  const web = node('web', 'container', { uid: U_WEB }, [auth, fresh]);
  return {
    schemaVersion: 1, title: 't', subtitle: 's', summary: '', repoPath: '/r',
    root: node('system', 'system', {}, [web]),
    edges: [], drift: null, planFindings: [], files: [],
  };
}
const item = (id: string, extra: Partial<BoardItem> = {}): BoardItem =>
  ({ id, title: `T${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...extra });
const find = (n: ViewNode, id: string): ViewNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));

describe('attachBoard', () => {
  it('links a screen uid of the IO-view tree (b130): nodeId = screen fqn, boardCount set; arch uid wins on a clash', () => {
    const m = model();
    const scr = node('app.web.home', 'screen', { uid: 'u-screen' });
    const clash = node('app.web.clash', 'screen', { uid: U_AUTH });
    m.navView = { root: node('(io)', 'system', {}, [node('app.web', 'container', {}, [scr, clash])]), edges: [] };
    const data: BoardFile = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item('b1', { links: ['u-screen', U_AUTH] })] }] };
    const [b1] = attachBoard(m, data, []).board!.boards[0].items;
    expect(b1.linked.map((l) => [l.uid, l.nodeId, l.kind])).toEqual([['u-screen', 'app.web.home', 'screen'], [U_AUTH, 'app.web.auth', 'component']]);
    expect(b1.deadLinks).toEqual([]);
    expect(scr.boardCount).toBe(1);
    expect('boardCount' in clash).toBe(false);
  });

  const FINDINGS: PlanFinding[] = [{ severity: 'info', rule: 'board-overdue', id: 'b1', message: 'x' }];

  it('links items to nodes, counts them, keeps dead links apart', () => {
    const m = model();
    const data: BoardFile = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [
      item('b1', { links: [U_AUTH, 'dead'] }), item('b2', { links: [U_AUTH, U_AUTH, U_NEW] }),
    ] }] };
    const out = attachBoard(m, data, FINDINGS);
    expect(out).toBe(m);
    const [b1, b2] = out.board!.boards[0].items;
    expect(b1.linked).toEqual([{ uid: U_AUTH, nodeId: 'app.web.auth', name: 'APP.WEB.AUTH', kind: 'component', status: 'done', owner: 'jay', state: 'has-code', findingCount: 1 }]);
    expect(b1.deadLinks).toEqual(['dead']);
    expect(b2.linked.map((l) => [l.nodeId, l.state, l.findingCount])).toEqual([['app.web.auth', 'has-code', 1], ['app.web.new', 'planned-no-code', 0]]);
    expect(b2.deadLinks).toEqual([]);
    expect(find(m.root, 'app.web.auth')!.boardCount).toBe(2);   // b2 links it twice, counts once
    expect(find(m.root, 'app.web.new')!.boardCount).toBe(1);
    expect('boardCount' in find(m.root, 'web')!).toBe(false);
    expect(out.board!.findings).toBe(FINDINGS);
    expect(out.board!.statuses).toEqual(BOARD_STATUSES);
    expect(out.board!.kinds).toEqual(BOARD_KINDS);
    expect(out.board!.priorities).toEqual(PLAN_PRIORITIES);
    expect(out.board!.sizes).toEqual(BOARD_SIZES);
  });

  it('item order is the file order; extra fields survive', () => {
    const data: BoardFile = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item('b10', { due: '2026-10-30' }), item('b2'), item('a')] }] };
    const items = attachBoard(model(), data, []).board!.boards[0].items;
    expect(items.map((i) => i.id)).toEqual(['b10', 'b2', 'a']);
    expect(items[0].due).toBe('2026-10-30');
  });

  it('fills the three default groups when the board has none; keeps declared groups', () => {
    const data: BoardFile = { schemaVersion: 1, boards: [
      { id: 'a', name: 'A', items: [] },
      { id: 'b', name: 'B', groups: [{ id: 'triage', name: 'Triage' }], items: [] },
    ] };
    const [a, b] = attachBoard(model(), data, []).board!.boards;
    expect(a.groups.map((g) => [g.id, g.status])).toEqual([['planned', 'planned'], ['in-progress', 'in-progress'], ['done', 'done']]);
    expect(b.groups).toEqual([{ id: 'triage', name: 'Triage' }]);
  });

  it('archived boards are sent but not counted', () => {
    const data: BoardFile = { schemaVersion: 1, boards: [
      { id: 'old', name: 'Old', archived: true, items: [item('b1', { links: [U_WEB] })] },
      { id: 'cur', name: 'Cur', items: [item('b2', { links: [U_AUTH] })] },
    ] };
    const m = attachBoard(model(), data, []);
    expect(m.board!.boards.map((b) => [b.id, b.archived])).toEqual([['old', true], ['cur', undefined]]);
    expect(m.board!.boards[0].items[0].linked).toHaveLength(1);
    expect('boardCount' in find(m.root, 'web')!).toBe(false);
    expect(find(m.root, 'app.web.auth')!.boardCount).toBe(1);
  });

  it('a model without uid nodes is unchanged apart from model.board; every link is dead', () => {
    const m = model();
    (function strip(n: ViewNode): void { delete n.uid; n.children.forEach(strip); })(m.root);
    const before = JSON.stringify(m.root);
    const data: BoardFile = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item('b1', { links: [U_AUTH] })] }] };
    const out = attachBoard(m, data, []);
    expect(JSON.stringify(out.root)).toBe(before);
    expect(out.board!.boards[0].items[0].deadLinks).toEqual([U_AUTH]);
  });

  it('does not mutate the input data; ids like __proto__ are plain ids', () => {
    const data: BoardFile = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item('__proto__', { links: [U_AUTH], tags: ['x'] }), item('constructor', { parent: '__proto__' })] }] };
    const copy = JSON.stringify(data);
    const out = attachBoard(model(), data, []);
    expect(JSON.stringify(data)).toBe(copy);
    expect(out.board!.boards[0].items.map((i) => i.id)).toEqual(['__proto__', 'constructor']);
    expect(out.board!.boards[0].items[0].linked).toHaveLength(1);
    out.board!.boards[0].items[0].tags.push('y');
    expect(data.boards[0].items[0].tags).toEqual(['x']);
  });
});
