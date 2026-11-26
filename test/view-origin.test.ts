import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Component, Container, FileOutline, SnapshotMeta, ViewNode } from '../src/types';
import { log } from '../src/log';

// P14-T4a: ViewNode.origin. Real parser output, claim-mode snapshot (fixture shape from view-planblock.test.ts).
const C4_FILE = '../plans/arch.c4';
const C4_TEXT = [
  'model {',                                   // 1
  "  app = system 'Claim App' {",              // 2
  "    web = container 'Web' {",               // 3
  "      auth = component 'Auth' {",           // 4
  '        link ../src/util.ts#formatDate',    // 5
  '      }',                                   // 6
  "      orders = component 'Orders' {",       // 7
  '        link ../src/order.ts#createOrder',  // 8
  '      }',                                   // 9
  '    }',                                     // 10
  "    extra = container 'Extra'",             // 11 (plan only)
  '  }',                                       // 12
  '}',                                         // 13
].join('\n');

function planFrom(text: string, file = C4_FILE): Plan {
  const r = parseC4(text, file);
  return { files: [file],elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function snapshotFor(plan: Plan, containers: Container[], components: Component[] = [], extra = false) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [
    { file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn('formatDate', 1, 5)] },
    { file: 'src/order.ts', lineCount: 5, parseError: false, elements: [fn('createOrder', 1, 5)] },
  ];
  // extra: two unclaimed files; helper.ts is imported by the claimed util.ts (shared), lonely.ts by nobody (unassigned)
  if (extra) {
    outlines.push(
      { file: 'src/helper.ts', lineCount: 5, parseError: false, elements: [fn('help', 1, 5)] },
      { file: 'src/lonely.ts', lineCount: 5, parseError: false, elements: [fn('alone', 1, 5)] },
    );
  }
  const input: BuildInput = {
    meta, containers, outlines, imports: [], components, componentEdges: [],
    fileEdges: extra ? [{ from: 'src/util.ts', to: 'src/helper.ts' }] : [],
  };
  return buildSnapshot(input, plan);
}

