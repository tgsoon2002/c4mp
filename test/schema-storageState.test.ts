import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { buildStorageState } from '../src/storage/storageState';
import { fieldDiff, matchFields } from '../src/storage/fieldDiff';
import { normalizeSqlType, sqlTypesEqual } from '../src/schema/sqlTypes';
import { unplannedStorage } from '../src/query/unplannedStorage';
import { listStoreFiles } from '../src/schema/storeScan';
import type { PlanElement } from '../src/types';
import type { Field } from '../src/schema/types';

// STOR-2 (b334): the storage state, fieldDiff and the SQL type normalizer.
const FIX = path.join(__dirname, 'fixtures');

const planOf = (root: string, storeBody: string, extra = '') =>
  parsePlanTexts(root, new Map([['a.c4', `model {\n  app = system 'App' {\n    api = container 'Api' {\n      s = store 'S' { ${storeBody} }\n${extra}\n    }\n  }\n}\n`]]));
const SCAN = { ignore: [], languages: ['typescript'] };
const filesOf = (root: string) => listStoreFiles(root, SCAN);

describe('sqlTypes', () => {
  it.each([
    ['varchar(255)', 'character varying(255)', true],
    ['varchar', 'character varying(255)', true],
    ['varchar(100)', 'varchar(255)', false],
    ['int', 'integer', true],
    ['INT4', 'integer', true],
    ['bigint', 'int8', true],
    ['timestamptz', 'timestamp with time zone', true],
    ['timestamp(3) with time zone', 'timestamptz(3)', true],
    ['timestamp', 'timestamptz', false],
    ['numeric(10, 2)', 'decimal(10,2)', true],
    ['numeric(10,2)', 'numeric(10,3)', false],
    ['text[]', 'text', false],
    ['text[]', 'text []', true],
    ['uuid', 'text', false],
    ['?', 'uuid', true],
  ])('%s vs %s equal = %s', (a, b, equal) => {
    expect(sqlTypesEqual(a, b)).toBe(equal);
    expect(sqlTypesEqual(b, a)).toBe(equal);
  });
  it.each([
    ['Character Varying(255)', { base: 'varchar', params: '255', array: false }],
    ['double precision', { base: 'double precision', params: null, array: false }],
    ['', null],
    ['?', null],
  ])('normalizeSqlType(%j)', (text, parts) => {
    expect(normalizeSqlType(text)).toEqual(parts);
  });
});

describe('fieldDiff', () => {
  const planField = (title: string, metadata: Record<string, string> = {}, localId = title): PlanElement => ({
    id: `app.api.s.users.${localId}`, kind: 'field', title, description: null, technology: null, links: [], metadata, parent: 'app.api.s.users', source: { file: 'a.c4', line: 1 },
  });
  const codeField = (name: string, over: Partial<Field> = {}): Field =>
    ({ name, key: name, type: 'text', unresolved: undefined, nullable: false, pk: false, unique: false, default: null, values: null, fk: null, line: 1, ...over });
  const fk = { table: 'classes', column: 'id', onDelete: null };

  it.each([
    ['same: nothing', [planField('email', { type: 'character varying', nullable: 'false' })], [codeField('email', { type: 'varchar(255)' })], []],
    ['stated type differs', [planField('email', { type: 'uuid' })], [codeField('email')], [{ field: 'email', kind: 'type', plan: 'uuid', code: 'text' }]],
    ['stated nullable differs', [planField('email', { nullable: 'true' })], [codeField('email')], [{ field: 'email', kind: 'nullable', plan: 'true', code: 'false' }]],
    ['fk differs', [planField('class_id', { fk: 'rooms.id' })], [codeField('class_id', { fk })], [{ field: 'class_id', kind: 'fk', plan: 'rooms.id', code: 'classes.id' }]],
    ['fk stated, code has none', [planField('class_id', { fk: 'classes.id' })], [codeField('class_id')], [{ field: 'class_id', kind: 'fk', plan: 'classes.id' }]],
    ['unstated values are not compared', [planField('class_id')], [codeField('class_id', { fk, nullable: true, type: 'uuid' })], []],
    ['extra and missing', [planField('gone', { type: 'text' })], [codeField('email', { type: 'uuid' })], [{ field: 'gone', kind: 'extra', plan: 'text' }, { field: 'email', kind: 'missing', code: 'uuid' }]],
    ['local id matches the name', [planField('E-mail', {}, 'email')], [codeField('email')], []],
  ])('%s', (_label, plan, code, expected) => {
    expect(fieldDiff('users', plan, code)).toEqual(expected.map((d) => ({ record: 'users', ...d })));
  });

  it('STOR-5 (b338) matchFields: pairs and planOnly in plan order, codeOnly in code order, a code field used once', () => {
    const [email, mail2, gone, name] = [planField('email'), planField('Mail', {}, 'email'), planField('gone'), planField('Full name', {}, 'full_name')];
    const [cName, cEmail, cId] = [codeField('full_name'), codeField('email'), codeField('id')];
    const m = matchFields([email, mail2, gone, name], [cName, cEmail, cId]);
    expect(m.pairs).toEqual([{ plan: email, code: cEmail }, { plan: name, code: cName }]);
    expect(m.planOnly).toEqual([mail2, gone]);
    expect(m.codeOnly).toEqual([cId]);
  });
});

