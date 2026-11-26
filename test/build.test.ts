import * as path from 'path';
import { buildSnapshot } from '../src/snapshot/build';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import {
  BuildInput,
  Container,
  Component,
  FileOutline,
  FileImports,
  ComponentEdge,
  FileEdge,
  SnapshotMeta,
  Plan,
  PlanElement,
} from '../src/types';

// Same fixture scenario as test/ownership.test.ts and test/check.test.ts's claim-mode block (3
// files, 3 plan elements: a function-level claim beating a folder claim (specificity conflict), a
// same-specificity tie (plan-order conflict), one shared-auto function, one unassigned function) --
// rebuilt locally here (matching this repo's existing convention of duplicating small fixtures per
// test file rather than sharing them, see ownership.test.ts vs check.test.ts) to drive
// buildSnapshot's claim-mode branch (P6-T9) end to end.
function buildClaimModePlan(): Plan {
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

function buildClaimModeBuildInput(): BuildInput {
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

  return {
    meta,
    containers,
    components: [], // overridden by the claim-mode branch; irrelevant here
    outlines,
    imports: [],
    componentEdges: [], // overridden by the claim-mode branch; irrelevant here
    fileEdges,
  };
}

describe('build', () => {
  const createSyntheticInput = (): BuildInput => {
    const meta: SnapshotMeta = {
      tool: 'c4pm@0.1.0',
      repoPath: '/test/repo',
      repoName: 'test-app',
      createdAt: '2026-01-01T00:00:00.000Z',
      git: null,
    };

    const containers: Container[] = [
      {
        id: 'app',
        name: 'App',
        path: '.',
        tech: 'Node.js',
        manifest: 'package.json',
      },
    ];

    const components: Component[] = [
      {
        id: 'app/_root',
        name: 'Root files',
        containerId: 'app',
        path: 'src',
        files: ['src/index.ts', 'src/config.ts'],
      },
      {
        id: 'app/utils',
        name: 'Utils',
        containerId: 'app',
        path: 'src/utils',
        files: ['src/utils/helper.ts'],
      },
    ];

    const outlines: FileOutline[] = [
      {
        file: 'src/index.ts',
        lineCount: 10,
        parseError: false,
        elements: [
          { name: 'start', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 },
        ],
      },
      {
        file: 'src/config.ts',
        lineCount: 8,
        parseError: false,
        elements: [
          { name: 'config', kind: 'function', startLine: 1, endLine: 8, lineCount: 8 },
        ],
      },
      {
        file: 'src/utils/helper.ts',
        lineCount: 6,
        parseError: false,
        elements: [
          { name: 'Helper', kind: 'class', startLine: 1, endLine: 6, lineCount: 6 },
        ],
      },
    ];

    const imports: FileImports[] = [
      {
        file: 'src/index.ts',
        imports: [
          {
            spec: 'lodash',
            kind: 'import',
            line: 1,
            status: 'external',
            pkg: 'lodash',
          },
          {
            spec: 'non-existent-pkg',
            kind: 'import',
            line: 2,
            status: 'unresolved',
          },
        ],
      },
      {
        file: 'src/config.ts',
        imports: [
          {
            spec: './helper',
            kind: 'import',
            line: 1,
            status: 'internal',
            target: 'src/utils/helper.ts',
          },
        ],
      },
      {
        file: 'src/utils/helper.ts',
        imports: [],
      },
    ];

    const componentEdges: ComponentEdge[] = [
      { from: 'app/_root', to: 'app/utils', weight: 1 },
    ];

    const fileEdges: FileEdge[] = [
      { from: 'src/index.ts', to: 'src/config.ts' },
      { from: 'src/config.ts', to: 'src/utils/helper.ts' },
    ];

    return {
      meta,
      containers,
      components,
      outlines,
      imports,
      componentEdges,
      fileEdges,
    };
  };

  it('builds snapshot with correct stats', () => {
    const input = createSyntheticInput();
    const snapshot = buildSnapshot(input);

    expect(snapshot.stats.containers).toBe(1);
    expect(snapshot.stats.components).toBe(2);
    expect(snapshot.stats.files).toBe(3);
    expect(snapshot.stats.codeElements).toBe(3);
    expect(snapshot.stats.componentEdges).toBe(1);
    expect(snapshot.stats.unresolvedImports).toBe(1);
  });

  it('builds externals correctly', () => {
    const input = createSyntheticInput();
    const snapshot = buildSnapshot(input);

    expect(snapshot.externals).toHaveLength(1);
    expect(snapshot.externals[0]).toEqual({
      pkg: 'lodash',
      usedBy: ['app/_root'],
    });
  });

  it('sorts all arrays', () => {
    const input = createSyntheticInput();
    // Deliberately pass unsorted arrays
    input.containers.reverse();
    input.components.reverse();
    input.outlines.reverse();
    input.componentEdges.reverse();
    input.fileEdges.reverse();
    // Deliberately pass unsorted component files
    input.components[0].files.reverse();

    const snapshot = buildSnapshot(input);

    // Check containers are sorted by id
    expect(snapshot.containers.map((c) => c.id)).toEqual(['app']);

    // Check components are sorted by id
    expect(snapshot.components.map((c) => c.id)).toEqual(['app/_root', 'app/utils']);

    // Check component files are sorted
    const rootComponent = snapshot.components.find((c) => c.id === 'app/_root');
    expect(rootComponent?.files).toEqual(['src/config.ts', 'src/index.ts']);

    // Check files are sorted by file path
    expect(snapshot.files.map((f) => f.file)).toEqual([
      'src/config.ts',
      'src/index.ts',
      'src/utils/helper.ts',
    ]);

    // Check component edges are sorted by from then to
    expect(snapshot.componentEdges[0]).toEqual({ from: 'app/_root', to: 'app/utils', weight: 1 });

    // Check file edges are sorted by from then to
    expect(snapshot.fileEdges).toEqual([
      { from: 'src/config.ts', to: 'src/utils/helper.ts' },
      { from: 'src/index.ts', to: 'src/config.ts' },
    ]);
  });

  it('throws when file is not in any component', () => {
    const input = createSyntheticInput();
    input.outlines.push({
      file: 'src/orphan.ts',
      lineCount: 5,
      parseError: false,
      elements: [],
    });

    expect(() => buildSnapshot(input)).toThrow('File src/orphan.ts is not in any component');
  });

  it('sets system id and name from metadata', () => {
    const input = createSyntheticInput();
    const snapshot = buildSnapshot(input);

    expect(snapshot.system.id).toBe('test-app');
    expect(snapshot.system.name).toBe('test-app');
  });

  it('includes all snapshot fields', () => {
    const input = createSyntheticInput();
    const snapshot = buildSnapshot(input);

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.meta).toBeDefined();
    expect(snapshot.system).toBeDefined();
    expect(snapshot.containers).toBeDefined();
    expect(snapshot.components).toBeDefined();
    expect(snapshot.files).toBeDefined();
    expect(snapshot.componentEdges).toBeDefined();
    expect(snapshot.fileEdges).toBeDefined();
    expect(snapshot.externals).toBeDefined();
    expect(snapshot.stats).toBeDefined();
  });

  describe('claim-mode (P6-T9)', () => {
    it('builds claim-mode Component[] from the plan instead of the folder-mode input.components', () => {
      const input = buildClaimModeBuildInput();
      const plan = buildClaimModePlan();
      const snapshot = buildSnapshot(input, plan);

      const ids = snapshot.components.map((c) => c.id).sort();
      expect(ids).toEqual(['app.auth', 'app.orders', 'app.payments']);
      expect(snapshot.components.every((c) => c.mode === 'claim')).toBe(true);
      expect(snapshot.components.every((c) => Array.isArray(c.claims) && c.claims!.length > 0)).toBe(true);
      expect(snapshot.components.every((c) => c.source)).toBe(true);
      // input.components ([]) must be ignored, not merged in
      expect(snapshot.stats.components).toBe(3);
    });

    it('assigns each component the files it dominantly owns (per Ownership + dominantOwnerPerFile)', () => {
      const input = buildClaimModeBuildInput();
      const plan = buildClaimModePlan();
      const snapshot = buildSnapshot(input, plan);

      const byId = new Map(snapshot.components.map((c) => [c.id, c]));
      // order.ts: createOrder+listOrders -> app.orders, cancelOrder -> app.payments => dominant app.orders (2-1)
      expect(byId.get('app.orders')!.files).toEqual(['src/orders/order.ts']);
      // payments.ts: createPayment -> app.payments, refundPayment -> shared-auto => tie, lower id wins (app.payments < shared-auto)
      expect(byId.get('app.payments')!.files).toEqual(['src/payments.ts']);
      // util.ts: formatDate -> app.auth, parseConfig -> unassigned => tie, lower id wins (app.auth < unassigned)
      expect(byId.get('app.auth')!.files).toEqual(['src/util.ts']);
    });

    it('assigns every snapshot file the claim-mode dominant owner as componentId', () => {
      const input = buildClaimModeBuildInput();
      const plan = buildClaimModePlan();
      const snapshot = buildSnapshot(input, plan);

      const byFile = new Map(snapshot.files.map((f) => [f.file, f.componentId]));
      expect(byFile.get('src/orders/order.ts')).toBe('app.orders');
      expect(byFile.get('src/payments.ts')).toBe('app.payments');
      expect(byFile.get('src/util.ts')).toBe('app.auth');
    });

    it('re-rolls componentEdges against the claim-based owner map (not the stale folder-mode edges on input)', () => {
      const input = buildClaimModeBuildInput();
      const plan = buildClaimModePlan();
      const snapshot = buildSnapshot(input, plan);

      // order.ts (app.orders) imports payments.ts (app.payments) -> one cross-component edge
      expect(snapshot.componentEdges).toEqual([{ from: 'app.orders', to: 'app.payments', weight: 1 }]);
    });

    it('falls back to the single real container for a parent-less component (resolveContainerId)', () => {
      const input = buildClaimModeBuildInput();
      const plan = buildClaimModePlan();
      const snapshot = buildSnapshot(input, plan);

      expect(snapshot.components.every((c) => c.containerId === 'app')).toBe(true);
    });

    it('folder-mode input (no plan) is completely unaffected: groupComponents output passes through untouched', () => {
      const input = createSyntheticInput();
      const snapshotNoPlan = buildSnapshot(input);
      const snapshotUndefinedPlan = buildSnapshot(input, undefined);

      for (const snapshot of [snapshotNoPlan, snapshotUndefinedPlan]) {
        expect(snapshot.components.map((c) => c.id)).toEqual(['app/_root', 'app/utils']);
        expect(snapshot.components.every((c) => c.mode === undefined)).toBe(true);
        expect(snapshot.componentEdges).toEqual([{ from: 'app/_root', to: 'app/utils', weight: 1 }]);
      }
    });

    it('a plan without function-level claims (folder-mode .c4 style) does not trigger claim-mode', () => {
      const input = createSyntheticInput();
      // plain file link only, no `#fn` -> extractClaims produces no 'function' claim -> not claim-mode
      const plan: Plan = {
        files: ['src/architecture.c4'],
        elements: [
          {
            id: 'app.utils',
            kind: 'component',
            title: 'Utils',
            description: null,
            technology: null,
            links: [{ raw: './utils/', path: 'src/utils/', name: null, lines: null, title: null }],
            metadata: {},
            parent: null,
            source: { file: 'src/architecture.c4', line: 1 },
          },
        ],
        relations: [],
        issues: [],
      };

      const snapshot = buildSnapshot(input, plan);
      expect(snapshot.components.map((c) => c.id)).toEqual(['app/_root', 'app/utils']);
      expect(snapshot.components.every((c) => c.mode === undefined)).toBe(true);
    });
  });
});

// Phase 28 LK-C (b393): components sit in layers (container > layer > component); the container is the scanned one.
describe('buildSnapshot with layers (claim mode)', () => {
  const root = path.join(__dirname, 'fixtures/layers-claim');
  let components: Component[];
  beforeAll(() => {
    const plan = parsePlan(root, ['c4/plan.c4']);
    components = runSnapshot({ repo: root, write: false, quiet: true, plan }).components;
  });

  it.each([
    ['shop.api.logic.orders', 'api'],
    ['shop.api.data.store', 'api'],
    ['shop.web.pages', 'web'],
  ])('%s is attached to the scanned container %s', (id, containerId) => {
    expect(components.find((c) => c.id === id)?.containerId).toBe(containerId);
  });
});

