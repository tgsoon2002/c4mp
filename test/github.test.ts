import { exitCodeFor, formatGithubDiff, formatGithubFindings, isFilePath, severityAtLeast } from '../src/report/github';
import { formatDiff } from '../src/report/diff';
import type { DiffFormat } from '../src/report/diff';
import { formatMarkdown, formatText } from '../src/compare/index';
import { PlanFinding, Severity, SnapshotDiff } from '../src/types';

/** Synthetic diff: 1 critical, 1 warning, 2 info. */
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

describe('github', () => {
  describe('severityAtLeast', () => {
    it('failOn none always returns false', () => {
      expect(severityAtLeast('critical', 'none')).toBe(false);
      expect(severityAtLeast('warning', 'none')).toBe(false);
      expect(severityAtLeast('info', 'none')).toBe(false);
    });

    it('failOn critical only returns true for critical', () => {
      expect(severityAtLeast('critical', 'critical')).toBe(true);
      expect(severityAtLeast('warning', 'critical')).toBe(false);
      expect(severityAtLeast('info', 'critical')).toBe(false);
    });

    it('failOn warning returns true for warning and critical', () => {
      expect(severityAtLeast('critical', 'warning')).toBe(true);
      expect(severityAtLeast('warning', 'warning')).toBe(true);
      expect(severityAtLeast('info', 'warning')).toBe(false);
    });
  });

  describe('exitCodeFor', () => {
    it('returns 0 when failOn is none regardless of severities', () => {
      expect(exitCodeFor([], 'none')).toBe(0);
      expect(exitCodeFor(['info'], 'none')).toBe(0);
      expect(exitCodeFor(['warning'], 'none')).toBe(0);
      expect(exitCodeFor(['critical'], 'none')).toBe(0);
    });

    it('returns 1 when failOn is critical and critical present', () => {
      expect(exitCodeFor(['critical'], 'critical')).toBe(1);
      expect(exitCodeFor(['critical', 'warning', 'info'], 'critical')).toBe(1);
    });

    it('returns 0 when failOn is critical but no critical', () => {
      expect(exitCodeFor([], 'critical')).toBe(0);
      expect(exitCodeFor(['info'], 'critical')).toBe(0);
      expect(exitCodeFor(['warning', 'info'], 'critical')).toBe(0);
    });

    it('returns 1 when failOn is warning and warning or critical present', () => {
      expect(exitCodeFor(['warning'], 'warning')).toBe(1);
      expect(exitCodeFor(['critical'], 'warning')).toBe(1);
      expect(exitCodeFor(['critical', 'warning', 'info'], 'warning')).toBe(1);
    });

    it('returns 0 when failOn is warning but only info', () => {
      expect(exitCodeFor([], 'warning')).toBe(0);
      expect(exitCodeFor(['info'], 'warning')).toBe(0);
    });
  });

  describe('formatGithubDiff', () => {
    it('formats synthetic diff with 1 critical, 1 warning, 2 info', () => {
      const result = formatGithubDiff(diff);

      // Check annotations
      expect(result).toContain('::error title=c4mp::unresolved imports increased: 0 → 2');
      expect(result).toContain('::warning title=c4mp::component grew: app/orders 40 → 120 lines (x3.0)');

      // Check markdown structure
      expect(result).toContain('### c4mp drift: demo');
      expect(result).toContain('aaaaaaa (2026-01-01) → no-git (2026-01-08)');
      expect(result).toContain('Summary: components +1 -0 renamed 0 changed 1');
      expect(result).toContain('**CRITICAL (1)**');
      expect(result).toContain('**WARNING (1)**');
      expect(result).toContain('**2 info changes**');

      // Verify annotations come before markdown
      const annotationIndex = result.indexOf('::error');
      const markdownIndex = result.indexOf('### c4mp drift:');
      expect(annotationIndex).toBeLessThan(markdownIndex);
    });
  });

  describe('formatDiff', () => {
    it.each<[string, (d: SnapshotDiff) => string]>([
      ['text', formatText],
      ['markdown', formatMarkdown],
      ['github', formatGithubDiff],
      ['unknown', formatText],
    ])('%s gives the same text as its formatter', (format, formatter) => {
      expect(formatDiff(diff, format as DiffFormat)).toBe(formatter(diff));
    });
  });

  describe('formatGithubFindings', () => {
    it('formats PhoFast findings with 3 errors, 2 warnings, and info', () => {
      const findings: PlanFinding[] = [
        {
          severity: 'critical',
          rule: 'missing-code',
          id: 'phofast.api.payments',
          message: 'Payment Service is done but its code is missing: src/api/payments/stripe.ts',
        },
        {
          severity: 'critical',
          rule: 'unplanned-code',
          id: 'src/api/loyalty/points.ts',
          message: 'no .c4 element claims this file',
        },
        {
          severity: 'critical',
          rule: 'unplanned-code',
          id: 'src/web/admin/Dashboard.tsx',
          message: 'no .c4 element claims this file',
        },
        {
          severity: 'warning',
          rule: 'late',
          id: 'phofast.api.notify',
          message: 'Notification Service is planned in sprint S14 (current S15)',
        },
        {
          severity: 'warning',
          rule: 'stub-in-done',
          id: 'phofast.api.auth',
          message: 'Auth Service is done but revokeToken is not implemented (todo) in src/api/auth/index.ts',
        },
        {
          severity: 'info',
          rule: 'line-link',
          id: 'phofast.api.auth',
          message: 'link uses line numbers (./index.ts#L6-L13); they shift on every edit, so link a function name instead',
        },
        {
          severity: 'info',
          rule: 'line-link',
          id: 'phofast.api.orders',
          message: 'link uses line numbers (./index.ts#L7-L14); they shift on every edit, so link a function name instead',
        },
        {
          severity: 'info',
          rule: 'line-link',
          id: 'phofast.web.checkout',
          message: 'link uses line numbers (./Checkout.tsx#L3-L14); they shift on every edit, so link a function name instead',
        },
      ];

      const result = formatGithubFindings(findings, 'phofast');

      // Count error and warning annotations
      const errorCount = (result.match(/::error file=/g) || []).length;
      const warningCount = (result.match(/::warning/g) || []).length;

      // Should have 3 errors (2 with file=)
      expect(errorCount).toBe(2); // Only unplanned-code has file=
      expect(result).toContain('::error title=c4mp missing-code::Payment Service is done but its code is missing: src/api/payments/stripe.ts');
      expect(result).toContain('::error file=src/api/loyalty/points.ts,title=c4mp unplanned-code::no .c4 element claims this file');
      expect(result).toContain('::error file=src/web/admin/Dashboard.tsx,title=c4mp unplanned-code::no .c4 element claims this file');

      // Should have 2 warnings
      expect(warningCount).toBe(2);
      expect(result).toContain('::warning title=c4mp late::Notification Service is planned in sprint S14 (current S15)');
      expect(result).toContain('::warning title=c4mp stub-in-done::Auth Service is done but revokeToken is not implemented (todo) in src/api/auth/index.ts');

      // Check markdown structure
      expect(result).toContain('### c4mp check: phofast');
      expect(result).toContain('**CRITICAL (3)**');
      expect(result).toContain('**WARNING (2)**');
      expect(result).toContain('**3 info findings**');
    });

    it('escapes special characters in messages', () => {
      const findings: PlanFinding[] = [
        {
          severity: 'critical',
          rule: 'test-rule',
          id: 'element.id',
          message: 'Message with % and\nnewline and\rreturn',
        },
      ];

      const result = formatGithubFindings(findings, 'test-repo');

      expect(result).toContain('::error title=c4mp test-rule::Message with %25 and%0Anewline and%0Dreturn');
    });
  });

  describe('isFilePath', () => {
    it.each(['a.ts', 'a.py', 'a.c4', 'src/a.rs', 'src/A.cs', 'src/a.php', 'src/a.cpp', 'src/a.swift'])('%s is a file', (id) => {
      expect(isFilePath(id)).toBe(true);
    });
    it.each(['phofast.api.payments', 'shop.api', 'src/api/'])('%s is not a file', (id) => {
      expect(isFilePath(id)).toBe(false);
    });
  });
});
