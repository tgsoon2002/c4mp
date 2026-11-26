import path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { runSnapshot } from '../src/index';
import { buildViewModel, parseSavedLayout } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import {
  ViewModel,
  ViewNode,
  Plan,
  PlanElement,
  Snapshot,
  BuildInput,
  Container,
  FileOutline,
  FileEdge,
  SnapshotMeta,
} from '../src/types';

describe('buildViewModel', () => {
  let model: ViewModel;

  beforeAll(() => {
    const snapshot = runSnapshot({
      repo: path.join(__dirname, 'fixtures/sample'),
      write: false,
      quiet: true,
    });
    model = buildViewModel(snapshot, 'sample-shop — 3 containers, 7 components, 8 files, 11 code elements, 7 component edges, 1 unresolved import');
  });

  describe('root node', () => {
    it('has correct id, kind, and name', () => {
      expect(model.root.id).toBe('sample-shop');
      expect(model.root.kind).toBe('system');
      expect(model.root.name).toBe('sample-shop');
    });

    it('has weight 70', () => {
      expect(model.root.weight).toBe(70);
    });

    it('has 3 container children', () => {
      expect(model.root.children).toHaveLength(3);
    });

    it('has no file or line', () => {
      expect(model.root.file).toBeUndefined();
      expect(model.root.line).toBeUndefined();
    });

    it('has x/y/w/h = 0', () => {
      expect(model.root.x).toBe(0);
      expect(model.root.y).toBe(0);
      expect(model.root.w).toBe(0);
      expect(model.root.h).toBe(0);
    });
  });

  describe('containers', () => {
    it('api container has correct properties', () => {
      const apiContainer = model.root.children.find((c) => c.id === 'api');
      expect(apiContainer).toBeDefined();
      expect(apiContainer!.kind).toBe('container');
      expect(apiContainer!.name).toBe('Api');
      expect(apiContainer!.detail).toBe('Node.js / TypeScript');
      expect(apiContainer!.weight).toBe(50);
      expect(apiContainer!.children).toHaveLength(5);
    });

    it('web container has correct properties', () => {
      const webContainer = model.root.children.find((c) => c.id === 'web');
      expect(webContainer).toBeDefined();
      expect(webContainer!.kind).toBe('container');
      expect(webContainer!.name).toBe('Web');
      expect(webContainer!.weight).toBe(19);
      expect(webContainer!.children).toHaveLength(2);
    });

    it('worker container has weight 1 and detail "no parsed code"', () => {
      const workerContainer = model.root.children.find((c) => c.id === 'worker');
      expect(workerContainer).toBeDefined();
      expect(workerContainer!.kind).toBe('container');
      expect(workerContainer!.name).toBe('Worker');
      expect(workerContainer!.detail).toBe('no parsed code');
      expect(workerContainer!.weight).toBe(1);
      expect(workerContainer!.children).toHaveLength(0);
    });

    it('containers are sorted by weight desc, then id', () => {
      const ids = model.root.children.map((c) => c.id);
      // api (50), web (19), worker (1) or alphabetically within same weight
      expect(ids[0]).toBe('api');
      expect(ids[1]).toBe('web');
      expect(ids[2]).toBe('worker');
    });
  });

  describe('components under api', () => {
    let apiContainer: ViewNode;

    beforeAll(() => {
      apiContainer = model.root.children.find((c) => c.id === 'api')!;
    });

    it('has 5 components with correct weights', () => {
      const comps = apiContainer.children;
      expect(comps).toHaveLength(5);

      const compsById = new Map(comps.map((c) => [c.id, c]));
      expect(compsById.get('api/services')!.weight).toBe(17);
      expect(compsById.get('api/routes')!.weight).toBe(10);
      expect(compsById.get('api/_root')!.weight).toBe(9);
      expect(compsById.get('api/models')!.weight).toBe(8);
      expect(compsById.get('api/lib')!.weight).toBe(6);
    });

    it('components are sorted by weight desc, then id', () => {
      const ids = apiContainer.children.map((c) => c.id);
      expect(ids[0]).toBe('api/services');
      expect(ids[1]).toBe('api/routes');
      expect(ids[2]).toBe('api/_root');
      expect(ids[3]).toBe('api/models');
      expect(ids[4]).toBe('api/lib');
    });
  });

  describe('orderService.ts file and elements', () => {
    let apiServicesComp: ViewNode;
    let orderServiceFile: ViewNode;
    let orderServiceClass: ViewNode;

    beforeAll(() => {
      const apiContainer = model.root.children.find((c) => c.id === 'api')!;
      apiServicesComp = apiContainer.children.find((c) => c.id === 'api/services')!;
      orderServiceFile = apiServicesComp.children.find((c) => c.file === 'api/src/services/orderService.ts')!;
      orderServiceClass = orderServiceFile.children.find((c) => c.name === 'OrderService')!;
    });

    it('orderService.ts file has correct properties', () => {
      expect(orderServiceFile.id).toBe('api/src/services/orderService.ts');
      expect(orderServiceFile.kind).toBe('file');
      expect(orderServiceFile.name).toBe('orderService.ts');
      expect(orderServiceFile.detail).toBe('17 lines');
      expect(orderServiceFile.weight).toBe(17);
      expect(orderServiceFile.file).toBe('api/src/services/orderService.ts');
    });

    it('OrderService class has correct properties', () => {
      expect(orderServiceClass.id).toBe('api/src/services/orderService.ts#OrderService');
      expect(orderServiceClass.kind).toBe('class');
      expect(orderServiceClass.name).toBe('OrderService');
      expect(orderServiceClass.detail).toBe('class · 15 lines');
      expect(orderServiceClass.weight).toBe(15);
      expect(orderServiceClass.line).toBe(3);
      expect(orderServiceClass.file).toBe('api/src/services/orderService.ts');
    });

    it('OrderService has method children in correct order and with correct weights', () => {
      const methods = orderServiceClass.children;
      expect(methods).toHaveLength(3);

      // Methods should be sorted by weight desc
      expect(methods[0].name).toBe('create');
      expect(methods[0].weight).toBe(7);
      expect(methods[0].line).toBe(6);

      expect(methods[1].name).toBe('find');
      expect(methods[1].weight).toBe(3);
      expect(methods[1].line).toBe(14);

      expect(methods[2].name).toBe('constructor');
      expect(methods[2].weight).toBe(1);
      expect(methods[2].line).toBe(4);
    });

    it('methods have correct id format', () => {
      const methods = orderServiceClass.children;
      expect(methods[0].id).toBe('api/src/services/orderService.ts#OrderService.create');
      expect(methods[1].id).toBe('api/src/services/orderService.ts#OrderService.find');
      expect(methods[2].id).toBe('api/src/services/orderService.ts#OrderService.constructor');
    });

    it('method with 1 line uses singular "line"', () => {
      const constructorMethod = orderServiceClass.children.find((m) => m.name === 'constructor')!;
      expect(constructorMethod.detail).toMatch(/1 line/);
      expect(constructorMethod.detail).not.toMatch(/1 lines/);
    });

    it('method with multiple lines uses plural "lines"', () => {
      const createMethod = orderServiceClass.children.find((m) => m.name === 'create')!;
      expect(createMethod.detail).toMatch(/7 lines/);
    });
  });

  describe('Cart.jsx file and elements', () => {
    let webComponentsComp: ViewNode;
    let cartFile: ViewNode;

    beforeAll(() => {
      const webContainer = model.root.children.find((c) => c.id === 'web')!;
      webComponentsComp = webContainer.children.find((c) => c.id === 'web/components')!;
      cartFile = webComponentsComp.children.find((c) => c.file === 'web/src/components/Cart.jsx')!;
    });

    it('Cart.jsx file has correct properties', () => {
      expect(cartFile.id).toBe('web/src/components/Cart.jsx');
      expect(cartFile.kind).toBe('file');
      expect(cartFile.name).toBe('Cart.jsx');
      expect(cartFile.weight).toBe(14);
      expect(cartFile.detail).toBe('14 lines');
    });

    it('file detail uses singular "line" for 1-line files', () => {
      const webContainer = model.root.children.find((c) => c.id === 'web')!;
      const filesWithOneLineCount = (function findFilesWithOneLineCount(node: ViewNode): ViewNode[] {
        const results: ViewNode[] = [];
        if (node.kind === 'file' && node.weight === 1) {
          results.push(node);
        }
        for (const child of node.children) {
          results.push(...findFilesWithOneLineCount(child));
        }
        return results;
      })(webContainer);

      // We should find files with 1 line somewhere in the model
      // For this fixture, if there are none, this test just verifies the logic is in place
      filesWithOneLineCount.forEach((file) => {
        expect(file.detail).toMatch(/1 line/);
        expect(file.detail).not.toMatch(/1 lines/);
      });
    });

    it('Cart.jsx children are in correct order', () => {
      const children = cartFile.children;
      expect(children).toHaveLength(2);

      // loadApp (4) should come before Cart (3)
      expect(children[0].name).toBe('loadApp');
      expect(children[0].weight).toBe(4);

      expect(children[1].name).toBe('Cart');
      expect(children[1].weight).toBe(3);
    });
  });

  describe('edges', () => {
    it('has 7 component edges', () => {
      expect(model.edges).toHaveLength(7);
    });
  });

  describe('all nodes have weight >= 1', () => {
    function checkWeights(node: ViewNode): void {
      expect(node.weight).toBeGreaterThanOrEqual(1);
      for (const child of node.children) {
        checkWeights(child);
      }
    }

    it('every node has weight >= 1', () => {
      checkWeights(model.root);
    });
  });

  describe('container weights sum', () => {
    it('container weights (excluding worker placeholder) sum to 69', () => {
      const apiWeight = model.root.children.find((c) => c.id === 'api')!.weight;
      const webWeight = model.root.children.find((c) => c.id === 'web')!.weight;
      expect(apiWeight + webWeight).toBe(69);
    });
  });

  describe('model metadata', () => {
    it('has correct title', () => {
      expect(model.title).toBe('sample-shop');
    });

    it('has correct summary', () => {
      expect(model.summary).toBe('sample-shop — 3 containers, 7 components, 8 files, 11 code elements, 7 component edges, 1 unresolved import');
    });

    it('has subtitle with git info or fallback', () => {
      expect(model.subtitle).toBeTruthy();
      expect(model.subtitle).toMatch(/\d{4}-\d{2}-\d{2}/); // has a date
    });

    it('subtitle format is <7-hex> · YYYY-MM-DD or no git · YYYY-MM-DD', () => {
      expect(model.subtitle).toMatch(/^([0-9a-f]{7}|no git) · \d{4}-\d{2}-\d{2}$/);
    });

    it('has repoPath', () => {
      expect(model.repoPath).toBeTruthy();
    });

    it('has edges from snapshot', () => {
      expect(model.edges).toHaveLength(7);
      expect(model.edges[0].from).toBeDefined();
      expect(model.edges[0].to).toBeDefined();
      expect(model.edges[0].weight).toBeDefined();
    });

    it('has drift null and empty planFindings', () => {
      expect(model.drift).toBeNull();
      expect(model.planFindings).toEqual([]);
    });
  });
});

