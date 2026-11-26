import { extractClaims, resolveOwnership } from '../src/c4/ownership';
import type { Plan, PlanElement, SnapshotFile, FileEdge } from '../src/types';

/**
 * Fixture scenario (3 files, 3 plan elements, 5 functions):
 *
 *  - src/orders/order.ts   #createOrder    -> function claim (app.orders) beats a folder claim
 *                                              (app.auth) on the same function -> specificity conflict
 *  - src/payments.ts       #createPayment  -> cleanly owned by a single function claim (app.payments)
 *                          #refundPayment  -> no claim at all, but order.ts (owned) imports payments.ts
 *                                              -> shared-auto
 *  - src/util.ts           #formatDate     -> two elements (app.auth, app.payments) each claim this
 *                                              exact function -> tie at same specificity -> plan-order conflict
 *                          #parseConfig    -> no claim, no importer -> unassigned
 */
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
      ],
      metadata: {},
      parent: null,
      source: { file: 'src/payments.c4', line: 1 },
    },
  ];

  return { files: ['src/auth.c4', 'src/orders.c4', 'src/payments.c4'], elements, relations: [], issues: [] };
}

function buildFiles(): SnapshotFile[] {
  return [
    {
      file: 'src/orders/order.ts',
      lineCount: 10,
      parseError: false,
      componentId: 'n/a',
      elements: [{ name: 'createOrder', kind: 'function', startLine: 1, endLine: 10, lineCount: 10 }],
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

function buildFileEdges(): FileEdge[] {
  // order.ts (owned by app.orders) imports payments.ts -> refundPayment becomes shared-auto.
  return [{ from: 'src/orders/order.ts', to: 'src/payments.ts' }];
}

describe('extractClaims', () => {
  it('derives claim kind from link shape and preserves claimIndex/order', () => {
    const claims = extractClaims(buildPlan());

    expect(claims).toEqual([
      { kind: 'folder', path: 'src/orders/', fn: null, elementId: 'app.auth', claimIndex: 0 },
      { kind: 'function', path: 'src/util.ts', fn: 'formatDate', elementId: 'app.auth', claimIndex: 1 },
      { kind: 'function', path: 'src/orders/order.ts', fn: 'createOrder', elementId: 'app.orders', claimIndex: 0 },
      { kind: 'function', path: 'src/payments.ts', fn: 'createPayment', elementId: 'app.payments', claimIndex: 0 },
      { kind: 'function', path: 'src/util.ts', fn: 'formatDate', elementId: 'app.payments', claimIndex: 1 },
    ]);
  });

  it('ignores non-component elements', () => {
    const plan = buildPlan();
    plan.elements.push({
      id: 'app',
      kind: 'system',
      title: 'App',
      description: null,
      technology: null,
      links: [{ raw: './', path: 'src/', name: null, lines: null, title: null }],
      metadata: {},
      parent: null,
      source: { file: 'src/app.c4', line: 1 },
    });

    const claims = extractClaims(plan);
    expect(claims.find((c) => c.elementId === 'app')).toBeUndefined();
  });
});

describe('resolveOwnership', () => {
  const claims = extractClaims(buildPlan());
  const ownership = resolveOwnership(claims, buildFiles(), buildFileEdges());

  it('specificity: a function claim beats a folder claim from a different element', () => {
    expect(ownership.owner['src/orders/order.ts#createOrder']).toBe('app.orders');

    const conflict = ownership.conflicts.find((c) => c.file === 'src/orders/order.ts' && c.fn === 'createOrder');
    expect(conflict).toEqual({
      file: 'src/orders/order.ts',
      fn: 'createOrder',
      winner: 'app.orders',
      losers: ['app.auth'],
      reason: 'specificity',
    });
  });

  it('cleanly owns a function with exactly one matching claim', () => {
    expect(ownership.owner['src/payments.ts#createPayment']).toBe('app.payments');
    expect(ownership.conflicts.find((c) => c.fn === 'createPayment')).toBeUndefined();
  });

  it('plan-order: two elements claim the same function at the same specificity', () => {
    expect(ownership.owner['src/util.ts#formatDate']).toBe('app.auth');

    const conflict = ownership.conflicts.find((c) => c.file === 'src/util.ts' && c.fn === 'formatDate');
    expect(conflict).toEqual({
      file: 'src/util.ts',
      fn: 'formatDate',
      winner: 'app.auth',
      losers: ['app.payments'],
      reason: 'plan-order',
    });
  });

  it('shared: an unclaimed function imported by an owned file becomes shared-auto', () => {
    expect(ownership.owner['src/payments.ts#refundPayment']).toBe('shared-auto');
    expect(ownership.shared).toContainEqual({ fn: 'src/payments.ts#refundPayment', users: ['app.orders'] });
  });

  it('unassigned: a function with no claim and no importer', () => {
    expect(ownership.owner['src/util.ts#parseConfig']).toBe('unassigned');
    expect(ownership.unassigned).toContain('src/util.ts#parseConfig');
  });

  it('owner record covers every function exactly once', () => {
    expect(Object.keys(ownership.owner).sort()).toEqual([
      'src/orders/order.ts#createOrder',
      'src/payments.ts#createPayment',
      'src/payments.ts#refundPayment',
      'src/util.ts#formatDate',
      'src/util.ts#parseConfig',
    ]);
  });

  it('no zero-function file -> no fileOwner key', () => {
    expect('fileOwner' in ownership).toBe(false);
  });
});

describe('resolveOwnership: zero-function files (fileOwner)', () => {
  const emptyFile = (file: string): SnapshotFile => ({ file, lineCount: 3, parseError: false, componentId: 'n/a', elements: [] });
  const fnFile = (file: string): SnapshotFile => ({
    file,
    lineCount: 3,
    parseError: false,
    componentId: 'n/a',
    elements: [{ name: 'f', kind: 'function', startLine: 1, endLine: 3, lineCount: 3 }],
  });

  it('folder claim owns a zero-function file under it', () => {
    const claims = [{ kind: 'folder' as const, path: 'svc/', fn: null, elementId: 'a', claimIndex: 0 }];
    const o = resolveOwnership(claims, [emptyFile('svc/A.java')], []);
    expect(o.fileOwner).toEqual({ 'svc/A.java': 'a' });
    expect(o.conflicts).toEqual([]);
  });

  it('file claim beats a folder claim from another element (specificity)', () => {
    const claims = [
      { kind: 'folder' as const, path: 'svc/', fn: null, elementId: 'a', claimIndex: 0 },
      { kind: 'file' as const, path: 'svc/A.java', fn: null, elementId: 'b', claimIndex: 0 },
    ];
    const o = resolveOwnership(claims, [emptyFile('svc/A.java')], []);
    expect(o.fileOwner).toEqual({ 'svc/A.java': 'b' });
    expect(o.conflicts).toEqual([{ file: 'svc/A.java', fn: null, winner: 'b', losers: ['a'], reason: 'specificity' }]);
  });

  it('equal specificity: first in plan order wins, one plan-order conflict with fn null', () => {
    const claims = [
      { kind: 'folder' as const, path: 'svc/', fn: null, elementId: 'a', claimIndex: 0 },
      { kind: 'folder' as const, path: 'svc/', fn: null, elementId: 'b', claimIndex: 0 },
    ];
    const o = resolveOwnership(claims, [emptyFile('svc/A.java')], []);
    expect(o.fileOwner).toEqual({ 'svc/A.java': 'a' });
    expect(o.conflicts).toEqual([{ file: 'svc/A.java', fn: null, winner: 'a', losers: ['b'], reason: 'plan-order' }]);
  });

  it('unclaimed zero-function file and files with functions get no entry; function claims never match', () => {
    const claims = [
      { kind: 'folder' as const, path: 'svc/', fn: null, elementId: 'a', claimIndex: 0 },
      { kind: 'function' as const, path: 'other/B.java', fn: 'f', elementId: 'b', claimIndex: 0 },
    ];
    const o = resolveOwnership(claims, [emptyFile('lib/X.java'), emptyFile('other/B.java'), fnFile('svc/C.ts')], []);
    expect('fileOwner' in o).toBe(false);
  });
});
