import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { layoutTree } from '../src/view/layoutTree';
import { Plan, PlanElement, BuildInput, FileOutline, SnapshotMeta, ViewModel, ViewNode } from '../src/types';

// b436: the file boxes of a component (folder-mode file nodes, claim-mode slices) are ordered by folder, then file name,
// so the automatic arrangement keeps the files of one folder next to each other, in a stable order.
const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'order-app', createdAt: '2026-01-01T00:00:00.000Z', git: null };
const containers = [{ id: 'app', name: 'App', path: '.', tech: 'TypeScript', manifest: null }];

// Line counts chosen so the old weight order scatters the folders (util/testIds.ts 40, b.ts 50, core/x.ts 45, util/text.ts 30, ...).
const LINES: Record<string, number> = {
  'util/text.ts': 30, 'b.ts': 50, 'util/testIds.ts': 40, 'core/x.ts': 45, 'a.ts': 5, 'util/fsAtomic.ts': 10, 'core/sub/z.ts': 60, 'core/y.ts': 20,
};
// Root files first, a folder's own files before its subfolders, names ordinal.
const EXPECTED = ['a.ts', 'b.ts', 'core/x.ts', 'core/y.ts', 'core/sub/z.ts', 'util/fsAtomic.ts', 'util/testIds.ts', 'util/text.ts'];

const outlines: FileOutline[] = Object.entries(LINES).map(([file, n]) => ({
  file,
  lineCount: n,
  parseError: false,
  elements: [{ name: `f_${file.replace(/\W/g, '_')}`, kind: 'function' as const, startLine: 1, endLine: n, lineCount: n }],
}));
const other: FileOutline = { file: 'other/o.ts', lineCount: 3, parseError: false, elements: [{ name: 'o', kind: 'function', startLine: 1, endLine: 3, lineCount: 3 }] };
const input: BuildInput = {
  meta,
  containers,
  components: [
    { id: 'app/lib', name: 'Lib', containerId: 'app', path: '.', files: Object.keys(LINES) },
    { id: 'app/other', name: 'Other', containerId: 'app', path: 'other', files: ['other/o.ts'] },
  ],
  outlines: [...outlines, other],
  imports: [],
  componentEdges: [{ from: 'app/other', to: 'app/lib', weight: 1 }],
  fileEdges: [],
};

// Claim mode needs one function-level claim (isClaimModePlan); the rest are file and folder claims.
const comp = (id: string, links: string[]): PlanElement => ({
  id, kind: 'component', title: id, description: null, technology: null, metadata: {}, parent: null, source: { file: 'a.c4', line: 1 },
  links: links.map((l) => {
    const [path, name] = l.split('#');
    return { raw: `./${l}`, path, name: name ?? null, lines: null, title: null };
  }),
});
const plan: Plan = {
  files: ['a.c4'],
  elements: [comp('app.lib', ['a.ts#f_a_ts', 'b.ts', 'core/', 'util/']), comp('app.other', ['other/'])],
  relations: [{ from: 'app.other', to: 'app.lib', label: null, source: { file: 'a.c4', line: 9 } }],
  issues: [],
};

const find = (n: ViewNode, id: string): ViewNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));

const models: Record<string, () => { m: ViewModel; lib: string }> = {
  'folder mode (file nodes)': () => ({ m: buildViewModel(buildSnapshot(input), 's'), lib: 'app/lib' }),
  'claim mode (slices)': () => ({ m: buildViewModel(buildSnapshot({ ...input, components: [] }, plan), 's', plan), lib: 'app.lib' }),
};
const arrangements: Record<string, (m: ViewModel) => void> = {
  'grid (no edges)': (m) => layoutTree(m.root),
  'with edges (layered where siblings pair)': (m) => layoutTree(m.root, { edges: m.edges }),
};
const cases = Object.keys(models).flatMap((mode) => Object.keys(arrangements).map((arr) => [mode, arr] as const));

describe('b436: file boxes of a component in folder order', () => {
  it.each(cases)('%s, %s: files of one folder sit next to each other, in reading order', (mode, arr) => {
    const { m, lib } = models[mode]();
    expect(m.edges.length).toBeGreaterThan(0);   // the 'with edges' pass really has an edge to use (between the two components)
    arrangements[arr](m);
    const files = find(m.root, lib)!.children;
    expect(files.map((c) => c.file)).toEqual(EXPECTED);
    // Reading order of the laid-out boxes (row by row, left to right) is the same folder order.
    const read = [...files].sort((a, b) => Math.round(a.y - b.y) || a.x - b.x).map((c) => c.file);
    expect(read).toEqual(EXPECTED);
  });

  it('the order is stable: the input order of the files does not change it', () => {
    const reversed = { ...input, components: input.components.map((c) => ({ ...c, files: [...c.files].reverse() })), outlines: [...input.outlines].reverse() };
    const m = buildViewModel(buildSnapshot(reversed), 's');
    expect(find(m.root, 'app/lib')!.children.map((c) => c.file)).toEqual(EXPECTED);
  });
});
