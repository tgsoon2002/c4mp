import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { pythonHandler } from '../src/languages/python';
import { extractPythonImports } from '../src/languages/python/imports';
import { createPythonResolver } from '../src/languages/python/resolve';

const parsePython = (code: string) => pythonHandler.parse(code, '');

describe('Python imports', () => {
  it('extracts imports from pyshop fixture', () => {
    const pyshopRoot = path.join(__dirname, 'fixtures/pyshop');
    const sourceFiles = [
      'run.py',
      'shop/__init__.py',
      'shop/config.py',
      'shop/models/order.py',
      'shop/services/orders.py',
      'shop/services/pricing.py',
    ];

    const allImports: Array<{ file: string; spec: string; line: number; status: string; target?: string; pkg?: string }> = [];

    for (const file of sourceFiles) {
      const filePath = path.join(pyshopRoot, file);
      const code = fs.readFileSync(filePath, 'utf-8');
      const tree = parsePython(code);
      const rawImports = extractPythonImports(tree);

      for (const rawImport of rawImports) {
        allImports.push({
          file,
          spec: rawImport.spec,
          line: rawImport.line,
          status: 'extracted',
        });
      }
    }

    // Check that we have the expected imports
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'run.py', spec: 'shop' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/__init__.py', spec: 'flask' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/__init__.py', spec: 'shop.config' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/config.py', spec: 'os' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/models/order.py', spec: 'dataclasses' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/services/orders.py', spec: 'shop.models.order' }));
    expect(allImports).toContainEqual(expect.objectContaining({ file: 'shop/services/orders.py', spec: '.pricing' }));
  });

  it('resolves imports in pyshop fixture', () => {
    const pyshopRoot = path.join(__dirname, 'fixtures/pyshop');
    const sourceFiles = [
      'run.py',
      'shop/__init__.py',
      'shop/config.py',
      'shop/models/order.py',
      'shop/services/orders.py',
      'shop/services/pricing.py',
    ];

    const resolver = createPythonResolver(pyshopRoot, sourceFiles);
    const results: Array<{ from: string; spec: string; status: string; target?: string; pkg?: string }> = [];

    const importSpecs: { [key: string]: string[] } = {
      'run.py': ['shop'],
      'shop/__init__.py': ['flask', 'shop.config'],
      'shop/config.py': ['os'],
      'shop/models/order.py': ['dataclasses'],
      'shop/services/orders.py': ['shop.models.order', '.pricing'],
      'shop/services/pricing.py': [],
    };

    for (const [file, specs] of Object.entries(importSpecs)) {
      for (const spec of specs) {
        const result = resolver(file, spec);
        results.push({ from: file, spec, status: result.status, target: result.target, pkg: result.pkg });
      }
    }

    // Count results
    const internal = results.filter(r => r.status === 'internal');
    const external = results.filter(r => r.status === 'external');
    const unresolved = results.filter(r => r.status === 'unresolved');

    expect(internal.length).toBe(4);
    expect(external.length).toBe(3);
    expect(unresolved.length).toBe(0);

    // Check specific internal resolutions
    expect(results).toContainEqual(
      expect.objectContaining({
        from: 'run.py',
        spec: 'shop',
        status: 'internal',
        target: 'shop/__init__.py',
      })
    );

    expect(results).toContainEqual(
      expect.objectContaining({
        from: 'shop/__init__.py',
        spec: 'shop.config',
        status: 'internal',
        target: 'shop/config.py',
      })
    );

    expect(results).toContainEqual(
      expect.objectContaining({
        from: 'shop/services/orders.py',
        spec: '.pricing',
        status: 'internal',
        target: 'shop/services/pricing.py',
      })
    );

    expect(results).toContainEqual(
      expect.objectContaining({
        from: 'shop/services/orders.py',
        spec: 'shop.models.order',
        status: 'internal',
        target: 'shop/models/order.py',
      })
    );

    // Check external packages
    expect(results).toContainEqual(expect.objectContaining({ spec: 'flask', status: 'external', pkg: 'flask' }));
    expect(results).toContainEqual(expect.objectContaining({ spec: 'os', status: 'external', pkg: 'os' }));
    expect(results).toContainEqual(expect.objectContaining({ spec: 'dataclasses', status: 'external', pkg: 'dataclasses' }));
  });

  it('resolves relative imports with temp tree', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-resolve-test-'));
    try {
      // Create temp structure: svc/app/models/notification.py, svc/app/routes/r.py
      fs.mkdirSync(path.join(tempDir, 'svc/app/models'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'svc/app/routes'), { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'svc/app/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'svc/app/models/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'svc/app/models/notification.py'), 'class N: pass');
      fs.writeFileSync(path.join(tempDir, 'svc/app/routes/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'svc/app/routes/r.py'), 'from app.models.notification import N');

      const sourceFiles = [
        'svc/app/__init__.py',
        'svc/app/models/__init__.py',
        'svc/app/models/notification.py',
        'svc/app/routes/__init__.py',
        'svc/app/routes/r.py',
      ];

      const resolver = createPythonResolver(tempDir, sourceFiles);

      // Resolve 'from app.models.notification import N' from svc/app/routes/r.py
      const result = resolver('svc/app/routes/r.py', 'app.models.notification');

      expect(result.status).toBe('internal');
      expect(result.target).toBe('svc/app/models/notification.py');
    } finally {
      // Clean up
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('resolves relative imports correctly', () => {
    const pyshopRoot = path.join(__dirname, 'fixtures/pyshop');
    const sourceFiles = [
      'run.py',
      'shop/__init__.py',
      'shop/config.py',
      'shop/models/order.py',
      'shop/services/orders.py',
      'shop/services/pricing.py',
    ];

    const resolver = createPythonResolver(pyshopRoot, sourceFiles);

    // Test: 'from . import pricing' from shop/services/orders.py
    // Should resolve to shop/services/__init__.py if it exists, or be unresolved
    // But in the spec, it should resolve to .pricing → shop/services/pricing.py
    const result1 = resolver('shop/services/orders.py', '.pricing');
    expect(result1.status).toBe('internal');
    expect(result1.target).toBe('shop/services/pricing.py');

    // Test: relative import that doesn't exist
    const result2 = resolver('shop/services/orders.py', '.nonexistent');
    expect(result2.status).toBe('unresolved');
  });

  it('falls back to the package __init__.py when the last segment is a name, not a module', () => {
    const resolver = createPythonResolver('/repo', ['tests/__init__.py', 'tests/test_requests.py', 'pkg/sub/__init__.py', 'pkg/a.py']);

    // 'from . import SNIMissingWarning' (requests tests/test_requests.py:57)
    expect(resolver('tests/test_requests.py', '.SNIMissingWarning')).toEqual({ status: 'internal', target: 'tests/__init__.py' });
    // dotted path whose last segment is no module: the package that holds it
    expect(resolver('pkg/a.py', '.sub.Name')).toEqual({ status: 'internal', target: 'pkg/sub/__init__.py' });
    // a module still wins over the package
    expect(resolver('pkg/sub/__init__.py', '..a')).toEqual({ status: 'internal', target: 'pkg/a.py' });
    // no package __init__.py: still unresolved
    expect(resolver('pkg/a.py', '.Missing').status).toBe('unresolved');
  });
});