describe('buildStorageState', () => {
  let root: string;
  beforeAll(() => {
    // A Drizzle schema and its own SQL migrations in one repo: both readers serve postgres and both find files.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-storagestate-'));
    fs.cpSync(path.join(FIX, 'schema-drizzle', 'db', 'schema'), path.join(root, 'db', 'schema'), { recursive: true });
    fs.cpSync(path.join(FIX, 'schema-sql', 'pg', 'migrations'), path.join(root, 'migrations'), { recursive: true });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('ORM + its SQL migrations, no reader key: an error entry with the candidates, not a throw', () => {
    const plan = planOf(root, "technology 'postgres'");
    let state!: ReturnType<typeof buildStorageState>;
    expect(() => { state = buildStorageState(plan, { repoRoot: root, files: filesOf(root) }); }).not.toThrow();
    expect(state.stores).toHaveLength(1);
    expect(state.stores[0]).toMatchObject({ reader: null, model: null, matching: null, fieldDiffs: [], files: [], candidates: ['drizzle', 'sql-migrations'] });
    expect(state.stores[0].error).toMatch(/^ambiguous: readers drizzle, sql-migrations .*set metadata reader$/);
  });

  it('the same store with a reader key reads; the unplanned query reports the ambiguous one as a problem and keeps going', () => {
    const named = buildStorageState(planOf(root, "technology 'postgres' metadata { reader 'drizzle' }"), { repoRoot: root, files: filesOf(root) });
    expect(named.stores[0].error).toBeUndefined();
    expect(named.stores[0].reader).toBe('drizzle');
    expect(named.stores[0].files.length).toBeGreaterThan(0);

    const out = unplannedStorage(planOf(root, "technology 'postgres'"), root, SCAN);
    expect(out.problems).toEqual([expect.stringMatching(/^store app\.api\.s: ambiguous: readers drizzle, sql-migrations/)]);
  });

  it.each([
    ['unknown reader id', "metadata { reader 'nope' }", /^unknown reader 'nope'/, []],
    ['no reader for the technology', "technology 'mongodb'", undefined, undefined],
  ])('%s', (_label, body, error, candidates) => {
    const s = buildStorageState(planOf(root, body), { repoRoot: root, files: filesOf(root) }).stores[0];
    expect(s.model).toBeNull();
    if (error) expect(s.error).toMatch(error);
    else expect(s.error).toBeUndefined();
    expect(s.candidates).toEqual(candidates);
  });

  it('b614: the files of an SQL store include the migrations that only ALTER its tables (fieldLocation), sorted and unique', () => {
    const s = buildStorageState(planOf(root, "metadata { reader 'sql-migrations' }"), { repoRoot: root, files: filesOf(root) }).stores[0];
    expect(s.error).toBeUndefined();
    // 0002 and 0003 add columns to tables of 0001; 0010 only drops a constraint and renames a table (no field there).
    expect(s.files).toEqual(['migrations/0001_init.sql', 'migrations/0002_alter.sql', 'migrations/0003_functions.sql']);
  });

  it('a read store lists records matched, field differences, and the alsoIn files', () => {
    const dedupe = path.join(FIX, 'schema-dedupe');
    const nested = parsePlanTexts(dedupe, new Map([['a.c4', `model {\n  app = system 'App' {\n    api = container 'Api' {\n      s = store 'S' { metadata { reader 'drizzle' }\n        users = record 'users' {\n          f = field 'email' { metadata { type 'uuid' } }\n        }\n      }\n    }\n  }\n}\n`]]));
    const st = buildStorageState(nested, { repoRoot: dedupe, files: filesOf(dedupe) }).stores[0];
    expect(st.files).toEqual(['db/core.ts', 'db/legacy.ts', 'db/relations.ts']);
    expect(st.matching?.matched.map((m) => m.code.name)).toEqual(['users']);
    expect(st.fieldDiffs).toEqual([
      { record: 'users', field: 'email', kind: 'type', plan: 'uuid', code: 'text' },
      { record: 'users', field: 'id', kind: 'missing', code: 'uuid' },
    ]);
  });
});