function find(n: ViewNode, id: string): ViewNode | undefined {
  if (n.id === id) return n;
  for (const c of n.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}

function collectOrigins(n: ViewNode, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (n.origin) out[n.id] = n.origin;
  n.children.forEach((c) => collectOrigins(c, out));
  return out;
}

const WEB: Container = { id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' };

describe('ViewNode.origin (P14-T4a)', () => {
  it('(a) claim mode: container matched by the plan is "both"', () => {
    const plan = planFrom(C4_TEXT);
    const m = buildViewModel(snapshotFor(plan, [WEB]), 's', plan);
    const web = find(m.root, 'web')!;
    log('view-model', 'origin', { id: web.id, kind: web.origin?.kind });
    expect(web.origin).toEqual({
      kind: 'both', folder: '.', manifest: 'package.json', planFile: C4_FILE, planLine: 3, planEndLine: 10,
    });
  });

  it('(b) plan-only container is "plan"', () => {
    const plan = planFrom(C4_TEXT);
    const m = buildViewModel(snapshotFor(plan, [WEB]), 's', plan);
    const extra = find(m.root, 'app.extra');
    expect(extra).toBeDefined();
    expect(extra!.origin).toMatchObject({ kind: 'plan', planFile: C4_FILE, planLine: 11 });
    expect(extra!.origin!.folder).toBeUndefined();
  });

  it('(c) scanned-only containers with no code are not drawn in claim mode (Phase 34 F1)', () => {
    const plan = planFrom(C4_TEXT);
    const other: Container = { id: 'worker', name: 'Worker', path: 'worker', tech: 'Python', manifest: null };
    const root: Container = { id: '_root', name: 'Root', path: '.', tech: 'Unknown', manifest: null };
    const m = buildViewModel(snapshotFor(plan, [WEB, other, root]), 's', plan);
    expect(find(m.root, 'worker')).toBeUndefined();
    expect(find(m.root, '_root')).toBeUndefined();
  });

  // Rewritten in P14-T44a. Old title: "(d) folder mode: origins are identical with and without a plan".
  // Why: T44a adds plan-only nodes in folder mode (attachPlanOnlyNodes), so their plan-origin entries appear.
  // Measured diff: with the plan = without the plan PLUS exactly app.web.auth, app.web.orders, app.extra
  // (kind 'plan'); no existing origin entry changed.
  it('(d) folder mode: origins with a plan = origins without it plus the plan-only entries (P14-T44a)', () => {
    const folderPlan = planFrom(C4_TEXT.replace(/ {8}link .*\n/g, ''));
    const comp: Component = { id: 'web/src', name: 'Src', containerId: 'web', path: 'src', files: ['src/order.ts', 'src/util.ts'] };
    const snap = snapshotFor(folderPlan, [WEB], [comp]);
    const without = collectOrigins(buildViewModel(snap, 's').root);
    const withPlan = collectOrigins(buildViewModel(snap, 's', folderPlan).root);
    expect(Object.keys(without).length).toBeGreaterThan(0);
    const addedKeys = Object.keys(withPlan).filter((k) => !(k in without));
    expect(addedKeys).toEqual(['app.web.auth', 'app.web.orders', 'app.extra']);
    expect(withPlan).toEqual({ ...without, ...Object.fromEntries(addedKeys.map((k) => [k, withPlan[k]])) });
    for (const k of addedKeys) expect(withPlan[k]).toMatchObject({ kind: 'plan', planFile: C4_FILE });
    expect(Object.keys(withPlan).filter((k) => !addedKeys.includes(k))).toEqual(Object.keys(without));
    expect(JSON.stringify(Object.fromEntries(Object.entries(withPlan).filter(([k]) => k in without))))
      .toBe(JSON.stringify(without));
  });

  it('(e) file / function nodes have no origin (slice / shared / unassigned: P14-T4b)', () => {
    const plan = planFrom(C4_TEXT);
    const m = buildViewModel(snapshotFor(plan, [WEB]), 's', plan);
    const withOrigin = ['system', 'container', 'component', 'slice', 'shared', 'unassigned'];
    const walk = (n: ViewNode): void => {
      if (!withOrigin.includes(n.kind)) expect(n.origin).toBeUndefined();
      n.children.forEach(walk);
    };
    walk(m.root);
  });
});

describe('synthetic and slice origin (P14-T4b)', () => {
  // plan file in c4/ so `link ../src/x.ts` resolves to repo-relative src/x.ts (claims then match the outlines)
  const plan = planFrom(C4_TEXT, 'c4/arch.c4');
  const m = buildViewModel(snapshotFor(plan, [WEB], [], true), 's', plan);
  const sys = m.root.id;

  it('(a) ::shared is synthetic with the "imports it" rule', () => {
    const shared = find(m.root, `${sys}::shared`)!;
    expect(shared.children.length).toBe(1);
    expect(shared.origin!.kind).toBe('synthetic');
    expect(shared.origin!.rule).toContain('imports it');
  });

  it('(b) ::unassigned is synthetic with the "no claimed file imports it" rule', () => {
    const un = find(m.root, `${sys}::unassigned`)!;
    expect(un.children.length).toBe(1);
    expect(un.origin).toEqual({ kind: 'synthetic', rule: 'no claim covers it and no claimed file imports it' });
  });

  it('(c) a slice is scanned and carries the folder of its file', () => {
    const slices: ViewNode[] = [];
    const walk = (n: ViewNode): void => { if (n.kind === 'slice') slices.push(n); n.children.forEach(walk); };
    walk(m.root);
    expect(slices.length).toBeGreaterThan(0);
    for (const s of slices) {
      expect(s.origin).toEqual({ kind: 'scanned', folder: s.file!.slice(0, s.file!.lastIndexOf('/')) });
    }
    expect(slices.some((s) => s.file === 'src/util.ts' && s.origin!.folder === 'src')).toBe(true);
  });
});
