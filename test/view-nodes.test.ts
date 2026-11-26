import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode, Component } from '../src/types';

// P13-T2c: ViewNode.meta, claims[].ownedCount, lostClaims, endLine. Real parser + real snapshot builder.
const C4_FILE = 'arch.c4';
const C4_TEXT = [
  'model {',
  "  app = system 'Claim App' {",
  '    metadata {',
  "      status 'live'",
  '    }',
  "    web = container 'Web' {",
  '      metadata {',
  "        owner 'kay'",
  '      }',
  "      auth = component 'Auth' {",
  '        metadata {',
  "          status 'in-progress'",
  "          owner 'jay'",
  "          sprint '4'",
  "          priority 'high'",
  '        }',
  '        link src/util.ts#formatDate',
  '        link src/',
  '      }',
  "      orders = component 'Orders' {",
  '        link src/order.ts#createOrder',
  '        link src/util.ts#formatDate',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const META = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null } as SnapshotMeta;
const CONTAINERS: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
const OUTLINES: FileOutline[] = [
  { file: 'src/util.ts', lineCount: 20, parseError: false, elements: [fn('formatDate', 1, 5), fn('other', 7, 12)] },
  { file: 'src/order.ts', lineCount: 5, parseError: false, elements: [fn('createOrder', 1, 5)] },
];

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function find(n: ViewNode, id: string): ViewNode | undefined {
  if (n.id === id) return n;
  for (const c of n.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}

describe('claim mode node meta / claims / lostClaims (P13-T2c)', () => {
  const plan = planFrom(C4_TEXT);
  const input: BuildInput = { meta: META, containers: CONTAINERS, components: [], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [] };
  const model = buildViewModel(buildSnapshot(input, plan), 's', plan);
  const auth = find(model.root, 'app.web.auth')!;
  const orders = find(model.root, 'app.web.orders')!;

  it('meta: component from Component.meta, container/system from plan metadata, only existing keys', () => {
    expect(auth.meta).toEqual({ status: 'in-progress', owner: 'jay', sprint: '4', priority: 'high' });
    expect(find(model.root, 'web')!.meta).toEqual({ owner: 'kay' });
    expect(model.root.meta).toEqual({ status: 'live' });
    expect(orders.meta).toBeUndefined();   // no metadata block -> no meta key at all
    expect('meta' in orders).toBe(false);
  });

  it('claims carry ownedCount: each owned function counted once, under its most specific claim', () => {
    const counts = (n: ViewNode) => n.claims!.map((c) => [c.kind, c.path, c.fn, c.ownedCount]);
    expect(counts(auth)).toEqual([
      ['function', 'src/util.ts', 'formatDate', 1],   // auth wins formatDate (plan order)
      ['folder', 'src/', null, 1],                    // 'other' only; formatDate already counted above
    ]);
    expect(counts(orders)).toEqual([
      ['function', 'src/order.ts', 'createOrder', 1],
      ['function', 'src/util.ts', 'formatDate', 0],   // lost
    ]);
  });

  it('P14-T38b: claim-mode component detail lists every link path in plan order, not only the first', () => {
    expect(orders.detail).toBe('src/order.ts + src/util.ts');   // 2 links, 2 paths
    expect(auth.detail).toBe('src/util.ts + src/');             // 2 links, incl. folder claim
  });

  it('lostClaims: one entry per conflict the component lost (auth also loses createOrder: its folder claim is less specific)', () => {
    expect(orders.lostClaims).toEqual([{ path: 'src/util.ts', fn: 'formatDate', lostTo: 'app.web.auth' }]);
    expect(auth.lostClaims).toEqual([{ path: 'src/order.ts', fn: 'createOrder', lostTo: 'app.web.orders' }]);
    expect('lostClaims' in find(model.root, 'web')!).toBe(false);   // not a component
  });

  it('P14-T6a: nothing shared and nothing unassigned -> no shared / unassigned node; Files list unchanged', () => {
    expect(model.root.children.filter((c) => c.kind === 'shared' || c.kind === 'unassigned')).toEqual([]);
    expect(find(model.root, 'app::shared')).toBeUndefined();
    expect(model.files.filter((f) => f.kind === 'source').map((f) => f.path)).toEqual(['src/order.ts', 'src/util.ts']);
    for (const f of model.files) expect(f.owners.every((o) => !o.includes('::'))).toBe(true);
  });

  it('P14-T6a/T29b: an owned file with zero functions (folder claim) creates no unassigned node and no shared node; the file is owned', () => {
    const outlines: FileOutline[] = [...OUTLINES, { file: 'src/empty.ts', lineCount: 3, parseError: false, elements: [] }];
    const m = buildViewModel(buildSnapshot({ ...input, outlines }, plan), 's', plan);
    const un = m.root.children.find((c) => c.kind === 'unassigned');
    expect(un).toBeUndefined();
    expect(m.root.children.some((c) => c.kind === 'shared')).toBe(false);
    expect(m.files.find((f) => f.path === 'src/empty.ts')).toMatchObject({ owners: ['app.web.auth'] });
  });

  it('function nodes carry endLine next to line', () => {
    const f = find(model.root, 'src/util.ts#other')!;
    expect(f.line).toBe(7);
    expect(f.endLine).toBe(12);
  });
});

describe('folder mode (P13-T2c)', () => {
  const comp: Component = { id: 'web/_root', name: 'Root files', containerId: 'web', path: '.', files: ['src/util.ts', 'src/order.ts'] };
  const input: BuildInput = { meta: META, containers: CONTAINERS, components: [comp], outlines: OUTLINES, imports: [], componentEdges: [], fileEdges: [] };
  const model = buildViewModel(buildSnapshot(input), 's');
  const json = JSON.stringify(model);

  it('no meta / claims / lostClaims anywhere; tech stays in container detail', () => {
    expect(json).not.toContain('"meta"');
    expect(json).not.toContain('"claims"');
    expect(json).not.toContain('"lostClaims"');
    expect(find(model.root, 'web')!.detail).toBe('Node.js');
  });

  it('endLine is the only addition on function nodes', () => {
    const f = find(model.root, 'src/util.ts#formatDate')!;
    expect(f.endLine).toBe(5);
  });
});
