import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P16-B10: the `tags` metadata key (raw comma separated string) reaches Component.meta (snapshot/build.ts)
// and ViewNode.meta (view/model.ts pickMeta). Two copies of the key list exist; this test pins both.
const C4_FILE = '../plans/arch.c4';

function c4Text(tags: string | null): string {
  return [
    'model {',
    "  app = system 'Claim App' {",
    "    web = container 'Web' {",
    "      auth = component 'Auth' {",
    ...(tags === null ? [] : ['        metadata {', `          tags '${tags}'`, "          status 'planned'", '        }']),
    '        link ../src/util.ts#formatDate',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function build(tags: string | null) {
  const r = parseC4(c4Text(tags), C4_FILE);
  const plan: Plan = { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = { name: 'formatDate', kind: 'function' as const, startLine: 1, endLine: 5, lineCount: 5 };
  const outlines: FileOutline[] = [{ file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn] }];
  const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
  const snap = buildSnapshot(input, plan);
  return { snap, model: buildViewModel(snap, 's', plan) };
}

const find = (n: ViewNode, id: string): ViewNode | undefined =>
  n.id === id ? n : n.children.map((c) => find(c, id)).find((x) => x !== undefined);

describe('tags metadata key (P16-B10)', () => {
  it('reaches Component.meta and ViewNode.meta as the raw string', () => {
    const { snap, model } = build('a, b');
    const comp = snap.components.find((c) => c.id === 'app.web.auth');
    expect(comp?.meta?.tags).toBe('a, b');
    expect(find(model.root, 'app.web.auth')?.meta?.tags).toBe('a, b');
  });

  it('is absent without the key', () => {
    const { snap, model } = build(null);
    const comp = snap.components.find((c) => c.id === 'app.web.auth');
    expect(comp?.meta && 'tags' in comp.meta).toBeFalsy();
    const node = find(model.root, 'app.web.auth');
    expect(node?.meta && 'tags' in node.meta).toBeFalsy();
  });
});
