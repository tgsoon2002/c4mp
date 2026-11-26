import { buildView } from '../src/page/html';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, PlanElement, BuildInput, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P14-I13 (guard test): every node id is unique and no ViewNode object sits under two parents.
// The duplicates found by I12 (16 methods listed under their class AND their slice) were fixed by I5d-i/I5d-ii,
// so this file guards that fix. It makes no model change.

interface TreeCheck {
  visits: number;     // every visit of a node in the tree walk (same counting as the I12 script)
  dupIds: string[];   // each id that is visited more than once, in first-duplicate order
  shared: string[];   // ids of node objects reached through more than one parent
}

// Walks the tree from root. Counts every visit by id; a node object reached a second time is recorded as shared.
function checkTree(root: ViewNode): TreeCheck {
  const idCount = new Map<string, number>();
  const visited = new Set<ViewNode>();
  const dupIds: string[] = [];
  const shared: string[] = [];
  let visits = 0;
  const stack: ViewNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visits++;
    const seen = idCount.get(node.id) ?? 0;
    idCount.set(node.id, seen + 1);
    if (seen === 1) dupIds.push(node.id);
    if (visited.has(node)) shared.push(node.id);
    else visited.add(node);
    for (const child of node.children) stack.push(child);
  }
  return { visits, dupIds, shared };
}

// LTS copy: skipped unless C4PM_LTS_COPY is set (same switch as layout-saved.test.ts).
const LTS_COPY = process.env.C4PM_LTS_COPY;
const ltsDescribe = LTS_COPY ? describe : describe.skip;

ltsDescribe('LTS view: unique ids and single parents (P14-I13 guard)', () => {
  it('every node id is unique and no node sits under two parents', () => {
    const { model } = buildView({ repo: LTS_COPY! });
    const r = checkTree(model.root);
    console.log(`LTS view: nodes=${r.visits} duplicateIds=${r.dupIds.length} sharedNodes=${r.shared.length}`);
    if (r.dupIds.length > 0) console.log(`first duplicate ids: ${r.dupIds.slice(0, 10).join(', ')}`);
    if (r.shared.length > 0) console.log(`first shared nodes: ${r.shared.slice(0, 10).join(', ')}`);
    expect(r.dupIds.slice(0, 10)).toEqual([]);
    expect(r.shared.slice(0, 10)).toEqual([]);
  });
});

// Fixture (no LTS needed): claim-mode plan, one file with a class and its two methods plus a function.
// The class and the methods are owned by the same file claim; the methods must appear only under the class.
const meta: SnapshotMeta = {
  tool: 'c4pm@0.1.0',
  repoPath: '/test/repo',
  repoName: 'dup-app',
  createdAt: '2026-01-01T00:00:00.000Z',
  git: null,
};
const containers = [{ id: 'app', name: 'App', path: '.', tech: 'TypeScript', manifest: null }];

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

describe('claim-mode fixture: unique ids and single parents (P14-I13 guard)', () => {
  it('a class and its methods give no duplicate ids and no node under two parents', () => {
    const plan: Plan = {
      files: ['a.c4'],
      // app.x holds a function claim only so the plan is claim mode (isClaimModePlan needs a function claim)
      elements: [el('app.c', [{ path: 'src/c.ts', name: null }]), el('app.x', [{ path: 'src/x.ts', name: 'g' }])],
      relations: [],
      issues: [],
    };
    const outlines: FileOutline[] = [{
      file: 'src/c.ts',
      lineCount: 30,
      parseError: false,
      elements: [
        { name: 'C', kind: 'class', startLine: 1, endLine: 20, lineCount: 20 },
        { name: 'C.a', kind: 'method', startLine: 2, endLine: 8, lineCount: 7 },
        { name: 'C.b', kind: 'method', startLine: 10, endLine: 18, lineCount: 9 },
        { name: 'f', kind: 'function', startLine: 22, endLine: 30, lineCount: 9 },
      ],
    }, {
      file: 'src/x.ts',
      lineCount: 5,
      parseError: false,
      elements: [{ name: 'g', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 }],
    }];
    const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
    const m = buildViewModel(buildSnapshot(input, plan), 's', plan);
    const r = checkTree(m.root);
    expect(r.dupIds).toEqual([]);
    expect(r.shared).toEqual([]);
  });
});
