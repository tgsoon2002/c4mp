import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode, ViewModel } from '../src/types';

// P14-T6b: origins / emptyFiles / importedBy on shared + unassigned nodes, ViewFile.noFunctions.
const C4_FILE = 'c4/arch.c4';
const C4_TEXT = [
  'model {',
  "  app = system 'Claim App' {",
  "    web = container 'Web' {",
  "      auth = component 'Auth' {",
  '        link ../src/util.ts#formatDate',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });

function build(withEmpty: boolean): ViewModel {
  const plan = planFrom(C4_TEXT);
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const outlines: FileOutline[] = [
    { file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn('formatDate', 1, 5)] },
    { file: 'src/shared.ts', lineCount: 5, parseError: false, elements: [fn('helper', 1, 5)] },
    { file: 'lib/lonely.ts', lineCount: 5, parseError: false, elements: [fn('orphan', 1, 5)] },
  ];
  if (withEmpty) {
    outlines.push({ file: 'src/types.ts', lineCount: 3, parseError: false, elements: [] });
    outlines.push({ file: 'public/a.js', lineCount: 3, parseError: false, elements: [] });
  }
  const input: BuildInput = {
    meta, containers, components: [], outlines, imports: [], componentEdges: [],
    fileEdges: [{ from: 'src/util.ts', to: 'src/shared.ts' }],
  };
  return buildViewModel(buildSnapshot(input, plan), 's', plan);
}

function find(n: ViewNode, pred: (x: ViewNode) => boolean): ViewNode | undefined {
  if (pred(n)) return n;
  for (const c of n.children) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

describe('P14-T6b shared/unassigned data', () => {
  const m = build(true);
  const unassigned = find(m.root, (n) => n.kind === 'unassigned')!;
  const shared = find(m.root, (n) => n.kind === 'shared')!;

  it('(a) unassigned.emptyFiles lists zero-function files, sorted', () => {
    expect(unassigned.emptyFiles).toEqual(['public/a.js', 'src/types.ts']);
    expect(unassigned.detail).toBe('1 unassigned function, 2 files without functions');
  });

  it('(b) origins group by folder with sorted files', () => {
    expect(unassigned.origins).toEqual([
      { folder: 'lib', files: ['lib/lonely.ts'] },
      { folder: 'public', files: ['public/a.js'] },
      { folder: 'src', files: ['src/types.ts'] },
    ]);
    expect(shared.origins).toEqual([{ folder: 'src', files: ['src/shared.ts'] }]);
  });

  it('(c) shared child has importedBy with the claimed file and component id', () => {
    const child = shared.children[0];
    expect(child.importedBy).toEqual([{ file: 'src/util.ts', owner: expect.any(String) }]);
    expect(child.importedBy![0].owner).toMatch(/auth$/);
  });

  it('(d) usedBy unchanged and independent of importedBy', () => {
    const child = shared.children[0];
    expect(Array.isArray(child.usedBy)).toBe(true);
    expect(child.usedBy!.length).toBe(1);
    expect(child.usedBy![0]).toMatch(/auth$/);
  });

  it('(e) ViewFile.noFunctions only for empty files', () => {
    const flagged = m.files.filter((f) => f.noFunctions).map((f) => f.path);
    expect(flagged).toEqual(['public/a.js', 'src/types.ts']);
    expect(m.files.find((f) => f.path === 'src/util.ts')!.noFunctions).toBeUndefined();
  });

  it('(f) unassigned detail unchanged when no empty files; emptyFiles absent', () => {
    const u = find(build(false).root, (n) => n.kind === 'unassigned')!;
    expect(u.detail).toBe('1 unassigned function');
    expect(u.emptyFiles).toBeUndefined();
  });
});
