import path from 'path';
import fs from 'fs';
import { extractImports } from '../src/languages/typescript/imports';
import { parseSource } from '../src/languages/typescript/language';

const fixtureDir = path.join(__dirname, 'fixtures/sample');

describe('extractImports', () => {
  it('should extract require calls from Cart.jsx', () => {
    const filePath = path.join(fixtureDir, 'web/src/components/Cart.jsx');
    const code = fs.readFileSync(filePath, 'utf8');
    const { tree } = parseSource(code, filePath);

    const imports = extractImports(tree);

    // Should have exactly 3 imports: react (require, line 1), ./cart.css (require, line 3), ../App (dynamic, line 10)
    expect(imports).toHaveLength(3);
    expect(imports[0]).toEqual({ spec: 'react', kind: 'require', line: 1 });
    expect(imports[1]).toEqual({ spec: './cart.css', kind: 'require', line: 3 });
    expect(imports[2]).toEqual({ spec: '../App', kind: 'dynamic', line: 10 });

    // Should NOT include the commented require('./old-cart')
    expect(imports.some(i => i.spec === './old-cart')).toBe(false);
  });

  it('should extract import and export-from from server.ts', () => {
    const filePath = path.join(fixtureDir, 'api/src/server.ts');
    const code = fs.readFileSync(filePath, 'utf8');
    const { tree } = parseSource(code, filePath);

    const imports = extractImports(tree);

    // Should have exactly 3 imports: express (import, line 1), ./routes/orders (import, line 2), ./lib/log (export-from, line 3)
    expect(imports).toHaveLength(3);
    expect(imports[0]).toEqual({ spec: 'express', kind: 'import', line: 1 });
    expect(imports[1]).toEqual({ spec: './routes/orders', kind: 'import', line: 2 });
    expect(imports[2]).toEqual({ spec: './lib/log', kind: 'export-from', line: 3 });
  });

  it('should deduplicate identical imports', () => {
    const filePath = path.join(fixtureDir, 'api/src/lib/missing-user.ts');
    const code = fs.readFileSync(filePath, 'utf8');
    const { tree } = parseSource(code, filePath);

    const imports = extractImports(tree);

    // Should have 1 import
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ spec: './does-not-exist', kind: 'import', line: 1 });
  });

  it('should skip non-literal require arguments', () => {
    const code = `const path = require('path');
const cfg = require(path.join(__dirname, 'config'));
const x = require(name + '.js');
const ok = require('./real');
`;
    const { tree } = parseSource(code, 'probe.js');

    const imports = extractImports(tree);

    // Should extract only the literal strings: 'path' at line 1 and './real' at line 4
    expect(imports).toHaveLength(2);
    expect(imports[0]).toEqual({ spec: 'path', kind: 'require', line: 1 });
    expect(imports[1]).toEqual({ spec: './real', kind: 'require', line: 4 });
  });
});
