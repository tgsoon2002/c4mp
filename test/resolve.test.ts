import * as path from 'path';
import { createResolver } from '../src/languages/typescript/resolve';

const fixtureRoot = path.join(__dirname, 'fixtures/sample');

const sourceFiles = [
  'api/src/lib/log.ts',
  'api/src/lib/missing-user.ts',
  'api/src/models/order.ts',
  'api/src/routes/orders.ts',
  'api/src/server.ts',
  'api/src/services/orderService.ts',
  'web/src/App.tsx',
  'web/src/components/Cart.jsx',
];

describe('resolve', () => {
  const resolver = createResolver(fixtureRoot, sourceFiles);

  describe('fixture Answer Key (11 rows)', () => {
    it('should resolve all 11 Answer Key rows correctly', () => {
      const tests = [
        // Row 1: express → external
        { from: 'api/src/server.ts', spec: 'express', status: 'external', pkg: 'express' },
        // Row 2: ./routes/orders → internal
        { from: 'api/src/server.ts', spec: './routes/orders', status: 'internal', target: 'api/src/routes/orders.ts' },
        // Row 3: ./lib/log → internal
        { from: 'api/src/server.ts', spec: './lib/log', status: 'internal', target: 'api/src/lib/log.ts' },
        // Row 4: ../services/orderService → internal
        { from: 'api/src/routes/orders.ts', spec: '../services/orderService', status: 'internal', target: 'api/src/services/orderService.ts' },
        // Row 5: @lib/log → internal (via tsconfig.json paths)
        { from: 'api/src/routes/orders.ts', spec: '@lib/log', status: 'internal', target: 'api/src/lib/log.ts' },
        // Row 6: ../models/order → internal
        { from: 'api/src/services/orderService.ts', spec: '../models/order', status: 'internal', target: 'api/src/models/order.ts' },
        // Row 7: ./does-not-exist → unresolved
        { from: 'api/src/lib/missing-user.ts', spec: './does-not-exist', status: 'unresolved' },
        // Row 8: ./components/Cart → internal
        { from: 'web/src/App.tsx', spec: './components/Cart', status: 'internal', target: 'web/src/components/Cart.jsx' },
        // Row 9: react → external
        { from: 'web/src/components/Cart.jsx', spec: 'react', status: 'external', pkg: 'react' },
        // Row 10: ./cart.css → asset
        { from: 'web/src/components/Cart.jsx', spec: './cart.css', status: 'asset' },
        // Row 11: ../App → internal
        { from: 'web/src/components/Cart.jsx', spec: '../App', status: 'internal', target: 'web/src/App.tsx' },
      ];

      tests.forEach(test => {
        const result = resolver(test.from, test.spec);
        expect(result.status).toBe(test.status);
        if (test.status === 'internal') {
          expect(result.target).toBe(test.target);
        } else if (test.status === 'external') {
          expect(result.pkg).toBe(test.pkg);
        }
      });
    });
  });

  describe('additional edge cases', () => {
    it('should resolve node:fs to external fs', () => {
      const result = resolver('api/src/server.ts', 'node:fs');
      expect(result.status).toBe('external');
      expect(result.pkg).toBe('fs');
    });

    it('should resolve @scope/pkg/sub to external @scope/pkg', () => {
      const result = resolver('api/src/server.ts', '@scope/pkg/sub');
      expect(result.status).toBe('external');
      expect(result.pkg).toBe('@scope/pkg');
    });
  });

  describe('edge cases', () => {
    it('should handle files not under node_modules in sourceFiles as internal', () => {
      const result = resolver('api/src/server.ts', './routes/orders');
      expect(result.status).toBe('internal');
      expect(result.target).toBe('api/src/routes/orders.ts');
    });

    it('should handle unresolved relative paths', () => {
      const result = resolver('api/src/lib/missing-user.ts', './does-not-exist');
      expect(result.status).toBe('unresolved');
      expect(result.target).toBeUndefined();
      expect(result.pkg).toBeUndefined();
    });
  });
});
