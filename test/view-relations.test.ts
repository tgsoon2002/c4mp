import { buildViewModel, PLAN_FILE_MAX_LINES, PLAN_FILES_MAX_TOTAL } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import {
  Plan, PlanElement, PlanRelation, BuildInput, Container, FileOutline, FileEdge, SnapshotMeta, ViewNode,
} from '../src/types';

// P13-T2d: ViewModel.relations, ViewNode.usedBy (shared children), ViewFile.lines/truncated.
// Same claim-mode scenario as view-model-unit.test.ts: order.ts -> payments.ts makes refundPayment shared.
const el = (id: string, links: [string, string | null][], file: string): PlanElement => ({
  id, kind: 'component', title: id, description: null, technology: null,
  links: links.map(([p, name]) => ({ raw: p, path: p, name, lines: null, title: null })),
  metadata: {}, parent: null, source: { file, line: 1 },
});
const rel = (from: string, to: string, label: string | null, line = 3): PlanRelation =>
  ({ from, to, label, source: { file: 'src/a.c4', line } });

function plan(relations: PlanRelation[], files = ['src/a.c4']): Plan {
  return {
    files,
    elements: [
      el('app.orders', [['src/order.ts', 'createOrder']], 'src/a.c4'),
      el('app.payments', [['src/payments.ts', 'createPayment']], 'src/a.c4'),
    ],
    relations,
    issues: [],
  };
}

function snapshotFor(p: Plan) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'r', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'app', name: 'App', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [
    { file: 'src/order.ts', lineCount: 7, parseError: false, elements: [fn('createOrder', 1, 7)] },
    { file: 'src/payments.ts', lineCount: 20, parseError: false, elements: [fn('createPayment', 1, 10), fn('refundPayment', 11, 20)] },
  ];
  const fileEdges: FileEdge[] = [{ from: 'src/order.ts', to: 'src/payments.ts' }];
  const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges };
  return buildSnapshot(input, p);
}

describe('ViewModel.relations (P13-T2d)', () => {
  it('keeps resolvable relations in file order with label/file/line; drops unresolved', () => {
    const p = plan([
      rel('app.orders', 'app.payments', 'pays', 4),
      rel('app.orders', 'app.ghost', 'x', 5),
      rel('payments', 'app.orders', null, 6), // localId(payments) is not a node id -> dropped
    ]);
    const m = buildViewModel(snapshotFor(p), 's', p);
    expect(m.relations).toEqual([{ from: 'app.orders', to: 'app.payments', label: 'pays', file: 'src/a.c4', line: 4 }]);
  });

  it('a plan-only container (synthesized claim-mode node, keyed by fqn) is a valid endpoint', () => {
    const p = plan([rel('app.web', 'app.payments', null)]);
    p.elements.push({ ...el('app.web', [], 'src/a.c4'), kind: 'container' });
    const m = buildViewModel(snapshotFor(p), 's', p);
    expect(m.relations).toEqual([{ from: 'app.web', to: 'app.payments', label: null, file: 'src/a.c4', line: 3 }]);
  });

  it('is absent without a plan (folder mode unchanged) and [] for a plan with no relations', () => {
    const p = plan([]);
    expect(buildViewModel(snapshotFor(p), 's').relations).toBeUndefined();
    expect(JSON.stringify(buildViewModel(snapshotFor(p), 's'))).not.toContain('relations');
    expect(buildViewModel(snapshotFor(p), 's', p).relations).toEqual([]);
  });

  it('does not change edges (finalizeEdges untouched)', () => {
    const p = plan([rel('app.orders', 'app.payments', 'pays')]);
    const m = buildViewModel(snapshotFor(p), 's', p);
    expect(m.edges.find((e) => e.from === 'app.orders' && e.to === 'app.payments')).toBeDefined();
  });
});

describe('ViewNode.usedBy (P13-T2d)', () => {
  const find = (n: ViewNode, pred: (x: ViewNode) => boolean): ViewNode[] =>
    [...(pred(n) ? [n] : []), ...n.children.flatMap((c) => find(c, pred))];

  it('shared children carry the components that use them; other nodes do not', () => {
    const p = plan([]);
    const m = buildViewModel(snapshotFor(p), 's', p);
    const shared = m.root.children.find((c) => c.kind === 'shared')!;
    expect(shared.children.map((c) => c.id)).toEqual(['src/payments.ts#refundPayment']);
    expect(shared.children[0].usedBy).toEqual(['app.orders']);
    const withUsedBy = find(m.root, (n) => n.usedBy !== undefined);
    // the shared function node is reused under its file node, so it may appear there too; nothing else has it
    expect(withUsedBy.every((n) => n.id === 'src/payments.ts#refundPayment')).toBe(true);
  });

  it('folder mode: no usedBy anywhere', () => {
    const p = plan([]);
    expect(JSON.stringify(buildViewModel(snapshotFor(p), 's').root)).not.toContain('usedBy');
  });
});

describe('ViewFile.lines / truncated (P13-T2d, Decision 11)', () => {
  const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);

  it('embeds the text (trailing newline is not a line); source files get none', () => {
    const p = plan([]);
    const m = buildViewModel(snapshotFor(p), 's', p, new Map([['src/a.c4', 'one\ntwo\n']]));
    const c4 = m.files!.find((f) => f.kind === 'plan')!;
    expect(c4.lines).toEqual(['one', 'two']);
    expect(c4.truncated).toBeUndefined();
    expect(m.files!.filter((f) => f.kind === 'source').every((f) => f.lines === undefined)).toBe(true);
  });

  it('no planTexts or file not in the map: no lines', () => {
    const p = plan([]);
    expect(buildViewModel(snapshotFor(p), 's', p).files!.find((f) => f.kind === 'plan')!.lines).toBeUndefined();
    expect(buildViewModel(snapshotFor(p), 's', p, new Map()).files!.find((f) => f.kind === 'plan')!.lines).toBeUndefined();
  });

  it('caps each file at 400 lines and reports truncated', () => {
    const p = plan([]);
    const m = buildViewModel(snapshotFor(p), 's', p, new Map([['src/a.c4', lines(450).join('\n')]]));
    const f = m.files!.find((x) => x.kind === 'plan')!;
    expect(f.lines).toHaveLength(PLAN_FILE_MAX_LINES);
    expect(f.truncated).toBe(50);
  });

  it('caps the total at 2000 across plan files in path order; later files get what is left', () => {
    const paths = ['src/a.c4', 'src/b.c4', 'src/c.c4', 'src/d.c4', 'src/e.c4', 'src/f.c4'];
    const p = plan([], paths);
    const texts = new Map(paths.map((x) => [x, lines(400).join('\n')] as [string, string]));
    const m = buildViewModel(snapshotFor(p), 's', p, texts);
    const plans = m.files!.filter((f) => f.kind === 'plan');
    expect(plans.map((f) => f.path)).toEqual(paths);
    expect(plans.slice(0, 5).every((f) => f.lines!.length === 400 && f.truncated === undefined)).toBe(true);
    expect(plans.reduce((s, f) => s + f.lines!.length, 0)).toBe(PLAN_FILES_MAX_TOTAL);
    expect(plans[5].lines).toEqual([]);
    expect(plans[5].truncated).toBe(400);
  });
});
