import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { findContainers } from '../src/grouper/containers';

const fixtureRoot = path.join(__dirname, 'fixtures', 'sample');

describe('containers', () => {
  it('finds containers from fixture with walk list', () => {
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

    const containers = findContainers(fixtureRoot, files);

    expect(containers).toHaveLength(3);
    expect(containers[0]).toEqual({
      id: 'api',
      name: 'Api',
      path: 'api',
      tech: 'Node.js / TypeScript',
      manifest: 'package.json',
    });
    expect(containers[1]).toEqual({
      id: 'web',
      name: 'Web',
      path: 'web',
      tech: 'Node.js',
      manifest: 'package.json',
    });
    expect(containers[2]).toEqual({
      id: 'worker',
      name: 'Worker',
      path: 'worker',
      tech: 'Python',
      manifest: 'requirements.txt',
    });
  });

  it('creates a single root container when no subdirectory containers found', () => {
    const webRoot = path.join(fixtureRoot, 'web');
    const files = ['src/App.tsx', 'src/components/Cart.jsx'];

    const containers = findContainers(webRoot, files);

    expect(containers).toHaveLength(1);
    expect(containers[0]).toEqual({
      id: 'sample-web',
      name: 'Sample Web',
      path: '.',
      tech: 'Node.js',
      manifest: 'package.json',
    });
  });

  it('uses path (not basename) for container ids to keep them stable', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
    try {
      // Create nested containers with same basename
      fs.mkdirSync(path.join(tempDir, 'apps'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'packages'), { recursive: true });

      // Create package.json files
      fs.writeFileSync(
        path.join(tempDir, 'apps', 'package.json'),
        JSON.stringify({ name: 'apps-web' })
      );
      fs.writeFileSync(
        path.join(tempDir, 'packages', 'package.json'),
        JSON.stringify({ name: 'packages-web' })
      );

      // Both have basename 'package.json', but different paths
      const containers = findContainers(tempDir, []);

      expect(containers).toHaveLength(2);
      // Sort by id to get consistent order
      const sorted = containers.sort((a, b) => a.id.localeCompare(b.id));

      expect(sorted[0]).toEqual({
        id: 'apps',
        name: 'Apps',
        path: 'apps',
        tech: 'Node.js',
        manifest: 'package.json',
      });
      expect(sorted[1]).toEqual({
        id: 'packages',
        name: 'Packages',
        path: 'packages',
        tech: 'Node.js',
        manifest: 'package.json',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('does not change top-level container ids when nested containers are added', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
    try {
      // Create top-level and nested containers
      fs.mkdirSync(path.join(tempDir, 'api'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'x', 'api'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'api', 'package.json'),
        JSON.stringify({ name: 'api' })
      );
      fs.writeFileSync(
        path.join(tempDir, 'x', 'api', 'package.json'),
        JSON.stringify({ name: 'api' })
      );

      const containers = findContainers(tempDir, []);

      expect(containers).toHaveLength(2);
      const sorted = containers.sort((a, b) => a.id.localeCompare(b.id));

      // Top-level api should have id 'api' (path == basename)
      expect(sorted[0]).toEqual({
        id: 'api',
        name: 'Api',
        path: 'api',
        tech: 'Node.js',
        manifest: 'package.json',
      });

      // Nested x/api should have id 'x-api' (based on path)
      expect(sorted[1]).toEqual({
        id: 'x-api',
        name: 'Api',
        path: 'x/api',
        tech: 'Node.js',
        manifest: 'package.json',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('skips the C4PM export folder at an anchor but not a nested C4PM folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
    try {
      fs.mkdirSync(path.join(tmp, '.c4pm'));
      for (const d of ['src', 'C4PM', 'src/C4PM']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
      for (const f of ['C4PM/package.json', 'src/C4PM/package.json']) fs.writeFileSync(path.join(tmp, f), '{}');
      const paths = findContainers(tmp, []).map(c => c.path);
      expect(paths).toContain('src/C4PM');
      expect(paths).not.toContain('C4PM');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const sampleFiles = [
    'api/src/server.ts',
    'web/src/App.tsx',
    'worker/main.py',
  ];

  it('fallback container keeps id _root, name is "<Folder> (loose files)"', () => {
    const containers = findContainers(fixtureRoot, [...sampleFiles, 'stray.ts']);
    const fallback = containers.filter((c) => c.id === '_root');
    expect(fallback).toHaveLength(1);
    expect(fallback[0].path).toBe('.');
    expect(fallback[0].name).toBe('Sample (loose files)');
  });

  it('no _root container without loose files', () => {
    const containers = findContainers(fixtureRoot, sampleFiles);
    expect(containers.some((c) => c.id === '_root')).toBe(false);
  });

  describe('manifests by selected language', () => {
    const cases: Array<[string, string, string, string]> = [
      ['php', 'composer.json', 'PHP (Composer)', 'composer.json'],
      ['csharp', 'App.csproj', 'C# (.NET)', 'App.csproj'],
      ['swift', 'Package.swift', 'Swift (SwiftPM)', 'Package.swift'],
    ];

    function withSvc(file: string, run: (tmp: string) => void): void {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
      try {
        fs.mkdirSync(path.join(tmp, 'svc'));
        fs.writeFileSync(path.join(tmp, 'svc', file), '');
        run(tmp);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it.each(cases)('%s: %s in a subfolder is a container only when the language is selected', (lang, file, tech, manifest) => {
      withSvc(file, (tmp) => {
        expect(findContainers(tmp, [], { languages: [lang] }).find((x) => x.path === 'svc')).toMatchObject({ id: 'svc', tech, manifest });
        expect(findContainers(tmp, [], { languages: ['typescript'] }).some((x) => x.path === 'svc')).toBe(false);
        expect(findContainers(tmp, []).some((x) => x.path === 'svc')).toBe(false);
      });
    });

    it('cpp: CMakeLists.txt is a container (already a default manifest)', () => {
      withSvc('CMakeLists.txt', (tmp) => {
        expect(findContainers(tmp, [], { languages: ['cpp'] }).find((x) => x.path === 'svc')).toMatchObject({ manifest: 'CMakeLists.txt' });
      });
    });

    it('container discovery skips bin/ only when csharp is selected, and keeps the user ignore', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
      try {
        for (const d of ['bin/tool', 'app', 'mine']) {
          fs.mkdirSync(path.join(tmp, d), { recursive: true });
          fs.writeFileSync(path.join(tmp, d, 'package.json'), '{}');
        }
        const paths = (o: object) => findContainers(tmp, [], o).map((c) => c.path).sort();
        expect(paths({})).toEqual(['app', 'bin/tool', 'mine']);
        expect(paths({ languages: ['csharp'] })).toEqual(['app', 'mine']);
        expect(paths({ languages: ['csharp'], ignore: ['mine'] })).toEqual(['app']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('extra manifests (composer.json, Gemfile, *.csproj)', () => {
    const cases: Array<[string, string, string]> = [
      ['composer.json', 'PHP (Composer)', 'composer.json'],
      ['Gemfile', 'Ruby (Bundler)', 'Gemfile'],
      ['App.csproj', 'C# (.NET)', 'App.csproj'],
    ];

    function withTree(fileNames: string[], run: (tmp: string) => void, dir = 'svc'): void {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-containers-'));
      try {
        if (dir) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
        for (const f of fileNames) fs.writeFileSync(path.join(tmp, dir, f), '');
        run(tmp);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it.each(cases)('%s in a subfolder creates a container when extraManifests is on', (file, tech, manifest) => {
      withTree([file], (tmp) => {
        const c = findContainers(tmp, [], { extraManifests: true }).find((x) => x.path === 'svc');
        expect(c).toMatchObject({ id: 'svc', tech, manifest });
      });
    });

    it.each(cases)('%s creates no svc container without the option or with false', (file) => {
      withTree([file], (tmp) => {
        expect(findContainers(tmp, []).some((x) => x.path === 'svc')).toBe(false);
        expect(findContainers(tmp, [], { extraManifests: false }).some((x) => x.path === 'svc')).toBe(false);
      });
    });

    it('pom.xml wins over App.csproj in one folder', () => {
      withTree(['App.csproj', 'pom.xml'], (tmp) => {
        const c = findContainers(tmp, [], { extraManifests: true }).find((x) => x.path === 'svc');
        expect(c).toMatchObject({ tech: 'Java (Maven)', manifest: 'pom.xml' });
      });
    });

    it('root-level Gemfile with no subfolders gives one root container with tech Ruby (Bundler)', () => {
      withTree(['Gemfile'], (tmp) => {
        const list = findContainers(tmp, [], { extraManifests: true });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ path: '.', tech: 'Ruby (Bundler)', manifest: 'Gemfile' });
      }, '');
    });

    it('root-level Gemfile creates no container of its own when subfolder containers exist', () => {
      withTree(['package.json'], (tmp) => {
        fs.writeFileSync(path.join(tmp, 'Gemfile'), '');
        const list = findContainers(tmp, ['svc/a.ts'], { extraManifests: true });
        expect(list.map((c) => c.path)).toEqual(['svc']);
      });
    });
  });
});
