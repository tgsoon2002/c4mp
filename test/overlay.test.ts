import * as path from 'path';
import type { ViewNode, ViewModel, CodeElement, Plan, PlanElement, BuildInput, Container, FileOutline, FileEdge, SnapshotMeta } from '../src/types';
import { runSnapshot, compareSnapshots } from '../src';
import { parsePlan, listC4Files, checkPlan } from '../src';
import { applyDrift, applyFindings } from '../src/view/overlay';
import { buildSnapshot } from '../src/snapshot/build';
import { buildViewModel } from '../src/view/model';

const SAMPLE_FIXTURE = path.join(__dirname, 'fixtures/sample');
const SAMPLE_V2_FIXTURE = path.join(__dirname, 'fixtures/sample-v2');
const PHOFAST_FIXTURE = path.join(__dirname, 'fixtures/phofast');

// Same T4/T8/T9 claim-mode fixture shape as test/ownership.test.ts, test/check.test.ts, and
// test/view-model-unit.test.ts's "T4/T8 fixture scenario end-to-end" block (reused verbatim here,
// not reinvented): 3 files, 3 claim-mode components, producing 4 component-claim-conflict findings
// (all with fn !== null), 1 split-file, 1 shared-auto, 1 unassigned-code.
function buildClaimPlan(): Plan {
  const elements: PlanElement[] = [
    {
      id: 'app.auth',
      kind: 'component',
      title: 'Auth',
      description: null,
      technology: null,
      links: [
        { raw: './orders/', path: 'src/orders/', name: null, lines: null, title: null },
        { raw: './util.ts#formatDate', path: 'src/util.ts', name: 'formatDate', lines: null, title: null },
      ],
      metadata: {},
      parent: null,
      source: { file: 'src/auth.c4', line: 1 },
    },
    {
      id: 'app.orders',
      kind: 'component',
      title: 'Orders',
      description: null,
      technology: null,
      links: [
        { raw: './orders/order.ts#createOrder', path: 'src/orders/order.ts', name: 'createOrder', lines: null, title: null },
        { raw: './orders/order.ts#listOrders', path: 'src/orders/order.ts', name: 'listOrders', lines: null, title: null },
      ],
      metadata: {},
      parent: null,
      source: { file: 'src/orders.c4', line: 1 },
    },
    {
      id: 'app.payments',
      kind: 'component',
      title: 'Payments',
      description: null,
      technology: null,
      links: [
        { raw: './payments.ts#createPayment', path: 'src/payments.ts', name: 'createPayment', lines: null, title: null },
        { raw: './util.ts#formatDate', path: 'src/util.ts', name: 'formatDate', lines: null, title: null },
        { raw: './orders/order.ts#cancelOrder', path: 'src/orders/order.ts', name: 'cancelOrder', lines: null, title: null },
      ],
      metadata: {},
      parent: null,
      source: { file: 'src/payments.c4', line: 1 },
    },
  ];
  return { files: ['src/auth.c4', 'src/orders.c4', 'src/payments.c4'], elements, relations: [], issues: [] };
}

function buildClaimBuildInput(): BuildInput {
  const meta: SnapshotMeta = {
    tool: 'c4pm@0.1.0',
    repoPath: '/test/repo',
    repoName: 'claim-app',
    createdAt: '2026-01-01T00:00:00.000Z',
    git: null,
  };
  const containers: Container[] = [
    { id: 'app', name: 'App', path: '.', tech: 'Node.js', manifest: 'package.json' },
  ];
  const outlines: FileOutline[] = [
    {
      file: 'src/orders/order.ts',
      lineCount: 20,
      parseError: false,
      elements: [
        { name: 'createOrder', kind: 'function', startLine: 1, endLine: 7, lineCount: 7 },
        { name: 'listOrders', kind: 'function', startLine: 8, endLine: 14, lineCount: 7 },
        { name: 'cancelOrder', kind: 'function', startLine: 15, endLine: 20, lineCount: 6 },
      ],
    },
    {
      file: 'src/payments.ts',
      lineCount: 20,
      parseError: false,
      elements: [
        { name: 'createPayment', kind: 'function', startLine: 1, endLine: 10, lineCount: 10 },
        { name: 'refundPayment', kind: 'function', startLine: 11, endLine: 20, lineCount: 10 },
      ],
    },
    {
      file: 'src/util.ts',
      lineCount: 10,
      parseError: false,
      elements: [
        { name: 'formatDate', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 },
        { name: 'parseConfig', kind: 'function', startLine: 6, endLine: 10, lineCount: 5 },
      ],
    },
  ];
  const fileEdges: FileEdge[] = [{ from: 'src/orders/order.ts', to: 'src/payments.ts' }];
  return { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges };
}

