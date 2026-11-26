import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, PlanElement, BuildInput, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P14-T29a: fileOnly flag on file nodes / ViewFile, and claim-mode file slices from Ownership.fileOwner.
const meta: SnapshotMeta = {
  tool: 'c4pm@0.1.0',
  repoPath: '/test/repo',
  repoName: 'fo-app',
  createdAt: '2026-01-01T00:00:00.000Z',
  git: null,
};
const containers = [{ id: 'app', name: 'App', path: '.', tech: 'Java', manifest: null }];
const fn = (name: string, start: number, end: number) => ({
  name,
  kind: 'function' as const,
  startLine: start,
  endLine: end,
  lineCount: end - start + 1,
});

function el(id: string, links: { path: string; name: string | null }[]): PlanElement {
  return {
    id,
    kind: 'component',
    title: id,
    description: null,
    technology: null,
    links: links.map((l) => ({ raw: `./${l.path}`, path: l.path, name: l.name, lines: null, title: null })),
    metadata: {},
    parent: null,
    source: { file: 'a.c4', line: 1 },
  };
}

function flatten(n: ViewNode): ViewNode[] {
  return [n, ...n.children.flatMap(flatten)];
}

describe('fileOnly in the view model (P14-T29a)', () => {
  it('folder mode: file node has fileOnly:true and no children', () => {
    const outlines: FileOutline[] = [
      { file: 'svc/A.java', lineCount: 12, parseError: false, elements: [], fileOnly: true },
      { file: 'svc/b.ts', lineCount: 3, parseError: false, elements: [fn('b', 1, 3)] },
    ];
    const comp = { id: 'app/svc', name: 'Svc', containerId: 'app', path: 'svc', files: ['svc/A.java', 'svc/b.ts'] };
    const snap = buildSnapshot({ meta, containers, components: [comp], outlines, imports: [], componentEdges: [], fileEdges: [] });
    const m = buildViewModel(snap, 's');
    const nodes = flatten(m.root);
    const a = nodes.find((n) => n.id === 'svc/A.java')!;
    expect(a.fileOnly).toBe(true);
    expect(a.children).toEqual([]);
    expect('fileOnly' in nodes.find((n) => n.id === 'svc/b.ts')!).toBe(false);
    expect(m.files.find((f) => f.path === 'svc/A.java')).toEqual({ path: 'svc/A.java', kind: 'source', owners: ['app/svc'], fileOnly: true });
    expect('fileOnly' in m.files.find((f) => f.path === 'svc/b.ts')!).toBe(false);
  });

  describe('claim mode', () => {
    const plan: Plan = {
      files: ['a.c4'],
      elements: [
        el('app.orders', [{ path: 'src/o.ts', name: 'create' }, { path: 'java/Order.java', name: null }, { path: 'js/', name: null }]),
        el('app.other', [{ path: 'src/p.ts', name: 'run' }]),
      ],
      relations: [],
      issues: [],
    };
    const outlines: FileOutline[] = [
      { file: 'src/o.ts', lineCount: 5, parseError: false, elements: [fn('create', 1, 5)] },
      { file: 'src/p.ts', lineCount: 5, parseError: false, elements: [fn('run', 1, 5)] },
      { file: 'java/Order.java', lineCount: 40, parseError: false, elements: [], fileOnly: true },
      { file: 'java/Lost.java', lineCount: 7, parseError: false, elements: [], fileOnly: true },
    ];
    outlines.push({ file: 'js/plain.js', lineCount: 9, parseError: false, elements: [] });   // parsed, just no functions
    const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
    const snap = buildSnapshot(input, plan);
    const m = buildViewModel(snap, 's', plan);
    const nodes = flatten(m.root);

    it('owned zero-function file: slice child, Files entry owned and flagged fileOnly', () => {
      const comp = nodes.find((n) => n.id === 'app.orders')!;
      const slice = comp.children.find((c) => c.id === 'app.orders::slice::java/Order.java')!;
      expect(slice).toBeDefined();
      expect(slice.kind).toBe('slice');
      expect(slice.fileOnly).toBe(true);
      expect(slice.children).toEqual([]);
      expect(slice.weight).toBe(40);
      expect(slice.detail).toBe('file-only (no parser) · java/Order.java');
      const f = m.files.find((x) => x.path === 'java/Order.java')!;
      expect(f.fileOnly).toBe(true);
      expect(f.owners).toEqual(['app.orders']);
      expect(f.flag).toBeUndefined();
      // the ordinary slice of the same component is unchanged (no fileOnly key)
      const ordinary = comp.children.find((c) => c.id === 'app.orders::slice::src/o.ts')!;
      expect('fileOnly' in ordinary).toBe(false);
    });

    it('owned zero-function file that was parsed (not fileOnly): plain slice, no fileOnly key', () => {
      const comp = nodes.find((n) => n.id === 'app.orders')!;
      const slice = comp.children.find((c) => c.id === 'app.orders::slice::js/plain.js')!;
      expect(slice.weight).toBe(9);
      expect(slice.detail).toBe('no functions · js/plain.js');
      expect('fileOnly' in slice).toBe(false);
      const f = m.files.find((x) => x.path === 'js/plain.js')!;
      expect(f.owners).toEqual(['app.orders']);
      expect('fileOnly' in f).toBe(false);
    });

    it('unowned zero-function file: Files flag unassigned, no tree node', () => {
      const f = m.files.find((x) => x.path === 'java/Lost.java')!;
      expect(f.flag).toBe('unassigned');
      expect(f.owners).toEqual([]);
      expect(nodes.some((n) => n.file === 'java/Lost.java' || n.id.endsWith('java/Lost.java'))).toBe(false);
    });
  });

  describe('Unassigned box excludes owned zero-function files (P14-T29b)', () => {
    const plan: Plan = {
      files: ['a.c4'],
      elements: [el('app.orders', [{ path: 'src/o.ts', name: 'create' }, { path: 'java/Order.java', name: null }])],
      relations: [],
      issues: [],
    };
    const claimed: FileOutline[] = [
      { file: 'src/o.ts', lineCount: 5, parseError: false, elements: [fn('create', 1, 5)] },
      { file: 'java/Order.java', lineCount: 40, parseError: false, elements: [], fileOnly: true },
    ];
    const build = (outlines: FileOutline[]) => {
      const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
      const m = buildViewModel(buildSnapshot(input, plan), 's', plan);
      return { m, nodes: flatten(m.root) };
    };

    it('only owned zero-function files: no Unassigned box at all', () => {
      const { nodes } = build(claimed);
      expect(nodes.some((n) => n.kind === 'unassigned')).toBe(false);
      expect(nodes.find((n) => n.id === 'app.orders')!.children.some((c) => c.id === 'app.orders::slice::java/Order.java')).toBe(true);
    });

    it('unassigned function plus owned zero-function file: file absent from emptyFiles and origins', () => {
      const { nodes } = build([...claimed, { file: 'loose/x.ts', lineCount: 4, parseError: false, elements: [fn('stray', 1, 4)] }]);
      const box = nodes.find((n) => n.kind === 'unassigned')!;
      expect(box).toBeDefined();
      expect(box.children.map((c) => c.name)).toEqual(['stray']);
      expect(box.emptyFiles).toBeUndefined();
      expect(box.origins).toEqual([{ folder: 'loose', files: ['loose/x.ts'] }]);
      expect(box.detail).toBe('1 unassigned function');
    });

    it('ownerless zero-function file: Unassigned box kept, file in emptyFiles and origins', () => {
      const { nodes } = build([...claimed, { file: 'java/Lost.java', lineCount: 7, parseError: false, elements: [], fileOnly: true }]);
      const box = nodes.find((n) => n.kind === 'unassigned')!;
      expect(box).toBeDefined();
      expect(box.emptyFiles).toEqual(['java/Lost.java']);
      expect(box.origins).toEqual([{ folder: 'java', files: ['java/Lost.java'] }]);
      expect(box.detail).toBe('0 unassigned functions, 1 file without functions');
    });

    it('unassigned function plus ownerless and owned zero-function files: detail counts only ownerless files', () => {
      const { nodes } = build([
        ...claimed,
        { file: 'loose/x.ts', lineCount: 4, parseError: false, elements: [fn('stray', 1, 4)] },
        { file: 'java/Lost.java', lineCount: 7, parseError: false, elements: [], fileOnly: true },
      ]);
      const box = nodes.find((n) => n.kind === 'unassigned')!;
      expect(box.emptyFiles).toEqual(['java/Lost.java']);
      expect(box.detail).toBe('1 unassigned function, 1 file without functions');
    });
  });

  it('snapshot without any fileOnly: no node or file entry has the key', () => {
    const outlines: FileOutline[] = [{ file: 'svc/b.ts', lineCount: 3, parseError: false, elements: [fn('b', 1, 3)] }];
    const comp = { id: 'app/svc', name: 'Svc', containerId: 'app', path: 'svc', files: ['svc/b.ts'] };
    const snap = buildSnapshot({ meta, containers, components: [comp], outlines, imports: [], componentEdges: [], fileEdges: [] });
    const m = buildViewModel(snap, 's');
    expect(flatten(m.root).some((n) => 'fileOnly' in n)).toBe(false);
    expect(m.files.some((f) => 'fileOnly' in f)).toBe(false);
  });
});
