import { describe as describeChange, endpointLabel, formatMarkdown, formatText } from '../src/compare/report';
import { Change, SnapshotDiff } from '../src/types';

describe('report', () => {
  describe('endpointLabel', () => {
    it('formats endpoint with commit and commitDate', () => {
      const label = endpointLabel({
        repoName: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        commit: 'abc1234def567',
        commitDate: '2026-01-01T10:00:00+00:00',
      });
      expect(label).toBe('abc1234 (2026-01-01)');
    });

    it('uses createdAt when commitDate is null', () => {
      const label = endpointLabel({
        repoName: 'test',
        createdAt: '2026-01-08T00:00:00.000Z',
        commit: 'xyz9876',
        commitDate: null,
      });
      expect(label).toBe('xyz9876 (2026-01-08)');
    });

    it('formats as no-git when commit is null', () => {
      const label = endpointLabel({
        repoName: 'test',
        createdAt: '2026-01-08T00:00:00.000Z',
        commit: null,
        commitDate: null,
      });
      expect(label).toBe('no-git (2026-01-08)');
    });
  });

  describe('describe', () => {
    it('formats health-worse', () => {
      const change: Change = {
        type: 'health',
        kind: 'modified',
        id: 'unresolved imports',
        before: 0,
        after: 2,
        severity: 'critical',
        rule: 'health-worse',
      };
      expect(describeChange(change)).toBe('unresolved imports increased: 0 → 2');
    });

    it('formats component-grew with ratio', () => {
      const change: Change = {
        type: 'component',
        kind: 'modified',
        id: 'app/orders',
        before: 40,
        after: 120,
        severity: 'warning',
        rule: 'component-grew',
      };
      expect(describeChange(change)).toBe('component grew: app/orders 40 → 120 lines (x3.0)');
    });

    it('formats file-grew with decimal ratio', () => {
      const change: Change = {
        type: 'file',
        kind: 'modified',
        id: 'src/orders/checkout.ts',
        before: 30,
        after: 110,
        severity: 'warning',
        rule: 'file-grew',
      };
      expect(describeChange(change)).toBe('file grew: src/orders/checkout.ts 30 → 110 lines (x3.7)');
    });

    it('formats component-added', () => {
      const change: Change = {
        type: 'component',
        kind: 'added',
        id: 'app/loyalty',
        after: 12,
        severity: 'info',
        rule: 'component-added',
      };
      expect(describeChange(change)).toBe('component added: app/loyalty (12 lines)');
    });

    it('formats component-renamed', () => {
      const change: Change = {
        type: 'component',
        kind: 'renamed',
        id: 'api/utils',
        renamedFrom: 'api/lib',
        before: 6,
        after: 6,
        severity: 'info',
        rule: 'component-renamed',
      };
      expect(describeChange(change)).toBe('component renamed: api/lib → api/utils');
    });

    it('formats edge-added', () => {
      const change: Change = {
        type: 'edge',
        kind: 'added',
        id: 'app/orders -> app/loyalty',
        after: 1,
        severity: 'info',
        rule: 'edge-added',
      };
      expect(describeChange(change)).toBe('dependency added: app/orders -> app/loyalty');
    });

    it('formats element with elementKind=function', () => {
      const change: Change = {
        type: 'element',
        kind: 'added',
        id: 'api/src/payments/stripe.ts#charge',
        elementKind: 'function',
        after: 3,
        severity: 'info',
        rule: 'element-added',
      };
      expect(describeChange(change)).toBe('function added: api/src/payments/stripe.ts#charge (3 lines)');
    });

    it('formats element with elementKind=method', () => {
      const change: Change = {
        type: 'element',
        kind: 'added',
        id: 'api/src/services/orderService.ts#OrderService.bulkCreate',
        elementKind: 'method',
        after: 13,
        severity: 'info',
        rule: 'element-added',
      };
      expect(describeChange(change)).toBe('method added: api/src/services/orderService.ts#OrderService.bulkCreate (13 lines)');
    });

    it('formats element with elementKind=class', () => {
      const change: Change = {
        type: 'element',
        kind: 'modified',
        id: 'api/src/services/orderService.ts#OrderService',
        elementKind: 'class',
        before: 15,
        after: 33,
        severity: 'info',
        rule: 'element-changed',
      };
      expect(describeChange(change)).toBe('class changed: api/src/services/orderService.ts#OrderService 15 → 33 lines');
    });

    it('formats cycle-added', () => {
      const change: Change = {
        type: 'cycle',
        kind: 'added',
        id: 'api/routes <-> api/services',
        severity: 'warning',
        rule: 'cycle-added',
      };
      expect(describeChange(change)).toBe('cycle added: api/routes <-> api/services');
    });

    it('formats external-removed', () => {
      const change: Change = {
        type: 'external',
        kind: 'removed',
        id: 'react',
        severity: 'info',
        rule: 'external-removed',
      };
      expect(describeChange(change)).toBe('package removed: react');
    });
  });

  describe('formatText', () => {
    it('formats synthetic diff exactly', () => {
      const diff: SnapshotDiff = {
        schemaVersion: 1,
        from: {
          repoName: 'demo',
          createdAt: '2026-01-01T00:00:00.000Z',
          commit: 'aaaaaaa1111',
          commitDate: '2026-01-01T10:00:00+00:00',
        },
        to: {
          repoName: 'demo',
          createdAt: '2026-01-08T00:00:00.000Z',
          commit: null,
          commitDate: null,
        },
        summary: {
          componentsAdded: 1,
          componentsRemoved: 0,
          componentsRenamed: 0,
          componentsModified: 1,
          filesAdded: 1,
          filesRemoved: 0,
          filesRenamed: 0,
          filesModified: 1,
          elementsAdded: 2,
          elementsRemoved: 0,
          elementsModified: 0,
          edgesAdded: 1,
          edgesRemoved: 0,
          cyclesAdded: 0,
          cyclesRemoved: 0,
          linesBefore: 100,
          linesAfter: 180,
        },
        changes: [
          {
            type: 'health',
            kind: 'modified',
            id: 'unresolved imports',
            before: 0,
            after: 2,
            severity: 'critical',
            rule: 'health-worse',
          },
          {
            type: 'component',
            kind: 'modified',
            id: 'app/orders',
            before: 40,
            after: 120,
            severity: 'warning',
            rule: 'component-grew',
          },
          {
            type: 'file',
            kind: 'modified',
            id: 'src/orders/checkout.ts',
            before: 30,
            after: 110,
            severity: 'warning',
            rule: 'file-grew',
          },
          {
            type: 'component',
            kind: 'added',
            id: 'app/loyalty',
            after: 12,
            severity: 'info',
            rule: 'component-added',
          },
          {
            type: 'edge',
            kind: 'added',
            id: 'app/orders -> app/loyalty',
            after: 1,
            severity: 'info',
            rule: 'edge-added',
          },
        ],
      };

      const expected =
        'c4mp diff · demo · aaaaaaa (2026-01-01) → no-git (2026-01-08)\n' +
        'Summary: components +1 -0 renamed 0 changed 1 | files +1 -0 renamed 0 changed 1 | functions +2 -0 changed 0 | dependencies +1 -0 | cycles +0 -0 | lines 100 → 180 (+80)\n' +
        '\n' +
        'CRITICAL (1)\n' +
        '  unresolved imports increased: 0 → 2\n' +
        'WARNING (2)\n' +
        '  component grew: app/orders 40 → 120 lines (x3.0)\n' +
        '  file grew: src/orders/checkout.ts 30 → 110 lines (x3.7)\n' +
        'INFO (2)\n' +
        '  component added: app/loyalty (12 lines)\n' +
        '  dependency added: app/orders -> app/loyalty';

      const result = formatText(diff);
      expect(result).toBe(expected);
    });
  });

  describe('formatMarkdown', () => {
    it('formats synthetic diff with empty sections showing None.', () => {
      const diff: SnapshotDiff = {
        schemaVersion: 1,
        from: {
          repoName: 'demo',
          createdAt: '2026-01-01T00:00:00.000Z',
          commit: 'aaaaaaa1111',
          commitDate: '2026-01-01T10:00:00+00:00',
        },
        to: {
          repoName: 'demo',
          createdAt: '2026-01-08T00:00:00.000Z',
          commit: null,
          commitDate: null,
        },
        summary: {
          componentsAdded: 1,
          componentsRemoved: 0,
          componentsRenamed: 0,
          componentsModified: 1,
          filesAdded: 1,
          filesRemoved: 0,
          filesRenamed: 0,
          filesModified: 1,
          elementsAdded: 2,
          elementsRemoved: 0,
          elementsModified: 0,
          edgesAdded: 1,
          edgesRemoved: 0,
          cyclesAdded: 0,
          cyclesRemoved: 0,
          linesBefore: 100,
          linesAfter: 180,
        },
        changes: [
          {
            type: 'health',
            kind: 'modified',
            id: 'unresolved imports',
            before: 0,
            after: 2,
            severity: 'critical',
            rule: 'health-worse',
          },
          {
            type: 'component',
            kind: 'modified',
            id: 'app/orders',
            before: 40,
            after: 120,
            severity: 'warning',
            rule: 'component-grew',
          },
          {
            type: 'file',
            kind: 'modified',
            id: 'src/orders/checkout.ts',
            before: 30,
            after: 110,
            severity: 'warning',
            rule: 'file-grew',
          },
          {
            type: 'component',
            kind: 'added',
            id: 'app/loyalty',
            after: 12,
            severity: 'info',
            rule: 'component-added',
          },
          {
            type: 'edge',
            kind: 'added',
            id: 'app/orders -> app/loyalty',
            after: 1,
            severity: 'info',
            rule: 'edge-added',
          },
        ],
      };

      const result = formatMarkdown(diff);

      // Verify structure
      expect(result).toContain('# Snapshot diff: demo');
      expect(result).toContain('From **aaaaaaa (2026-01-01)** to **no-git (2026-01-08)**');
      expect(result).toContain('## Summary');
      expect(result).toContain('| components | 1 | 0 | 0 | 1 |');
      expect(result).toContain('| files | 1 | 0 | 0 | 1 |');
      expect(result).toContain('| functions | 2 | 0 | – | 0 |');
      expect(result).toContain('| dependencies | 1 | 0 | – | – |');
      expect(result).toContain('| cycles | 0 | 0 | – | – |');
      expect(result).toContain('Lines: 100 → 180 (+80)');
      expect(result).toContain('## Critical (1)');
      expect(result).toContain('- unresolved imports increased: 0 → 2');
      expect(result).toContain('## Warning (2)');
      expect(result).toContain('- component grew: app/orders 40 → 120 lines (x3.0)');
      expect(result).toContain('- file grew: src/orders/checkout.ts 30 → 110 lines (x3.7)');
      expect(result).toContain('## Info (2)');
      expect(result).toContain('- component added: app/loyalty (12 lines)');
      expect(result).toContain('- dependency added: app/orders -> app/loyalty');
    });

    it('shows None. for empty severity sections', () => {
      const diff: SnapshotDiff = {
        schemaVersion: 1,
        from: {
          repoName: 'demo',
          createdAt: '2026-01-01T00:00:00.000Z',
          commit: 'abc1234',
          commitDate: '2026-01-01T00:00:00.000Z',
        },
        to: {
          repoName: 'demo',
          createdAt: '2026-01-02T00:00:00.000Z',
          commit: 'def5678',
          commitDate: '2026-01-02T00:00:00.000Z',
        },
        summary: {
          componentsAdded: 0,
          componentsRemoved: 0,
          componentsRenamed: 0,
          componentsModified: 0,
          filesAdded: 0,
          filesRemoved: 0,
          filesRenamed: 0,
          filesModified: 0,
          elementsAdded: 0,
          elementsRemoved: 0,
          elementsModified: 0,
          edgesAdded: 0,
          edgesRemoved: 0,
          cyclesAdded: 0,
          cyclesRemoved: 0,
          linesBefore: 100,
          linesAfter: 100,
        },
        changes: [],
      };

      const result = formatMarkdown(diff);

      expect(result).toContain('## Critical (0)\n\nNone.');
      expect(result).toContain('## Warning (0)\n\nNone.');
      expect(result).toContain('## Info (0)\n\nNone.');
    });
  });

  describe('answer key tests from §3.2', () => {
    it('formats 6 rows from sample-v2 diff correctly', () => {
      const changes: Change[] = [
        {
          type: 'component',
          kind: 'renamed',
          id: 'api/utils',
          renamedFrom: 'api/lib',
          before: 6,
          after: 6,
          severity: 'info',
          rule: 'component-renamed',
        },
        {
          type: 'file',
          kind: 'renamed',
          id: 'api/src/utils/log.ts',
          renamedFrom: 'api/src/lib/log.ts',
          before: 3,
          after: 3,
          severity: 'info',
          rule: 'file-renamed',
        },
        {
          type: 'element',
          kind: 'added',
          id: 'api/src/payments/stripe.ts#charge',
          elementKind: 'function',
          after: 3,
          severity: 'info',
          rule: 'element-added',
        },
        {
          type: 'element',
          kind: 'modified',
          id: 'api/src/services/orderService.ts#OrderService',
          elementKind: 'class',
          before: 15,
          after: 33,
          severity: 'info',
          rule: 'element-changed',
        },
        {
          type: 'cycle',
          kind: 'added',
          id: 'api/routes <-> api/services',
          severity: 'warning',
          rule: 'cycle-added',
        },
        {
          type: 'external',
          kind: 'removed',
          id: 'react',
          severity: 'info',
          rule: 'external-removed',
        },
      ];

      const texts = changes.map((c) => describeChange(c));

      expect(texts[0]).toBe('component renamed: api/lib → api/utils');
      expect(texts[1]).toBe('file renamed: api/src/lib/log.ts → api/src/utils/log.ts');
      expect(texts[2]).toBe('function added: api/src/payments/stripe.ts#charge (3 lines)');
      expect(texts[3]).toBe('class changed: api/src/services/orderService.ts#OrderService 15 → 33 lines');
      expect(texts[4]).toBe('cycle added: api/routes <-> api/services');
      expect(texts[5]).toBe('package removed: react');
    });
  });
});