// ---------- P6-T9: plan-aware rendering (claim-mode) ----------

describe('buildViewModel plan-aware rendering (P6-T9)', () => {
  describe('plan-only container, zero snapshot files (bug-report items a/b)', () => {
    function buildZeroFilePlan(): Plan {
      const elements: PlanElement[] = [
        {
          id: 'sys.bot',
          kind: 'container',
          title: 'Bot Service',
          description: null,
          technology: 'Node, Telegram bot',
          links: [],
          metadata: {},
          parent: 'sys',
          source: { file: 'arch.c4', line: 1 },
        },
        {
          id: 'sys.bot.handler',
          kind: 'component',
          title: 'Handler',
          description: null,
          technology: null,
          // one function-level claim is required for isClaimModePlan to flip claim-mode on
          links: [{ raw: './handler.ts#onMessage', path: 'handler.ts', name: 'onMessage', lines: null, title: null }],
          metadata: {},
          parent: 'sys.bot',
          source: { file: 'arch.c4', line: 2 },
        },
      ];
      return { files: ['arch.c4'], elements, relations: [], issues: [] };
    }

    function buildZeroFileSnapshot(): Snapshot {
      return {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@test',
          repoPath: '/test/repo',
          repoName: 'bot-app',
          createdAt: '2026-01-01T00:00:00.000Z',
          git: null,
        },
        system: { id: 'bot-app', name: 'bot-app' },
        containers: [], // no folder/manifest containers at all -- zero files on disk
        components: [
          {
            id: 'sys.bot.handler',
            name: 'Handler',
            containerId: 'sys.bot',
            path: 'handler.ts',
            files: [],
            mode: 'claim',
            claims: [{ kind: 'function', path: 'handler.ts', fn: 'onMessage', elementId: 'sys.bot.handler', claimIndex: 0 }],
            source: 'arch.c4',
            meta: {},
          },
        ],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 0, components: 1, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
      };
    }

    it('renders a non-empty root with the plan-declared container and component, no crash', () => {
      const snapshot = buildZeroFileSnapshot();
      const plan = buildZeroFilePlan();
      const model = buildViewModel(snapshot, 'zero-file summary', plan);

      expect(model.root.children.length).toBeGreaterThan(0);
      const container = model.root.children.find((c) => c.kind === 'container');
      expect(container).toBeDefined();
      expect(container!.weight).toBeGreaterThanOrEqual(1); // sensible zero-code placeholder, matches today's `|| 1` convention
      expect(container!.children).toHaveLength(1);
      expect(container!.children[0].kind).toBe('component');
      expect(container!.children[0].weight).toBeGreaterThanOrEqual(1);
    });

    it("container detail comes from the plan's technology field, not 'Unknown'", () => {
      const snapshot = buildZeroFileSnapshot();
      const plan = buildZeroFilePlan();
      const model = buildViewModel(snapshot, 'zero-file summary', plan);

      const container = model.root.children.find((c) => c.kind === 'container');
      expect(container!.detail).toBe('Node, Telegram bot');
      expect(container!.detail).not.toBe('Unknown');
      expect(container!.name).toBe('Bot Service');
    });
  });

  describe('T4/T8 fixture scenario end-to-end: buildSnapshot -> buildViewModel (slice/shared/unassigned)', () => {
    // Same scenario as test/build.test.ts's claim-mode block / test/ownership.test.ts / test/check.test.ts.
    function buildPlan(): Plan {
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

    function buildInput(): BuildInput {
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

    it('produces slice nodes under each component matching Ownership.owner', () => {
      const plan = buildPlan();
      const snapshot = buildSnapshot(buildInput(), plan);
      const model = buildViewModel(snapshot, 'summary', plan);

      const container = model.root.children.find((c) => c.kind === 'container');
      expect(container).toBeDefined();
      const compById = new Map(container!.children.map((c) => [c.id, c]));

      // app.orders owns createOrder+listOrders, both in order.ts -> one slice node
      const orders = compById.get('app.orders')!;
      expect(orders.children).toHaveLength(1);
      expect(orders.children[0].kind).toBe('slice');
      expect(orders.children[0].id).toBe('app.orders::slice::src/orders/order.ts');
      expect(orders.children[0].children.map((n) => n.id).sort()).toEqual([
        'src/orders/order.ts#createOrder',
        'src/orders/order.ts#listOrders',
      ]);

      // app.payments owns createPayment (payments.ts) + cancelOrder (order.ts) -> two slice nodes (split across files)
      const payments = compById.get('app.payments')!;
      expect(payments.children).toHaveLength(2);
      expect(payments.children.map((n) => n.kind)).toEqual(['slice', 'slice']);
      const paymentsSliceFiles = payments.children.map((n) => n.file).sort();
      expect(paymentsSliceFiles).toEqual(['src/orders/order.ts', 'src/payments.ts']);

      // app.auth owns formatDate (util.ts) -> one slice node
      const auth = compById.get('app.auth')!;
      expect(auth.children).toHaveLength(1);
      expect(auth.children[0].id).toBe('app.auth::slice::src/util.ts');
      expect(auth.children[0].children.map((n) => n.id)).toEqual(['src/util.ts#formatDate']);
    });

    it('produces shared/unassigned sibling nodes under the system matching Ownership.shared/unassigned', () => {
      const plan = buildPlan();
      const snapshot = buildSnapshot(buildInput(), plan);
      const model = buildViewModel(snapshot, 'summary', plan);

      const shared = model.root.children.find((c) => c.kind === 'shared');
      const unassigned = model.root.children.find((c) => c.kind === 'unassigned');
      expect(shared).toBeDefined();
      expect(unassigned).toBeDefined();

      // src/payments.ts#refundPayment is unclaimed but imported by order.ts (owned) -> shared-auto
      expect(shared!.children.map((n) => n.id)).toEqual(['src/payments.ts#refundPayment']);
      // src/util.ts#parseConfig is unclaimed and has no importer -> unassigned
      expect(unassigned!.children.map((n) => n.id)).toEqual(['src/util.ts#parseConfig']);
    });

    it('shared/unassigned sit as siblings of the container directly under the system root', () => {
      const plan = buildPlan();
      const snapshot = buildSnapshot(buildInput(), plan);
      const model = buildViewModel(snapshot, 'summary', plan);

      const kinds = model.root.children.map((c) => c.kind).sort();
      expect(kinds).toEqual(['container', 'shared', 'unassigned']);
    });

    describe('P9-T9a: plan relations become edges; dangling edges dropped', () => {
      const rel = (from: string, to: string) => ({ from, to, label: null, source: { file: 'src/auth.c4', line: 1 } });

      it('claim-mode plan relation yields an edge between the two component nodes (plan-only weight 1)', () => {
        const plan = { ...buildPlan(), relations: [rel('app.auth', 'app.orders')] };
        const snapshot = buildSnapshot(buildInput(), plan);
        const model = buildViewModel(snapshot, 'summary', plan);
        expect(model.edges).toContainEqual({ from: 'app.auth', to: 'app.orders', weight: 1 });
      });

      it('relation duplicating a scanned edge keeps one edge and sums weights; unresolved endpoints skipped', () => {
        const base = buildPlan();
        const snapshot = buildSnapshot(buildInput(), base);
        const scanned = snapshot.componentEdges.find((e) => e.from === 'app.orders' && e.to === 'app.payments')!;
        expect(scanned).toBeDefined();
        const plan = { ...base, relations: [rel('app.orders', 'app.payments'), rel('app.orders', 'app.ghost')] };
        const model = buildViewModel(snapshot, 'summary', plan);
        const matches = model.edges.filter((e) => e.from === 'app.orders' && e.to === 'app.payments');
        expect(matches).toEqual([{ from: 'app.orders', to: 'app.payments', weight: scanned.weight + 1 }]);
        expect(model.edges.some((e) => e.to === 'app.ghost')).toBe(false);
      });

      it("a plan's relations are drawn without function claims too (Q3)", () => {
        const plan = buildPlan();
        const snapshot = buildSnapshot(buildInput(), plan);
        const noClaims: Plan = {
          ...plan,
          elements: plan.elements.map((e) => ({ ...e, links: e.links.map((l) => ({ ...l, name: null })) })),
          relations: [rel('app.auth', 'app.orders')],
        };
        const model = buildViewModel(snapshot, 'summary', noClaims);
        expect(model.edges).toContainEqual({ from: 'app.auth', to: 'app.orders', weight: 1 });
      });

      it('scanned edge pointing at a missing node id is dropped', () => {
        const plan = buildPlan();
        const snapshot = buildSnapshot(buildInput(), plan);
        const withBad = {
          ...snapshot,
          componentEdges: [
            ...snapshot.componentEdges,
            { from: 'app.orders', to: 'unassigned', weight: 3 },
            { from: 'nowhere', to: 'app.auth', weight: 1 },
          ],
        };
        const model = buildViewModel(withBad, 'summary', plan);
        expect(model.edges).toEqual(snapshot.componentEdges);
      });
    });
  });

  describe('folder-mode regression guard (no plan, or plan without function-claims)', () => {
    // Rewritten in P14-T44a. Old title: "phofast fixture: identical model whether or not a plan without
    // function-claims is passed" (P6-T9 rule: such a plan must change nothing). T44a supersedes that rule:
    // in folder mode, plan containers/components with no scanned match now appear as planOnly nodes.
    it('phofast fixture: plan without function-claims adds only planOnly nodes (P14-T44a)', () => {
      const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/phofast'), write: false, quiet: true });
      const modelNoPlan = buildViewModel(snapshot, 'summary');

      // PhoFast's architecture.c4 declares containers (phofast.web/api/db) and components but no
      // function-level `#fn` links anywhere -> not claim-mode, so folder mode applies.
      const { parsePlan } = require('../src/plan/parser');
      const { listC4Files } = require('../src/plan/files');
      const c4Files = listC4Files(path.join(__dirname, 'fixtures/phofast'));
      const plan = parsePlan(path.join(__dirname, 'fixtures/phofast'), c4Files);
      const modelWithPlan = buildViewModel(snapshot, 'summary', plan);

      // The 14 plan-only nodes (measured on this fixture): 2 persons, the other system (b837), plan containers and components with no scanned match.
      const planOnlyIds = (n: ViewNode, out: string[] = []): string[] => {
        if (n.planOnly === true) out.push(n.id);
        n.children.forEach((c) => planOnlyIds(c, out));
        return out;
      };
      expect(planOnlyIds(modelWithPlan.root).sort()).toEqual([
        'customer',   // P20-T3: the fixture's two persons are plan-only nodes now
        'kitchen',
        'phofast.api',
        'phofast.api.auth',
        'phofast.api.menu',
        'phofast.api.notify',
        'phofast.api.orders',
        'phofast.api.payments',
        'phofast.db',
        'phofast.web',
        'phofast.web.checkout',
        'phofast.web.menupage',
        'phofast.web.reviews',
        'stripe',     // b837: the plan's second system (not ours) is an outside node beside ours
      ]);
      expect(planOnlyIds(modelNoPlan.root)).toEqual([]);

      // Tree: without the planOnly nodes, the tree is exactly the no-plan tree (ids, kinds, weights,
      // meta, origins, edges and file nodes of every other node are identical). Parent weights unchanged.
      const withoutPlanOnly = (n: ViewNode): ViewNode => ({
        ...n,
        children: n.children.filter((c) => c.planOnly !== true).map(withoutPlanOnly),
      });
      // C1-CTX: the two persons put the system under a 'context' root, beside it; the system subtree is the no-plan tree.
      expect(modelWithPlan.root).toMatchObject({ kind: 'context', name: modelNoPlan.root.name });
      // C1 A1 (b828): the persons first (plan order), then the system; b837: then the other plan system
      expect(modelWithPlan.root.children.map((c) => `${c.kind}:${c.id}`)).toEqual(['person:customer', 'person:kitchen', `system:${modelNoPlan.root.id}`, 'system:stripe']);
      expect(withoutPlanOnly(modelWithPlan.root.children[2])).toEqual(modelNoPlan.root);

      // Other root-level fields: identical, except `files` (plan .c4 files appear as kind 'plan'), `relations`
      // (P13-T2d key, present whenever a plan is passed) and `edges`: since EXT-1 a plan relation ends at a plan-only
      // node, so the plan adds edges, every one of them touching a planOnly node (the scanned edges are unchanged).
      const { root: _rootWith, files: filesWithPlan, relations, edges: edgesWithPlan, ...restWithPlan } = modelWithPlan;
      const { root: _rootNo, files: filesNoPlan, edges: edgesNoPlan, ...restNoPlan } = modelNoPlan;
      expect(restWithPlan).toEqual(restNoPlan);
      const planOnlySet = new Set(planOnlyIds(modelWithPlan.root));
      expect(edgesWithPlan.filter((e) => !planOnlySet.has(e.from) && !planOnlySet.has(e.to))).toEqual(edgesNoPlan);
      expect(edgesWithPlan.length).toBeGreaterThan(0);
      expect(relations!.length).toBeGreaterThan(0);
      expect(filesWithPlan.filter((f) => f.kind === 'source')).toEqual(filesNoPlan);
      expect(filesWithPlan.filter((f) => f.kind === 'plan').map((f) => f.path)).toEqual(plan.files);
      expect(modelNoPlan.edges).toEqual(snapshot.componentEdges);
    });

    it('sample fixture: unchanged tree with no plan passed at all (today\'s exact behavior)', () => {
      const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
      const model = buildViewModel(
        snapshot,
        'sample-shop — 3 containers, 7 components, 8 files, 11 code elements, 7 component edges, 1 unresolved import'
      );
      expect(model.root.children).toHaveLength(3);
      expect(model.root.children.every((c) => c.kind === 'container')).toBe(true);
      expect(model.edges).toEqual(snapshot.componentEdges);
    });
  });

  describe('P7-T4 model wiring: claims/source/history/code/callsAvailable', () => {
    // Own model instance (this describe sits under 'buildViewModel plan-aware rendering (P6-T9)',
    // a sibling of the top-level 'buildViewModel' describe, so that describe's own `model` isn't
    // in scope here) -- same sample fixture, no plan, matching the top-level describe's setup.
    let model: ViewModel;

    beforeAll(() => {
      const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
      model = buildViewModel(snapshot, 'sample-shop — 3 containers, 7 components, 8 files, 11 code elements, 7 component edges, 1 unresolved import');
    });

    it('every function/method node has callsAvailable === false, no exceptions', () => {
      const walk = (node: ViewNode, out: ViewNode[]): void => {
        if (node.kind === 'function' || node.kind === 'method') out.push(node);
        for (const child of node.children) walk(child, out);
      };
      const fnNodes: ViewNode[] = [];
      walk(model.root, fnNodes);
      expect(fnNodes.length).toBeGreaterThan(0);
      expect(fnNodes.every((n) => n.callsAvailable === false)).toBe(true);
    });

    it("function node's code matches the real file's lines exactly (sample fixture, real disk read)", () => {
      const apiContainer = model.root.children.find((c) => c.id === 'api')!;
      const apiModelsComp = apiContainer.children.find((c) => c.id === 'api/models')!;
      const orderFile = apiModelsComp.children.find((c) => c.file === 'api/src/models/order.ts')!;
      const makeOrder = orderFile.children.find((c) => c.name === 'makeOrder')!;

      expect(makeOrder.kind).toBe('function');
      expect(makeOrder.line).toBe(5);
      expect(makeOrder.callsAvailable).toBe(false);
      expect(makeOrder.code).toEqual([
        "export function makeOrder(input: Partial<Order>): Order {",
        "  const helper = () => 'x';",
        "  return { id: input.id ?? helper() };",
        "}",
      ]);
    });

    it("method node's code matches the real file's lines exactly", () => {
      const apiContainer = model.root.children.find((c) => c.id === 'api')!;
      const apiServicesComp = apiContainer.children.find((c) => c.id === 'api/services')!;
      const orderServiceFile = apiServicesComp.children.find((c) => c.file === 'api/src/services/orderService.ts')!;
      const orderServiceClass = orderServiceFile.children.find((c) => c.name === 'OrderService')!;
      const create = orderServiceClass.children.find((c) => c.name === 'create')!;

      expect(create.kind).toBe('method');
      expect(create.code).toEqual([
        "  create(input: Partial<Order>): Order {",
        "    function validate() {",
        "      return true;",
        "    }",
        "    validate();",
        "    return makeOrder(input);",
        "  }",
      ]);
    });

    it('folder-mode component nodes leave claims/source/history undefined (no plan)', () => {
      const apiContainer = model.root.children.find((c) => c.id === 'api')!;
      const apiModelsComp = apiContainer.children.find((c) => c.id === 'api/models')!;
      expect(apiModelsComp.claims).toBeUndefined();
      expect(apiModelsComp.source).toBeUndefined();
      expect(apiModelsComp.history).toBeUndefined();
    });

    describe('claim-mode component: claims/source/history (real temp git repo)', () => {
      function makeTempClaimRepo(): string {
        const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t4-claimrepo-'));
        fs.mkdirSync(path.join(tempRepo, 'src', 'orders'), { recursive: true });
        fs.writeFileSync(
          path.join(tempRepo, 'src', 'orders', 'order.ts'),
          "export function createOrder(id: string): string {\n  return id;\n}\n"
        );
        fs.writeFileSync(path.join(tempRepo, 'src', 'orders.c4'), "// claim declaration\n");

        execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'add', '.'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'declare orders claim'], {
          stdio: 'ignore',
          env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' },
        });
        return tempRepo;
      }

      function makePlan(): Plan {
        const elements: PlanElement[] = [
          {
            id: 'app.orders',
            kind: 'component',
            title: 'Orders',
            description: null,
            technology: null,
            links: [
              { raw: './orders/order.ts#createOrder', path: 'src/orders/order.ts', name: 'createOrder', lines: null, title: null },
            ],
            metadata: {},
            parent: null,
            source: { file: 'src/orders.c4', line: 1 },
          },
        ];
        return { files: ['src/orders.c4'], elements, relations: [], issues: [] };
      }

      it("component node's claims matches its Component.claims exactly, source is the .c4 path, history has a real commit", () => {
        const tempRepo = makeTempClaimRepo();
        try {
          const plan = makePlan();
          const snapshot = runSnapshot({ repo: tempRepo, plan, write: false, quiet: true });
          const claimModel = buildViewModel(snapshot, 'summary', plan);

          const ordersComponent = snapshot.components.find((c) => c.id === 'app.orders')!;
          expect(ordersComponent).toBeDefined();
          expect(ordersComponent.mode).toBe('claim');

          const findNode = (node: ViewNode, id: string): ViewNode | null => {
            if (node.id === id) return node;
            for (const child of node.children) {
              const found = findNode(child, id);
              if (found) return found;
            }
            return null;
          };
          const ordersNode = findNode(claimModel.root, 'app.orders')!;
          expect(ordersNode).toBeDefined();
          expect(ordersNode.kind).toBe('component');

          // P13-T2c: entries gain ownedCount on top of the mirrored Component.claims fields
          expect(ordersNode.claims!.map(({ ownedCount, ...c }) => c)).toEqual(ordersComponent.claims);
          expect(ordersNode.claims!.every((c) => typeof c.ownedCount === 'number')).toBe(true);
          expect(ordersNode.source).toBe('src/orders.c4');
          expect(ordersNode.source).toBe(ordersComponent.source);

          expect(ordersNode.history).toBeDefined();
          expect(ordersNode.history!.length).toBeGreaterThanOrEqual(1);
          expect(ordersNode.history![0].message).toBe('declare orders claim');
          expect(ordersNode.history![0].commit).toMatch(/^[0-9a-f]{40}$/);

          // the slice's real function child gets `code` from the real on-disk file + callsAvailable false
          const createOrderNode = findNode(claimModel.root, 'src/orders/order.ts#createOrder')!;
          expect(createOrderNode).toBeDefined();
          expect(createOrderNode.callsAvailable).toBe(false);
          expect(createOrderNode.code).toEqual([
            'export function createOrder(id: string): string {',
            '  return id;',
            '}',
          ]);
        } finally {
          fs.rmSync(tempRepo, { recursive: true, force: true });
        }
      });
    });
  });
});

