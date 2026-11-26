import path from 'path';
import { groupComponents } from '../src/grouper/components';
import { Container } from '../src/types';

describe('groupComponents', () => {
  it('should group fixture files into components per §5.2', () => {
    // Fixture files from §5.2 Walk
    const files = [
      'api/src/lib/log.ts',
      'api/src/lib/missing-user.ts',
      'api/src/models/order.ts',
      'api/src/routes/orders.ts',
      'api/src/server.ts',
      'api/src/services/orderService.ts',
      'web/src/App.tsx',
      'web/src/components/Cart.jsx',
    ];

    // Containers from §5.2
    const containers: Container[] = [
      { id: 'api', name: 'Api', path: 'api', tech: 'Node.js / TypeScript', manifest: 'package.json' },
      { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: 'package.json' },
      { id: 'worker', name: 'Worker', path: 'worker', tech: 'Python', manifest: 'requirements.txt' },
    ];

    const components = groupComponents(files, containers);

    // Expected 7 components
    expect(components).toHaveLength(7);

    // Check each component matches §5.2 Components table
    const componentMap = new Map(components.map(c => [c.id, c]));

    // api/_root
    expect(componentMap.has('api/_root')).toBe(true);
    const apiRoot = componentMap.get('api/_root')!;
    expect(apiRoot.name).toBe('Root files');
    expect(apiRoot.containerId).toBe('api');
    expect(apiRoot.path).toBe('api/src');
    expect(apiRoot.files).toEqual(['api/src/server.ts']);

    // api/lib
    expect(componentMap.has('api/lib')).toBe(true);
    const apiLib = componentMap.get('api/lib')!;
    expect(apiLib.name).toBe('Lib');
    expect(apiLib.containerId).toBe('api');
    expect(apiLib.path).toBe('api/src/lib');
    expect(apiLib.files).toEqual(['api/src/lib/log.ts', 'api/src/lib/missing-user.ts']);

    // api/models
    expect(componentMap.has('api/models')).toBe(true);
    const apiModels = componentMap.get('api/models')!;
    expect(apiModels.name).toBe('Models');
    expect(apiModels.path).toBe('api/src/models');
    expect(apiModels.files).toEqual(['api/src/models/order.ts']);

    // api/routes
    expect(componentMap.has('api/routes')).toBe(true);
    const apiRoutes = componentMap.get('api/routes')!;
    expect(apiRoutes.name).toBe('Routes');
    expect(apiRoutes.path).toBe('api/src/routes');
    expect(apiRoutes.files).toEqual(['api/src/routes/orders.ts']);

    // api/services
    expect(componentMap.has('api/services')).toBe(true);
    const apiServices = componentMap.get('api/services')!;
    expect(apiServices.name).toBe('Services');
    expect(apiServices.path).toBe('api/src/services');
    expect(apiServices.files).toEqual(['api/src/services/orderService.ts']);

    // web/_root
    expect(componentMap.has('web/_root')).toBe(true);
    const webRoot = componentMap.get('web/_root')!;
    expect(webRoot.name).toBe('Root files');
    expect(webRoot.containerId).toBe('web');
    expect(webRoot.path).toBe('web/src');
    expect(webRoot.files).toEqual(['web/src/App.tsx']);

    // web/components
    expect(componentMap.has('web/components')).toBe(true);
    const webComponents = componentMap.get('web/components')!;
    expect(webComponents.name).toBe('Components');
    expect(webComponents.path).toBe('web/src/components');
    expect(webComponents.files).toEqual(['web/src/components/Cart.jsx']);

    // Check sorting
    expect(components.map(c => c.id)).toEqual([
      'api/_root',
      'api/lib',
      'api/models',
      'api/routes',
      'api/services',
      'web/_root',
      'web/components',
    ]);
  });

  it('should handle root container at . with files in root and subdirs', () => {
    const files = ['index.js', 'lib/a.js'];
    const containers: Container[] = [
      { id: 'sample', name: 'Sample', path: '.', tech: 'Node.js', manifest: 'package.json' },
    ];

    const components = groupComponents(files, containers);

    expect(components).toHaveLength(2);

    const componentMap = new Map(components.map(c => [c.id, c]));

    // sample/_root
    expect(componentMap.has('sample/_root')).toBe(true);
    const root = componentMap.get('sample/_root')!;
    expect(root.name).toBe('Root files');
    expect(root.containerId).toBe('sample');
    expect(root.path).toBe('');
    expect(root.files).toEqual(['index.js']);

    // sample/lib
    expect(componentMap.has('sample/lib')).toBe(true);
    const lib = componentMap.get('sample/lib')!;
    expect(lib.name).toBe('Lib');
    expect(lib.containerId).toBe('sample');
    expect(lib.path).toBe('lib');
    expect(lib.files).toEqual(['lib/a.js']);
  });

  it('should group pyshop files with shop as sourceRoot (P4-T9)', () => {
    // Pyshop scenario: root container with shop/ prefix
    const files = [
      'run.py',
      'shop/__init__.py',
      'shop/config.py',
      'shop/models/order.py',
      'shop/services/orders.py',
      'shop/services/pricing.py',
    ];

    const containers: Container[] = [
      { id: 'pyshop', name: 'Pyshop', path: '.', tech: 'Python', manifest: 'requirements.txt' },
    ];

    const components = groupComponents(files, containers);

    // Expected 3 components: _root, models, services
    expect(components).toHaveLength(3);

    const componentMap = new Map(components.map(c => [c.id, c]));

    // pyshop/_root: loose files and files directly in shop/
    expect(componentMap.has('pyshop/_root')).toBe(true);
    const root = componentMap.get('pyshop/_root')!;
    expect(root.name).toBe('Root files');
    expect(root.containerId).toBe('pyshop');
    expect(root.path).toBe('shop');
    expect(root.files).toEqual(['run.py', 'shop/__init__.py', 'shop/config.py']);

    // pyshop/models
    expect(componentMap.has('pyshop/models')).toBe(true);
    const models = componentMap.get('pyshop/models')!;
    expect(models.name).toBe('Models');
    expect(models.containerId).toBe('pyshop');
    expect(models.path).toBe('shop/models');
    expect(models.files).toEqual(['shop/models/order.py']);

    // pyshop/services
    expect(componentMap.has('pyshop/services')).toBe(true);
    const services = componentMap.get('pyshop/services')!;
    expect(services.name).toBe('Services');
    expect(services.containerId).toBe('pyshop');
    expect(services.path).toBe('shop/services');
    expect(services.files).toEqual(['shop/services/orders.py', 'shop/services/pricing.py']);

    // Check sorting
    expect(components.map(c => c.id)).toEqual(['pyshop/_root', 'pyshop/models', 'pyshop/services']);
  });

  it('should not create sourceRoot when files are in different first-level folders (P4-T9)', () => {
    // Files a/x.ts and b/y.ts in different folders - no common sourceRoot
    const files = ['a/x.ts', 'b/y.ts'];

    const containers: Container[] = [
      { id: 'multi', name: 'Multi', path: '.', tech: 'TypeScript', manifest: 'package.json' },
    ];

    const components = groupComponents(files, containers);

    // Expected 2 components: a, b (not a single folder structure)
    expect(components).toHaveLength(2);

    const componentMap = new Map(components.map(c => [c.id, c]));

    // multi/a
    expect(componentMap.has('multi/a')).toBe(true);
    const a = componentMap.get('multi/a')!;
    expect(a.name).toBe('A');
    expect(a.containerId).toBe('multi');
    expect(a.path).toBe('a');
    expect(a.files).toEqual(['a/x.ts']);

    // multi/b
    expect(componentMap.has('multi/b')).toBe(true);
    const b = componentMap.get('multi/b')!;
    expect(b.name).toBe('B');
    expect(b.containerId).toBe('multi');
    expect(b.path).toBe('b');
    expect(b.files).toEqual(['b/y.ts']);

    // Check sorting
    expect(components.map(c => c.id)).toEqual(['multi/a', 'multi/b']);
  });

  it('should still handle src/ folders unchanged (P4-T9)', () => {
    // Container with src/ should use src as sourceRoot (unchanged behavior)
    const files = ['src/index.ts', 'src/util/helper.ts'];

    const containers: Container[] = [
      { id: 'srcapp', name: 'SrcApp', path: '.', tech: 'TypeScript', manifest: 'package.json' },
    ];

    const components = groupComponents(files, containers);

    expect(components).toHaveLength(2);

    const componentMap = new Map(components.map(c => [c.id, c]));

    // srcapp/_root
    expect(componentMap.has('srcapp/_root')).toBe(true);
    const root = componentMap.get('srcapp/_root')!;
    expect(root.path).toBe('src');
    expect(root.files).toEqual(['src/index.ts']);

    // srcapp/util
    expect(componentMap.has('srcapp/util')).toBe(true);
    const util = componentMap.get('srcapp/util')!;
    expect(util.path).toBe('src/util');
    expect(util.files).toEqual(['src/util/helper.ts']);
  });
});
