import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createResolverKit, external, internal, internalAll, storedResults, TARGET_IGNORED, unresolved } from '../src/languages/resolveKit';
import { createResolver } from '../src/languages/typescript/resolve';
import { collectImports } from '../src/languages/treesitter';
import type { ImportRule } from '../src/languages/treesitter';
import { pythonHandler } from '../src/languages/python';

// R4 (b189): the plumbing shared by the language resolvers and import extractors.
describe('resolver kit', () => {
  it('builds the three results; only unresolved carries a reason', () => {
    expect(internal('a/b.py')).toEqual({ status: 'internal', target: 'a/b.py' });
    expect(external('requests')).toEqual({ status: 'external', pkg: 'requests' });
    expect(unresolved('header not found')).toEqual({ status: 'unresolved', reason: 'header not found' });
  });

  // R4b (b194): one spec, several files.
  it('internalAll sorts and dedupes targets; one target is a plain internal result', () => {
    expect(internalAll(['b.cs', 'a.cs', 'b.cs'])).toEqual({ status: 'internal', target: 'a.cs', targets: ['a.cs', 'b.cs'] });
    expect(internalAll(['a.cs', 'a.cs'])).toEqual(internal('a.cs'));
    expect(() => internalAll([])).toThrow();
  });

  it('storedResults drops reason and gives one result per target, without a targets field', () => {
    expect(storedResults(internalAll(['b.cs', 'a.cs']))).toEqual([internal('a.cs'), internal('b.cs')]);
    expect(storedResults(internal('a.py'))).toEqual([internal('a.py')]);
    expect(storedResults(external('requests'))).toEqual([external('requests')]);
    expect(storedResults(unresolved('file not found'))).toEqual([{ status: 'unresolved' }]);
  });

  it('dirOf gives the repo root as an empty string; firstExisting keeps candidate order', () => {
    const kit = createResolverKit('x', '/repo', ['a/b.h', 'a/c.h', 'top.h']);
    expect(kit.dirOf('top.h')).toBe('');
    expect(kit.dirOf('a/b/c.h')).toBe('a/b');
    expect(kit.firstExisting(['nope.h', 'a/c.h', 'a/b.h'])).toBe('a/c.h');
    expect(kit.firstExisting(['nope.h'])).toBeUndefined();
  });

  it('findUp returns the nearest folder with a value and reads each folder once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-kit-'));
    try {
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(root, 'm.txt'), 'root');
      fs.writeFileSync(path.join(root, 'a', 'm.txt'), 'a');
      const kit = createResolverKit('x', root, []);
      const reads: string[] = [];
      const read = (file: string, dir: string) => {
        reads.push(dir);
        return fs.existsSync(file) ? `${dir}:${fs.readFileSync(file, 'utf8')}` : null;
      };
      expect(kit.findUp('a/b/f.x', 'm.txt', read)).toBe('a:a');
      expect(kit.findUp('a/b/g.x', 'm.txt', read)).toBe('a:a');
      expect(kit.findUp('top.x', 'm.txt', read)).toBe(':root');
      expect(kit.findUp('top.x', 'none.txt', () => null)).toBeNull();
      expect(reads).toEqual(['a/b', 'a', '']);   // cached per folder
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolver passes results through, reason included', () => {
    const kit = createResolverKit('x', '/repo', []);
    const resolve = kit.resolver((from, spec) => (spec === 'pkg' ? external('pkg') : unresolved(`no ${spec} from ${from}`)));
    expect(resolve('a.x', 'pkg')).toEqual({ status: 'external', pkg: 'pkg' });
    expect(resolve('a.x', 'b')).toEqual({ status: 'unresolved', reason: 'no b from a.x' });
  });

  // E2 (b192): the target is in the repo but the scan skipped it (build/, vendor/, an ignore pattern):
  // still unresolved, with its own reason (hono '../../build/dts-plugins').
  describe('target-ignored', () => {
    let root: string;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-kit-ignored-'));
      fs.mkdirSync(path.join(root, 'build'));
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'build', 'gen.h'), '');
      fs.writeFileSync(path.join(root, 'build', 'dts-plugins.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(root, 'src', 'a.c'), '');
      fs.writeFileSync(path.join(root, 'vite.config.ts'), '');
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it('a tried candidate that is a file on disk but not scanned gives target-ignored', () => {
      const kit = createResolverKit('x', root, ['src/a.c']);
      const resolve = kit.resolver((_from, spec) =>
        kit.firstExisting([`src/${spec}`, `build/${spec}`]) ? internal('x') : unresolved('header not found'));
      expect(resolve('src/a.c', 'gen.h')).toEqual(unresolved(TARGET_IGNORED));
      expect(resolve('src/a.c', 'none.h')).toEqual(unresolved('header not found'));
    });

    it('keeps the reason for a folder, a path outside the repo, and candidates of an earlier import', () => {
      const kit = createResolverKit('x', root, ['src/a.c']);
      const resolve = kit.resolver((_from, spec) =>
        spec === 'other' ? unresolved('no candidates') : kit.firstExisting([spec]) ? internal('x') : unresolved('not found'));
      expect(resolve('src/a.c', 'build')).toEqual(unresolved('not found'));
      expect(resolve('src/a.c', '../outside.h')).toEqual(unresolved('not found'));
      expect(resolve('src/a.c', 'build/gen.h')).toEqual(unresolved(TARGET_IGNORED));
      expect(resolve('src/a.c', 'other')).toEqual(unresolved('no candidates'));
    });

    it('the TypeScript resolver gives the same reason', () => {
      const resolve = createResolver(root, ['vite.config.ts']);
      expect(resolve('vite.config.ts', './build/dts-plugins')).toEqual(unresolved(TARGET_IGNORED));
      expect(resolve('vite.config.ts', './nope')).toEqual(unresolved('path not found'));
    });
  });
});

describe('collectImports', () => {
  const tree = pythonHandler.parse('import b\nimport a, b\nif x:\n    import c\n', '');

  it('applies rules, drops empty specs and repeats, sorts by line then spec', () => {
    // every import statement also gives an empty spec and 'a' on line 2 (a repeat after the first)
    const rules: Record<string, ImportRule> = {
      import_statement: { hits: (node) => [...node.namedChildren.map((c) => ({ spec: c.text })), { spec: '' }, { spec: 'a', line: 2 }] },
    };
    expect(collectImports(tree, rules, 'test-imports')).toEqual([
      { spec: 'b', kind: 'import', line: 1 },
      { spec: 'a', kind: 'import', line: 2 },
      { spec: 'b', kind: 'import', line: 2 },
      { spec: 'c', kind: 'import', line: 4 },
    ]);
  });

  it('a null hit walks the node like any other; a match stops the walk unless descend is set', () => {
    const imports: ImportRule = { hits: (node) => [{ spec: node.text, kind: 'require' }] };
    const lines = (rules: Record<string, ImportRule>) => collectImports(tree, { ...rules, import_statement: imports }, 't').map((i) => i.line);
    expect(lines({ if_statement: { hits: () => null } })).toEqual([1, 2, 4]);
    expect(lines({ if_statement: { hits: () => [] } })).toEqual([1, 2]);
    expect(lines({ if_statement: { hits: () => [], descend: true } })).toEqual([1, 2, 4]);
    expect(collectImports(tree, { import_statement: imports }, 't')[0]).toEqual({ spec: 'import b', kind: 'require', line: 1 });
  });
});