describe('P10-T3 savedLayout parsing from plan metadata', () => {
  it.each([
    ['300,200;1200,860,33178,23922', { bx: 300, by: 200, rx: 1200, ry: 860, rw: 33178, rh: 23922 }],
    [';1200,860,33178,23922', { rx: 1200, ry: 860, rw: 33178, rh: 23922 }],
    ['-5,7; -10, 20, 300, 150', { bx: -5, by: 7, rx: -10, ry: 20, rw: 300, rh: 150 }],
  ])('parses %s', (v, expected) => {
    expect(parseSavedLayout(v, 'x')).toEqual(expected);
  });

  it.each(['', 'abc', '1,2,3,4', '1,2;3,4,5', '1;2,3,4,5', ';1,2,0,10', ';1,2,3.5,4', '1,2;3,4,5,6,7'])(
    'ignores malformed %p (null, no throw)',
    (v) => {
      expect(parseSavedLayout(v, 'x')).toBeNull();
    }
  );

  describe('on nodes (claim mode)', () => {
    const el = (id: string, kind: string, parent: string | null, metadata: Record<string, string>, links: PlanElement['links'] = []): PlanElement => ({
      id, kind, title: id, description: null, technology: null, links, metadata, parent, source: { file: 'a.c4', line: 1 },
    });
    const build = (cMeta: Record<string, string>, ctMeta: Record<string, string>, sysMeta: Record<string, string> = {}) => {
      const plan: Plan = {
        files: ['a.c4'],
        elements: [
          el('claim-app', 'system', null, sysMeta),
          el('claim-app.app', 'container', 'claim-app', ctMeta),
          el('claim-app.app.orders', 'component', 'claim-app.app', cMeta, [
            { raw: './orders/order.ts#createOrder', path: 'src/orders/order.ts', name: 'createOrder', lines: null, title: null },
          ]),
        ],
        relations: [],
        issues: [],
      };
      const input: BuildInput = {
        meta: { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'claim-app', createdAt: '2026-01-01T00:00:00.000Z', git: null },
        containers: [{ id: 'app', name: 'App', path: '.', tech: 'Node.js', manifest: 'package.json' }],
        components: [],
        outlines: [{
          file: 'src/orders/order.ts', lineCount: 7, parseError: false,
          elements: [{ name: 'createOrder', kind: 'function', startLine: 1, endLine: 7, lineCount: 7 }],
        }],
        imports: [], componentEdges: [], fileEdges: [],
      };
      return buildViewModel(buildSnapshot(input, plan), 'summary', plan);
    };
    const find = (n: ViewNode, kind: string): ViewNode | undefined =>
      n.kind === kind ? n : n.children.map((c) => find(c, kind)).find(Boolean);

    it('component, container and system nodes get savedLayout; bad values are ignored', () => {
      const m = build({ layout: '1,2;3,4,5,6' }, { layout: ';7,8,9,10' }, { layout: ';0,0,100,100' });
      expect(find(m.root, 'component')!.savedLayout).toEqual({ bx: 1, by: 2, rx: 3, ry: 4, rw: 5, rh: 6 });
      expect(find(m.root, 'container')!.savedLayout).toEqual({ rx: 7, ry: 8, rw: 9, rh: 10 });
      expect(m.root.savedLayout).toEqual({ rx: 0, ry: 0, rw: 100, rh: 100 });
      const bad = build({ layout: 'garbage' }, {});
      expect(find(bad.root, 'component')!.savedLayout).toBeUndefined();
      expect(find(bad.root, 'container')!.savedLayout).toBeUndefined();
    });
  });

  it('folder mode: no savedLayout anywhere even if a (non-claim) plan carries layout metadata', () => {
    const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
    const plan: Plan = {
      files: ['a.c4'],
      elements: [{
        id: 'sample-shop', kind: 'system', title: 's', description: null, technology: null, links: [],
        metadata: { layout: ';1,2,3,4' }, parent: null, source: { file: 'a.c4', line: 1 },
      }],
      relations: [], issues: [],
    };
    const walk = (n: ViewNode): boolean => n.savedLayout !== undefined || n.children.some(walk);
    expect(walk(buildViewModel(snapshot, 's', plan).root)).toBe(false);
  });
});

