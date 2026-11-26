import * as path from 'path';
import { parsePlan } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { layoutView } from '../src/view/layout';
import { BuildInput, CodeElement, Component, Container, Plan, PlanElement, SnapshotMeta, ViewNode } from '../src/types';

// P14-L4-4-i: planned code attaches `planned` and `builtState` to the real scanned node. Fixture: test/fixtures/level4.
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/level4');

function fixturePlan(): Plan {
  return parsePlan(FIXTURE_ROOT, ['c4/plan.c4']);
}

// Folder mode: no component-level #fn link, so isClaimModePlan is false and components come from the input.
function folderPlan(): Plan {
  const plan = fixturePlan();
  return { ...plan, elements: plan.elements.map((el) => (el.kind === 'component' ? { ...el, links: [] } : el)) };
}

const fn = (name: string, kind: CodeElement['kind'] = 'function', stub?: CodeElement['stub']): CodeElement => ({
  name,
  kind,
  startLine: 1,
  endLine: 3,
  lineCount: 3,
  ...(stub ? { stub } : {}),
});

// The fixture declares no container: components with no parent fall back to containers[0] (snapshot/build.ts resolveContainerId).
const SHOP: Container = { id: 'shop', name: 'Shop', path: '.', tech: 'Node.js', manifest: 'package.json' };

function snapshotFor(plan: Plan, components: Component[] = []) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Shop', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const input: BuildInput = {
    meta,
    containers: [SHOP],
    outlines: [
      { file: 'src/built.ts', lineCount: 3, parseError: false, elements: [fn('buildInvoice')] },
      { file: 'src/stub.ts', lineCount: 3, parseError: false, elements: [fn('stubbed', 'function', 'throws')] },
    ],
    imports: [],
    components,
    componentEdges: [],
    fileEdges: [],
  };
  return buildSnapshot(input, plan);
}

