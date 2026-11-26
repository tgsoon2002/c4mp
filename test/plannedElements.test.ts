import * as path from 'path';
import { parsePlan } from '../src/plan/parser';
import { extractPlannedCode, resolvePlannedParent, type ParentCtx, type PlannedCode } from '../src/plan/plannedElements';
import type { Plan, PlanElement, PlanLink } from '../src/types';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures/level4');

function fixturePlan(): Plan {
  return parsePlan(FIXTURE_ROOT, ['c4/plan.c4']);
}

function element(id: string, kind: string, parent: string | null, extra: Partial<PlanElement> = {}): PlanElement {
  return {
    id,
    kind,
    title: id,
    description: null,
    technology: null,
    links: [],
    metadata: {},
    parent,
    source: { file: 'c4/plan.c4', line: 1 },
    ...extra,
  };
}

function planOf(elements: PlanElement[]): Plan {
  return { files: ['c4/plan.c4'], elements, relations: [], issues: [] };
}

describe('extractPlannedCode', () => {
  test('lists exactly the four fixture code elements, sorted by fqn', () => {
    const list = extractPlannedCode(fixturePlan());
    expect(list.map(p => p.element.id)).toEqual([
      'billing.Invoice',
      'billing.build_invoice',
      'billing.plan_fn',
      'reports.stub_fn',
    ]);
  });

  test('reads name, kind, status, signature and the named link from the fixture', () => {
    const byId = new Map(extractPlannedCode(fixturePlan()).map(p => [p.element.id, p]));

    const planFn = byId.get('billing.plan_fn')!;
    expect(planFn.kind).toBe('function');
    expect(planFn.name).toBe('planFn');
    expect(planFn.status).toBe('planned');
    expect(planFn.signature).toBe('planFn(): void');
    expect(planFn.link?.name).toBe('planFn');

    const stub = byId.get('reports.stub_fn')!;
    expect(stub.status).toBe('in-progress');
    expect(stub.link?.name).toBe('stubbed');
  });

  test('element with no status has status undefined', () => {
    const invoice = extractPlannedCode(fixturePlan()).find(p => p.element.id === 'billing.Invoice')!;
    expect(invoice.kind).toBe('type');
    expect(invoice.status).toBeUndefined();
    expect(invoice.signature).toBeUndefined();
  });

  test('parentComponent is the nearest non-code ancestor', () => {
    const byId = new Map(extractPlannedCode(fixturePlan()).map(p => [p.element.id, p]));
    expect(byId.get('billing.plan_fn')!.parentComponent).toBe('billing');
    expect(byId.get('reports.stub_fn')!.parentComponent).toBe('reports');
  });

  test('method nested under a class resolves the component above the class', () => {
    const plan = planOf([
      element('shop', 'component', null),
      element('shop.billing', 'class', 'shop', { title: 'Billing' }),
      element('shop.billing.create', 'method', 'shop.billing', { title: 'create' }),
    ]);
    const list = extractPlannedCode(plan);
    expect(list.map(p => p.element.id)).toEqual(['shop.billing', 'shop.billing.create']);
    expect(list.find(p => p.element.id === 'shop.billing.create')!.parentComponent).toBe('shop');
  });

  test('a plan with no code elements returns []', () => {
    expect(extractPlannedCode(planOf([element('shop', 'component', null)]))).toEqual([]);
  });

  test('output does not depend on input order', () => {
    const plan = fixturePlan();
    const reversed = { ...plan, elements: [...plan.elements].reverse() };
    expect(extractPlannedCode(reversed).map(p => p.element.id))
      .toEqual(extractPlannedCode(plan).map(p => p.element.id));
  });
});

function plannedWith(parentComponent: string, linkPath: string | null): PlannedCode {
  const link: PlanLink | undefined = linkPath === null
    ? undefined
    : { raw: linkPath, path: linkPath, name: 'fn', lines: null, title: null };
  return {
    element: element('x.fn', 'function', parentComponent),
    kind: 'function',
    name: 'fn',
    status: undefined,
    parentComponent,
    ...(link ? { link } : {}),
  };
}

function ctxOf(partial: Partial<ParentCtx> = {}): ParentCtx {
  return {
    nodeIds: new Set(),
    fileNodeIds: new Set(),
    components: [],
    parentLinkPaths: () => [],
    ...partial,
  };
}

describe('resolvePlannedParent', () => {
  test('claim-mode component present as a node: via fqn', () => {
    const byId = new Map(extractPlannedCode(fixturePlan()).map(p => [p.element.id, p]));
    const hit = resolvePlannedParent(byId.get('billing.plan_fn')!, ctxOf({ nodeIds: new Set(['billing']) }));
    expect(hit).toEqual({ parentId: 'billing', via: 'fqn' });
  });

  test('fqn wins over a linked file node', () => {
    const p = plannedWith('billing', 'src/a.ts');
    const hit = resolvePlannedParent(p, ctxOf({ nodeIds: new Set(['billing']), fileNodeIds: new Set(['src/a.ts']) }));
    expect(hit).toEqual({ parentId: 'billing', via: 'fqn' });
  });

  test('folder mode, link to a scanned file: via file', () => {
    const byId = new Map(extractPlannedCode(fixturePlan()).map(p => [p.element.id, p]));
    const stub = byId.get('reports.stub_fn')!;
    const hit = resolvePlannedParent(stub, ctxOf({ fileNodeIds: new Set([stub.link!.path]) }));
    expect(hit).toEqual({ parentId: stub.link!.path, via: 'file' });
  });

  test('folder mode, link to a file not yet scanned inside a scanned folder: via folder', () => {
    const p = plannedWith('shop', 'api/services/new.ts');
    const hit = resolvePlannedParent(p, ctxOf({ components: [{ id: 'shop/services', path: 'api/services' }] }));
    expect(hit).toEqual({ parentId: 'shop/services', via: 'folder' });
  });

  test('link-less element whose parent component links api/services/: via parent-link', () => {
    const p = plannedWith('shop', null);
    const hit = resolvePlannedParent(p, ctxOf({
      components: [{ id: 'shop/services', path: 'api/services' }],
      parentLinkPaths: parent => (parent === 'shop' ? ['api/services/'] : []),
    }));
    expect(hit).toEqual({ parentId: 'shop/services', via: 'parent-link' });
  });

  test('nothing matches: null', () => {
    const p = plannedWith('shop', 'other/x.ts');
    expect(resolvePlannedParent(p, ctxOf({ components: [{ id: 'a', path: 'api/services' }] }))).toBeNull();
  });

  test('prefix boundary: api/services2 does not match api/services', () => {
    const p = plannedWith('shop', 'api/services2/x.ts');
    expect(resolvePlannedParent(p, ctxOf({ components: [{ id: 'a', path: 'api/services' }] }))).toBeNull();
  });

  test('longest prefix wins: api/services over api', () => {
    const p = plannedWith('shop', 'api/services/x.ts');
    const hit = resolvePlannedParent(p, ctxOf({
      components: [{ id: 'api', path: 'api' }, { id: 'api/services', path: 'api/services' }],
    }));
    expect(hit).toEqual({ parentId: 'api/services', via: 'folder' });
  });
});
