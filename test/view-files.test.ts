import path from 'path';
import { runSnapshot } from '../src/index';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, PlanElement, BuildInput, Container, FileOutline, FileEdge, SnapshotMeta } from '../src/types';

// P13-T2a: ViewModel.files. Fixture mirrors test/view-model-unit.test.ts's T4/T8 claim-mode scenario,
// plus two files: shared-only.ts (all functions shared-auto) and lonely.ts (unclaimed, uncalled).
function el(id: string, links: { path: string; name: string }[], file: string): PlanElement {
  return {
    id,
    kind: 'component',
    title: id,
    description: null,
    technology: null,
    links: links.map((l) => ({ raw: `./${l.path}#${l.name}`, path: l.path, name: l.name, lines: null, title: null })),
    metadata: {},
    parent: null,
    source: { file, line: 1 },
  };
}

function buildPlan(): Plan {
  return {
    files: ['../outside/arch.c4', 'src/auth.c4', 'src/orders.c4'],
    elements: [
      el('app.auth', [{ path: 'src/util.ts', name: 'formatDate' }], 'src/auth.c4'),
      el(
        'app.orders',
        [
          { path: 'src/orders/order.ts', name: 'createOrder' },
          { path: 'src/orders/order.ts', name: 'listOrders' },
        ],
        'src/orders.c4'
      ),
      el('app.payments', [{ path: 'src/orders/order.ts', name: 'cancelOrder' }], 'src/orders.c4'),
    ],
    relations: [],
    issues: [],
  };
}

function buildInput(): BuildInput {
  const meta: SnapshotMeta = {
    tool: 'c4pm@0.1.0',
    repoPath: '/test/repo',
    repoName: 'claim-app',
    createdAt: '2026-01-01T00:00:00.000Z',
    git: null,
  };
  const containers: Container[] = [{ id: 'app', name: 'App', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = (name: string, start: number, end: number) => ({
    name,
    kind: 'function' as const,
    startLine: start,
    endLine: end,
    lineCount: end - start + 1,
  });
  const outlines: FileOutline[] = [
    {
      file: 'src/orders/order.ts',
      lineCount: 20,
      parseError: false,
      elements: [fn('createOrder', 1, 7), fn('listOrders', 8, 14), fn('cancelOrder', 15, 20)],
    },
    { file: 'src/util.ts', lineCount: 10, parseError: false, elements: [fn('formatDate', 1, 5), fn('parseConfig', 6, 10)] },
    { file: 'src/shared-only.ts', lineCount: 5, parseError: false, elements: [fn('helper', 1, 5)] },
    { file: 'src/lonely.ts', lineCount: 5, parseError: false, elements: [fn('orphan', 1, 5)] },
  ];
  const fileEdges: FileEdge[] = [{ from: 'src/orders/order.ts', to: 'src/shared-only.ts' }];
  return { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges };
}

describe('ViewModel.files (P13-T2a)', () => {
  const plan = buildPlan();
  const snapshot = buildSnapshot(buildInput(), plan);
  const model = buildViewModel(snapshot, 'summary', plan);
  const byPath = new Map(model.files.map((f) => [f.path, f]));

  it('claim mode: file split between two components -> flag split, both owners', () => {
    const f = byPath.get('src/orders/order.ts')!;
    expect(f.kind).toBe('source');
    expect(f.flag).toBe('split');
    expect([...f.owners].sort()).toEqual(['app.orders', 'app.payments']);
    expect(new Set(f.owners).size).toBe(f.owners.length);
  });

  it('claim mode: all functions unclaimed and uncalled -> unassigned, no owners', () => {
    expect(byPath.get('src/lonely.ts')).toEqual({ path: 'src/lonely.ts', kind: 'source', owners: [], flag: 'unassigned' });
  });

  it('claim mode: owned by the auto Shared component -> flag shared, owner is the Shared node id', () => {
    const sharedNode = model.root.children.find((n) => n.kind === 'shared')!;
    expect(byPath.get('src/shared-only.ts')).toEqual({
      path: 'src/shared-only.ts',
      kind: 'source',
      owners: [sharedNode.id],
      flag: 'shared',
    });
  });

  it('claim mode: one real owner plus an unassigned function -> single owner, no flag', () => {
    const f = byPath.get('src/util.ts')!;
    expect(f.owners).toEqual(['app.auth']);
    expect(f.flag).toBeUndefined();
  });

  it('plan files listed with kind plan, flag c4, no owners (including ../ paths)', () => {
    for (const p of plan.files) {
      expect(byPath.get(p)).toEqual({ path: p, kind: 'plan', owners: [], flag: 'c4' });
    }
  });

  it('sorted by path and stable across two calls', () => {
    const paths = model.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(buildViewModel(snapshot, 'summary', plan).files).toEqual(model.files);
  });

  it('folder mode: single owner = componentId, no flags on source files', () => {
    const snap = runSnapshot({ repo: path.join(__dirname, 'fixtures/phofast'), write: false, quiet: true });
    const m = buildViewModel(snap, 'summary');
    expect(m.files).toHaveLength(snap.files.length);
    for (const f of m.files) {
      const sf = snap.files.find((s) => s.file === f.path)!;
      expect(f).toEqual({ path: sf.file, kind: 'source', owners: [sf.componentId] });
    }
  });

  it('folder mode with a plan: plan files still listed', () => {
    const snap = runSnapshot({ repo: path.join(__dirname, 'fixtures/phofast'), write: false, quiet: true });
    const noClaims: Plan = { ...plan, elements: [], files: ['arch.c4'] };
    const m = buildViewModel(snap, 'summary', noClaims);
    expect(m.files.find((f) => f.path === 'arch.c4')).toEqual({ path: 'arch.c4', kind: 'plan', owners: [], flag: 'c4' });
  });
});
