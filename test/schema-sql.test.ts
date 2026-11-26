import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { READERS, applySqlFiles, fieldLocation, readSqlSchema, readStore, readerExtensions, sortMigrationFiles } from '../src/schema';
import { detectSqlFiles } from '../src/schema/sqlMigrations';
import { listSourceFiles } from '../src/importer/walk';
import { SOURCE_EXTENSIONS } from '../src/languages/registry';
import type { RecordType } from '../src/schema';

// P23 (b212 D3): the sql-migrations reader (reader #2). Fixtures: test/fixtures/schema-sql (pg, sqlite, mysql).

const ROOT = path.join(__dirname, 'fixtures', 'schema-sql');
const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  };
  walk(dir);
  return out;
};
/** Everything the tests compare: a record without file/line noise. */
const shape = (r: RecordType) => ({
  name: r.name, schema: r.schema, primaryKey: r.primaryKey, indexes: r.indexes, checks: r.checks,
  fields: r.fields.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable, pk: f.pk, unique: f.unique, default: f.default, values: f.values, fk: f.fk })),
});
const sql = (...texts: string[]) => applySqlFiles(texts.map((text, i) => ({ file: `f${i}.sql`, text })));
const tbl = (m: ReturnType<typeof sql>, name: string) => {
  const r = m.records.find((x) => x.name === name);
  if (!r) throw new Error(`no table ${name}`);
  return r;
};
const withTempRepo = (files: Record<string, string>, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sql-'));
  try {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const fk = (table: string, column: string, onDelete: string | null) => ({ table, column, onDelete });
const col = (name: string, type: string, o: Partial<{ nullable: boolean; pk: boolean; unique: boolean; default: string | null; values: string[] | null; fk: ReturnType<typeof fk> | null }> = {}) =>
  ({ name, type, nullable: true, pk: false, unique: false, default: null, values: null, fk: null, ...o });

describe('ordering', () => {
  it('numbers compare as numbers, then name; flyway versions, repeatable and unnumbered last; prisma folders count', () => {
    expect(sortMigrationFiles(['m/10_b.sql', 'm/2_a.sql', 'm/0009_x.sql', 'm/0010_y.sql', 'm/seed.sql', 'm/R__views.sql', 'm/V1_10__a.sql', 'm/V1_2__b.sql', 'm/20240101120000_t.sql']))
      .toEqual(['m/V1_2__b.sql', 'm/V1_10__a.sql', 'm/2_a.sql', 'm/0009_x.sql', 'm/0010_y.sql', 'm/10_b.sql', 'm/20240101120000_t.sql', 'm/R__views.sql', 'm/seed.sql']);
    expect(sortMigrationFiles(['prisma/migrations/20240201_b/migration.sql', 'prisma/migrations/20240101_a/migration.sql', 'a/001.up.sql']))
      .toEqual(['a/001.up.sql', 'prisma/migrations/20240101_a/migration.sql', 'prisma/migrations/20240201_b/migration.sql']);
  });
});

describe('detect', () => {
  it('migration folders, flyway names and CREATE TABLE text; not down or undo files, not other sql', () => {
    withTempRepo({
      'db/migrations/1.sql': 'select 1', 'prisma/migrations/2024_a/migration.sql': 'x', 'drizzle/0000_x.sql': 'x', 'sql/V3__x.sql': 'x',
      'ops/dump.sql': 'create  temp table t (a int)', 'ops/data.sql': 'insert into t values (1)',
      'db/migrations/1.down.sql': 'drop table t', 'sql/U3__x.sql': 'x', 'src/a.ts': 'CREATE TABLE x',
    }, (dir) => {
      const files = ['db/migrations/1.sql', 'prisma/migrations/2024_a/migration.sql', 'drizzle/0000_x.sql', 'sql/V3__x.sql', 'ops/dump.sql', 'ops/data.sql', 'db/migrations/1.down.sql', 'sql/U3__x.sql', 'src/a.ts'];
      expect(detectSqlFiles(dir, files)).toEqual(['db/migrations/1.sql', 'prisma/migrations/2024_a/migration.sql', 'drizzle/0000_x.sql', 'sql/V3__x.sql', 'ops/dump.sql']);
    });
  });
});

describe('postgres migration history (fixtures/schema-sql/pg)', () => {
  const files = filesUnder('pg');
  const model = readSqlSchema(ROOT, files);
  it('final model, exactly', () => {
    expect(model.records.map(shape)).toEqual([
      {
        name: 'users', schema: undefined, primaryKey: ['id'],
        indexes: [{ name: 'users_lower_email_idx', unique: false, columns: ['lower(email)'], where: null }], checks: [],
        fields: [
          col('id', 'uuid', { nullable: false, pk: true, default: 'gen_random_uuid()' }),
          col('email', 'text', { nullable: false, unique: true }),
          col('full_name', 'text'),
          col('role', 'user_role', { nullable: false, default: "'student'", values: ['admin', 'teacher', 'student', 'guest'] }),
          col('manager_id', 'uuid', { fk: fk('users', 'id', 'set null') }),
          col('created_at', 'timestamp with time zone', { nullable: false, default: 'now()' }),
          col('updated_at', 'timestamptz'),
        ],
      },
      {
        name: 'classes', schema: undefined, primaryKey: ['id'],
        indexes: [{ name: 'classes_code_idx', unique: true, columns: ['code'], where: 'capacity IS NOT NULL' }],
        checks: [{ name: 'classes_capacity_check', expr: 'capacity > 0' }],
        fields: [
          col('id', 'uuid', { nullable: false, pk: true }),
          col('code', 'varchar(20)', { nullable: false }),
          col('name', 'text', { nullable: false }),
          col('capacity', 'bigint', { default: '30' }),
          col('teacher_id', 'uuid', { fk: fk('users', 'id', 'cascade') }),
        ],
      },
      {
        name: 'invoices', schema: 'billing', primaryKey: ['id'], indexes: [], checks: [],
        fields: [
          col('id', 'serial', { nullable: false, pk: true }),
          col('user_id', 'uuid', { nullable: false, fk: fk('users', 'id', null) }),
          col('tags', 'text[]', { nullable: false, default: "'{}'" }),
        ],
      },
      {
        name: 'class_members', schema: undefined, primaryKey: ['class_id', 'user_id'], indexes: [], checks: [],
        fields: [
          col('class_id', 'uuid', { nullable: false, pk: true, fk: fk('classes', 'id', 'cascade') }),
          col('user_id', 'uuid', { nullable: false, pk: true, fk: fk('users', 'id', null) }),
          col('status', 'text', { nullable: false, default: "'active'" }),
        ],
      },
    ]);
  });
  it('record file and lines point at the CREATE TABLE', () => {
    const users = tbl(model, 'users');
    expect([users.file, users.line, users.endLine]).toEqual(['pg/migrations/0001_init.sql', 5, 12]);
    expect(tbl(model, 'class_members').file).toBe('pg/migrations/0001_init.sql');
  });
  it('b613: a column a later file adds carries that file (fieldLocation); the record\'s own columns carry none', () => {
    const users = tbl(model, 'users');
    const classes = tbl(model, 'classes');
    const at = (r: RecordType, name: string) => fieldLocation(r, r.fields.find((f) => f.name === name)!);
    expect(at(users, 'updated_at')).toEqual({ file: 'pg/migrations/0003_functions.sql', line: 8 });
    expect(at(classes, 'teacher_id')).toEqual({ file: 'pg/migrations/0002_alter.sql', line: 1 });
    expect(at(users, 'email')).toEqual({ file: 'pg/migrations/0001_init.sql', line: 7 });
    // renamed (title -> name) and altered (capacity) in later files: still written in 0001, no file of their own
    expect(model.records.flatMap((r) => r.fields.filter((f) => 'file' in f).map((f) => `${r.name}.${f.name}`))).toEqual(['users.updated_at', 'classes.teacher_id']);
  });
  it('what is not understood is listed with file:line, never dropped; data and settings are skipped silently', () => {
    expect(model.unsupported).toEqual([
      { file: 'pg/migrations/0003_functions.sql', dialect: 'sql', line: 2, statement: 'CREATE FUNCTION', reason: 'not read' },
      { file: 'pg/migrations/0003_functions.sql', dialect: 'sql', line: 9, statement: 'CREATE TRIGGER', reason: 'not read' },
      { file: 'pg/migrations/0003_functions.sql', dialect: 'sql', line: 19, statement: 'ALTER TABLE ghost', reason: 'table ghost not found' },
    ]);
  });
  it('is independent of the order the files are passed in', () => {
    expect(readSqlSchema(ROOT, [...files].reverse())).toEqual(model);
  });
});

describe('sqlite and mysql spellings', () => {
  it('sqlite: [x] and "x" identifiers, INTEGER PRIMARY KEY AUTOINCREMENT, WITHOUT ROWID', () => {
    expect(readSqlSchema(ROOT, filesUnder('sqlite')).records.map(shape)).toEqual([
      {
        name: 'notes', schema: undefined, primaryKey: ['id'], checks: [],
        indexes: [{ name: 'notes_author', unique: false, columns: ['author_id'], where: null }],
        fields: [
          col('id', 'INTEGER', { nullable: false, pk: true, default: 'AUTOINCREMENT' }),
          col('title', 'TEXT', { nullable: false }),
          col('body', 'TEXT', { default: "''" }),
          col('author_id', 'INTEGER', { fk: fk('authors', 'id', null) }),
        ],
      },
      {
        name: 'authors', schema: undefined, primaryKey: ['id'], indexes: [], checks: [],
        fields: [col('id', 'INTEGER', { nullable: false, pk: true }), col('name', 'TEXT', { nullable: false })],
      },
    ]);
  });
  it('mysql: backticks, AUTO_INCREMENT, inline ENUM, KEY / UNIQUE KEY, table FK, MODIFY', () => {
    const m = readSqlSchema(ROOT, filesUnder('mysql'));
    expect(m.unsupported).toEqual([]);
    expect(m.records.map(shape)).toEqual([
      {
        name: 'orders', schema: undefined, primaryKey: ['id'], checks: [],
        indexes: [
          { name: 'idx_customer', unique: false, columns: ['customer_id'], where: null },
          { name: 'uq_status_created', unique: true, columns: ['status', 'created'], where: null },
        ],
        fields: [
          col('id', 'bigint unsigned', { nullable: false, pk: true, default: 'AUTO_INCREMENT' }),
          col('customer_id', 'int', { nullable: false, fk: fk('customers', 'id', 'cascade') }),
          col('status', "enum('new','paid')", { nullable: false, default: "'new'", values: ['new', 'paid'] }),
          col('created', 'datetime', { default: 'CURRENT_TIMESTAMP' }),
        ],
      },
      {
        name: 'customers', schema: undefined, primaryKey: ['id'], indexes: [], checks: [],
        fields: [col('id', 'int', { nullable: false, pk: true }), col('name', 'varchar(120)', { nullable: false })],
      },
    ]);
  });
});

describe('statement splitting and names', () => {
  it('; inside comments, strings, quoted identifiers and dollar bodies does not split; the dollar body is skipped as one unsupported entry', () => {
    const m = sql(`
      -- a; b
      /* c; /* nested; */ d; */
      CREATE TABLE "Odd;Name" (a text DEFAULT 'x;y', "b;c" int DEFAULT E'it\\'s;');
      DO $body$ BEGIN PERFORM 1; END $body$;
      CREATE TABLE after_do (id int);`);
    expect(m.records.map((r) => r.name)).toEqual(['Odd;Name', 'after_do']);
    expect(tbl(m, 'Odd;Name').fields.map((f) => [f.name, f.default])).toEqual([['a', "'x;y'"], ['b;c', "E'it\\'s;'"]]);
    expect(m.unsupported).toEqual([{ file: 'f0.sql', dialect: 'sql', line: 5, statement: 'DO', reason: 'not read' }]);
  });
  it('unquoted names fold to lower case, quoted names keep case; schema qualifier dropped (kept on the record unless public)', () => {
    const m = sql('CREATE TABLE PUBLIC.Users (Id int PRIMARY KEY); CREATE TABLE "Users" (id int); CREATE TABLE app.Things (x int REFERENCES Users(id));');
    expect(m.records.map((r) => [r.name, r.schema])).toEqual([['users', undefined], ['Users', undefined], ['things', 'app']]);
    expect(tbl(m, 'things').fields[0].fk).toEqual(fk('users', 'id', null));
  });
  it('CREATE TRIGGER ... BEGIN ... END (mysql / sqlite) keeps its inner semicolons', () => {
    const m = sql('CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (CASE WHEN 1 THEN 2 END); END; CREATE TABLE z (id int);');
    expect(m.records.map((r) => r.name)).toEqual(['z']);
    expect(m.unsupported).toHaveLength(1);
    expect(m.unsupported[0]).toMatchObject({ statement: 'CREATE TRIGGER', line: 1 });
  });
  it('an unterminated string or comment does not throw', () => {
    expect(() => sql("CREATE TABLE a (x int); SELECT 'oops")).not.toThrow();
    expect(sql('CREATE TABLE a (x int); /* open').records).toHaveLength(1);
  });
});

describe('ALTER / DROP behaviour', () => {
  it('rename column follows pk, index, and foreign keys that point at it; rename table follows foreign keys', () => {
    const m = sql(
      'CREATE TABLE a (id int PRIMARY KEY, n int); CREATE INDEX a_n ON a (n); CREATE TABLE b (a_id int REFERENCES a(id));',
      'ALTER TABLE a RENAME COLUMN id TO uid; ALTER TABLE a RENAME COLUMN n TO m; ALTER TABLE a RENAME TO c;',
    );
    expect(tbl(m, 'c').primaryKey).toEqual(['uid']);
    expect(tbl(m, 'c').indexes[0].columns).toEqual(['m']);
    expect(tbl(m, 'b').fields[0].fk).toEqual(fk('c', 'uid', null));
    expect(m.unsupported).toEqual([]);
  });
  it('drop column removes its indexes, constraints and checks; drop constraint/index/table undo their effect', () => {
    const m = sql(
      `CREATE TABLE p (id int PRIMARY KEY); CREATE TABLE q (id int, x int UNIQUE, y int CHECK (y > 0), z int, p_id int REFERENCES p(id), CONSTRAINT q_zz UNIQUE (z, id));
       CREATE INDEX q_y ON q (y); CREATE INDEX q_id ON q (id);`,
      'ALTER TABLE q DROP COLUMN y; ALTER TABLE q DROP CONSTRAINT q_x_key; ALTER TABLE q DROP CONSTRAINT q_zz; DROP INDEX IF EXISTS q_id, nothing_here; DROP TABLE p;',
    );
    const q = tbl(m, 'q');
    expect(q.fields.map((f) => [f.name, f.unique, f.fk])).toEqual([['id', false, null], ['x', false, null], ['z', false, null], ['p_id', false, null]]);
    expect(q.indexes).toEqual([]);
    expect(q.checks).toEqual([]);
    expect(m.records.map((r) => r.name)).toEqual(['q']);
    expect(m.unsupported).toEqual([]);
  });
  it('drop primary key, set / drop not null and default, type change, composite and expression indexes', () => {
    const m = sql(
      "CREATE TABLE t (a int, b int, c text NOT NULL DEFAULT 'x'); ALTER TABLE t ADD PRIMARY KEY (a, b);",
      'ALTER TABLE t ALTER COLUMN c DROP NOT NULL, ALTER COLUMN c DROP DEFAULT, ALTER COLUMN b SET DATA TYPE bigint USING b::bigint; CREATE INDEX CONCURRENTLY IF NOT EXISTS t_ix ON t (a DESC, (b + 1), c text_pattern_ops);',
    );
    const t = tbl(m, 't');
    expect(t.primaryKey).toEqual(['a', 'b']);
    expect(t.fields.map((f) => [f.name, f.type, f.nullable, f.pk, f.default])).toEqual([['a', 'int', false, true, null], ['b', 'bigint', false, true, null], ['c', 'text', true, false, null]]);
    expect(t.indexes).toEqual([{ name: 't_ix', unique: false, columns: ['a', 'b + 1', 'c'], where: null }]);
    expect(sql('CREATE TABLE t (a int PRIMARY KEY); ALTER TABLE t DROP CONSTRAINT t_pkey;').records[0].primaryKey).toEqual([]);
  });
  it('enum: values set, added, and applied to array columns; CREATE TABLE IF NOT EXISTS keeps the first', () => {
    const m = sql("CREATE TYPE s AS ENUM ('a', 'b'); CREATE TABLE t (x s, y s[]); ALTER TYPE s ADD VALUE 'c' BEFORE 'b'; CREATE TABLE IF NOT EXISTS t (other int);");
    expect(tbl(m, 't').fields.map((f) => [f.name, f.values])).toEqual([['x', ['a', 'c', 'b']], ['y', ['a', 'c', 'b']]]);
  });
  it('REFERENCES without a column list uses the single-column primary key of the target; otherwise it is reported', () => {
    const ok = sql('CREATE TABLE p (id int PRIMARY KEY); CREATE TABLE c (p_id int REFERENCES p ON DELETE CASCADE);');
    expect(tbl(ok, 'c').fields[0].fk).toEqual(fk('p', 'id', 'cascade'));
    const bad = sql('CREATE TABLE p (a int, b int, PRIMARY KEY (a, b)); CREATE TABLE c (p_id int REFERENCES p);');
    expect(bad.unsupported).toHaveLength(1);
    expect(bad.unsupported[0]).toMatchObject({ file: 'f0.sql', line: 1, statement: 'c.p_id' });
    // b613: added by a later file, reported at that file; MODIFY in a later file moves the column there
    const later = sql('CREATE TABLE p (a int, b int, PRIMARY KEY (a, b)); CREATE TABLE c (id int);', '\nALTER TABLE c ADD COLUMN p_id int REFERENCES p;', 'ALTER TABLE c MODIFY id bigint;');
    expect(later.unsupported).toEqual([{ file: 'f1.sql', dialect: 'sql', line: 2, statement: 'c.p_id', reason: 'REFERENCES p without a column list and no single-column primary key to use' }]);
    expect(tbl(later, 'c').fields.map((f) => [f.name, f.file, f.line])).toEqual([['id', 'f2.sql', 1], ['p_id', 'f1.sql', 2]]);
  });
  it('composite foreign key is mapped column by column; GENERATED and unknown actions are kept visible', () => {
    const m = sql(`CREATE TABLE p (a int, b int, PRIMARY KEY (a, b));
      CREATE TABLE c (x int, y int, id int GENERATED ALWAYS AS IDENTITY, FOREIGN KEY (x, y) REFERENCES p (a, b) ON DELETE RESTRICT ON UPDATE CASCADE);
      ALTER TABLE c ALTER COLUMN x SET STATISTICS 100;`);
    expect(tbl(m, 'c').fields.map((f) => [f.name, f.fk, f.default])).toEqual([
      ['x', fk('p', 'a', 'restrict'), null], ['y', fk('p', 'b', 'restrict'), null], ['id', null, 'GENERATED ALWAYS AS IDENTITY'],
    ]);
    expect(m.unsupported).toEqual([{ file: 'f0.sql', dialect: 'sql', line: 3, statement: 'ALTER TABLE c', reason: 'action not read: ALTER COLUMN x SET STATISTICS 100' }]);
  });
});

describe('the reader in the gateway', () => {
  it('is reader #2: static, postgres / mysql / sqlite, asks for .sql files', () => {
    const r = READERS.byId['sql-migrations'];
    expect(READERS.all.map((x) => x.id)).toEqual(['drizzle', 'sql-migrations']);
    expect([r.family, r.techs, r.extensions]).toEqual(['static', ['postgres', 'mysql', 'sqlite'], ['.sql']]);
    expect(readerExtensions()).toEqual(['.sql']);
    expect(READERS.byTech.mysql).toEqual([r]);
  });
  it('the file walk lists .sql files when given the readers extensions, and not otherwise', () => {
    expect(listSourceFiles(ROOT, { extensions: SOURCE_EXTENSIONS }).filter((f) => f.endsWith('.sql'))).toEqual([]);
    expect(listSourceFiles(ROOT, { extensions: [...SOURCE_EXTENSIONS, ...readerExtensions()] })).toContain('pg/migrations/0001_init.sql');
  });
  it('mysql and sqlite stores pick it by technology; model is tagged with the reader', () => {
    const res = readStore(ROOT, filesUnder('mysql'), { technology: 'MariaDB 11' });
    expect(res.reader).toBe('sql-migrations');
    expect(res.model?.reader).toBe('sql-migrations');
    expect(res.model?.records.map((r) => r.name)).toEqual(['orders', 'customers']);
  });
  it('drizzle and sql-migrations both find files for a postgres store: ambiguous; metadata reader picks one', () => {
    withTempRepo({
      'src/schema.ts': "import { pgTable, uuid } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: uuid('id').primaryKey() });\n",
      'drizzle/0000_init.sql': 'CREATE TABLE "users" ("id" uuid PRIMARY KEY NOT NULL);\n',
    }, (dir) => {
      const files = ['src/schema.ts', 'drizzle/0000_init.sql'];
      expect(() => readStore(dir, files, { technology: 'postgres' })).toThrow(/ambiguous.*drizzle, sql-migrations.*set metadata reader/);
      expect(readStore(dir, files, { technology: 'postgres', reader: 'sql-migrations' }).model?.records.map((r) => r.name)).toEqual(['users']);
      expect(readStore(dir, files, { reader: 'drizzle' }).reader).toBe('drizzle');
      // only one of them has files: no ambiguity
      expect(readStore(dir, ['drizzle/0000_init.sql'], { technology: 'postgres' }).reader).toBe('sql-migrations');
    });
  });
});
