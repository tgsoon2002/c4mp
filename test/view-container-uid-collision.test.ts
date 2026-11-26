import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { mapNodeToElement } from '../src/c4/applyLayout';
import type { Plan, BuildInput, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// b27: the system fqn equals the container's scan id ('files-demo'), so a node id lookup matches the system first.
const SYSTEM_UID = '2035e9a9-0000-4000-8000-000000000001';
const CONTAINER_UID = '272fa911-0000-4000-8000-000000000002';
const C4_TEXT = [
  'model {',
  "  files-demo = system 'Files Demo' {",
  '    metadata {',
  `      uid '${SYSTEM_UID}'`,
  "      status 'live'",
  '    }',
  "    files-demo = container 'Files Demo' {",
  '      metadata {',
  `        uid '${CONTAINER_UID}'`,
  "        status 'wip'",
  '      }',
  "      core = component 'Core' {",
  '        link src/util.ts#formatDate',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const OUTLINES: FileOutline[] = [
  { file: 'src/util.ts', lineCount: 10, parseError: false, elements: [{ name: 'formatDate', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 }] },
];
const meta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'files-demo', createdAt: '2026-01-01T00:00:00.000Z', git: null } as SnapshotMeta;

function findKind(n: ViewNode, kind: string): ViewNode | undefined {
  if (n.kind === kind) return n;
  for (const c of n.children) {
    const f = findKind(c, kind);
    if (f) return f;
  }
  return undefined;
}

describe('container node keeps its own plan element when the system shares its id (b27)', () => {
  const r = parseC4(C4_TEXT, 'arch.c4');
  const plan: Plan = { files: ['arch.c4'], elements: r.elements, relations: r.relations, issues: r.issues };

  it('mapNodeToElement with a kind picks the element of that kind', () => {
    const idOf = (kind?: string) => {
      const m = mapNodeToElement(plan, 'files-demo', kind);
      return 'element' in m ? m.element.id : m.reason;
    };
    expect(idOf('system')).toBe('files-demo');
    expect(idOf('container')).toBe('files-demo.files-demo');
    expect(idOf()).toBe('files-demo'); // no kind: unchanged
  });

  it('claim-mode view model: container and system get their own uid and meta', () => {
    const input: BuildInput = {
      meta,
      containers: [{ id: 'files-demo', name: 'files-demo', path: '.', tech: 'Node.js', manifest: 'package.json' }],
      components: [], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [],
    };
    const model = buildViewModel(buildSnapshot(input, plan), 's', plan);
    const sys = findKind(model.root, 'system')!;
    const con = findKind(model.root, 'container')!;
    expect(sys.uid).toBe(SYSTEM_UID);
    expect(con.uid).toBe(CONTAINER_UID);
    expect(con.uid).not.toBe(sys.uid);
    expect(con.meta?.status).toBe('wip');
    expect(sys.meta?.status).toBe('live');
  });
});
