import { findCycles } from '../src/board/graph';
import { checkBoard } from '../src/board/check';
import type { BoardItem } from '../src/types';

type E = [string, string][];

describe('findCycles', () => {
  it.each<[string, string[], E, string[][]]>([
    ['no edges', ['a', 'b'], [], []],
    ['self edge', ['a', 'b'], [['a', 'a']], [['a']]],
    ['2-cycle', ['a', 'b'], [['a', 'b'], ['b', 'a']], [['a', 'b']]],
    ['3-cycle', ['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']], [['a', 'b', 'c']]],
    ['two separate cycles', ['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']], [['a', 'b'], ['c', 'd']]],
    ['long chain, no cycle', ['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']], []],
    ['edge to an unknown node is ignored', ['a'], [['a', 'x'], ['x', 'a']], []],
    ['two cycles sharing a node', ['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['a', 'c'], ['c', 'a']], [['a', 'b'], ['a', 'c']]],
    ['duplicate edges count once', ['a', 'b'], [['a', 'b'], ['a', 'b'], ['b', 'a']], [['a', 'b']]],
  ])('%s', (_name, nodes, edges, expected) => {
    expect(findCycles(nodes, edges)).toEqual({ cycles: expected, truncated: false });
  });

  it('the same cycle entered from any rotation is reported once, starting at the smallest id', () => {
    const edges: E = [['c', 'a'], ['a', 'b'], ['b', 'c']];
    expect(findCycles(['c', 'b', 'a'], edges).cycles).toEqual([['a', 'b', 'c']]);
    expect(findCycles(['b', 'a', 'c'], [['b', 'c'], ['c', 'a'], ['a', 'b']]).cycles).toEqual([['a', 'b', 'c']]);
  });

  it('a cycle hanging off a chain is found without the chain', () => {
    expect(findCycles(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'b']]).cycles).toEqual([['b', 'c']]);
  });

  describe('deep graphs (no recursion, no stack overflow)', () => {
    const N = 20000;
    const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(5, '0')}`);
    const chain: E = ids.slice(1).map((id, i) => [ids[i], id]);

    it('a 20000-item chain has no cycle and is not truncated', () => {
      expect(findCycles(ids, chain)).toEqual({ cycles: [], truncated: false });
    });

    it('a 20000-item ring is one cycle of 20000', () => {
      const r = findCycles(ids, [...chain, [ids[N - 1], ids[0]]]);
      expect(r.truncated).toBe(false);
      expect(r.cycles).toHaveLength(1);
      expect(r.cycles[0]).toHaveLength(N);
      expect(r.cycles[0][0]).toBe(ids[0]);
    });

    it('a long chain ending in a small cycle finds only that cycle', () => {
      const r = findCycles(ids, [...chain, [ids[N - 1], ids[N - 2]]]);
      expect(r).toEqual({ cycles: [[ids[N - 2], ids[N - 1]]], truncated: false });
    });

    it('checkBoard on a 20000-item dependsOn chain, parent chain and dependsOn ring finishes with the right findings', () => {
      const mk = (i: number, extra: Partial<BoardItem>): BoardItem => ({ id: `b${i}`, title: 't', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...extra });
      const chainItems = Array.from({ length: N }, (_, i) => mk(i, i > 0 ? { dependsOn: [`b${i - 1}`], parent: `b${i - 1}` } : {}));
      const clean = checkBoard({ schemaVersion: 1, boards: [{ id: 'x', name: 'X', items: chainItems }] }, null, { today: '2026-01-01' });
      expect(clean).toEqual([]);
      const ringItems = chainItems.map((it, i) => (i === 0 ? { ...it, dependsOn: [`b${N - 1}`], parent: `b${N - 1}` } : it));
      const rules = checkBoard({ schemaVersion: 1, boards: [{ id: 'x', name: 'X', items: ringItems }] }, null, { today: '2026-01-01' }).map((f) => f.rule).sort();
      expect(rules).toEqual(['board-depends-cycle', 'board-nest-cycle']);
    });

    it('a ring whose smallest id sits in the middle still reports the cycle from the smallest id', () => {
      const rot = [...ids.slice(10000), ...ids.slice(0, 10000)];
      const edges: E = rot.map((id, i) => [id, rot[(i + 1) % N]]);
      const r = findCycles(ids, edges);
      expect(r.cycles).toHaveLength(1);
      expect(r.cycles[0][0]).toBe(ids[0]);
    });
  });

  describe('caps', () => {
    const complete = (n: number): { nodes: string[]; edges: E } => {
      const nodes = Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, '0')}`);
      const edges: E = [];
      for (const a of nodes) for (const b of nodes) if (a !== b) edges.push([a, b]);
      return { nodes, edges };
    };

    it('a 12-node complete graph stops fast at the default 100 cycles and says truncated', () => {
      const { nodes, edges } = complete(12);
      const t0 = Date.now();
      const r = findCycles(nodes, edges);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r.truncated).toBe(true);
      expect(r.cycles).toHaveLength(100);
    });

    it('maxCycles is honoured; exactly maxCycles cycles is not truncated', () => {
      const edges: E = [['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']];
      expect(findCycles(['a', 'b', 'c', 'd'], edges, { maxCycles: 2 })).toEqual({ cycles: [['a', 'b'], ['c', 'd']], truncated: false });
      const r = findCycles(['a', 'b', 'c', 'd'], edges, { maxCycles: 1 });
      expect(r).toEqual({ cycles: [['a', 'b']], truncated: true });
    });

    it('the step budget stops a search that finds few cycles', () => {
      const { nodes, edges } = complete(12);
      const r = findCycles(nodes, edges, { maxCycles: 1e9, maxSteps: 1000 });
      expect(r.truncated).toBe(true);
    });
  });
});
