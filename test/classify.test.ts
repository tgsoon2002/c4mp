import { classify, sortChanges } from '../src/compare/classify';
import type { Change, RawChange } from '../src/types';

describe('classify', () => {
  it('should classify health metric getting worse as critical', () => {
    const raw: RawChange[] = [
      { type: 'health', kind: 'modified', id: 'unresolved imports', before: 1, after: 2 },
    ];
    const result = classify(raw);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
    expect(result[0].rule).toBe('health-worse');
  });

  it('should classify health metric getting better as info', () => {
    const raw: RawChange[] = [
      { type: 'health', kind: 'modified', id: 'parse errors', before: 2, after: 0 },
    ];
    const result = classify(raw);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('health-better');
  });

  it('should classify container added as info', () => {
    const raw: RawChange[] = [
      { type: 'container', kind: 'added', id: 'api' },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('container-added');
  });

  it('should classify container removed as warning', () => {
    const raw: RawChange[] = [
      { type: 'container', kind: 'removed', id: 'api', before: 1 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('container-removed');
  });

  it('should classify component added as info', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'added', id: 'api/payments', after: 5 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('component-added');
  });

  it('should classify component removed as warning', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'removed', id: 'web/components', before: 14 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('component-removed');
  });

  it('should classify component renamed as info', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'renamed', id: 'api/utils', renamedFrom: 'api/lib', before: 6, after: 6 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('component-renamed');
  });

  it('should classify component grew (17→36) as warning', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'modified', id: 'api/services', before: 17, after: 36 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('component-grew');
  });

  it('should classify component shrank (40→15) as warning', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'modified', id: 'web/_root', before: 40, after: 15 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('component-shrank');
  });

  it('should classify component changed (10→12) as info', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'modified', id: 'api/routes', before: 10, after: 12 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('component-changed');
  });

  it('should NOT classify 10→20 as grew (delta 10 < 15)', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'modified', id: 'test', before: 10, after: 20 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('component-changed');
  });

  it('should classify 20→40 as grew (delta 20 >= 15, after >= before * 2)', () => {
    const raw: RawChange[] = [
      { type: 'component', kind: 'modified', id: 'test', before: 20, after: 40 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('component-grew');
  });

  it('should classify file added as info', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'added', id: 'api/src/payments/stripe.ts', after: 5 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('file-added');
  });

  it('should classify file removed as info', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'removed', id: 'web/src/components/Cart.jsx', before: 14 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('file-removed');
  });

  it('should classify file renamed as info', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'renamed', id: 'api/src/utils/log.ts', renamedFrom: 'api/src/lib/log.ts', before: 3, after: 3 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('file-renamed');
  });

  it('should classify file grew as warning', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'modified', id: 'api/src/services/orderService.ts', before: 17, after: 36 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('file-grew');
  });

  it('should classify file shrank as warning', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'modified', id: 'test.ts', before: 30, after: 10 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('file-shrank');
  });

  it('should classify file changed as info', () => {
    const raw: RawChange[] = [
      { type: 'file', kind: 'modified', id: 'api/src/routes/orders.ts', before: 10, after: 12 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('file-changed');
  });

  it('should classify element added as info', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'added', id: 'api/src/payments/stripe.ts#charge', elementKind: 'function', after: 3 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('element-added');
  });

  it('should classify element removed as info', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'removed', id: 'web/src/components/Cart.jsx#Cart', elementKind: 'function', before: 3 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('element-removed');
  });

  it('should classify class element changed (15→40) as info', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'modified', id: 'api/src/services/orderService.ts#OrderService', elementKind: 'class', before: 15, after: 40 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('element-changed');
  });

  it('should classify method grew (15→40) as warning', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'modified', id: 'test.ts#MyClass.method', elementKind: 'method', before: 15, after: 40 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('element-grew');
  });

  it('should classify function grew as warning', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'modified', id: 'api/src/routes/orders.ts#orderRoutes', elementKind: 'function', before: 7, after: 22 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('element-grew');
  });

  it('should classify element changed as info', () => {
    const raw: RawChange[] = [
      { type: 'element', kind: 'modified', id: 'api/src/routes/orders.ts#orderRoutes', elementKind: 'function', before: 7, after: 8 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('element-changed');
  });

  it('should classify edge added as info', () => {
    const raw: RawChange[] = [
      { type: 'edge', kind: 'added', id: 'api/routes -> api/payments', after: 1 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('edge-added');
  });

  it('should classify edge removed as info', () => {
    const raw: RawChange[] = [
      { type: 'edge', kind: 'removed', id: 'web/_root -> web/components', before: 1 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('edge-removed');
  });

  it('should classify edge modified as info', () => {
    const raw: RawChange[] = [
      { type: 'edge', kind: 'modified', id: 'api/routes -> api/services', before: 1, after: 2 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('edge-changed');
  });

  it('should classify cycle added as warning', () => {
    const raw: RawChange[] = [
      { type: 'cycle', kind: 'added', id: 'api/routes <-> api/services' },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('warning');
    expect(result[0].rule).toBe('cycle-added');
  });

  it('should classify cycle removed as info', () => {
    const raw: RawChange[] = [
      { type: 'cycle', kind: 'removed', id: 'web/_root <-> web/components' },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('cycle-removed');
  });

  it('should classify external added as info', () => {
    const raw: RawChange[] = [
      { type: 'external', kind: 'added', id: 'stripe' },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('external-added');
  });

  it('should classify external removed as info', () => {
    const raw: RawChange[] = [
      { type: 'external', kind: 'removed', id: 'react' },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('external-removed');
  });

  it('should sort changes by severity, type, then id', () => {
    const raw: RawChange[] = [
      { type: 'external', kind: 'added', id: 'stripe' },
      { type: 'health', kind: 'modified', id: 'unresolved imports', before: 1, after: 2 },
      { type: 'component', kind: 'modified', id: 'api/routes', before: 10, after: 12 },
      { type: 'cycle', kind: 'added', id: 'api/routes <-> api/services' },
      { type: 'container', kind: 'removed', id: 'api', before: 1 },
    ];
    const result = classify(raw);

    // Expected order: critical (health), warning (container, cycle), info (component, external)
    expect(result[0].severity).toBe('critical');
    expect(result[0].type).toBe('health');

    expect(result[1].severity).toBe('warning');
    expect(result[1].type).toBe('container'); // container comes before cycle in TYPE_ORDER

    expect(result[2].severity).toBe('warning');
    expect(result[2].type).toBe('cycle');

    expect(result[3].severity).toBe('info');
    expect(result[3].type).toBe('component');

    expect(result[4].severity).toBe('info');
    expect(result[4].type).toBe('external');
  });

  it('should sort by id when severity and type are the same', () => {
    const raw: RawChange[] = [
      { type: 'external', kind: 'added', id: 'zebra' },
      { type: 'external', kind: 'added', id: 'apple' },
      { type: 'external', kind: 'added', id: 'banana' },
    ];
    const result = classify(raw);

    expect(result[0].id).toBe('apple');
    expect(result[1].id).toBe('banana');
    expect(result[2].id).toBe('zebra');
  });

  it('should not mutate the input array during sort', () => {
    const raw: RawChange[] = [
      { type: 'external', kind: 'added', id: 'c' },
      { type: 'external', kind: 'added', id: 'a' },
      { type: 'external', kind: 'added', id: 'b' },
    ];
    const classified = raw.map((r) => ({
      ...r,
      severity: 'info' as const,
      rule: 'test',
    }));
    const sorted = sortChanges(classified);

    // Original should not be sorted
    expect(classified[0].id).toBe('c');
    expect(classified[1].id).toBe('a');
    expect(classified[2].id).toBe('b');

    // Result should be sorted
    expect(sorted[0].id).toBe('a');
    expect(sorted[1].id).toBe('b');
    expect(sorted[2].id).toBe('c');
  });

  it('should handle edge case: health 0→1 as critical', () => {
    const raw: RawChange[] = [
      { type: 'health', kind: 'modified', id: 'parse errors', before: 0, after: 1 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('critical');
    expect(result[0].rule).toBe('health-worse');
  });

  it('should handle edge case: health 1→0 as info', () => {
    const raw: RawChange[] = [
      { type: 'health', kind: 'modified', id: 'unresolved imports', before: 1, after: 0 },
    ];
    const result = classify(raw);
    expect(result[0].severity).toBe('info');
    expect(result[0].rule).toBe('health-better');
  });
});
