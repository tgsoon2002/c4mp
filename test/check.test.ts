import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import { checkPlan } from '../src/c4/check';
import { formatFindings } from '../src/query/format';
import type { Plan, PlanElement, PlanFinding, Snapshot, SnapshotFile, FileEdge } from '../src/types';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures/phofast');

// Claim-mode fixture (P6-T8), built on the same scenario shape as test/ownership.test.ts's fixture
// (3 files, function-level claims producing a specificity conflict, a plan-order conflict, a
// shared-auto, and an unassigned function), extended with one more function (order.ts#cancelOrder,
// claimed by app.payments) so order.ts ends up with two distinct real owners -> a split-file finding
// too. Built directly as a Plan + Snapshot (not via runSnapshot/parsePlan) since none of these files
// need to exist on disk -- checkPlan's claim-mode rules only look at snapshot.files/fileEdges and the
// plan's links, not the filesystem.
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

function buildClaimModeFiles(): SnapshotFile[] {
  return [
    {
      file: 'src/orders/order.ts',
      lineCount: 20,
      parseError: false,
      componentId: 'n/a',
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
      componentId: 'n/a',
      elements: [
        { name: 'createPayment', kind: 'function', startLine: 1, endLine: 10, lineCount: 10 },
        { name: 'refundPayment', kind: 'function', startLine: 11, endLine: 20, lineCount: 10 },
      ],
    },
    {
      file: 'src/util.ts',
      lineCount: 10,
      parseError: false,
      componentId: 'n/a',
      elements: [
        { name: 'formatDate', kind: 'function', startLine: 1, endLine: 5, lineCount: 5 },
        { name: 'parseConfig', kind: 'function', startLine: 6, endLine: 10, lineCount: 5 },
      ],
    },
  ];
}

function buildClaimModeFileEdges(): FileEdge[] {
  // order.ts (owned by app.orders) imports payments.ts -> refundPayment becomes shared-auto.
  return [{ from: 'src/orders/order.ts', to: 'src/payments.ts' }];
}

function buildClaimModeSnapshot(): Snapshot {
  return {
    schemaVersion: 2,
    meta: {
      tool: 'c4pm@test',
      repoPath: '/test/repo',
      repoName: 'claim-app',
      createdAt: '2026-01-01T00:00:00.000Z',
      git: null,
    },
    system: { id: 'claim-app', name: 'claim-app' },
    containers: [],
    components: [],
    files: buildClaimModeFiles(),
    componentEdges: [],
    fileEdges: buildClaimModeFileEdges(),
    externals: [],
    stats: {
      containers: 0,
      components: 0,
      files: 3,
      codeElements: 7,
      componentEdges: 0,
      unresolvedImports: 0,
    },
  };
}

