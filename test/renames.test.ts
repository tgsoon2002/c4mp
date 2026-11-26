import { detectRenames, relativeFiles, similarity } from '../src/compare/renames';
import { Component } from '../src/types';

describe('renames', () => {
  describe('relativeFiles', () => {
    it('strips component path from files', () => {
      const component: Component = {
        id: 'api/lib',
        name: 'Lib',
        containerId: 'api',
        path: 'api/src/lib',
        files: ['api/src/lib/log.ts', 'api/src/lib/missing-user.ts'],
      };

      const result = relativeFiles(component);
      expect(result).toEqual(['log.ts', 'missing-user.ts']);
    });

    it('returns sorted relative files', () => {
      const component: Component = {
        id: 'test/comp',
        name: 'Test',
        containerId: 'test',
        path: 'test/src',
        files: ['test/src/z.ts', 'test/src/a.ts', 'test/src/m.ts'],
      };

      const result = relativeFiles(component);
      expect(result).toEqual(['a.ts', 'm.ts', 'z.ts']);
    });
  });

  describe('similarity', () => {
    it('computes Jaccard similarity correctly', () => {
      // Both have same 2 files
      expect(similarity(['log.ts', 'missing-user.ts'], ['log.ts', 'missing-user.ts'])).toBe(1.0);

      // One file in common
      expect(similarity(['log.ts', 'missing-user.ts'], ['log.ts', 'other.ts'])).toBe(1 / 3);

      // No files in common
      expect(similarity(['a.ts'], ['b.ts'])).toBe(0);
    });

    it('returns 0 when both arrays are empty', () => {
      expect(similarity([], [])).toBe(0);
    });

    it('handles one empty array', () => {
      expect(similarity(['a.ts'], [])).toBe(0);
      expect(similarity([], ['b.ts'])).toBe(0);
    });
  });

  describe('detectRenames', () => {
    it('detects rename with 1.0 similarity from fixture case', () => {
      const removed: Component[] = [
        {
          id: 'api/lib',
          name: 'Lib',
          containerId: 'api',
          path: 'api/src/lib',
          files: ['api/src/lib/log.ts', 'api/src/lib/missing-user.ts'],
        },
        {
          id: 'web/components',
          name: 'Components',
          containerId: 'web',
          path: 'web/src/components',
          files: ['web/src/components/Cart.jsx'],
        },
      ];

      const added: Component[] = [
        {
          id: 'api/payments',
          name: 'Payments',
          containerId: 'api',
          path: 'api/src/payments',
          files: ['api/src/payments/stripe.ts'],
        },
        {
          id: 'api/utils',
          name: 'Utils',
          containerId: 'api',
          path: 'api/src/utils',
          files: ['api/src/utils/log.ts', 'api/src/utils/missing-user.ts'],
        },
      ];

      const result = detectRenames(removed, added);
      expect(result).toEqual({ 'api/lib': 'api/utils' });
    });

    it('does not rename when similarity is below threshold', () => {
      const removed: Component[] = [
        {
          id: 'comp/a',
          name: 'A',
          containerId: 'comp',
          path: 'comp/a',
          files: ['comp/a/x.ts', 'comp/a/y.ts'],
        },
      ];

      const added: Component[] = [
        {
          id: 'comp/b',
          name: 'B',
          containerId: 'comp',
          path: 'comp/b',
          files: ['comp/b/x.ts', 'comp/b/z.ts'],
        },
      ];

      // Similarity is 1/3 which is < 0.7
      const result = detectRenames(removed, added);
      expect(result).toEqual({});
    });

    it('assigns highest scoring candidate when two compete for same old', () => {
      const removed: Component[] = [
        {
          id: 'comp/old',
          name: 'Old',
          containerId: 'comp',
          path: 'comp/old',
          files: ['comp/old/shared.ts', 'comp/old/a.ts'],
        },
      ];

      const added: Component[] = [
        {
          id: 'comp/new1',
          name: 'New1',
          containerId: 'comp',
          path: 'comp/new1',
          files: ['comp/new1/shared.ts', 'comp/new1/x.ts'], // 1/3 = 0.33 (too low anyway)
        },
        {
          id: 'comp/new2',
          name: 'New2',
          containerId: 'comp',
          path: 'comp/new2',
          files: ['comp/new2/shared.ts', 'comp/new2/a.ts'], // 2/2 = 1.0
        },
      ];

      const result = detectRenames(removed, added);
      // new2 has higher score (1.0 vs 0.33)
      expect(result).toEqual({ 'comp/old': 'comp/new2' });
    });

    it('returns empty object when no matches', () => {
      const removed: Component[] = [
        {
          id: 'comp/a',
          name: 'A',
          containerId: 'comp',
          path: 'comp/a',
          files: ['comp/a/a.ts'],
        },
      ];

      const added: Component[] = [
        {
          id: 'comp/b',
          name: 'B',
          containerId: 'comp',
          path: 'comp/b',
          files: ['comp/b/b.ts'],
        },
      ];

      const result = detectRenames(removed, added);
      expect(result).toEqual({});
    });
  });
});
