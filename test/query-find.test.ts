import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { findElements, outlineFile, outlineOf, ROW_KINDS } from '../src/query/find';
import type { RowKind } from '../src/query/find';
import { explainOwner, ownerOf } from '../src/query/owner';
import { listSourceFiles } from '../src/importer/walk';

const FIX = path.join(__dirname, 'fixtures');

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-find-'));
  for (const [rel, text] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text);
  }
  return dir;
}

function catchQueryError(fn: () => unknown): QueryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QueryError);
    return err as QueryError;
  }
  throw new Error('expected QueryError');
}

describe('findElements', () => {
  let level4: QueryContext;
  let phofast: QueryContext;
  let sample: QueryContext;

  beforeAll(() => {
    level4 = loadQueryContext(path.join(FIX, 'level4'));
    phofast = loadQueryContext(path.join(FIX, 'phofast'));
    sample = loadQueryContext(path.join(FIX, 'sample'));
  });

  it('every row of every fixture carries the owner ownerOf gives', () => {
    for (const ctx of [level4, phofast, sample]) {
      const { results, total, truncated } = findElements(ctx, { query: '.', limit: 100 });
      expect(results.length).toBeGreaterThan(0);
      expect(truncated).toBe(total > results.length);
      for (const r of results) {
        expect(r.owner).toEqual(r.kind === 'file' ? ownerOf(ctx, r.path) : ownerOf(ctx, r.path, r.name));
      }
    }
  });

  it('level4 (claim mode): finds an element case-insensitively with lines and owner', () => {
    const first = level4.snapshot.files.flatMap((f) => f.elements.map((e) => ({ f: f.file, e })))[0];
    const out = findElements(level4, { query: first.e.name.toUpperCase(), kind: first.e.kind as 'function' });
    const row = out.results.find((r) => r.path === first.f && r.name === first.e.name)!;
    expect(row).toMatchObject({ kind: first.e.kind, startLine: first.e.startLine, endLine: first.e.endLine });
    expect(row.owner).toEqual(ownerOf(level4, first.f, first.e.name));
  });

  it('level4: stub flag is carried', () => {
    const stubbed = level4.snapshot.files.flatMap((f) => f.elements.filter((e) => e.stub).map((e) => ({ f: f.file, e })));
    expect(stubbed.length).toBeGreaterThan(0);
    const row = findElements(level4, { query: stubbed[0].e.name, kind: 'function' }).results.find(
      (r) => r.path === stubbed[0].f && r.name === stubbed[0].e.name,
    )!;
    expect(row.stub).toBe(stubbed[0].e.stub);
  });

  it('a path match gives a file row without lines; kind filter splits file from elements', () => {
    const file = sample.snapshot.files[0].file;
    const out = findElements(sample, { query: file, kind: 'file' });
    expect(out.results[0]).toMatchObject({ path: file, name: file, kind: 'file' });
    expect(out.results[0].startLine).toBeUndefined();
    expect(out.results.every((r) => r.kind === 'file')).toBe(true);
    const noFiles = findElements(sample, { query: file.split('/').pop()!.replace(/\..*$/, ''), kind: 'function' });
    expect(noFiles.results.every((r) => r.kind === 'function')).toBe(true);
  });

  describe('ordering, limits, duplicates (temp repo)', () => {
    let ctx: QueryContext;
    beforeAll(() => {
      const root = tempRepo({
        'src/a.ts':
          'export function run() { return 1; }\n' +
          'export function runner() { return 2; }\n' +
          'export function dorun() { return 3; }\n' +
          'export class Task { run() { return 4; } }\n' +
          'export const obj = { run() { return 5; } };\n',
        'src/b.ts': 'export function run() { return 6; }\n',
      });
      ctx = loadQueryContext(root);
    });

    it('exact name > exact last segment > prefix > substring, then path, then startLine', () => {
      const names = findElements(ctx, { query: 'run', kind: 'function' }).results.concat(
        findElements(ctx, { query: 'run', kind: 'method' }).results,
      );
      expect(names.length).toBe(6);
      const all = findElements(ctx, { query: 'run' }).results.filter((r) => r.kind !== 'file');
      expect(all.map((r) => `${r.path}:${r.name}`)).toEqual([
        'src/a.ts:run',
        'src/b.ts:run',
        'src/a.ts:Task.run',
        'src/a.ts:obj.run',
        'src/a.ts:runner',
        'src/a.ts:dorun',
      ]);
    });

    // b580: inside one rank, source before test files (role test, config tests.globs), even when the test path sorts first;
    // the rank tiers still come first (an exact hit in a test file beats a substring hit in source).
    it('same rank: source files before test files; rank still wins over the test flag', () => {
      const root = tempRepo({
        'aaa/validate.test.ts':
          'export function checkValidation() { return 1; }\n' +
          'export function validation() { return 2; }\n',
        'src/validate.ts': 'export function requestValidation() { return 3; }\n',
      });
      try {
        const c = loadQueryContext(root);
        expect(c.snapshot.files.find((f) => f.file === 'aaa/validate.test.ts')?.role).toBe('test');
        const rows = findElements(c, { query: 'validation' }).results.filter((r) => r.kind !== 'file');
        expect(rows.map((r) => `${r.path}:${r.name}`)).toEqual([
          'aaa/validate.test.ts:validation',
          'src/validate.ts:requestValidation',
          'aaa/validate.test.ts:checkValidation',
        ]);
        expect(findElements(c, { query: 'validation', limit: 2 }).results.map((r) => r.name)).toContain('requestValidation');
        // path matches (file rows) follow the same rule
        const files = findElements(c, { query: 'validate', kind: 'file' }).results.map((r) => r.path);
        expect(files).toEqual(['src/validate.ts', 'aaa/validate.test.ts']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('duplicate names are all returned', () => {
      const runs = findElements(ctx, { query: 'run', kind: 'function' }).results.filter((r) => r.name === 'run');
      expect(runs.map((r) => r.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('limit truncates and reports total; default 20; invalid limits and queries throw invalid', () => {
      const out = findElements(ctx, { query: 'run', limit: 2 });
      expect(out.results).toHaveLength(2);
      expect(out.truncated).toBe(true);
      expect(out.total).toBeGreaterThan(2);
      for (const limit of [0, 101, 1.5, Number.NaN]) {
        expect(catchQueryError(() => findElements(ctx, { query: 'run', limit })).code).toBe('invalid');
      }
      expect(catchQueryError(() => findElements(ctx, { query: '   ' })).code).toBe('invalid');
      expect(catchQueryError(() => findElements(ctx, { query: 'run', kind: 'nope' as never })).code).toBe('invalid');
      expect(findElements(ctx, { query: 'run', limit: 100 }).truncated).toBe(false);
    });

    // b681: every code element kind is a --kind value; an unknown kind is refused with the full list.
    it('--kind type gives code types, --kind test gives test cases; an unknown kind names every kind', () => {
      const root = tempRepo({
        'src/shape.ts':
          'export interface Shape { area(): number }\n' +
          'export type ShapeId = string;\n' +
          'export enum ShapeKind { Round }\n' +
          'export function shapeOf() { return 1; }\n',
        'test/shape.test.ts': "describe('shapes', () => { it('shape area', () => { expect(1).toBe(1); }); });\n",
      });
      try {
        const c = loadQueryContext(root);
        const rows = (kind?: RowKind) => findElements(c, { query: 'shape', kind }).results.map((r) => `${r.kind} ${r.name}`);
        expect(rows('type')).toEqual(['type Shape', 'type ShapeId', 'type ShapeKind']);
        expect(rows('test')).toEqual(['test shapes › shape area']);
        expect(rows('function')).toEqual(['function shapeOf']);
        expect(rows()).toEqual(expect.arrayContaining(['type Shape', 'function shapeOf', 'test shapes › shape area', 'file src/shape.ts']));
        expect(ROW_KINDS).toEqual(['function', 'class', 'method', 'type', 'test', 'file', 'record']);
        const err = catchQueryError(() => findElements(c, { query: 'shape', kind: 'nope' as never }));
        expect(err.code).toBe('invalid');
        expect(err.message).toBe("kind must be one of function, class, method, type, test, file, record (got 'nope')");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('.d.ts exclusion lives in the file walk (importer/walk.ts), not in find', () => {
    it('listSourceFiles drops the .d.ts, so the scan never has it and find/outline cannot see it', () => {
      const root = tempRepo({
        'src/types.d.ts': 'export declare function ghostFn(): void;\n',
        'src/real.ts': 'export function realFn() { return 1; }\n',
      });
      expect(listSourceFiles(root, { extensions: ['.ts'], ignore: [] })).toEqual(['src/real.ts']);
      const ctx = loadQueryContext(root);
      expect(ctx.snapshot.files.map((f) => f.file)).toEqual(['src/real.ts']);
      expect(findElements(ctx, { query: 'ghostFn' }).total).toBe(0);
      expect(findElements(ctx, { query: 'types.d.ts' }).total).toBe(0);
      expect(catchQueryError(() => outlineFile(ctx, 'src/types.d.ts')).code).toBe('not-found');
    });
  });
});

describe('outlineFile', () => {
  it('outlineOf is the same function', () => {
    expect(outlineOf).toBe(outlineFile);
  });

  it('class + methods nest; object literal arrow members stay top-level; owners set', () => {
    const root = tempRepo({
      'src/m.ts':
        'export class Cart {\n  add() { return 1; }\n  total() { return 2; }\n}\n' +
        'export const util = { fmt: () => 1, parse: () => 2 };\n' +
        'export const top = () => 3;\n',
    });
    const ctx = loadQueryContext(root);
    const out = outlineFile(ctx, 'src/m.ts');
    expect(out).toMatchObject({ path: 'src/m.ts', parseError: false });
    const byName = (n: string) => out.elements.find((e) => e.name === n);
    const cart = byName('Cart')!;
    expect(cart.kind).toBe('class');
    expect(cart.children!.map((c) => c.name)).toEqual(['Cart.add', 'Cart.total']);
    expect(cart.children![0].kind).toBe('method');
    expect(out.elements.map((e) => e.name)).not.toContain('Cart.add');
    // obj.m has no class parent -> top level (names as the scanner gives them)
    const objMembers = out.elements.filter((e) => e.name.startsWith('util.'));
    expect(objMembers.length).toBe(2);
    expect(objMembers.every((e) => e.children === undefined)).toBe(true);
    expect(byName('top')!.kind).toBe('function');
    expect(cart.owner).toEqual(ownerOf(ctx, 'src/m.ts', 'Cart'));
  });

  it('Python property getter + setter are listed individually under the class', () => {
    const root = tempRepo({
      'pkg/shop.py':
        'class Item:\n' +
        '    @property\n    def price(self):\n        return 1\n\n' +
        '    @price.setter\n    def price(self, v):\n        self._p = v\n',
    });
    const ctx = loadQueryContext(root, { cli: { languages: ['python'] } });
    const out = outlineFile(ctx, 'pkg/shop.py');
    const item = out.elements.find((e) => e.name === 'Item')!;
    // b138: the later repeat of a name in one file is suffixed #2, so each element has its own id.
    expect(item.children!.map((c) => c.name)).toEqual(['Item.price', 'Item.price#2']);
    expect(item.children![0].startLine).toBeLessThan(item.children![1].startLine);
    expect(findElements(ctx, { query: 'Item.price' }).results.map((r) => r.name)).toEqual(['Item.price', 'Item.price#2']);
  });

  it('pyshop fixture: class with method under Python', () => {
    const ctx = loadQueryContext(path.join(FIX, 'pyshop'), { cli: { languages: ['python'] } });
    const out = outlineFile(ctx, 'shop/models/order.py');
    const order = out.elements.find((e) => e.name === 'Order')!;
    expect(order.children!.map((c) => c.name)).toContain('Order.is_free');
  });

  it('fileOnly file with languages files: no elements, fileOnly flag; empty file ok; unknown is not-found', () => {
    const root = tempRepo({ 'svc/main.go': 'package main\nfunc main() {}\n', 'src/empty.ts': '' });
    const ctx = loadQueryContext(root, { cli: { languages: ['typescript', 'files'] } });
    const md = outlineFile(ctx, 'svc/main.go');
    expect(md).toMatchObject({ path: 'svc/main.go', lineCount: 2, fileOnly: true, elements: [] });
    const row = findElements(ctx, { query: 'main.go', kind: 'file' }).results[0];
    expect(row).toMatchObject({ kind: 'file', path: 'svc/main.go', fileOnly: true });
    expect(outlineFile(ctx, 'src/empty.ts').elements).toEqual([]);
    const err = catchQueryError(() => outlineFile(ctx, 'src/nope.ts'));
    expect(err.code).toBe('not-found');
    expect(err.message).toMatch(/--lang files/);
  });

  it('fixtures: every file outlines, and nested + top-level counts equal the scanned elements', () => {
    for (const name of ['level4', 'phofast', 'sample']) {
      const ctx = loadQueryContext(path.join(FIX, name));
      for (const f of ctx.snapshot.files) {
        const out = outlineFile(ctx, f.file);
        const countAll = (els: { children?: unknown[] }[]): number =>
          els.reduce((n, e) => n + 1 + countAll((e.children ?? []) as { children?: unknown[] }[]), 0);
        expect(countAll(out.elements)).toBe(f.elements.length + (f.nested?.length ?? 0));
      }
    }
  });
});

describe('nested functions (b782)', () => {
  const N_TS = [
    'export function outer(): number {',
    '  function inner(b: number): number {',
    '    return b * 2;',
    '  }',
    '  return inner(1);',
    '}',
    '',
  ].join('\n');
  const PLAN = "specification {\n  element component\n}\nmodel {\n  core = component 'Core' {\n    link ../src/n.ts#outer\n  }\n}\n";

  it('folder mode: find lists outer.inner with lines; outline puts it under outer', () => {
    const ctx = loadQueryContext(tempRepo({ 'src/n.ts': N_TS }));
    const want = { path: 'src/n.ts', name: 'outer.inner', kind: 'function', startLine: 2, endLine: 4, lineCount: 3 };
    expect(findElements(ctx, { query: 'inner' }).results[0]).toMatchObject(want);
    expect(findElements(ctx, { query: 'inner', kind: 'function' }).results[0]).toMatchObject(want);
    expect(findElements(ctx, { query: 'inner', kind: 'method' }).results).toEqual([]);
    const out = outlineFile(ctx, 'src/n.ts').elements;
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('outer');
    expect(out[0].children).toMatchObject([{ name: 'outer.inner', kind: 'function', startLine: 2, endLine: 4 }]);
  });

  it('claim mode: a nested function has its outer element owner; a bare name is not-found', () => {
    const ctx = loadQueryContext(tempRepo({ 'src/n.ts': N_TS, 'c4/plan.c4': PLAN }));
    expect(ctx.claimMode).toBe(true);
    const owner = ownerOf(ctx, 'src/n.ts', 'outer');
    expect(owner.kind).toBe('component');
    expect(ownerOf(ctx, 'src/n.ts', 'outer.inner')).toEqual(owner);
    expect(findElements(ctx, { query: 'inner' }).results[0].owner).toEqual(owner);
    expect(explainOwner(ctx, 'src/n.ts', 'outer.inner')).toEqual(explainOwner(ctx, 'src/n.ts', 'outer'));
    expect(catchQueryError(() => ownerOf(ctx, 'src/n.ts', 'inner')).code).toBe('not-found');
  });
});

// STOR-4 (b336): the records of the plan stores in find (kind 'record') and in outline of a file only a reader reads (.sql).
describe('records (plan store with the sql-migrations reader)', () => {
  let root: string;
  let ctx: QueryContext;
  beforeAll(() => {
    root = tempRepo({
      'src/a.ts': 'export function users() { return 1; }\n',
      'c4/arch.c4': [
        'model {',
        "  app = system 'App' {",
        "    db = store 'Db' {",
        "      technology 'PostgreSQL'",
        "      metadata { reader 'sql-migrations' }",
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    fs.cpSync(path.join(FIX, 'schema-sql', 'pg', 'migrations'), path.join(root, 'migrations'), { recursive: true });
    ctx = loadQueryContext(root);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const UNASSIGNED = { id: 'unassigned', title: 'Unassigned', kind: 'unassigned' };

  it('find lists the record row beside the code rows; --kind record only records', () => {
    const all = findElements(ctx, { query: 'users' }).results;
    expect(all.find((r) => r.kind === 'record')).toEqual({
      path: 'migrations/0001_init.sql', name: 'users', kind: 'record', startLine: 5, endLine: 12, lineCount: 8, owner: UNASSIGNED,
    });
    expect(all.some((r) => r.kind === 'function' && r.name === 'users')).toBe(true);
    const only = findElements(ctx, { query: 'users', kind: 'record' }).results;
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.kind === 'record')).toBe(true);
  });

  it('outline of a migration: its records with their fields; a file with neither records nor fields of its own stays not-found', () => {
    const out = outlineFile(ctx, 'migrations/0001_init.sql');
    const text = fs.readFileSync(path.join(root, 'migrations', '0001_init.sql'), 'utf8');
    expect(out).toMatchObject({ path: 'migrations/0001_init.sql', lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), parseError: false });
    const users = out.elements.find((e) => e.name === 'users')!;
    expect(users).toMatchObject({ kind: 'record', startLine: 5, endLine: 12, lineCount: 8, owner: UNASSIGNED });
    expect(users.children![0]).toEqual({ name: 'id', kind: 'field', startLine: 6, endLine: 6, lineCount: 1, owner: UNASSIGNED });
    expect(out.elements.map((e) => e.name)).toEqual(expect.arrayContaining(['users', 'classes']));
    expect(catchQueryError(() => outlineFile(ctx, 'migrations/0010_late.sql')).code).toBe('not-found');
  });

  // b613: each migration lists only what it writes; a column a later file adds is a `record.field` row of that file.
  it('outline per migration: 0001 its records with only the fields it declares, 0002 / 0003 the fields they add', () => {
    const names = (file: string) => outlineFile(ctx, file).elements.map((e) => [e.name, e.kind, e.startLine, (e.children ?? []).map((c) => `${c.name}@${c.startLine}`)]);
    expect(names('migrations/0001_init.sql')).toEqual([
      ['users', 'record', 5, ['id@6', 'email@7', 'full_name@8', 'role@9', 'manager_id@10', 'created_at@11']],
      ['classes', 'record', 14, ['id@15', 'code@16', 'name@17', 'capacity@18']],
      ['invoices', 'record', 30, ['id@31', 'user_id@32', 'tags@33']],
      ['class_members', 'record', 22, ['class_id@23', 'user_id@24', 'status@25']],
    ]);
    expect(outlineFile(ctx, 'migrations/0002_alter.sql').elements).toEqual([
      { name: 'classes.teacher_id', kind: 'field', startLine: 1, endLine: 1, lineCount: 1, owner: UNASSIGNED },
    ]);
    expect(names('migrations/0003_functions.sql')).toEqual([['users.updated_at', 'field', 8, []]]);
  });

  it('a repo whose plan has no store: no record rows, .sql stays not-found', () => {
    const bare = tempRepo({ 'src/a.ts': 'export function users() { return 1; }\n' });
    try {
      fs.cpSync(path.join(FIX, 'schema-sql', 'pg', 'migrations'), path.join(bare, 'migrations'), { recursive: true });
      const c = loadQueryContext(bare);
      expect(findElements(c, { query: 'users' }).results.map((r) => r.kind)).toEqual(['function']);
      expect(catchQueryError(() => outlineFile(c, 'migrations/0001_init.sql')).code).toBe('not-found');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
