import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { READERS, buildReaderRegistry, readStore, detectAll, mergeModels, dedupeRecords, readDrizzleSchema } from '../src/schema';
import type { StorageReader, SchemaModel, StoreDescription, RecordType } from '../src/schema';

// P23-D3c (b275): the storage reader gateway. Fake readers for the picking rules, Drizzle for the real one.

const rec = (name: string) => ({ name, key: name, file: 'x', line: 1, endLine: 1, fields: [], primaryKey: [], indexes: [], checks: [] });
const fake = (over: Partial<StorageReader> = {}): StorageReader => ({
  id: 'fake', family: 'static', techs: ['postgres'],
  detect: (_r, files) => files.filter((f) => f.endsWith('.fake')),
  read: (_r, files) => ({ records: files.map(rec), unsupported: [] }),
  ...over,
});
const FILES = ['a.fake', 'sub/b.fake', 'sub/c.fake', 'z.ts'];
const run = (readers: StorageReader[], store: StoreDescription, files = FILES) =>
  readStore('/nowhere', files, store, buildReaderRegistry(readers));
const withTempDir = (fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-readers-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('reader registry', () => {
  it('rejects a repeated id', () => {
    expect(() => buildReaderRegistry([fake(), fake()])).toThrow('reader fake listed twice');
  });
  it('derives byId, byTech, all', () => {
    const a = fake({ id: 'a', techs: ['t1', 't2'] });
    const b = fake({ id: 'b', techs: ['t2'] });
    const reg = buildReaderRegistry([a, b]);
    expect(reg.all).toEqual([a, b]);
    expect(reg.byId.b).toBe(b);
    expect(reg.byTech.t1).toEqual([a]);
    expect(reg.byTech.t2).toEqual([a, b]);
  });
});

describe('readStore', () => {
  it('picks by technology word and tags the model with the reader', () => {
    const res = run([fake()], { technology: 'postgres 3.1' });
    expect(res.reader).toBe('fake');
    expect(res.model?.reader).toBe('fake');
    expect(res.model?.records.map((r) => r.name)).toEqual(['a.fake', 'sub/b.fake', 'sub/c.fake']);
  });
  it('picks by reader id even without technology', () => {
    expect(run([fake()], { reader: 'fake' }).reader).toBe('fake');
  });
  it('unknown reader id lists the known ids', () => {
    expect(() => run([fake()], { reader: 'nope' })).toThrow("unknown reader 'nope'; known readers: fake");
  });
  it('several readers for a tech: the one with files wins; two with files is ambiguous', () => {
    const a = fake({ id: 'a' });
    const b = fake({ id: 'b', detect: (_r, f) => f.filter((x) => x.endsWith('.other')) });
    expect(run([a, b], { technology: 'postgres' }).reader).toBe('a');
    expect(() => run([a, fake({ id: 'b' })], { technology: 'postgres' })).toThrow(/ambiguous.*set metadata reader/);
    expect(run([a, b], { technology: 'postgres' }, ['q.ts']).model).toBeNull();
  });
  it('refuses a live reader', () => {
    expect(() => run([fake({ family: 'live' })], { reader: 'fake' })).toThrow(/live reader/);
  });
  it('no reader for the store is a result, not an error', () => {
    expect(run([fake()], { technology: 'mongodb' })).toMatchObject({ reader: null, model: null });
    expect(run([fake()], {})).toMatchObject({ reader: null, model: null });
  });
  it('a reader that finds no files gives model null with its id', () => {
    expect(run([fake()], { reader: 'fake' }, ['z.ts'])).toMatchObject({ reader: 'fake', model: null });
  });
  it('source (file or folder) restricts the files', () => {
    expect(run([fake()], { reader: 'fake', source: 'sub' }).model?.records.map((r) => r.name)).toEqual(['sub/b.fake', 'sub/c.fake']);
    expect(run([fake()], { reader: 'fake', source: 'a.fake' }).model?.records.map((r) => r.name)).toEqual(['a.fake']);
  });
  it('unknown technology text gives no reader', () => {
    expect(run([fake()], { technology: 'Oracle 19' })).toMatchObject({ reader: null, model: null });
  });
  it('a named source file is read even when detect would skip it; a folder still filters', () => {
    const files = ['sub/x.txt', 'sub/b.fake'];
    expect(run([fake()], { reader: 'fake', source: 'sub/x.txt' }, files).model?.records.map((r) => r.name)).toEqual(['sub/x.txt']);
    expect(run([fake()], { reader: 'fake', source: 'sub' }, files).model?.records.map((r) => r.name)).toEqual(['sub/b.fake']);
  });
  it('enforces limits with errors', () => {
    expect(() => run([fake({ limits: { maxFiles: 2 } })], { reader: 'fake' })).toThrow(/maxFiles 2/);
    expect(() => run([fake({ limits: { maxRecords: 1 } })], { reader: 'fake' })).toThrow(/maxRecords 1/);
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'a.fake'), '0123456789');
      const reg = buildReaderRegistry([fake({ limits: { maxBytes: 5 } })]);
      expect(() => readStore(dir, ['a.fake'], { reader: 'fake' }, reg)).toThrow(/maxBytes 5/);
    });
  });
});

describe('detectAll and mergeModels', () => {
  it('detectAll skips live readers', () => {
    const reg = buildReaderRegistry([fake(), fake({ id: 'lv', family: 'live' })]);
    expect(detectAll('/nowhere', FILES, reg)).toEqual({ fake: ['a.fake', 'sub/b.fake', 'sub/c.fake'] });
  });
  it('mergeModels concatenates', () => {
    const m = (n: string): SchemaModel => ({ records: [rec(n)], unsupported: [{ file: n, dialect: 'd' }] });
    const merged = mergeModels([m('a'), m('b')]);
    expect(merged.records.map((r) => r.name)).toEqual(['a', 'b']);
    expect(merged.unsupported).toHaveLength(2);
  });
});