describe('check', () => {
  it('finds all 8 PhoFast violations with sprint S15', () => {
    const files = [
      'src/architecture.c4',
      'src/api/auth/auth.c4',
      'src/api/menu/menu.c4',
      'src/api/orders/orders.c4',
      'src/api/payments/payments.c4',
      'src/api/notify/notify.c4',
      'src/web/pages/pages.c4',
    ];

    const plan = parsePlan(FIXTURE_ROOT, files);
    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT, { sprint: 'S15' }).filter(f => f.rule !== 'plan-unmatched');

    // Check exact count and content
    expect(findings).toHaveLength(8);

    // Check each finding
    expect(findings[0]).toEqual({
      severity: 'critical',
      rule: 'missing-code',
      id: 'phofast.api.payments',
      message: 'Payment Service is done but its code is missing: src/api/payments/stripe.ts',
    });

    expect(findings[1]).toEqual({
      severity: 'critical',
      rule: 'unplanned-code',
      id: 'src/api/loyalty/points.ts',
      message: 'no .c4 element claims this file',
    });

    expect(findings[2]).toEqual({
      severity: 'critical',
      rule: 'unplanned-code',
      id: 'src/web/admin/Dashboard.tsx',
      message: 'no .c4 element claims this file',
    });

    expect(findings[3]).toEqual({
      severity: 'warning',
      rule: 'late',
      id: 'phofast.api.notify',
      message: 'Notification Service is planned in sprint S14 (current S15)',
    });

    expect(findings[4]).toEqual({
      severity: 'warning',
      rule: 'stub-in-done',
      id: 'phofast.api.auth',
      message: 'Auth Service is done but revokeToken is not implemented (todo) in src/api/auth/index.ts',
    });

    expect(findings[5]).toEqual({
      severity: 'info',
      rule: 'line-link',
      id: 'phofast.api.auth',
      message: 'link uses line numbers (./index.ts#L6-L13); they shift on every edit, so link a function name instead',
    });

    expect(findings[6]).toEqual({
      severity: 'info',
      rule: 'line-link',
      id: 'phofast.api.orders',
      message: 'link uses line numbers (./index.ts#L7-L14); they shift on every edit, so link a function name instead',
    });

    expect(findings[7]).toEqual({
      severity: 'info',
      rule: 'line-link',
      id: 'phofast.web.checkout',
      message: 'link uses line numbers (./Checkout.tsx#L3-L14); they shift on every edit, so link a function name instead',
    });
  });

  it('finds 7 PhoFast violations without sprint', () => {
    const files = [
      'src/architecture.c4',
      'src/api/auth/auth.c4',
      'src/api/menu/menu.c4',
      'src/api/orders/orders.c4',
      'src/api/payments/payments.c4',
      'src/api/notify/notify.c4',
      'src/web/pages/pages.c4',
    ];

    const plan = parsePlan(FIXTURE_ROOT, files);
    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT).filter(f => f.rule !== 'plan-unmatched');

    // Should be 7 (no late finding)
    expect(findings).toHaveLength(7);

    // Should not have late finding
    expect(findings.every(f => f.rule !== 'late')).toBe(true);
  });

  it('detects planned-but-built', () => {
    const plan: Plan = {
      files: [],
      elements: [
        {
          id: 'test.component',
          kind: 'component',
          title: 'Test Component',
          description: null,
          technology: null,
          links: [
            {
              raw: './index.ts',
              path: 'src/api/auth/index.ts',
              name: null,
              lines: null,
              title: null,
            },
          ],
          metadata: { status: 'planned' },
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT);

    const plannedBuiltFinding = findings.find(f => f.rule === 'planned-but-built');
    expect(plannedBuiltFinding).toBeDefined();
    expect(plannedBuiltFinding?.severity).toBe('info');
  });

  describe('planned-but-built needs code in the target (b227)', () => {
    let repo: string;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-planned-built-'));
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
    });

    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    };

    const plannedWith = (linkPath: string): Plan => ({
      files: [],
      elements: [
        {
          id: 'app.m',
          kind: 'component',
          title: 'M',
          description: null,
          technology: null,
          links: [{ raw: `./${linkPath}`, path: linkPath, name: null, lines: null, title: null }],
          metadata: { status: 'planned' },
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    });

    const plannedBuiltFor = (linkPath: string) =>
      checkPlan(
        plannedWith(linkPath),
        runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript', 'files'] } }),
        repo
      ).filter(f => f.rule === 'planned-but-built');

    it('an empty index.ts in the folder is not built', () => {
      write('src/m/index.ts', '');
      expect(plannedBuiltFor('src/m/')).toEqual([]);
    });

    it('an index.ts with only a comment is not built', () => {
      write('src/m/index.ts', '// todo\n');
      expect(plannedBuiltFor('src/m/')).toEqual([]);
    });

    it('an index.ts with comments and `export {};` is not built', () => {
      write('src/m/index.ts', '// todo\n/* later */\nexport {};\n');
      expect(plannedBuiltFor('src/m/')).toEqual([]);
    });

    it('an index.ts with only `export {}` (no semicolon) is not built', () => {
      write('src/m/index.ts', 'export {}\n');
      expect(plannedBuiltFor('src/m/')).toEqual([]);
    });

    it('an index.ts with a function is built (info)', () => {
      write('src/m/index.ts', 'export function f() {}\n');
      const findings = plannedBuiltFor('src/m/');
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('info');
    });

    it('an index.ts with `export {};` and a function is built', () => {
      write('src/m/index.ts', 'export {};\nexport function f() {}\n');
      expect(plannedBuiltFor('src/m/')).toHaveLength(1);
    });

    it('an index.ts that only re-exports is built', () => {
      write('src/m/index.ts', "export * from './x';\n");
      expect(plannedBuiltFor('src/m/')).toHaveLength(1);
    });

    it('an index.ts with `export * from` after `export {};` is built', () => {
      write('src/m/index.ts', "export {};\nexport * from './x';\n");
      expect(plannedBuiltFor('src/m/')).toHaveLength(1);
    });

    it('a link to an empty file is not built', () => {
      write('src/m/index.ts', '');
      expect(plannedBuiltFor('src/m/index.ts')).toEqual([]);
    });

    it('a link to a missing path is not built', () => {
      expect(plannedBuiltFor('src/nowhere/')).toEqual([]);
    });

    it('a folder is built when any file under it holds code', () => {
      write('src/m/a.ts', '');
      write('src/m/b.ts', 'export const b = 1;\n');
      expect(plannedBuiltFor('src/m/')).toHaveLength(1);
    });

    it('a non-empty file-only .java file is built', () => {
      write('src/m/A.java', 'class A {}\n');
      expect(plannedBuiltFor('src/m/A.java')).toHaveLength(1);
    });

    it('a whitespace-only file-only .java file is not built', () => {
      write('src/m/A.java', '  \n\n');
      expect(plannedBuiltFor('src/m/A.java')).toEqual([]);
    });
  });

  it('detects abandoned-but-present', () => {
    const plan: Plan = {
      files: [],
      elements: [
        {
          id: 'test.component',
          kind: 'component',
          title: 'Test Component',
          description: null,
          technology: null,
          links: [
            {
              raw: './index.ts',
              path: 'src/api/menu/index.ts',
              name: null,
              lines: null,
              title: null,
            },
          ],
          metadata: { status: 'abandoned' },
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT);

    const abandonedPresentFinding = findings.find(f => f.rule === 'abandoned-but-present');
    expect(abandonedPresentFinding).toBeDefined();
    expect(abandonedPresentFinding?.severity).toBe('warning');
  });

  it('detects broken-function', () => {
    const plan: Plan = {
      files: [],
      elements: [
        {
          id: 'test.component',
          kind: 'component',
          title: 'Test Component',
          description: null,
          technology: null,
          links: [
            {
              raw: './api/auth/index.ts#nonExistentFunction',
              path: 'src/api/auth/index.ts',
              name: 'nonExistentFunction',
              lines: null,
              title: null,
            },
          ],
          metadata: { status: 'done' },
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT);

    const brokenFunctionFinding = findings.find(f => f.rule === 'broken-function');
    expect(brokenFunctionFinding).toBeDefined();
    expect(brokenFunctionFinding?.severity).toBe('warning');
  });

  it('detects parse-error from plan issues', () => {
    const plan: Plan = {
      files: ['test.c4'],
      elements: [
        {
          id: 'test.component',
          kind: 'component',
          title: 'Test',
          description: null,
          technology: null,
          links: [],
          metadata: {},
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [
        { file: 'test.c4', line: 5, message: 'unexpected end of input' },
      ],
    };

    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT);

    const parseErrorFinding = findings.find(f => f.rule === 'parse-error');
    expect(parseErrorFinding).toBeDefined();
    expect(parseErrorFinding?.severity).toBe('warning');
    expect(parseErrorFinding?.message).toBe('test.c4:5 unexpected end of input');
  });

  it('formatFindings produces correct output', () => {
    const findings: PlanFinding[] = [
      {
        severity: 'critical',
        rule: 'missing-code',
        id: 'test.component',
        message: 'Missing code message',
      },
      {
        severity: 'warning',
        rule: 'late',
        id: 'test.other',
        message: 'Late message',
      },
      {
        severity: 'info',
        rule: 'line-link',
        id: 'test.component',
        message: 'Line link message',
      },
    ];

    const output = formatFindings(findings, 'test-repo');

    expect(output).toContain('c4mp check · test-repo · 3 findings (1 critical, 1 warning, 1 info)');
    // Severity padded to 9, rule padded to 16, then id, two spaces, message
    expect(output).toContain('critical missing-code    test.component  Missing code message');
    expect(output).toContain('warning  late            test.other  Late message');
    expect(output).toContain('info     line-link       test.component  Line link message');
  });

  it('formatFindings handles longer rules with padding', () => {
    const findings: PlanFinding[] = [
      {
        severity: 'info',
        rule: 'planned-but-built',
        id: 'sample_shop.api.models',
        message: 'Models is planned but code exists: ../api/src/models/; update the status?',
      },
    ];

    const output = formatFindings(findings, 'sample');

    // planned-but-built is 17 chars, should pad to 18 (17 + 1 space)
    // Assert that there's at least one space between rule and id
    expect(output).toContain('planned-but-built sample_shop.api.models  Models is planned');
  });

  it('returns no findings for plan with no components', () => {
    const plan: Plan = {
      files: [],
      elements: [
        {
          id: 'test.system',
          kind: 'system',
          title: 'Test System',
          description: null,
          technology: null,
          links: [],
          metadata: {},
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const findings = checkPlan(plan, snapshot, FIXTURE_ROOT);

    // Should have no unplanned-code findings since there are no components
    expect(findings.filter(f => f.rule === 'unplanned-code')).toHaveLength(0);
  });

  it('plan-unmatched (B14): reports once (info) with the count for built-looking components that match no scanned node', () => {
    const comp = (id: string, links: string[], status?: string): PlanElement => ({
      id,
      kind: 'component',
      title: id,
      description: null,
      technology: null,
      links: links.map(p => ({ raw: p, path: p, name: null, lines: null, title: null })),
      metadata: status ? { status } : {},
      parent: null,
      source: { file: 'test.c4', line: 1 },
    });
    const plan: Plan = {
      files: ['test.c4'],
      elements: [comp('x.ghost_a', ['src/nowhere/']), comp('x.ghost_b', [], 'done'), comp('x.idea', [], 'planned')],
      relations: [],
      issues: [],
    };
    const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
    const hit = checkPlan(plan, snapshot, FIXTURE_ROOT).filter(f => f.rule === 'plan-unmatched');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('info');
    expect(hit[0].message).toContain('2 plan components match no scanned node');
    expect(hit[0].message).not.toContain('x.idea');
  });

  describe('claim-mode rules (P6-T8)', () => {
    it('produces exactly the four new finding types, no unplanned-code', () => {
      const plan = buildClaimModePlan();
      const snapshot = buildClaimModeSnapshot();
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const rules = new Set(findings.map(f => f.rule));
      expect(rules).toEqual(new Set(['component-claim-conflict', 'split-file', 'shared-auto', 'unassigned-code']));
      expect(findings.some(f => f.rule === 'unplanned-code')).toBe(false);
    });

    it('component-claim-conflict: one warning per OwnershipConflict, naming winner/losers/reason', () => {
      const plan = buildClaimModePlan();
      const snapshot = buildClaimModeSnapshot();
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const conflicts = findings.filter(f => f.rule === 'component-claim-conflict');
      expect(conflicts).toHaveLength(4);
      expect(conflicts.every(f => f.severity === 'warning')).toBe(true);

      const byId = new Map(conflicts.map(f => [f.id, f]));

      expect(byId.get('src/orders/order.ts#createOrder')?.message).toBe(
        'app.orders wins ownership of src/orders/order.ts#createOrder over app.auth (reason: specificity)'
      );
      expect(byId.get('src/orders/order.ts#listOrders')?.message).toBe(
        'app.orders wins ownership of src/orders/order.ts#listOrders over app.auth (reason: specificity)'
      );
      expect(byId.get('src/orders/order.ts#cancelOrder')?.message).toBe(
        'app.payments wins ownership of src/orders/order.ts#cancelOrder over app.auth (reason: specificity)'
      );
      expect(byId.get('src/util.ts#formatDate')?.message).toBe(
        'app.auth wins ownership of src/util.ts#formatDate over app.payments (reason: plan-order)'
      );
    });

    it('split-file: info finding for the file with 2 distinct real owners, naming the minority', () => {
      const plan = buildClaimModePlan();
      const snapshot = buildClaimModeSnapshot();
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const splitFindings = findings.filter(f => f.rule === 'split-file');
      expect(splitFindings).toHaveLength(1);
      expect(splitFindings[0].severity).toBe('info');
      expect(splitFindings[0].id).toBe('src/orders/order.ts');
      expect(splitFindings[0].message).toBe(
        'src/orders/order.ts is split across owners app.orders, app.payments; minority: app.payments (cancelOrder)'
      );
    });

    it('split-file tie: no blank minority text; lists every owner as split evenly (P14-T38a)', () => {
      // Two owners, one function each in the same file -> equal counts -> no minority.
      const plan: Plan = {
        files: ['src/orders.c4', 'src/payments.c4'],
        elements: [
          {
            id: 'app.orders', kind: 'component', title: 'Orders', description: null, technology: null,
            links: [{ raw: './orders/order.ts#createOrder', path: 'src/orders/order.ts', name: 'createOrder', lines: null, title: null }],
            metadata: {}, parent: null, source: { file: 'src/orders.c4', line: 1 },
          },
          {
            id: 'app.payments', kind: 'component', title: 'Payments', description: null, technology: null,
            links: [{ raw: './orders/order.ts#cancelOrder', path: 'src/orders/order.ts', name: 'cancelOrder', lines: null, title: null }],
            metadata: {}, parent: null, source: { file: 'src/payments.c4', line: 1 },
          },
        ],
        relations: [],
        issues: [],
      };
      const base = buildClaimModeSnapshot();
      const snapshot: Snapshot = {
        ...base,
        files: [
          {
            file: 'src/orders/order.ts', lineCount: 20, parseError: false, componentId: 'n/a',
            elements: [
              { name: 'createOrder', kind: 'function', startLine: 1, endLine: 7, lineCount: 7 },
              { name: 'cancelOrder', kind: 'function', startLine: 8, endLine: 14, lineCount: 7 },
            ],
          },
        ],
        fileEdges: [],
      };
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const splitFindings = findings.filter(f => f.rule === 'split-file');
      expect(splitFindings).toHaveLength(1);
      expect(splitFindings[0].message).toBe(
        'src/orders/order.ts is split across owners app.orders, app.payments; split evenly: app.orders (createOrder); app.payments (cancelOrder)'
      );
      expect(splitFindings[0].message).not.toMatch(/minority: ?$/);
    });

    it('shared-auto: info finding per SharedCode entry, naming the function and its users', () => {
      const plan = buildClaimModePlan();
      const snapshot = buildClaimModeSnapshot();
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const sharedFindings = findings.filter(f => f.rule === 'shared-auto');
      expect(sharedFindings).toHaveLength(1);
      expect(sharedFindings[0].severity).toBe('info');
      expect(sharedFindings[0].id).toBe('src/payments.ts#refundPayment');
      expect(sharedFindings[0].message).toBe(
        'src/payments.ts#refundPayment is unclaimed but used by app.orders, app.payments; treated as shared code'
      );
    });

    it('unassigned-code: critical finding per Ownership.unassigned entry', () => {
      const plan = buildClaimModePlan();
      const snapshot = buildClaimModeSnapshot();
      const findings = checkPlan(plan, snapshot, '/test/repo');

      const unassignedFindings = findings.filter(f => f.rule === 'unassigned-code');
      expect(unassignedFindings).toHaveLength(1);
      expect(unassignedFindings[0].severity).toBe('critical');
      expect(unassignedFindings[0].id).toBe('src/util.ts#parseConfig');
      expect(unassignedFindings[0].message).toBe(
        'no component claims src/util.ts#parseConfig and nothing calls it'
      );
    });
  });

  describe('broken-claim-link (P14-T38c)', () => {
    let repo: string;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-broken-claim-link-'));
      fs.mkdirSync(path.join(repo, 'src', 'empty'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'src', 'docs'));
      fs.writeFileSync(path.join(repo, 'src', 'docs', 'readme.md'), '# readme\n');
      fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function foo() {\n  return 1;\n}\n');
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
    });

    const planWithLinks = (links: PlanElement['links']): Plan => ({
      files: [],
      elements: [
        {
          id: 'app.broken',
          kind: 'component',
          title: 'Broken',
          description: null,
          technology: null,
          links,
          metadata: { status: 'done' },
          parent: null,
          source: { file: 'test.c4', line: 1 },
        },
      ],
      relations: [],
      issues: [],
    });

    it('flags a folder link to a folder that exists but has no source files', () => {
      const plan = planWithLinks([
        { raw: './empty/', path: 'src/empty/', name: null, lines: null, title: null },
        { raw: './docs/', path: 'src/docs/', name: null, lines: null, title: null },
      ]);
      const findings = checkPlan(plan, runSnapshot({ repo, write: false, quiet: true }), repo)
        .filter(f => f.rule === 'broken-claim-link');

      expect(findings.every(f => f.severity === 'warning' && f.id === 'app.broken')).toBe(true);
      expect(findings.map(f => f.message).sort()).toEqual([
        './docs/ points to nothing: src/docs/ has no source files',
        './empty/ points to nothing: src/empty/ has no source files',
      ]);
    });

    it('P14-T38d: counts file-only files (languages files) as source files of a folder', () => {
      fs.mkdirSync(path.join(repo, 'src', 'java'));
      fs.writeFileSync(path.join(repo, 'src', 'java', 'A.java'), 'class A {}\n');
      const plan = planWithLinks([
        { raw: './java/', path: 'src/java/', name: null, lines: null, title: null },
        { raw: './empty/', path: 'src/empty/', name: null, lines: null, title: null },
        { raw: './docs/', path: 'src/docs/', name: null, lines: null, title: null },
      ]);
      const messages = (languages: string[]) =>
        checkPlan(plan, runSnapshot({ repo, write: false, quiet: true, config: { languages } }), repo)
          .filter(f => f.rule === 'broken-claim-link')
          .map(f => f.message)
          .sort();

      // With `files`: the java folder has a (file-only) source file; empty and docs-only stay flagged.
      expect(messages(['typescript', 'files'])).toEqual([
        './docs/ points to nothing: src/docs/ has no source files',
        './empty/ points to nothing: src/empty/ has no source files',
      ]);
      // Without `files` the .java file is not scanned, so the folder is still flagged.
      expect(messages(['typescript'])).toContain('./java/ points to nothing: src/java/ has no source files');
    });

    it('does not flag valid file, function, line-range and folder links', () => {
      const plan = planWithLinks([
        { raw: './a.ts', path: 'src/a.ts', name: null, lines: null, title: null },
        { raw: './a.ts#foo', path: 'src/a.ts', name: 'foo', lines: null, title: null },
        { raw: './a.ts#L1-L3', path: 'src/a.ts', name: null, lines: { start: 1, end: 3 }, title: null },
        { raw: './src/', path: 'src/', name: null, lines: null, title: null },
      ]);
      const findings = checkPlan(plan, runSnapshot({ repo, write: false, quiet: true }), repo);

      expect(findings.filter(f => f.rule === 'broken-claim-link')).toEqual([]);
    });
  });

  // b178 part 2: a folder link without the trailing '/' resolves but claims no file (ownership.ts), so check warns.
  describe('folder-link-no-slash (b178)', () => {
    let repo: string;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-folder-link-no-slash-'));
      fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'lib', 'a.ts'), 'export function foo() {\n  return 1;\n}\n');
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
    });

    const findingsFor = (link: PlanElement['links'][number]): PlanFinding[] => {
      const plan: Plan = {
        files: [],
        elements: [{
          id: 'app.lib', kind: 'component', title: 'Lib', description: null, technology: null,
          links: [link], metadata: { status: 'done' }, parent: null, source: { file: 'test.c4', line: 1 },
        }],
        relations: [],
        issues: [],
      };
      return checkPlan(plan, runSnapshot({ repo, write: false, quiet: true }), repo).filter(f => f.rule === 'folder-link-no-slash');
    };

    it.each([
      { name: 'an existing folder without / is flagged once', raw: './lib', p: 'src/lib', count: 1 },
      { name: 'the same folder with / is not flagged', raw: './lib/', p: 'src/lib/', count: 0 },
      { name: 'a missing folder is not flagged (other rules cover it)', raw: './gone', p: 'src/gone', count: 0 },
    ])('$name', ({ raw, p, count }) => {
      const findings = findingsFor({ raw, path: p, name: null, lines: null, title: null });
      expect(findings).toHaveLength(count);
      if (count) {
        expect(findings[0]).toEqual({
          severity: 'warning',
          rule: 'folder-link-no-slash',
          id: 'app.lib',
          message: "./lib is a folder but has no trailing '/': it claims no files; write it as ./lib/",
        });
      }
    });
  });

  describe('folder-mode regression guard (P6-T8)', () => {
    it('PhoFast fixture (file/line links only, no function-name links) still produces the exact same unplanned-code findings, unchanged', () => {
      const files = [
        'src/architecture.c4',
        'src/api/auth/auth.c4',
        'src/api/menu/menu.c4',
        'src/api/orders/orders.c4',
        'src/api/payments/payments.c4',
        'src/api/notify/notify.c4',
        'src/web/pages/pages.c4',
      ];

      const plan = parsePlan(FIXTURE_ROOT, files);
      const snapshot = runSnapshot({ repo: FIXTURE_ROOT, write: false, quiet: true });
      const findings = checkPlan(plan, snapshot, FIXTURE_ROOT, { sprint: 'S15' }).filter(f => f.rule !== 'plan-unmatched');

      // Byte-identical to the "finds all 8 PhoFast violations with sprint S15" test above: none of
      // the four new claim-mode rules should fire (PhoFast has no function-name `#fn` links, so
      // extractClaims() never produces a ClaimKind 'function' claim, so isClaimMode stays false).
      expect(findings).toHaveLength(8);
      expect(findings.filter(f => f.rule === 'unplanned-code')).toHaveLength(2);
      expect(findings.some(f => ['component-claim-conflict', 'split-file', 'shared-auto', 'unassigned-code'].includes(f.rule))).toBe(false);

      expect(findings[1]).toEqual({
        severity: 'critical',
        rule: 'unplanned-code',
        id: 'src/api/loyalty/points.ts',
        message: 'no .c4 element claims this file',
      });
      expect(findings[2]).toEqual({
        severity: 'critical',
        rule: 'unplanned-code',
        id: 'src/web/admin/Dashboard.tsx',
        message: 'no .c4 element claims this file',
      });
    });
  });

  describe('planned function/class/type false signals (P14-L4-3a)', () => {
    const LEVEL4_ROOT = path.join(__dirname, 'fixtures/level4');
    type Link = PlanElement['links'][number];

    const link = (filePath: string, name: string | null): Link => ({
      raw: `../${filePath}${name ? `#${name}` : ''}`,
      path: filePath,
      name,
      lines: null,
      title: null,
    });
    const element = (overrides: Partial<PlanElement>): PlanElement => ({
      id: 'app.x',
      kind: 'function',
      title: 'X',
      description: null,
      technology: null,
      links: [],
      metadata: {},
      parent: null,
      source: { file: 'test.c4', line: 1 },
      ...overrides,
    });
    const checkWith = (elements: PlanElement[]): PlanFinding[] =>
      checkPlan({ files: [], elements, relations: [], issues: [] }, runSnapshot({ repo: LEVEL4_ROOT, write: false, quiet: true }), LEVEL4_ROOT);
    const rulesFor = (findings: PlanFinding[], id: string): string[] =>
      findings.filter(f => f.id === id).map(f => f.rule);

    it('planned function whose file is absent gets no broken-function and no missing-code', () => {
      const findings = checkWith([
        element({ id: 'app.plan_absent', title: 'planFn', metadata: { status: 'planned' }, links: [link('src/planned.ts', 'planFn')] }),
      ]);
      expect(rulesFor(findings, 'app.plan_absent')).not.toContain('broken-function');
      expect(rulesFor(findings, 'app.plan_absent')).not.toContain('missing-code');
    });

    it('planned function in an existing file with the name absent gets no broken-function and no planned-but-built', () => {
      const findings = checkWith([
        element({ id: 'app.plan_name', title: 'nope', metadata: { status: 'planned' }, links: [link('src/built.ts', 'nope')] }),
      ]);
      expect(rulesFor(findings, 'app.plan_name')).not.toContain('broken-function');
      expect(rulesFor(findings, 'app.plan_name')).not.toContain('planned-but-built');
    });

    it('planned type with a link to an existing file gets no broken-function and no planned-but-built', () => {
      const findings = checkWith([
        element({ id: 'app.type', kind: 'type', title: 'Invoice', metadata: { status: 'planned' }, links: [link('src/built.ts', 'Invoice')] }),
      ]);
      expect(rulesFor(findings, 'app.type')).not.toContain('broken-function');
      expect(rulesFor(findings, 'app.type')).not.toContain('planned-but-built');
    });

    it('link-less nested done function whose name exists in the parent file gets no missing-code', () => {
      const findings = checkWith([
        element({ id: 'app.billing', kind: 'component', title: 'Billing', links: [link('src/built.ts', 'buildInvoice')] }),
        element({ id: 'app.billing.build', title: 'buildInvoice', parent: 'app.billing', metadata: { status: 'done' } }),
      ]);
      expect(rulesFor(findings, 'app.billing.build')).not.toContain('missing-code');
    });

    it('a plain component keeps planned-but-built and broken-function', () => {
      const findings = checkWith([
        element({ id: 'app.comp', kind: 'component', title: 'Comp', metadata: { status: 'planned' }, links: [link('src/built.ts', 'nope')] }),
      ]);
      expect(rulesFor(findings, 'app.comp')).toContain('planned-but-built');
      expect(rulesFor(findings, 'app.comp')).toContain('broken-function');
    });

    describe('new rules and stub-in-done by name (P14-L4-3b)', () => {
      const billing = element({ id: 'app.billing', kind: 'component', title: 'Billing', links: [link('src/built.ts', 'buildInvoice')] });

      it('planned function whose file is absent gets planned-not-built', () => {
        const findings = checkWith([
          element({ id: 'app.absent', title: 'planFn', metadata: { status: 'planned', signature: 'planFn(): void' }, links: [link('src/planned.ts', 'planFn')] }),
        ]);
        expect(rulesFor(findings, 'app.absent')).toEqual(['planned-not-built']);
      });

      it('built function with status planned gets planned-built-update-status and not planned-not-built', () => {
        const findings = checkWith([
          element({ id: 'app.built', title: 'buildInvoice', metadata: { status: 'planned', signature: 'buildInvoice(total: number)' }, links: [link('src/built.ts', 'buildInvoice')] }),
        ]);
        expect(rulesFor(findings, 'app.built')).toEqual(['planned-built-update-status']);
      });

      it('stub + planned (and stub + in-progress) gives no planned-not-built, no planned-built-update-status and no stub-in-done', () => {
        for (const status of ['planned', 'in-progress']) {
          const findings = checkWith([
            element({ id: 'app.stub', title: 'stubbed', metadata: { status, signature: 'stubbed(): void' }, links: [link('src/stub.ts', 'stubbed')] }),
          ]);
          expect(rulesFor(findings, 'app.stub')).toEqual([]);
        }
      });

      it('stub + done gives exactly one stub-in-done, and another stub in the same file adds nothing for this element', () => {
        const snapshot = runSnapshot({ repo: LEVEL4_ROOT, write: false, quiet: true });
        const stubFile = snapshot.files.find(f => f.file === 'src/stub.ts')!;
        stubFile.elements.push({ ...stubFile.elements[0], name: 'otherStub' });
        const findings = checkPlan(
          { files: [], elements: [element({ id: 'app.done_stub', title: 'stubbed', metadata: { status: 'done' }, links: [link('src/stub.ts', 'stubbed')] })], relations: [], issues: [] },
          snapshot,
          LEVEL4_ROOT
        );
        const stubFindings = findings.filter(f => f.rule === 'stub-in-done');
        expect(stubFindings).toHaveLength(1);
        expect(stubFindings[0].id).toBe('app.done_stub');
        expect(stubFindings[0].message).toContain('stubbed is done but stubbed is not implemented (');
        expect(stubFindings[0].message).toContain(') in src/stub.ts');
        expect(stubFindings[0].message).not.toContain('otherStub');
      });

      it('link-less nested done function whose name is absent from the parent files gets only missing-code (warning)', () => {
        const findings = checkWith([
          billing,
          element({ id: 'app.billing.nope', title: 'nopeFn', parent: 'app.billing', metadata: { status: 'done', owner: 'K' } }),
        ]);
        expect(rulesFor(findings, 'app.billing.nope')).toEqual(['missing-code']);
        const finding = findings.find(f => f.id === 'app.billing.nope')!;
        expect(finding.severity).toBe('warning');
        expect(finding.message).toBe('nopeFn is done but no function nopeFn was found in the files of app.billing; add a link');
      });

      it('link-less in-progress function with the name absent gets exactly missing-code and planned-not-built', () => {
        const findings = checkWith([
          billing,
          element({ id: 'app.billing.wip', title: 'wipFn', parent: 'app.billing', metadata: { status: 'in-progress' } }),
        ]);
        expect(rulesFor(findings, 'app.billing.wip').sort()).toEqual(['missing-code', 'planned-not-built']);
      });

      it('planned function without signature gets missing-signature; with signature it does not', () => {
        const without = checkWith([
          element({ id: 'app.nosig', title: 'planFn', metadata: { status: 'planned' }, links: [link('src/planned.ts', 'planFn')] }),
        ]);
        expect(rulesFor(without, 'app.nosig')).toContain('missing-signature');

        const withSig = checkWith([
          element({ id: 'app.sig', title: 'planFn', metadata: { status: 'planned', signature: 'planFn(): void' }, links: [link('src/planned.ts', 'planFn')] }),
        ]);
        expect(rulesFor(withSig, 'app.sig')).not.toContain('missing-signature');
      });

      it('element without status gets no new finding', () => {
        const findings = checkWith([
          billing,
          element({ id: 'app.billing.nostatus', title: 'nopeFn', parent: 'app.billing' }),
        ]);
        expect(rulesFor(findings, 'app.billing.nostatus')).toEqual([]);
      });
    });
  });
});

describe('checkPlan code-parse-error', () => {
  it('warns once per snapshot file with parseError', () => {
    const plan = { files: [], elements: [], relations: [], issues: [] } as unknown as Plan;
    const snapshot = {
      files: [
        { file: 'src/ok.ts', lineCount: 1, parseError: false, elements: [] },
        { file: 'src/bad.ts', lineCount: 1, parseError: true, elements: [] },
      ],
      fileEdges: [],
    } as unknown as Snapshot;
    const f = checkPlan(plan, snapshot, os.tmpdir()).filter(x => x.rule === 'code-parse-error');
    expect(f).toEqual([expect.objectContaining({ severity: 'warning', id: 'src/bad.ts' })]);
  });

  describe('components in layers (Phase 28 LK-C)', () => {
    it.each(['layers-claim', 'layers-folder'])('%s: no relation-target-missing and no plan-unmatched (layered components stand in or attach)', (fixture) => {
      const root = path.join(__dirname, 'fixtures', fixture);
      const plan = parsePlan(root, ['c4/plan.c4']);
      const snapshot = runSnapshot({ repo: root, write: false, quiet: true, plan });
      const rules = checkPlan(plan, snapshot, root).map(f => f.rule);
      expect(rules).not.toContain('relation-target-missing');
      expect(rules).not.toContain('plan-unmatched');
    });
  });
});
