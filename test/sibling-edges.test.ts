import { siblingEdges } from '../src/view/siblingEdges';
import { ViewEdge, ViewNode } from '../src/types';

// P14-I14: pure sibling-pair lifting. Helpers copied from layout-tree.test.ts (not imported).

const mk = (id: string, children: ViewNode[] = []): ViewNode => ({
  id, kind: 'component', name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});
const edge = (from: string, to: string, weight = 1): ViewEdge => ({ from, to, weight });

describe('siblingEdges', () => {
  test('edge between two siblings gives one pair on their parent', () => {
    const a = mk('a');
    const b = mk('b');
    const root = mk('root', [a, b]);
    const out = siblingEdges(root, [edge('a', 'b', 4)]);
    expect([...out.keys()]).toEqual([root]);
    expect(out.get(root)).toEqual([{ from: 0, to: 1, weight: 4 }]);
  });

  test('edge between cousins is lifted to the two children of their lowest common ancestor', () => {
    const a = mk('a');
    const b = mk('b');
    const p1 = mk('p1', [a]);
    const p2 = mk('p2', [b]);
    const root = mk('root', [p1, p2]);
    const out = siblingEdges(root, [edge('a', 'b', 2)]);
    expect([...out.keys()]).toEqual([root]);
    expect(out.get(root)).toEqual([{ from: 0, to: 1, weight: 2 }]);
  });

  test('same-parent duplicates sum weights; reverse direction is a separate pair; pairs sort by from then to', () => {
    const a = mk('a');
    const b = mk('b');
    const c = mk('c');
    const root = mk('root', [a, b, c]);
    const out = siblingEdges(root, [
      edge('c', 'a', 1),
      edge('a', 'b', 2),
      edge('a', 'b', 3),
      edge('a', 'c', 1),
    ]);
    expect(out.get(root)).toEqual([
      { from: 0, to: 1, weight: 5 },
      { from: 0, to: 2, weight: 1 },
      { from: 2, to: 0, weight: 1 },
    ]);
  });

  test('edge into own ancestor, self edge, and unknown id are dropped', () => {
    const a = mk('a');
    const p1 = mk('p1', [a]);
    const b = mk('b');
    const root = mk('root', [p1, b]);
    const out = siblingEdges(root, [
      edge('a', 'p1'),
      edge('p1', 'a'),
      edge('a', 'a'),
      edge('a', 'missing'),
      edge('missing', 'b'),
    ]);
    expect(out.size).toBe(0);
  });

  test('two runs give equal output', () => {
    const a = mk('a');
    const b = mk('b');
    const p = mk('p', [a]);
    const root = mk('root', [p, b]);
    const edges = [edge('a', 'b', 1), edge('p', 'b', 2)];
    expect(siblingEdges(root, edges)).toEqual(siblingEdges(root, edges));
  });
});
