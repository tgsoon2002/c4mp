import path from 'path';
import { runSnapshot } from '../src/index';
import { buildInnerFileEdges, buildViewModel } from '../src/view/model';
import { FileEdge, ViewKind, ViewNode } from '../src/types';

// b896 (K 2026-11-19): file -> file import arrows inside one box, a list apart from model.edges.

const box = (id: string, kind: ViewKind, children: ViewNode[] = [], file?: string): ViewNode => ({
  id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
  ...(file ? { file } : {}),
});
const fileBox = (file: string) => box(file, 'file', [], file);
const slice = (comp: string, file: string) => box(`${comp}::slice::${file}`, 'slice', [], file);

describe('buildInnerFileEdges (b896)', () => {
  const root = box('sys', 'system', [
    box('api', 'container', [
      box('api/a', 'component', [fileBox('a/one.ts'), fileBox('a/two.ts')]),
      box('api/b', 'component', [fileBox('b/three.ts')]),
      box('api/c', 'component', [slice('api/c', 'c/x.ts'), slice('api/c', 'c/y.ts')]),
      box('api/d', 'component', [slice('api/d', 'c/x.ts')]),
    ]),
  ]);
  const run = (edges: FileEdge[]) => buildInnerFileEdges(root, edges);

  it.each<[string, FileEdge[], { from: string; to: string; weight: number }[]]>([
    ['two files under one component: one edge with their node ids', [{ from: 'a/one.ts', to: 'a/two.ts' }], [{ from: 'a/one.ts', to: 'a/two.ts', weight: 1 }]],
    ['an import across two components: none', [{ from: 'a/one.ts', to: 'b/three.ts' }], []],
    ['slices under one component: an edge between the slice ids', [{ from: 'c/y.ts', to: 'c/x.ts' }], [{ from: 'api/c::slice::c/y.ts', to: 'api/c::slice::c/x.ts', weight: 1 }]],
    ['a self import: none', [{ from: 'a/one.ts', to: 'a/one.ts' }], []],
    ['duplicates: one edge', [{ from: 'a/two.ts', to: 'a/one.ts' }, { from: 'a/two.ts', to: 'a/one.ts' }], [{ from: 'a/two.ts', to: 'a/one.ts', weight: 1 }]],
  ])('%s', (_name, edges, expected) => {
    expect(run(edges)).toEqual(expected);
  });

  it('sorted by from, then to', () => {
    const out = run([{ from: 'c/y.ts', to: 'c/x.ts' }, { from: 'a/two.ts', to: 'a/one.ts' }, { from: 'a/one.ts', to: 'a/two.ts' }]);
    expect(out.map((e) => `${e.from}>${e.to}`)).toEqual(['a/one.ts>a/two.ts', 'a/two.ts>a/one.ts', 'api/c::slice::c/y.ts>api/c::slice::c/x.ts']);
  });
});

describe('buildViewModel fileEdges (b896)', () => {
  const build = (fixture: string) => {
    const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures', fixture), write: false, quiet: true });
    return { model: buildViewModel(snapshot, 'x'), without: buildViewModel({ ...snapshot, fileEdges: [] }, 'x') };
  };

  it('a same-component import gives fileEdges; model.edges is the same as without it', () => {
    const { model, without } = build('layers-claim');   // no plan: folder mode, api/_root holds orders.ts and store.ts
    expect(model.fileEdges).toEqual([{ from: 'api/src/orders.ts', to: 'api/src/store.ts', weight: 1 }]);
    expect(model.edges).toEqual(without.edges);
    expect(without.fileEdges).toBeUndefined();
  });

  it('no same-component import: fileEdges absent', () => {
    const { model, without } = build('sample');
    expect(model.fileEdges).toBeUndefined();
    expect(model.edges).toEqual(without.edges);
  });
});