// P14-I5d-i: a method is listed only under its class (never also under the slice).
describe('P14-I5d-i: a method is listed only under its class (claim mode)', () => {
  const meta: SnapshotMeta = {
    tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'mc-app', createdAt: '2026-01-01T00:00:00.000Z', git: null,
  };
  const containers = [{ id: 'app', name: 'App', path: '.', tech: 'Java', manifest: null }];
  const el = (id: string, links: { path: string; name: string | null }[]): PlanElement => ({
    id,
    kind: 'component',
    title: id,
    description: null,
    technology: null,
    links: links.map((l) => ({ raw: `./${l.path}`, path: l.path, name: l.name, lines: null, title: null })),
    metadata: {},
    parent: null,
    source: { file: 'a.c4', line: 1 },
  });
  const walk = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(walk)];

  it('slice lists the class and the function; the class lists its methods; no node has two parents', () => {
    const plan: Plan = {
      files: ['a.c4'],
      // app.x holds a function claim only so the plan is claim mode (isClaimModePlan needs a function claim)
      elements: [el('app.c', [{ path: 'src/c.ts', name: null }]), el('app.x', [{ path: 'src/x.ts', name: 'g' }])],
      relations: [],
      issues: [],
    };
    const outlines: FileOutline[] = [{
      file: 'src/c.ts',
      lineCount: 30,
      parseError: false,
      elements: [
        { name: 'C', kind: 'class', startLine: 1, endLine: 20, lineCount: 20 },
        { name: 'C.a', kind: 'method', startLine: 2, endLine: 8, lineCount: 7 },
        { name: 'C.b', kind: 'method', startLine: 10, endLine: 18, lineCount: 9 },
        { name: 'f', kind: 'function', startLine: 22, endLine: 30, lineCount: 9 },
      ],
    }, {
      file: 'src/x.ts',
      lineCount: 5,
      parseError: false,
      elements: [{ name: 'g', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 }],
    }];
    const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
    const m = buildViewModel(buildSnapshot(input, plan), 's', plan);
    const nodes = walk(m.root);
    expect(nodes.filter((n, i) => nodes.indexOf(n) !== i).map((n) => n.id)).toEqual([]);

    const slice = nodes.find((n) => n.id === 'app.c')!.children.find((c) => c.id === 'app.c::slice::src/c.ts')!;
    expect(slice.children.map((c) => c.id)).toEqual(['src/c.ts#C', 'src/c.ts#f']);
    // sorted by weight desc (C.b 9 lines before C.a 7 lines), as sortNodes does for every children list
    expect(slice.children[0].children.map((c) => c.id)).toEqual(['src/c.ts#C.b', 'src/c.ts#C.a']);
    expect(slice.detail.startsWith('2 owned elements')).toBe(true);
    expect(slice.weight).toBe(20 + 9);
  });

  it('fn-claim on the class only: its methods fall to Unassigned but are listed only under the class', () => {
    const plan: Plan = {
      files: ['a.c4'],
      elements: [el('app.c', [{ path: 'src/c.ts', name: 'C' }])],
      relations: [],
      issues: [],
    };
    const cOutline: FileOutline = {
      file: 'src/c.ts',
      lineCount: 30,
      parseError: false,
      elements: [
        { name: 'C', kind: 'class', startLine: 1, endLine: 20, lineCount: 20 },
        { name: 'C.a', kind: 'method', startLine: 2, endLine: 8, lineCount: 7 },
        { name: 'C.b', kind: 'method', startLine: 10, endLine: 18, lineCount: 9 },
      ],
    };
    const looseOutline: FileOutline = {
      file: 'loose/x.ts',
      lineCount: 4,
      parseError: false,
      elements: [{ name: 'stray', kind: 'function', startLine: 1, endLine: 4, lineCount: 4 }],
    };
    const build = (outlines: FileOutline[]) =>
      buildViewModel(
        buildSnapshot({ meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] }, plan),
        's',
        plan
      );

    const m = build([cOutline, looseOutline]);
    const nodes = walk(m.root);
    expect(new Set(nodes).size).toBe(nodes.length);

    // C.a and C.b are unowned (the class claim does not cover methods), so they count as unassigned
    const unassigned = nodes.find((n) => n.kind === 'unassigned')!;
    expect(unassigned.detail).toBe('3 unassigned functions');
    expect(unassigned.children.map((c) => c.id)).toEqual(['loose/x.ts#stray']);

    const slice = nodes.find((n) => n.id === 'app.c::slice::src/c.ts')!;
    expect(slice.children.map((c) => c.id)).toEqual(['src/c.ts#C']);
    const cls = nodes.find((n) => n.id === 'src/c.ts#C')!;
    expect(cls.children.map((c) => c.id)).toEqual(['src/c.ts#C.b', 'src/c.ts#C.a']);

    // without the loose file, every unassigned id is a method under a listed class: no Unassigned node
    const m2 = build([cOutline]);
    expect(walk(m2.root).some((n) => n.kind === 'unassigned')).toBe(false);
  });
});
