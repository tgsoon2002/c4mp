import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P14-T5b: plan `root_files` (technology 'Unknown') + scanned `_root` fallback are one map box.
const C4_FILE = '../plans/arch.c4';

function c4Text(rootTech: string): string {
  return [
    'model {',
    "  repo_copy = system 'Repo' {",
    `    root_files = container 'Root' {`,
    `      technology '${rootTech}'`,
    "      scripts = component 'Scripts' {",
    '        link ../scripts/run.ts#runAll',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function snapshotFor(plan: Plan, containers: Container[]) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/lts', repoName: 'Lts', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [{ file: 'scripts/run.ts', lineCount: 5, parseError: false, elements: [fn('runAll', 1, 5)] }];
  const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
  return buildSnapshot(input, plan);
}

const ROOT: Container = { id: '_root', name: 'Lts (loose files)', path: '.', tech: 'Unknown', manifest: null } as unknown as Container;
const WEB: Container = { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: 'package.json' };

function containers(m: { root: ViewNode }): ViewNode[] {
  return m.root.children.filter((c) => c.kind === 'container');
}

describe('plan root_files + scanned _root merge (P14-T5b)', () => {
  it('(a) technology Unknown: one container node with the plan id and origin both', () => {
    const plan = planFrom(c4Text('Unknown'));
    const m = buildViewModel(snapshotFor(plan, [ROOT]), 's', plan);
    const cs = containers(m);
    expect(cs.map((c) => c.id)).toEqual(['repo_copy.root_files']);
    expect(cs[0].name).toBe('Root');
    expect(cs[0].origin?.kind).toBe('both');
    expect(m.root.children.some((c) => c.id === '_root')).toBe(false);
  });

  it('(b) technology Node.js: the scanned _root holds no code, so only the plan container is drawn (Phase 34 F1)', () => {
    const plan = planFrom(c4Text('Node.js'));
    const m = buildViewModel(snapshotFor(plan, [ROOT]), 's', plan);
    expect(containers(m).map((c) => c.id).sort()).toEqual(['repo_copy.root_files']);
  });

  it('(c) no scanned _root: plan root_files stays a plan-only node; a scanned container with no code is not drawn (Phase 34 F1)', () => {
    const plan = planFrom(c4Text('Unknown'));
    const m = buildViewModel(snapshotFor(plan, [WEB]), 's', plan);
    expect(containers(m).map((c) => c.id).sort()).toEqual(['repo_copy.root_files']);
    expect(find(m.root, 'repo_copy.root_files')!.origin?.kind).toBe('plan');
  });

  it('(d) components of the plan container still sit under the merged node', () => {
    const plan = planFrom(c4Text('Unknown'));
    const m = buildViewModel(snapshotFor(plan, [ROOT]), 's', plan);
    const merged = find(m.root, 'repo_copy.root_files')!;
    expect(merged.children.map((c) => c.id)).toEqual(['repo_copy.root_files.scripts']);
  });

  it('(e) the Snapshot still contains the container with id _root', () => {
    const plan = planFrom(c4Text('Unknown'));
    const snap = snapshotFor(plan, [ROOT]);
    buildViewModel(snap, 's', plan);
    expect(snap.containers.some((c) => c.id === '_root')).toBe(true);
  });
});

function find(n: ViewNode, id: string): ViewNode | undefined {
  if (n.id === id) return n;
  for (const c of n.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}
