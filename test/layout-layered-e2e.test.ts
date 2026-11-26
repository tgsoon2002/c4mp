import { layoutView } from '../src/view/layout';
import { layoutTree } from '../src/view/layoutTree';
import { ViewEdge, ViewModel, ViewNode } from '../src/types';

// P14-I17: layoutView passes model.edges to layoutTree, so edges decide the order of the children.

const mk = (id: string, kind: ViewNode['kind'], children: ViewNode[] = []): ViewNode => ({
  id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});
const files = (p: string, n: number) => Array.from({ length: n }, (_, i) => mk(`${p}/f${i}`, 'file'));
const model = (root: ViewNode, edges: ViewEdge[] = []): ViewModel => ({
  schemaVersion: 1, title: 't', subtitle: '', summary: '', repoPath: '/x', root, edges, drift: null, planFindings: [], files: [],
});
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
const get = (m: ViewModel, id: string) => all(m.root).find((n) => n.id === id)!;

/** sys > k > [a, b, c], each component holding 2 files. */
const tree = (): ViewNode => mk('sys', 'system', [
  mk('k', 'container', ['a', 'b', 'c'].map((c) => mk(`k/${c}`, 'component', files(`k/${c}`, 2)))),
]);

describe('layered layout wired through layoutView', () => {
  it('callers sit above callees; the cycle-closing edge b->a is ignored for ranking', () => {
    const edges: ViewEdge[] = [
      { from: 'k/a', to: 'k/b', weight: 1 },
      { from: 'k/a', to: 'k/c', weight: 1 },
      { from: 'k/b', to: 'k/a', weight: 1 },
    ];
    const m = layoutView(model(tree(), edges));
    expect(get(m, 'k/b').y).toBeGreaterThan(get(m, 'k/a').y);
    expect(get(m, 'k/c').y).toBeGreaterThan(get(m, 'k/a').y);
    expect(get(m, 'k/b').y).toBeCloseTo(get(m, 'k/c').y, 6);
  });

  it('every bean is 170 in its parent frame', () => {
    const edges: ViewEdge[] = [
      { from: 'k/a', to: 'k/b', weight: 1 },
      { from: 'k/a', to: 'k/c', weight: 1 },
      { from: 'k/b', to: 'k/a', weight: 1 },
    ];
    const m = layoutView(model(tree(), edges));
    for (const p of all(m.root)) {
      for (const c of p.children) expect(c.bubble!.w / p.scale!).toBeCloseTo(170, 6);
    }
  });

  it('with edges: [] the output equals the grid result (layoutTree without edges)', () => {
    const viaView = layoutView(model(tree(), [])).root;
    const direct = tree();
    layoutTree(direct, { saved: true });
    expect(viaView).toEqual(direct);
  });
});
