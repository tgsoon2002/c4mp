import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDrizzleSchema } from '../src/schema';
import type { Field, RecordType } from '../src/schema';

// P23-D3a (b267): the Drizzle reader on trimmed copies of the Acme schema (the answer key of b267),
// plus a few small constructs Acme does not use. Fixtures: test/fixtures/schema-drizzle.

const ROOT = path.join(__dirname, 'fixtures', 'schema-drizzle');
const KELLA = ['users', 'classes', 'auth', 'students', 'enrollment', 'files', 'materials', 'center', 'index']
  .map((f) => `db/schema/${f}.ts`);
const model = readDrizzleSchema(ROOT, [...KELLA, 'db/columns.ts']);

const table = (name: string): RecordType => {
  const r = model.records.find((x) => x.name === name);
  if (!r) throw new Error(`no table ${name}`);
  return r;
};
const field = (t: string, f: string): Field => {
  const x = table(t).fields.find((y) => y.name === f);
  if (!x) throw new Error(`no column ${t}.${f}`);
  return x;
};
const index = (t: string, name: string) => {
  const i = table(t).indexes.find((x) => x.name === name);
  if (!i) throw new Error(`no index ${name}`);
  return i;
};
const withTempFile = (name: string, code: string, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-schema-'));
  try {
    fs.writeFileSync(path.join(dir, name), code);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('readDrizzleSchema: Acme answer key', () => {
  it('tables by SQL name, two in classes.ts, TS const names and files kept', () => {
    expect(model.records.map((r) => r.name).sort()).toEqual([
      'center_pages', 'class_materials', 'class_support_teachers', 'classes', 'enrollments', 'files', 'login_identities',
      'material_versions', 'materials', 'news_posts', 'student_profiles', 'users',
    ]);
    expect(table('classes')).toMatchObject({ key: 'classes', file: 'db/schema/classes.ts' });
    expect(table('class_support_teachers')).toMatchObject({ key: 'classSupportTeachers', file: 'db/schema/classes.ts' });
    expect(table('classes').line).toBeLessThan(table('classes').endLine);
    expect(table('class_support_teachers').line).toBeGreaterThan(table('classes').endLine);
    expect(model.unsupported).toEqual([]);
  });

  it('classes.code: text, not null, unique', () => {
    expect(field('classes', 'code')).toMatchObject({ key: 'code', type: 'text', nullable: false, unique: true, pk: false });
  });

  it('classes.state: values from CLASS_STATES, default as written', () => {
    expect(field('classes', 'state')).toMatchObject({ key: 'state', type: 'text', nullable: false, values: ['active', 'closed'], default: "'active'" });
    expect(field('classes', 'name').values).toBeNull();
  });

  it('classes.main_teacher_id: nullable fk to users.id, onDelete null; key camelCase', () => {
    expect(field('classes', 'main_teacher_id')).toMatchObject({
      key: 'mainTeacherId', type: 'uuid', nullable: true, fk: { table: 'users', column: 'id', onDelete: null },
    });
  });

  it('multi-line .notNull().references() chain', () => {
    expect(field('classes', 'created_by')).toMatchObject({ nullable: false, fk: { table: 'users', column: 'id', onDelete: null } });
  });

  it('onDelete cascade: class_support_teachers.class_id and login_identities.user_id', () => {
    expect(field('class_support_teachers', 'class_id').fk).toEqual({ table: 'classes', column: 'id', onDelete: 'cascade' });
    expect(field('login_identities', 'user_id').fk).toEqual({ table: 'users', column: 'id', onDelete: 'cascade' });
  });

  it('center_pages.key: primary key with enum values', () => {
    expect(field('center_pages', 'key')).toMatchObject({ pk: true, nullable: false, type: 'text', values: ['home', 'about', 'programs', 'contact', 'footer'] });
    expect(table('center_pages').primaryKey).toEqual([]);
  });

  it('composite primaryKey: SQL names, members get pk', () => {
    expect(table('class_support_teachers').primaryKey).toEqual(['class_id', 'email']);
    expect(field('class_support_teachers', 'class_id').pk).toBe(true);
    expect(field('class_support_teachers', 'email').pk).toBe(true);
    expect(field('class_support_teachers', 'user_id').pk).toBe(false);
    expect(table('class_materials').primaryKey).toEqual(['class_id', 'material_id']);
  });

  it("numeric('target_band', {precision, scale}) -> numeric(2,1)", () => {
    expect(field('student_profiles', 'target_band')).toMatchObject({ type: 'numeric(2,1)', nullable: true });
  });

  it('self reference (AnyPgColumn form): users.created_by -> users.id', () => {
    expect(field('users', 'created_by').fk).toEqual({ table: 'users', column: 'id', onDelete: null });
  });

  it('mutual references materials <-> material_versions (order independent)', () => {
    expect(field('materials', 'current_version_id').fk).toEqual({ table: 'material_versions', column: 'id', onDelete: null });
    expect(field('material_versions', 'material_id').fk).toEqual({ table: 'materials', column: 'id', onDelete: null });
  });

  it('partial unique index: classes_join_code_uniq with where text; plain index has no where', () => {
    expect(index('classes', 'classes_join_code_uniq')).toEqual({ name: 'classes_join_code_uniq', unique: true, columns: ['join_code'], where: 'join_code IS NOT NULL' });
    expect(index('classes', 'classes_state_idx')).toEqual({ name: 'classes_state_idx', unique: false, columns: ['state'], where: null });
  });

  it('enrollments_active_uniq: 2 columns + where', () => {
    expect(index('enrollments', 'enrollments_active_uniq')).toEqual({
      name: 'enrollments_active_uniq', unique: true, columns: ['class_id', 'student_profile_id'], where: 'left_at IS NULL',
    });
  });

  it('.desc().nullsFirst() is stripped to plain column names', () => {
    expect(index('news_posts', 'news_posts_status_published_at_idx').columns).toEqual(['status', 'published_at']);
  });

  it("expression index: 'lower(email)', no phantom column 'lower'", () => {
    expect(index('users', 'users_email_lower_uniq')).toMatchObject({ unique: true, columns: ['lower(email)'], where: null });
    expect(table('users').fields.some((f) => f.name === 'lower')).toBe(false);
  });

  it('checks: direct check() and helper checks (oneOf, maxLength, halfStepRange) all give name + SQL text', () => {
    expect(table('news_posts').checks).toContainEqual({ name: 'news_posts_published_at_check', expr: "status <> 'published' OR published_at IS NOT NULL" });
    expect(table('news_posts').checks.map((c) => c.name)).toContain('news_posts_status_check');
    expect(table('login_identities').checks).toContainEqual({ name: 'login_identities_password_hash_check', expr: "password_hash IS NULL OR provider = 'password'" });
    expect(table('login_identities').checks).toContainEqual({ name: 'login_identities_provider_check', expr: expect.stringMatching(/^provider IN \('[a-z_]+'(, '[a-z_]+')*\)$/) });
    expect(table('classes').checks).toEqual([
      { name: 'classes_name_length_check', expr: 'char_length(name) <= 100' },
      { name: 'classes_description_length_check', expr: 'char_length(description) <= 500' },
      { name: 'classes_state_check', expr: "state IN ('active', 'closed')" },
    ]);
    expect(table('student_profiles').checks).toContainEqual({
      name: 'student_profiles_target_band_check', expr: 'target_band BETWEEN 4 AND 9 AND target_band * 2 = trunc(target_band * 2)',
    });
    expect(table('materials').checks.map((c) => c.name)).toContain('materials_link_url_check');
  });

  it('index.ts (re-exports) and columns.ts (helper bodies) give no tables', () => {
    expect(model.records.filter((r) => r.file === 'db/schema/index.ts' || r.file === 'db/columns.ts')).toEqual([]);
  });

  it('helper-built columns are read in place (D3b): idColumn, timestamptz(name), createdAt, jsonb, legacyId', () => {
    expect(field('classes', 'id')).toMatchObject({ key: 'id', type: 'uuid', pk: true, nullable: false });
    expect(field('classes', 'id').unresolved).toBeUndefined();
    expect(field('classes', 'closed_at')).toMatchObject({ key: 'closedAt', type: 'timestamptz', nullable: true });
    expect(field('classes', 'created_at')).toMatchObject({ key: 'createdAt', type: 'timestamptz', nullable: false, default: 'now()' });
    expect(field('classes', 'updated_at')).toMatchObject({ type: 'timestamptz', nullable: false, default: 'now()' });
    expect(field('center_pages', 'blocks')).toMatchObject({ type: 'jsonb', nullable: false });
    expect(field('classes', 'legacy_id')).toMatchObject({ key: 'legacyId', type: 'text', nullable: true });
    expect(field('classes', 'code').unresolved).toBeUndefined();
  });

  it('helper indexes: legacyIdUnique(table, column) -> unique partial index with the name built from the table', () => {
    expect(index('classes', 'classes_legacy_id_uniq')).toEqual({ name: 'classes_legacy_id_uniq', unique: true, columns: ['legacy_id'], where: 'legacy_id IS NOT NULL' });
    expect(index('news_posts', 'news_posts_legacy_id_uniq').columns).toEqual(['legacy_id']);
  });

  it('totals of the Acme fixture: before D3b 44 of 130 columns were type ? and only 4 checks and 14 indexes were read', () => {
    const all = model.records.flatMap((r) => r.fields);
    expect(model.records.length).toBe(12);
    expect(all.length).toBe(130);
    expect(all.filter((f) => f.fk).length).toBe(25);
    expect(all.filter((f) => f.type === '?').length).toBe(0);   // before: 44
    expect(all.filter((f) => f.unresolved !== undefined).length).toBe(0);
    expect(model.records.reduce((n, r) => n + r.checks.length, 0)).toBe(24);   // before: 4
    expect(model.records.every((r) => r.checks.every((c) => c.expr !== null))).toBe(true);
    expect(model.records.reduce((n, r) => n + r.indexes.length, 0)).toBe(20);   // before: 14
  });

  it('every fk points at a table and column that exist', () => {
    let fks = 0;
    for (const r of model.records) {
      for (const f of r.fields) {
        if (!f.fk) continue;
        fks++;
        const t = model.records.find((x) => x.name === f.fk?.table);
        expect(t?.fields.some((c) => c.name === f.fk?.column)).toBe(true);
      }
    }
    expect(fks).toBeGreaterThan(15);
  });
});

describe('readDrizzleSchema: other dialects, edge constructs, errors', () => {
  it('mysql and sqlite files go to unsupported, no tables, no crash', () => {
    const m = readDrizzleSchema(ROOT, ['db/schema/users.ts', 'other/mysql.ts', 'other/sqlite.ts']);
    expect(m.unsupported).toEqual([{ file: 'other/mysql.ts', dialect: 'mysql' }, { file: 'other/sqlite.ts', dialect: 'sqlite' }]);
    expect(m.records.map((r) => r.name)).toEqual(['users']);
  });

  it('a reference to a table outside the given files is kept as written, not dropped', () => {
    const m = readDrizzleSchema(ROOT, ['db/schema/enrollment.ts']);
    const f = m.records[0].fields.find((x) => x.name === 'student_profile_id');
    expect(f?.fk).toEqual({ table: 'studentProfiles', column: 'id', onDelete: null });
  });

  it('edge fixture: forward reference, inline enum, timestamp, numeric forms, unread builder, object extras, spread', () => {
    const m = readDrizzleSchema(ROOT, ['other/edge.ts']);
    const o = m.records.find((r) => r.name === 'orders') as RecordType;
    const f = (n: string) => o.fields.find((x) => x.name === n) as Field;
    expect(f('customer_id').fk).toEqual({ table: 'customers', column: 'id', onDelete: 'set null' });
    expect(f('kind')).toMatchObject({ values: ['web', 'shop'], default: "'web'" });
    expect(f('at')).toMatchObject({ type: 'timestamp', default: 'now()' });
    expect(f('qty')).toMatchObject({ type: 'integer', default: '1', nullable: false });
    expect(f('price').type).toBe('numeric(10)');
    expect(f('ratio').type).toBe('numeric');
    expect(f('tag')).toMatchObject({ type: '?', unresolved: 'varchar' });
    expect(o.fields.map((x) => x.name)).not.toContain('extraColumns');
    expect(o.indexes).toEqual([{ name: 'orders_customer_idx', unique: false, columns: ['customer_id'], where: null }]);
    expect(f('id').pk).toBe(true);
  });

  it('a file with syntax errors throws; so does a missing file', () => {
    withTempFile('bad.ts', "import { pgTable } from 'drizzle-orm/pg-core';\nexport const x = pgTable('x', {;\n", (dir) => {
      expect(() => readDrizzleSchema(dir, ['bad.ts'])).toThrow(/bad\.ts/);
      expect(() => readDrizzleSchema(dir, ['missing.ts'])).toThrow();
    });
  });

  it('a reference that is not () => table.column throws', () => {
    withTempFile('a.ts', "import { pgTable, uuid } from 'drizzle-orm/pg-core';\nexport const x = pgTable('x', { a: uuid('a').references(() => pick()) });\n", (dir) => {
      expect(() => readDrizzleSchema(dir, ['a.ts'])).toThrow(/references/);
    });
  });
});

describe('readDrizzleSchema: project helpers (D3b) on a different project', () => {
  const shop = readDrizzleSchema(path.join(__dirname, 'fixtures', 'schema-drizzle-helpers', 'shop'), ['shop.ts']);
  const orders = shop.records[0];
  const col = (n: string): Field => orders.fields.find((f) => f.key === n) as Field;

  it('own wrappers resolve: arrow, function declaration, same-file helper, default parameter, customType', () => {
    expect(col('id')).toMatchObject({ name: 'id', type: 'uuid', pk: true, nullable: false });
    expect(col('sku')).toMatchObject({ name: 'sku', type: 'text', nullable: false });
    expect(col('title')).toMatchObject({ name: 'title', type: 'text', nullable: false });
    expect(col('total')).toMatchObject({ name: 'total_cents', type: 'integer', nullable: false, default: '0' });
    expect(col('tax')).toMatchObject({ name: 'tax_cents', default: '7' });
    expect(col('shippedAt')).toMatchObject({ name: 'shipped_at', type: 'timestamptz', nullable: true });
    expect(col('search')).toMatchObject({ name: 'search_doc', type: 'tsvector' });
  });

  it('a helper calling a helper resolves when it ends in a drizzle builder within 2 helper calls', () => {
    expect(col('placedAt')).toMatchObject({ name: 'born_at', type: 'timestamptz', nullable: false, default: 'now()' });
  });

  it('stays unresolved: package import, 3 helper calls deep, spread argument; spread entry adds no column', () => {
    expect(col('token')).toMatchObject({ type: '?', unresolved: 'nanoid' });
    expect(col('deep')).toMatchObject({ type: '?', unresolved: 'deep1' });
    expect(col('spreadStamp')).toMatchObject({ type: '?', unresolved: 'stamp' });
    expect(orders.fields.map((f) => f.key)).not.toContain('by');
    expect(col('qty')).toMatchObject({ type: 'integer' });
  });

  it('checks and indexes through helpers, with parameters substituted', () => {
    expect(orders.checks).toEqual([
      { name: 'orders_total_pos', expr: 'total_cents > 0' },
      { name: 'orders_title_len', expr: 'length(title) < 80' },
      { name: 'orders_status_ok', expr: "status IN ('new', 'paid', 'ship''d')" },
      { name: 'orders_qty_pos', expr: 'qty > 0' },   // twoHops -> positive -> check: 2 helper calls
    ]);                                              // threeHops (3 calls) is skipped
    expect(orders.indexes).toEqual([{ name: 'orders_lookup_idx', unique: false, columns: ['sku'], where: null }]);
  });
});