function allNodes(root: ViewNode): Map<string, ViewNode> {
  const out = new Map<string, ViewNode>();
  const walk = (n: ViewNode): void => {
    if (!out.has(n.id)) out.set(n.id, n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

const FOLDER_COMPONENT: Component = {
  id: 'src',
  name: 'Src',
  containerId: 'shop',
  path: 'src',
  files: ['src/built.ts', 'src/stub.ts'],
};

describe('planned code on real nodes (P14-L4-4-i)', () => {
  it('claim mode: a built planned function gets planned + builtState "built"', () => {
    const plan = fixturePlan();
    const nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    const built = nodes.get('src/built.ts#buildInvoice')!;
    expect(built).toBeDefined();
    expect(built.planned).toMatchObject({ status: 'done', source: { file: 'c4/plan.c4' } });
    expect(built.builtState).toBe('built');
  });

  it('claim mode: a stub gets builtState "stub"', () => {
    const plan = fixturePlan();
    const nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    const stub = nodes.get('src/stub.ts#stubbed')!;
    expect(stub.planned).toMatchObject({ status: 'in-progress' });
    expect(stub.builtState).toBe('stub');
  });

  it('folder mode: a built planned function gets planned on its real node (the K case)', () => {
    const plan = folderPlan();
    const nodes = allNodes(buildViewModel(snapshotFor(plan, [FOLDER_COMPONENT]), 's', plan).root);
    const built = nodes.get('src/built.ts#buildInvoice')!;
    expect(built.planned).toMatchObject({ status: 'done' });
    expect(built.builtState).toBe('built');
  });

  it('absent planned functions and types get no node under the file#name id (ghosts use the plan fqn, L4-4-ii) and do not throw', () => {
    const plan = fixturePlan();
    const nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    expect(nodes.has('src/planned.ts#planFn')).toBe(false);
    expect(nodes.has('src/types.ts#Invoice')).toBe(false);
  });

  it('a plan with no level-4 elements leaves every node without planned / builtState', () => {
    const plan: Plan = { ...fixturePlan(), elements: fixturePlan().elements.filter((el) => el.kind === 'component') };
    const nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    for (const n of nodes.values()) {
      expect(n.planned).toBeUndefined();
      expect(n.builtState).toBeUndefined();
    }
  });
});

// P14-L4-4-ii: planned code with no scanned node gets a ghost ViewNode (id = plan fqn) under its resolved parent.
function findEl(plan: Plan, title: string): PlanElement {
  const el = plan.elements.find((e) => e.title === title);
  if (!el) throw new Error(`fixture has no element titled ${title}`);
  return el;
}

function parentOf(root: ViewNode, childId: string): ViewNode | undefined {
  for (const n of allNodes(root).values()) {
    if (n.children.some((c) => c.id === childId)) return n;
  }
  return undefined;
}

describe('ghost nodes for planned code (P14-L4-4-ii)', () => {
  it('claim mode: absent planned function and type get ghosts under the component', () => {
    const plan = fixturePlan();
    const root = buildViewModel(snapshotFor(plan), 's', plan).root;
    const nodes = allNodes(root);
    const billing = findEl(plan, 'Billing');
    const planFn = findEl(plan, 'planFn');
    const invoice = findEl(plan, 'Invoice');

    expect(nodes.get(planFn.id)).toMatchObject({
      kind: 'function',
      name: 'planFn',
      detail: 'planned · planFn(): void',
      weight: 1,
      builtState: 'planned',
      callsAvailable: false,
      origin: { kind: 'plan' },
      planned: { status: 'planned' },
    });
    expect(nodes.get(planFn.id)!.file).toBeUndefined();
    expect(parentOf(root, planFn.id)?.id).toBe(billing.id);

    expect(nodes.get(invoice.id)).toMatchObject({ kind: 'type', builtState: 'planned' });
    expect(nodes.get(invoice.id)!.planned).toBeUndefined();   // no status: not annotated (L4-4-i rule)
    expect(parentOf(root, invoice.id)?.id).toBe(billing.id);
  });

  it('claim mode: a built planned function gets no ghost', () => {
    const plan = fixturePlan();
    const nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    expect(nodes.has(findEl(plan, 'buildInvoice').id)).toBe(false);
  });

  it('folder mode: absent function whose link file is scanned gets a ghost under that file node', () => {
    // parent: null so no fqn parent node matches (plan-only components are nodes in folder mode and would win).
    const base = folderPlan();
    const stubEl = findEl(base, 'stubbed');
    const extra: PlanElement = {
      ...stubEl,
      id: 'extra.fn',
      title: 'extra',
      parent: null,
      links: [{ ...stubEl.links[0], path: 'src/built.ts', name: 'extra' }],
      metadata: { status: 'planned' },
    };
    const plan: Plan = { ...base, elements: [...base.elements, extra] };
    const root = buildViewModel(snapshotFor(plan, [FOLDER_COMPONENT]), 's', plan).root;
    expect(allNodes(root).get(extra.id)).toMatchObject({ kind: 'function', builtState: 'planned' });
    expect(parentOf(root, extra.id)?.id).toBe('src/built.ts');
  });

  it('folder mode: absent function whose link file is not scanned gets a ghost under the scanned component', () => {
    const base = folderPlan();
    const stubEl = findEl(base, 'stubbed');
    const extra: PlanElement = {
      ...stubEl,
      id: 'extra.fn',
      title: 'extra',
      parent: null,
      links: [{ ...stubEl.links[0], path: 'src/planned.ts', name: 'extra' }],
      metadata: { status: 'planned' },
    };
    const plan: Plan = { ...base, elements: [...base.elements, extra] };
    const root = buildViewModel(snapshotFor(plan, [FOLDER_COMPONENT]), 's', plan).root;
    expect(allNodes(root).has(extra.id)).toBe(true);
    expect(parentOf(root, extra.id)?.id).toBe('src');
  });

  it('an element with no parent on the map gets no ghost and does not throw', () => {
    const base = fixturePlan();
    const stubEl = findEl(base, 'stubbed');
    const orphan: PlanElement = { ...stubEl, id: 'orphan.fn', title: 'orphan', parent: null, links: [], metadata: { status: 'planned' } };
    const plan: Plan = { ...base, elements: [...base.elements, orphan] };
    let nodes: Map<string, ViewNode> = new Map();
    expect(() => {
      nodes = allNodes(buildViewModel(snapshotFor(plan), 's', plan).root);
    }).not.toThrow();
    expect(nodes.has('orphan.fn')).toBe(false);
  });

  it('layoutView of a model with ghosts does not throw and keeps the ghost', () => {
    const plan = fixturePlan();
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    let laid: ReturnType<typeof layoutView> | undefined;
    expect(() => {
      laid = layoutView(model);
    }).not.toThrow();
    expect(allNodes(laid!.root).has(findEl(plan, 'planFn').id)).toBe(true);
  });
});

describe('component origin both (P14-L4-9a)', () => {
  it('claim mode: a claim component that owns scanned files has origin both', () => {
    const plan = fixturePlan();
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    const billing = allNodes(model.root).get('billing')!;
    const comp = snapshotFor(plan).components.find((c) => c.id === 'billing')!;
    expect(billing.origin).toMatchObject({ kind: 'both', folder: comp.path });
    expect(billing.origin?.planFile).toBeDefined();
    expect(billing.origin?.planLine).toBeDefined();
  });

  it('claim mode: a claim component with no scanned files keeps origin plan', () => {
    const base = fixturePlan();
    const ghost: PlanElement = {
      ...base.elements.find((e) => e.id === 'billing')!,
      id: 'ghostcomp',
      title: 'Ghost',
      parent: null,
      links: [{ raw: '../src/none.ts#ghostFn', path: 'src/none.ts', name: 'ghostFn', lines: null, title: null }],
      metadata: {},
    };
    const plan: Plan = { ...base, elements: [...base.elements, ghost] };
    const snap = snapshotFor(plan);
    expect(snap.components.find((c) => c.id === 'ghostcomp')!.files).toEqual([]);
    const node = allNodes(buildViewModel(snap, 's', plan).root).get('ghostcomp')!;
    expect(node.origin?.kind).toBe('plan');
    expect(node.origin?.planFile).toBeDefined();
  });

  it('folder mode with no plan: a scanned component keeps origin scanned', () => {
    const plan = folderPlan();
    const model = buildViewModel(snapshotFor(plan, [FOLDER_COMPONENT]), 's', undefined);
    expect(allNodes(model.root).get('src')?.origin).toEqual({ kind: 'scanned', folder: 'src' });
  });
});