// Walk a ViewModel tree and find the node with the given id, or undefined.
function findNodeById(root: ViewNode, id: string): ViewNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Helper to build a ViewModel tree from a Snapshot.
 * Mirrors P5-T2: system → containers → components → files → elements.
 * Used for testing overlay functions with real data.
 */
function buildViewModelFromSnapshot(snapshot: any): ViewModel {
  const { system, containers, components, files, componentEdges, meta } = snapshot;
  let currentFile = '';

  // Helper to compute weight of elements (sum of children or 1)
  function computeWeight(elements: CodeElement[]): number {
    if (elements.length === 0) return 0;
    return elements.reduce((sum, el) => sum + el.lineCount, 0);
  }

  // Build element nodes
  function buildElementNodes(elements: CodeElement[]): ViewNode[] {
    return elements.map(el => ({
      id: `${currentFile}#${el.name}`,
      kind: el.kind,
      name: el.name.split('.').pop() || el.name,
      detail: `${el.kind} · ${el.lineCount} lines${el.stub ? ` · stub: ${el.stub}` : ''}`,
      weight: el.lineCount,
      children: [],
      x: 0, y: 0, w: 0, h: 0,
      file: currentFile,
      line: el.startLine,
      stub: el.stub,
      callsAvailable: false,
    }));
  }

  // Build file nodes
  function buildFileNodes(files: any[], componentId: string): ViewNode[] {
    const result: ViewNode[] = [];
    for (const f of files) {
      if (f.componentId !== componentId) continue;

      currentFile = f.file;
      const elements = f.elements || [];

      // Group elements by class
      const elementsByClass = new Map<string, CodeElement[]>();
      const topLevelElements: CodeElement[] = [];

      for (const el of elements) {
        if (el.kind === 'method' && el.name.includes('.')) {
          const className = el.name.split('.')[0];
          if (!elementsByClass.has(className)) {
            elementsByClass.set(className, []);
          }
          elementsByClass.get(className)!.push(el);
        } else if (el.kind === 'method') {
          // Skip methods not bound to a class
          continue;
        } else {
          topLevelElements.push(el);
        }
      }

      // Build class nodes with method children
      const elementNodes: ViewNode[] = [];
      for (const el of topLevelElements) {
        if (el.kind === 'class') {
          const methods = elementsByClass.get(el.name) || [];
          const methodNodes = methods.map(m => ({
            id: `${f.file}#${m.name}`,
            kind: 'method' as const,
            name: m.name.split('.').pop() || m.name,
            detail: `method · ${m.lineCount} lines${m.stub ? ` · stub: ${m.stub}` : ''}`,
            weight: m.lineCount,
            children: [],
            x: 0, y: 0, w: 0, h: 0,
            file: f.file,
            line: m.startLine,
            stub: m.stub,
            callsAvailable: false,
          }));

          elementNodes.push({
            id: `${f.file}#${el.name}`,
            kind: 'class',
            name: el.name,
            detail: `class · ${el.lineCount} lines`,
            weight: el.lineCount,
            children: methodNodes.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)),
            x: 0, y: 0, w: 0, h: 0,
            file: f.file,
            line: el.startLine,
            callsAvailable: false,
          });
        } else if (el.kind === 'function') {
          elementNodes.push({
            id: `${f.file}#${el.name}`,
            kind: 'function',
            name: el.name,
            detail: `function · ${el.lineCount} lines${el.stub ? ` · stub: ${el.stub}` : ''}`,
            weight: el.lineCount,
            children: [],
            x: 0, y: 0, w: 0, h: 0,
            file: f.file,
            line: el.startLine,
            stub: el.stub,
            callsAvailable: false,
          });
        }
      }

      const children = elementNodes.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

      result.push({
        id: f.file,
        kind: 'file',
        name: path.basename(f.file),
        detail: `${f.lineCount} lines`,
        weight: f.lineCount || 1,
        children,
        x: 0, y: 0, w: 0, h: 0,
        file: f.file,
        callsAvailable: false,
      });
    }

    return result.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  }

  // Build component nodes
  function buildComponentNodes(components: any[], containerId: string): ViewNode[] {
    const result: ViewNode[] = [];
    for (const comp of components) {
      if (comp.containerId !== containerId) continue;

      const files = buildFileNodes(snapshot.files, comp.id);
      const weight = files.length > 0 ? files.reduce((sum, f) => sum + f.weight, 0) : 1;

      result.push({
        id: comp.id,
        kind: 'component',
        name: comp.name,
        detail: comp.path,
        weight,
        children: files,
        x: 0, y: 0, w: 0, h: 0,
        callsAvailable: false,
      });
    }

    return result.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  }

  // Build container nodes
  const containerNodes: ViewNode[] = [];
  for (const container of containers) {
    const components = buildComponentNodes(snapshot.components, container.id);
    const weight = components.length > 0 ? components.reduce((sum, c) => sum + c.weight, 0) : 1;

    containerNodes.push({
      id: container.id,
      kind: 'container',
      name: container.name,
      detail: container.tech,
      weight,
      children: components,
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false,
    });
  }

  const containerNodes_sorted = containerNodes.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const systemWeight = containerNodes_sorted.reduce((sum, c) => sum + c.weight, 0) || 1;

  // Build subtitle
  const date = (meta.git?.date ?? meta.createdAt).slice(0, 10);
  const commit = meta.git?.commit ? meta.git.commit.slice(0, 7) : 'no-git';
  const subtitle = `${commit} · ${date}`;

  // Return ViewModel
  return {
    schemaVersion: 1,
    title: system.name,
    subtitle,
    summary: '',
    repoPath: meta.repoPath,
    root: {
      id: 'system',
      kind: 'system',
      name: system.name,
      detail: '',
      weight: systemWeight,
      children: containerNodes_sorted,
      x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false,
    },
    edges: componentEdges,
    drift: null,
    planFindings: [],
    files: [],
  };
}

