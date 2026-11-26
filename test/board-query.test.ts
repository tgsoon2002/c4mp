import type { BoardFile, BoardItem } from '../src/types';
import { parsePlanTexts } from '../src/plan/parser';
import { boardTreeGraph, itemsFor, resolveLinks, showItem } from '../src/board/query';
import type { ItemView } from '../src/board/query';

// P18-PB2: board queries on a two-board fixture and a small plan.

const PLAN = parsePlanTexts('/nowhere', new Map([['p.c4', [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      metadata { uid 'u-api' status 'in-progress' owner 'K' }",
  '    }',
  "    web = container 'Web' { metadata { uid 'u-web' } }",
  "    nouid = container 'NoUid'",
  '  }',
  '}',
].join('\n')]]));

const it1 = (id: string, over: Partial<BoardItem> = {}): BoardItem =>
  ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

const FILE: BoardFile = {
  schemaVersion: 1,
  boards: [
    { id: 'main', name: 'Main', items: [
      it1('b1', { kind: 'feature', owner: 'K', links: ['u-api', 'u-gone'] }),
      it1('b2', { parent: 'b1', dependsOn: ['b3', 'ghost'], links: ['u-api'] }),
      it1('b3', { parent: 'b1', status: 'done' }),
      it1('b4', { parent: 'b3' }),
      it1('b5', { dependsOn: ['b6'] }),
    ] },
    { id: 'other', name: 'Other', archived: true, items: [it1('b6', { links: ['u-api', 'u-web'] })] },
  ],
};

describe('showItem', () => {
  it('parent, children, dependsOn (+ a missing one), dependents across boards, linked facts from the plan', () => {
    const v = showItem(FILE, PLAN, 'b2') as ItemView;
    expect(v.board).toEqual({ id: 'main', name: 'Main' });
    expect(v.parent!.id).toBe('b1');
    expect(v.children).toEqual([]);
    expect(v.dependsOn).toEqual([{ id: 'b3', title: 'T b3', kind: 'task', status: 'done' }, { id: 'ghost', missing: true }]);
    expect(v.dependents).toEqual([]);
    expect(v.linked).toEqual([{ uid: 'u-api', state: 'resolved', kind: 'container', fqn: 'app.api', title: 'Api', status: 'in-progress', owner: 'K' }]);

    const b1 = showItem(FILE, PLAN, 'b1')!;
    expect(b1.children.map((c) => c.id)).toEqual(['b2', 'b3']);
    expect(b1.linked.map((l) => [l.uid, l.state])).toEqual([['u-api', 'resolved'], ['u-gone', 'missing']]);
    expect(showItem(FILE, PLAN, 'b3')!.dependents.map((d) => d.id)).toEqual(['b2']);
    expect(showItem(FILE, PLAN, 'b6')!.dependents.map((d) => d.id)).toEqual(['b5']);
    expect(showItem(FILE, PLAN, 'b6')!.board.archived).toBe(true);
  });
  it('no plan: links are unchecked, not missing; unknown id is null', () => {
    expect(showItem(FILE, null, 'b1')!.linked.map((l) => l.state)).toEqual(['unchecked', 'unchecked']);
    expect(showItem(FILE, PLAN, 'zz')).toBeNull();
  });
  it('an element without uid never matches a link', () => {
    expect(resolveLinks(['undefined', ''], PLAN).map((l) => l.state)).toEqual(['missing', 'missing']);
  });
});

describe('boardTreeGraph', () => {
  const tree = (id: string | null, recursive: boolean, extra: { boardId?: string; maxNodes?: number } = {}) =>
    boardTreeGraph(FILE, id, { recursive, maxNodes: 120, ...extra });

  it('one item: itself and one level, dependsOn as edges, outside counted', () => {
    const r = tree('b1', false);
    if ('error' in r) throw new Error(r.error);
    expect(r.graph.nodes.map((n) => [n.id, n.parent])).toEqual([['b1', undefined], ['b2', 'b1'], ['b3', 'b1']]);
    expect(r.graph.edges).toEqual([{ from: 'b3', to: 'b2' }]);   // b3 first, then b2
    expect(r.outside).toBe(1);   // b2 -> ghost
    expect(r.truncated).toBe(true);   // b4 hidden
    expect(r.boardId).toBe('main');
  });
  it('recursive shows every level; no id = top-level items of the board (the only open board)', () => {
    const r = tree('b1', true);
    if ('error' in r) throw new Error(r.error);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(r.truncated).toBe(false);
    const all = tree(null, false);
    if ('error' in all) throw new Error(all.error);
    expect(all.graph.nodes.map((n) => n.id)).toEqual(['b1', 'b2', 'b3', 'b5']);
    expect(all.graph.nodes[0]).toMatchObject({ label: 'T b1', kind: 'feature', status: 'planned', owner: 'K' });
  });
  it('errors: unknown item, unknown board, two open boards, too many nodes', () => {
    expect(tree('zz', false)).toEqual({ error: "no item 'zz'" });
    expect(tree(null, false, { boardId: 'x' })).toMatchObject({ error: expect.stringContaining("no board 'x'") });
    const two: BoardFile = { ...FILE, boards: [FILE.boards[0], { id: 'c', name: 'C', items: [] }] };
    expect(boardTreeGraph(two, null, { recursive: false, maxNodes: 120 })).toMatchObject({ error: expect.stringContaining('2 boards') });
    expect(tree('b1', true, { maxNodes: 2 })).toMatchObject({ error: expect.stringContaining('more than --max-nodes 2') });
    expect(tree(null, true, { boardId: 'other' })).toMatchObject({ graph: { nodes: [{ id: 'b6' }] } });
  });
  it('a parent cycle does not loop; 20000 chained items do not overflow', () => {
    const cyc: BoardFile = { schemaVersion: 1, boards: [{ id: 'a', name: 'A', items: [it1('x', { parent: 'y' }), it1('y', { parent: 'x' }), it1('z', { parent: 'z' })] }] };
    const r = boardTreeGraph(cyc, null, { recursive: true, maxNodes: 120 });
    if ('error' in r) throw new Error(r.error);
    expect(r.graph.nodes.map((n) => [n.id, n.parent])).toEqual([['z', undefined], ['x', undefined], ['y', 'x']]);   // none hidden: the smallest id of the cycle becomes the root
    const big: BoardFile = { schemaVersion: 1, boards: [{ id: 'a', name: 'A', items: [] }] };
    for (let n = 1; n <= 20000; n++) big.boards[0].items.push(it1(`b${n}`, n > 1 ? { parent: `b${n - 1}` } : {}));
    const g = boardTreeGraph(big, 'b1', { recursive: true, maxNodes: 100000 });
    expect('graph' in g && g.graph.nodes.length).toBe(20000);
  });
});

describe('itemsFor', () => {
  it('every item of every board (archived too) that links the uid, in board then id order', () => {
    expect(itemsFor(FILE, 'u-api').map((x) => `${x.board.id}/${x.item.id}`)).toEqual(['main/b1', 'main/b2', 'other/b6']);
    expect(itemsFor(FILE, 'u-web').map((x) => x.item.id)).toEqual(['b6']);
    expect(itemsFor(FILE, 'none')).toEqual([]);
  });
});
