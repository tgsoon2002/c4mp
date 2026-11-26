import * as fs from 'fs';
import * as path from 'path';
import { makeRepo, runPlanCli } from './helpers/planEditHarness';
import { parsePlanTexts } from '../src/plan/parser';
import { readStorage } from '../src/storage/storageState';
import { checkStorage } from '../src/storage/checkStorage';
import { unplannedStorage } from '../src/query/unplannedStorage';
import { buildReaderRegistry } from '../src/schema/readers';
import { runCheck } from '../src/query/check';
import type { StorageReader } from '../src/schema/reader';
import type { PlanFinding } from '../src/types';

// STOR-3 (b335): the storage rules (checkStorage over readStorage), on tmp repos with the Drizzle and SQL fixtures.
const FIX = path.join(__dirname, 'fixtures');
const SCAN = { ignore: [], languages: ['typescript'] };

const PLAN = (stores: string) => [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      data = component 'Data' { link ../../../../src/db/ }",
  stores,
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/** The store of the drift cases: `reader` names the reader, `fkField` a code column that has an fk to users.id. */
const DRIFT = (reader: string, fkField: string) => [
  "      main = store 'Main' {",
  "        technology 'postgres'",
  `        metadata { reader '${reader}' source 'src/db' status 'done' owner 'k' }`,
  "        users = record 'users' {",
  "          metadata { status 'done' owner 'k' }",
  "          email = field 'email' { metadata { type 'uuid' } }",
  `          ${fkField} = field '${fkField}' { metadata { fk 'rooms.id' } }`,
  "          ghost = field 'ghost' { metadata { type 'text' } }",
  "          role = field 'role' { metadata { type 'int' status 'planned' } }",
  "          gone_field = field 'full_name' { metadata { type 'int' status 'abandoned' } }",
  '        }',
  "        classes = record 'classes' { metadata { status 'planned' } }",
  "        ghost_table = record 'ghost_table' { metadata { status 'in-progress' } }",
  "        gone = record 'gone' { metadata { status 'abandoned' } }",
  '      }',
].join('\n');

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Tmp repo: the plan under .c4pm, `fixture` (a folder of test/fixtures) copied to src/db. */
function repo(plan: string, fixture: string | null = 'schema-drizzle') {
  const r = makeRepo('c4pm-storagecheck-', { 'a.c4': plan });
  roots.push(r.root);
  if (fixture) fs.cpSync(path.join(FIX, fixture), path.join(r.root, 'src', 'db'), { recursive: true });
  return r;
}

const findingsOf = (root: string, plan: string, registry?: ReturnType<typeof buildReaderRegistry>): PlanFinding[] => {
  const p = parsePlanTexts(root, new Map([['a.c4', plan]]));
  return checkStorage(p, readStorage(p, root, SCAN, registry));
};
const brief = (list: PlanFinding[]) => list.map((f) => [f.severity, f.rule, f.id]);
const STORAGE_RULES = ['missing-store', 'store-unreadable', 'missing-record', 'planned-but-built', 'field-drift', 'unplanned-record', 'unplanned-store'];

describe('checkStorage: drift on a read store', () => {
  it.each([
    ['drizzle', 'schema-drizzle', 'created_by', 'users.id'],
    ['sql-migrations', 'schema-sql/pg', 'manager_id', 'users.id'],
  ])('%s: every rule, severity by status, in rule order', (reader, fixture, fkField, codeFk) => {
    const plan = PLAN(DRIFT(reader, fkField));
    const { root } = repo(plan, fixture);
    const all = findingsOf(root, plan);
    const own = all.filter((f) => f.rule !== 'unplanned-record' && !(f.rule === 'field-drift' && f.message.includes(': missing in the plan')));
    // field-drift of the planned fields comes in plan order (the parser orders elements by fqn)
    const drift: [string, string, string, unknown][] = [
      ['critical', 'field-drift', 'app.api.main.users.email', "users.email: type 'uuid' in the plan, 'text' in the code"],
      ['critical', 'field-drift', `app.api.main.users.${fkField}`, `users.${fkField}: fk 'rooms.id' in the plan, '${codeFk}' in the code`],
      ['critical', 'field-drift', 'app.api.main.users.ghost', 'users.ghost: extra in the plan, the code has no such field'],
      ['info', 'field-drift', 'app.api.main.users.role', expect.stringMatching(/^users\.role: type 'int' in the plan, '\w+' in the code$/)],
    ];
    expect(own.map((f) => [...brief([f])[0], f.message])).toEqual([
      ['warning', 'missing-record', 'app.api.main.ghost_table', `record 'ghost_table' is not in the code of store app.api.main (reader ${reader})`],
      ['info', 'planned-but-built', 'app.api.main.classes', expect.stringMatching(/^classes is planned but code exists: src\/db\/[\w/.]+:\d+; update the status\?$/)],
      ...drift.sort((a, b) => (a[2] < b[2] ? -1 : 1)),
    ]);
    // the code columns the plan does not list: one critical field-drift each on the done record, after the planned fields
    const missing = all.filter((f) => f.rule === 'field-drift' && f.message.includes(': missing in the plan'));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((f) => f.id === 'app.api.main.users' && f.severity === 'critical')).toBe(true);
    expect(missing.some((f) => f.message.startsWith('users.id: missing in the plan'))).toBe(true);
    // the abandoned record and field get nothing; classes (no planned field, Q10) gets no field-drift
    expect(all.some((f) => f.id === 'app.api.main.gone' || f.id === 'app.api.main.users.gone_field' || f.message.startsWith('users.full_name: '))).toBe(false);
    expect(all.some((f) => f.rule === 'field-drift' && f.message.startsWith('classes.'))).toBe(false);
    // unplanned-record last, info, `file#name`; the store covers the hits, so no unplanned-store
    const firstUnplanned = all.findIndex((f) => f.rule === 'unplanned-record');
    expect(firstUnplanned).toBeGreaterThan(0);
    expect(all.slice(firstUnplanned).every((f) => f.rule === 'unplanned-record' && f.severity === 'info' && /^src\/db\/.+#\w+$/.test(f.id))).toBe(true);
    expect(all.some((f) => f.rule === 'unplanned-store')).toBe(false);
  });
});

describe('checkStorage: stores with no code', () => {
  it.each([
    ['no reader, no status', "technology 'FoxPro'", [['warning', 'missing-store', "no reader for technology 'FoxPro'"]]],
    ['no reader, planned', "technology 'FoxPro' metadata { status 'planned' }", [['info', 'missing-store', "no reader for technology 'FoxPro'"]]],
    ['no reader, done', "technology 'FoxPro' metadata { status 'done' owner 'k' }", [['critical', 'missing-store', "no reader for technology 'FoxPro'"]]],
    ['no reader, abandoned', "technology 'FoxPro' metadata { status 'abandoned' }", []],
    ['the reader finds no files', "metadata { reader 'drizzle' source 'nowhere' status 'in-progress' }", [['warning', 'missing-store', "reader 'drizzle' found no files"]]],
    ['unknown reader, done', "metadata { reader 'nope' status 'done' owner 'k' }", [['warning', 'store-unreadable', "unknown reader 'nope'; known readers: drizzle, sql-migrations"]]],
  ])('%s', (_label, body, expected) => {
    // the store's records are not judged when it has no code: one finding per problem
    const plan = PLAN(`      fox = store 'Fox' { ${body}\n        rec = record 'rec' { metadata { status 'done' owner 'k' } } }`);
    const { root } = repo(plan);
    const own = findingsOf(root, plan).filter((f) => f.rule !== 'unplanned-store');
    expect(own.map((f) => [f.severity, f.rule, f.message])).toEqual(expected);
    expect(own.every((f) => f.id === 'app.api.fox')).toBe(true);
  });

  it('a store with no code: the drizzle hit no store covers is an unplanned-store (info)', () => {
    const plan = PLAN("      fox = store 'Fox' { technology 'FoxPro' }");
    const { root } = repo(plan);
    expect(findingsOf(root, plan).filter((f) => f.rule === 'unplanned-store')).toEqual([
      { severity: 'info', rule: 'unplanned-store', id: 'src/db', message: expect.stringMatching(/^drizzle finds \d+ records in \d+ files, no store covers them$/) },
    ]);
  });
});

describe('checkStorage: reader failures are findings, never a crash (S10)', () => {
  const failing = (over: Partial<StorageReader>): StorageReader => ({
    id: 'bad', family: 'static', techs: ['postgres'], detect: (_r, files) => files.filter((f) => f.endsWith('.ts')),
    read: () => { throw new Error('cannot parse x.ts'); }, ...over,
  });

  it('a reader that throws on a store: store-unreadable with its message; on the repo scan: store-unreadable store-scan', () => {
    const plan = PLAN("      s = store 'S' { metadata { reader 'bad' status 'done' owner 'k' } }");
    const { root } = repo(plan);
    expect(findingsOf(root, plan, buildReaderRegistry([failing({})]))).toEqual([
      { severity: 'warning', rule: 'store-unreadable', id: 'app.api.s', message: 'cannot parse x.ts' },
      { severity: 'warning', rule: 'store-unreadable', id: 'store-scan', message: 'cannot parse x.ts' },
    ]);
  });

  it('plan unplanned --view storage still throws the scan error, as before', () => {
    const plan = PLAN("      s = store 'S' { technology 'FoxPro' }");
    const { root } = repo(plan);
    const p = parsePlanTexts(root, new Map([['a.c4', plan]]));
    expect(() => unplannedStorage(p, root, SCAN, buildReaderRegistry([failing({})]))).toThrow('cannot parse x.ts');
  });
});

describe('check and the write gate', () => {
  it('check reports the storage findings; plan add record --check is not refused (T3)', async () => {
    const r = repo(PLAN(DRIFT('drizzle', 'created_by')));
    const before = runCheck(r.root, {}, {})!.findings;
    expect(before.some((f) => f.rule === 'missing-record' && f.id === 'app.api.main.ghost_table')).toBe(true);
    const add = await runPlanCli(['plan', 'add', 'record', 'audit_log', '--parent', 'app.api.main', '--check', '--yes', '--repo', r.root]);
    expect(add.stderr).toBe('');
    expect(add.code).toBe(0);
    expect(fs.readFileSync(r.files['a.c4'], 'utf8')).toContain("record 'audit_log'");
    // the new record has no status: a warning missing-record
    expect(runCheck(r.root, {}, {})!.findings).toContainEqual(expect.objectContaining({ severity: 'warning', rule: 'missing-record', id: 'app.api.main.audit_log' }));
  });

  it('a plan with no store reads no storage and gets no storage finding (Q4)', () => {
    const r = repo(PLAN(''));
    expect(runCheck(r.root, {}, {})!.findings.filter((f) => STORAGE_RULES.includes(f.rule))).toEqual([]);
  });
});