describe('overlay', () => {
  describe('applyDrift', () => {
    it('applies drift marks from sample → sample-v2', () => {
      const v1 = runSnapshot({ repo: SAMPLE_FIXTURE, write: false, quiet: true });
      const v2 = runSnapshot({ repo: SAMPLE_V2_FIXTURE, write: false, quiet: true });
      const diff = compareSnapshots(v1, v2);

      const model = buildViewModelFromSnapshot(v2);
      applyDrift(model, diff, 'sample');

      // Verify drift object exists
      expect(model.drift).not.toBeNull();
      expect(model.drift!.from).toBe('sample');
      expect(model.drift!.summary).toMatch(/components.*files.*functions/);

      // Helper to find node by id
      function findNode(id: string): ViewNode | undefined {
        function search(node: ViewNode): ViewNode | undefined {
          if (node.id === id) return node;
          for (const child of node.children) {
            const result = search(child);
            if (result) return result;
          }
        }
        return search(model.root);
      }

      // Test component drifts
      const apiServices = findNode('api/services');
      expect(apiServices?.drift).toBe('grew');

      const apiPayments = findNode('api/payments');
      expect(apiPayments?.drift).toBe('added');

      const apiUtils = findNode('api/utils');
      expect(apiUtils?.drift).toBe('renamed');

      const apiRoutes = findNode('api/routes');
      expect(apiRoutes?.drift).toBe('changed');

      const webRoot = findNode('web/_root');
      expect(webRoot?.drift).toBe('changed');

      // Test file drifts
      const orderServiceFile = findNode('api/src/services/orderService.ts');
      expect(orderServiceFile?.drift).toBe('grew');

      const stripeFile = findNode('api/src/payments/stripe.ts');
      expect(stripeFile?.drift).toBe('added');

      const logUtilFile = findNode('api/src/utils/log.ts');
      expect(logUtilFile?.drift).toBe('renamed');

      // Test element drifts
      const chargeElement = findNode('api/src/payments/stripe.ts#charge');
      expect(chargeElement?.drift).toBe('added');

      const bulkCreateElement = findNode('api/src/services/orderService.ts#OrderService.bulkCreate');
      expect(bulkCreateElement?.drift).toBe('added');

      const registerElement = findNode('api/src/services/orderService.ts#OrderService.register');
      expect(registerElement?.drift).toBe('added');

      const ordersElement = findNode('api/src/routes/orders.ts#orderRoutes');
      expect(ordersElement?.drift).toBe('changed');

      const orderServiceElement = findNode('api/src/services/orderService.ts#OrderService');
      expect(orderServiceElement?.drift).toBe('changed');

      // Test removed items
      expect(model.drift!.removed).toEqual([
        { kind: 'component', id: 'web/components', lines: 14 },
        { kind: 'file', id: 'web/src/components/Cart.jsx', lines: 14 },
        { kind: 'element', id: 'web/src/components/Cart.jsx#Cart', lines: 3 },
        { kind: 'element', id: 'web/src/components/Cart.jsx#loadApp', lines: 4 },
      ]);
    });
  });

  describe('applyFindings', () => {
    it('places file findings on file nodes and others on planFindings', () => {
      const snapshot = runSnapshot({ repo: PHOFAST_FIXTURE, write: false, quiet: true });
      const c4Files = listC4Files(PHOFAST_FIXTURE);
      const plan = parsePlan(PHOFAST_FIXTURE, c4Files);
      const findings = checkPlan(plan, snapshot, PHOFAST_FIXTURE, { sprint: 'S15' });

      const model = buildViewModelFromSnapshot(snapshot);
      applyFindings(model, findings);

      // Helper to find node by id
      function findNode(id: string): ViewNode | undefined {
        function search(node: ViewNode): ViewNode | undefined {
          if (node.id === id) return node;
          for (const child of node.children) {
            const result = search(child);
            if (result) return result;
          }
        }
        return search(model.root);
      }

      // Test file findings
      const pointsFile = findNode('src/api/loyalty/points.ts');
      expect(pointsFile?.findings).toBeDefined();
      expect(pointsFile?.findings?.length).toBe(1);
      expect(pointsFile?.findings?.[0].rule).toBe('unplanned-code');
      expect(pointsFile?.findings?.[0].severity).toBe('critical');

      const dashboardFile = findNode('src/web/admin/Dashboard.tsx');
      expect(dashboardFile?.findings).toBeDefined();
      expect(dashboardFile?.findings?.length).toBe(1);
      expect(dashboardFile?.findings?.[0].rule).toBe('unplanned-code');
      expect(dashboardFile?.findings?.[0].severity).toBe('critical');

      // Test planFindings count (should be 6: missing-code, 3x line-link, late, stub-in-done)
      const planFindings = model.planFindings;
      expect(planFindings.length).toBeGreaterThanOrEqual(4);

      // Verify at least one missing-code
      const hasMissingCode = planFindings.some(f => f.rule === 'missing-code');
      expect(hasMissingCode).toBe(true);

      // Verify at least one line-link
      const hasLineLink = planFindings.some(f => f.rule === 'line-link');
      expect(hasLineLink).toBe(true);

      // Verify no critical unplanned-code in planFindings (they should be on file nodes)
      const unplannedInPlanFindings = planFindings.filter(f => f.rule === 'unplanned-code');
      expect(unplannedInPlanFindings.length).toBe(0);
    });

    it('regression: an id with no matching node at all still falls through to planFindings unchanged', () => {
      // phofast.api.auth etc. are PlanElement (component) ids, not file/function/method/class node
      // ids -- they must never accidentally become "routable" by this task's widening.
      const snapshot = runSnapshot({ repo: PHOFAST_FIXTURE, write: false, quiet: true });
      const c4Files = listC4Files(PHOFAST_FIXTURE);
      const plan = parsePlan(PHOFAST_FIXTURE, c4Files);
      const findings = checkPlan(plan, snapshot, PHOFAST_FIXTURE, { sprint: 'S15' });

      const model = buildViewModelFromSnapshot(snapshot);
      applyFindings(model, findings);

      const missingCode = model.planFindings.find(f => f.rule === 'missing-code');
      expect(missingCode).toBeDefined();
      // 'phofast.api.payments' (the finding's original id) is a component id -- confirm no node in
      // the tree has that id at all, i.e. this really is the "no match" path, not a coincidence.
      expect(findNodeById(model.root, 'phofast.api.payments')).toBeUndefined();
    });
  });

  describe('applyFindings · claim-mode routing (P6-T10)', () => {
    // Build the real end-to-end pipeline (buildSnapshot -> checkPlan -> buildViewModel ->
    // applyFindings) on the shared T4/T8/T9 fixture, so this exercises the actual id schemes
    // check.ts's four claim-mode rules and view/model.ts's claim-mode tree produce -- not a
    // hand-rolled approximation.
    function buildClaimModel() {
      const plan = buildClaimPlan();
      const snapshot = buildSnapshot(buildClaimBuildInput(), plan);
      const findings = checkPlan(plan, snapshot, '/test/repo');
      const model = buildViewModel(snapshot, 'summary', plan);
      applyFindings(model, findings);
      return { model, findings };
    }

    it('component-claim-conflict (fn !== null) lands on the matching function-element node, not planFindings', () => {
      const { model, findings } = buildClaimModel();
      const conflicts = findings.filter(f => f.rule === 'component-claim-conflict');
      expect(conflicts).toHaveLength(4);
      // All 4 conflicts in this fixture are at function-level (id = `${file}#${fn}`), none at
      // file/folder-level (id = bare file) -- confirmed by checking every id contains '#'.
      expect(conflicts.every(f => f.id.includes('#'))).toBe(true);

      for (const conflict of conflicts) {
        const node = findNodeById(model.root, conflict.id);
        expect(node).toBeDefined();
        expect(['function', 'method', 'class']).toContain(node!.kind);
        expect(node!.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ severity: 'warning', rule: 'component-claim-conflict', message: conflict.message }),
          ])
        );
      }

      // None of the 4 conflicts should have leaked into planFindings.
      expect(model.planFindings.some(f => f.rule === 'component-claim-conflict')).toBe(false);
    });

    it('shared-auto lands on the function-element node under the shared container, not planFindings', () => {
      const { model, findings } = buildClaimModel();
      const sharedFindings = findings.filter(f => f.rule === 'shared-auto');
      expect(sharedFindings).toHaveLength(1);
      expect(sharedFindings[0].id).toBe('src/payments.ts#refundPayment');

      const sharedContainer = model.root.children.find(c => c.kind === 'shared');
      expect(sharedContainer).toBeDefined();

      const node = findNodeById(model.root, 'src/payments.ts#refundPayment');
      expect(node).toBeDefined();
      expect(node!.kind).toBe('function');
      // Confirm it's actually the child under the 'shared' container, not some other coincidental match.
      expect(sharedContainer!.children.map(c => c.id)).toContain(node!.id);
      expect(node!.findings).toEqual([
        { severity: 'info', rule: 'shared-auto', message: sharedFindings[0].message },
      ]);

      expect(model.planFindings.some(f => f.rule === 'shared-auto')).toBe(false);
    });

    it('unassigned-code lands on the function-element node under the unassigned container, not planFindings', () => {
      const { model, findings } = buildClaimModel();
      const unassignedFindings = findings.filter(f => f.rule === 'unassigned-code');
      expect(unassignedFindings).toHaveLength(1);
      expect(unassignedFindings[0].id).toBe('src/util.ts#parseConfig');

      const unassignedContainer = model.root.children.find(c => c.kind === 'unassigned');
      expect(unassignedContainer).toBeDefined();

      const node = findNodeById(model.root, 'src/util.ts#parseConfig');
      expect(node).toBeDefined();
      expect(node!.kind).toBe('function');
      expect(unassignedContainer!.children.map(c => c.id)).toContain(node!.id);
      expect(node!.findings).toEqual([
        { severity: 'critical', rule: 'unassigned-code', message: unassignedFindings[0].message },
      ]);

      expect(model.planFindings.some(f => f.rule === 'unassigned-code')).toBe(false);
    });

    it('split-file (bare file id, no single owning node in claim mode) intentionally falls through to planFindings', () => {
      const { model, findings } = buildClaimModel();
      const splitFindings = findings.filter(f => f.rule === 'split-file');
      expect(splitFindings).toHaveLength(1);
      expect(splitFindings[0].id).toBe('src/orders/order.ts');

      // Confirm there really is no node with this id in claim mode (a plain file node is never
      // attached to the tree when every component is claim-mode) -- this is the documented,
      // intentional "nowhere to land" case, not a bug.
      expect(findNodeById(model.root, 'src/orders/order.ts')).toBeUndefined();

      expect(model.planFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: 'info', rule: 'split-file', message: splitFindings[0].message }),
        ])
      );
    });

    it('a file/folder-level component-claim-conflict (fn === null) would also fall through to planFindings', () => {
      // This fixture's 4 conflicts all have fn set (so they land on function nodes per the test
      // above). To confirm the fn === null path is still an intentional planFindings fallthrough
      // (not something this task silently broke), apply a hand-built fn === null conflict finding
      // directly and confirm it has nowhere claim-mode-specific to land: its id is a bare file path,
      // same as split-file's, which is orphaned in claim mode.
      const { model } = buildClaimModel();
      const fileLevelConflict = {
        severity: 'warning' as const,
        rule: 'component-claim-conflict',
        id: 'src/orders/order.ts',
        message: 'app.orders wins ownership of src/orders/order.ts over app.auth (reason: specificity)',
      };
      const before = model.planFindings.length;
      applyFindings(model, [fileLevelConflict]);
      expect(model.planFindings.length).toBe(before + 1);
      expect(model.planFindings[model.planFindings.length - 1]).toEqual({
        severity: 'warning',
        rule: 'component-claim-conflict',
        message: fileLevelConflict.message,
      });
    });
  });
});
