import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { SYSTEM_ID_QUALIFIER } from '../src/names';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode, ViewModel, Component } from '../src/types';
import { log } from '../src/log';

// P13-BUG-id-collision: node ids are unique across the whole tree even when the system id
// (toId(repoName)) equals a container id. Real parser + real snapshot builder.
const C4_TEXT = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'API' {",
  "      one = component 'One' {",
  '        link src/util.ts#formatDate',
  '      }',
  "      two = component 'Two' {",
  '        link src/order.ts#createOrder',
  '        link src/util.ts#other',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
const OUTLINES: FileOutline[] = [
  { file: 'src/util.ts', lineCount: 20, parseError: false, elements: [fn('formatDate', 1, 5), fn('other', 7, 12)] },
  { file: 'src/order.ts', lineCount: 5, parseError: false, elements: [fn('createOrder', 1, 5)] },
];
const meta = (repoName: string) =>
  ({ tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName, createdAt: '2026-01-01T00:00:00.000Z', git: null }) as SnapshotMeta;
const container = (id: string): Container[] => [{ id, name: id, path: '.', tech: 'Node.js', manifest: 'package.json' }];

function planFrom(text: string): Plan {
  const r = parseC4(text, 'arch.c4');
  return { files: ['arch.c4'], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function allIds(n: ViewNode, out: string[] = []): string[] {
  out.push(n.id);
  n.children.forEach((c) => allIds(c, out));
  return out;
}

function claimModel(repoName: string, containerId: string): ViewModel {
  // Phase 34 F1: the scanned container must hold code to be drawn, so the plan container carries its id (they are one box).
  const plan = planFrom(C4_TEXT.replace("api = container 'API'", `${containerId} = container 'API'`));
  const input: BuildInput = { meta: meta(repoName), containers: container(containerId), components: [], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [] };
  return buildViewModel(buildSnapshot(input, plan), 's', plan);
}

function folderModel(repoName: string, containerId: string): ViewModel {
  const comp: Component = { id: `${containerId}/_root`, name: 'Root files', containerId, path: '.', files: ['src/util.ts', 'src/order.ts'] };
  const input: BuildInput = { meta: meta(repoName), containers: container(containerId), components: [comp], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [] };
  return buildViewModel(buildSnapshot(input), 's');
}

describe('whole-tree id uniqueness (P13-BUG-id-collision)', () => {
  for (const [label, build] of [['claim', claimModel], ['folder', folderModel]] as const) {
    describe(`${label} mode`, () => {
      const colliding = build('files-demo', 'files-demo');
      const clean = build('Repo Name', 'files-demo');

      it('colliding repo: every id in the tree is unique; only the system id is qualified', () => {
        const ids = allIds(colliding.root);
        log('test', `${label} colliding ids`, ids);
        expect(new Set(ids).size).toBe(ids.length);
        expect(colliding.root.kind).toBe('system');
        expect(colliding.root.id).toBe('files-demo' + SYSTEM_ID_QUALIFIER);
        expect(colliding.root.children.filter((c) => c.kind === 'container').map((c) => c.id)).toContain('files-demo');
      });

      it('non-colliding repo: ids unchanged (system id is toId(repoName), no qualifier)', () => {
        const ids = allIds(clean.root);
        expect(new Set(ids).size).toBe(ids.length);
        expect(clean.root.id).toBe('repo-name');
      });

      it('every id except the system id is byte-identical between colliding and non-colliding builds', () => {
        // shared/unassigned ids are `${systemId}::...` with the bare system id, so compare after renaming the prefix
        const renamed = allIds(clean.root).slice(1).map((id) => id.replace(/^repo-name::/, 'files-demo::'));
        expect(allIds(colliding.root).slice(1)).toEqual(renamed);
      });

      it('edges and relations still reference ids that exist in the tree', () => {
        const ids = new Set(allIds(colliding.root));
        for (const e of colliding.edges) {
          expect(ids.has(e.from)).toBe(true);
          expect(ids.has(e.to)).toBe(true);
        }
        for (const r of colliding.relations ?? []) {
          expect(ids.has(r.from)).toBe(true);
          expect(ids.has(r.to)).toBe(true);
        }
        expect(colliding.edges).toEqual(clean.edges);
        expect(colliding.relations).toEqual(clean.relations);
        expect(colliding.files.map((f) => f.owners)).toEqual(clean.files.map((f) => f.owners));
      });
    });
  }

  it('claim mode: a qualified system still maps to its plan element by the bare id (meta)', () => {
    const text = C4_TEXT.replace("api = container 'API'", "files-demo = container 'API'").replace("app = system 'App' {", "app = system 'Files Demo' {\n    metadata {\n      status 'live'\n    }");
    const plan = planFrom(text);
    const input: BuildInput = { meta: meta('files-demo'), containers: container('files-demo'), components: [], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [] };
    const model = buildViewModel(buildSnapshot(input, plan), 's', plan);
    expect(model.root.id).toBe('files-demo' + SYSTEM_ID_QUALIFIER);
    expect(model.root.meta).toEqual({ status: 'live' });
  });
});