describe('drizzle as reader #1', () => {
  const ROOT = path.join(__dirname, 'fixtures', 'schema-drizzle');
  const all = ['db/columns.ts', 'db/schema/users.ts', 'db/schema/classes.ts', 'db/schema/index.ts', 'other/mysql.ts', 'other/edge.ts'];
  it('is first and read() equals readDrizzleSchema', () => {
    expect(READERS.all[0].id).toBe('drizzle');
    expect(READERS.byTech.postgres).toContain(READERS.byId.drizzle);
    expect(READERS.byId.drizzle.read(ROOT, all)).toEqual(readDrizzleSchema(ROOT, all));
  });
  it('detect finds drizzle files and not unrelated files', () => {
    expect(READERS.byId.drizzle.detect(ROOT, ['db/schema/users.ts', 'db/schema/classes.ts'])).toEqual(['db/schema/users.ts', 'db/schema/classes.ts']);
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'plain.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(dir, 'notes.md'), 'drizzle-orm/pg-core\n');
      expect(READERS.byId.drizzle.detect(dir, ['plain.ts', 'notes.md'])).toEqual([]);
    });
  });
  it('PostgreSQL 16 picks drizzle', () => {
    expect(readStore(ROOT, all, { technology: 'PostgreSQL 16' }).reader).toBe('drizzle');
  });
  it('readStore on a postgres store tags the model with drizzle', () => {
    const res = readStore(ROOT, all, { technology: 'postgres', source: 'db' });
    expect(res.reader).toBe('drizzle');
    expect(res.model?.reader).toBe('drizzle');
    expect(res.model?.records.length).toBeGreaterThan(0);
  });
});

describe('dedupeRecords (STOR-1, b282)', () => {
  const at = (name: string, file: string, line: number, schema?: string): RecordType => ({ ...rec(name), file, line, endLine: line + 2, ...(schema ? { schema } : {}) });
  it.each([
    ['same name in two files: one record, the second is alsoIn', [at('t', 'a.ts', 1), at('t', 'b.ts', 5)], 1, [{ file: 'b.ts', line: 5, endLine: 7 }]],
    ['three places and another record between: first-find order kept', [at('t', 'a.ts', 1), at('u', 'a.ts', 9), at('t', 'b.ts', 5), at('t', 'c.ts', 2)], 2, [{ file: 'b.ts', line: 5, endLine: 7 }, { file: 'c.ts', line: 2, endLine: 4 }]],
    ['same name, different schema: two records', [at('t', 'a.ts', 1), at('t', 'b.ts', 5, 'billing')], 2, undefined],
    ['the same place twice adds nothing', [at('t', 'a.ts', 1), at('t', 'a.ts', 1)], 1, undefined],
    ['no repeat: untouched', [at('t', 'a.ts', 1), at('u', 'b.ts', 5)], 2, undefined],
  ])('%s', (_label, input, count, alsoIn) => {
    const out = dedupeRecords(input);
    expect(out).toHaveLength(count);
    expect(out[0].name).toBe('t');
    expect(out[0].alsoIn).toEqual(alsoIn);
    expect(out[0].file).toBe('a.ts');
  });
  it('does not change the reader objects', () => {
    const input = [at('t', 'a.ts', 1), at('t', 'b.ts', 5)];
    dedupeRecords(input);
    expect(input[0].alsoIn).toBeUndefined();
  });
  it('readStore dedupes, and maxRecords counts the deduped records', () => {
    const dup = fake({ read: () => ({ records: [at('t', 'a.fake', 1), at('t', 'sub/b.fake', 1)], unsupported: [] }), limits: { maxRecords: 1 } });
    const res = run([dup], { reader: 'fake' });
    expect(res.model?.records).toHaveLength(1);
    expect(res.model?.records[0].alsoIn).toEqual([{ file: 'sub/b.fake', line: 1, endLine: 3 }]);
  });
  it('drizzle fixture: 6 declarations of 3 tables give 3 records; the raw reader still gives 6', () => {
    const root = path.join(__dirname, 'fixtures', 'schema-dedupe');
    const files = ['db/core.ts', 'db/relations.ts', 'db/legacy.ts'];
    expect(readDrizzleSchema(root, files).records).toHaveLength(6);
    const model = readStore(root, files, { reader: 'drizzle' }).model;
    expect(model?.records.map((r) => r.name)).toEqual(['users', 'classes', 'enrollments']);
    expect(model?.records.map((r) => (r.alsoIn ?? []).map((l) => l.file))).toEqual([['db/legacy.ts'], ['db/relations.ts', 'db/legacy.ts'], []]);
  });
});

describe('model JSON round trip with the new optional fields', () => {
  it('survives', () => {
    const leaf = { name: 'id', key: 'id', type: 'string', nullable: false, pk: false, unique: false, default: null, values: null, fk: null, line: 1 };
    const m: SchemaModel = {
      reader: 'mongo',
      unsupported: [],
      records: [{ ...rec('sessions'), alsoIn: [{ file: 'y', line: 2, endLine: 3 }], kind: 'keypattern', pattern: 'session:*', ttl: '24h',
        fields: [{ ...leaf, name: 'user', key: 'user', type: 'object', repeated: true, children: [leaf] }] }],
    };
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});
