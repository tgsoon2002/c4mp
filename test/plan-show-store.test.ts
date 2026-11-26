import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from './helpers/runCli';

// b275 part C: `plan show <store>` prints what the store's reader finds in the code; other kinds are unchanged.
const FIXTURE = path.join(__dirname, 'fixtures', 'schema-drizzle');
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      main = store 'Main' {",
  "        technology 'PostgreSQL 16'",
  "        metadata { source 'src/db' }",
  "        users = record 'users' {",
  "          email = field 'email'",
  '        }',
  "        nothere = record 'nothere'",
  '      }',
  "      odd = store 'Odd' { technology 'FoxPro' }",
  "      bad = store 'Bad' {",
  "        technology 'PostgreSQL'",
  "        metadata { reader 'nope' }",
  '      }',
  "      empty = store 'Empty' {",
  "        technology 'PostgreSQL'",
  '        metadata {',
  "          reader 'drizzle'",
  "          source 'nowhere'",
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-showstore-'));
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
  fs.mkdirSync(path.join(tmp, 'c4'));
  fs.writeFileSync(path.join(tmp, 'c4', 'arch.c4'), PLAN);
  fs.cpSync(FIXTURE, path.join(tmp, 'src', 'db'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const show = (target: string, ...extra: string[]) => runCli(['plan', 'show', target, '--repo', tmp, ...extra]);

describe('plan show <store> code line', () => {
  it('prints reader and record count, text and json', () => {
    const t = show('app.api.main');
    expect(t.status).toBe(0);
    expect(t.stdout).toMatch(/^code:\s+reader drizzle, \d+ records$/m);
    const j = JSON.parse(show('app.api.main', '--json').stdout);
    expect(j.code).toMatchObject({ reader: 'drizzle' });
    expect(j.code.records).toBeGreaterThan(0);
    expect(t.stdout).toContain(`reader drizzle, ${j.code.records} records`);
  });
  it('unknown technology: the reason, no reader', () => {
    expect(show('app.api.odd').stdout).toMatch(/^code:\s+no reader for technology 'FoxPro'$/m);
    expect(JSON.parse(show('app.api.odd', '--json').stdout).code).toMatchObject({ reader: null, records: 0, reason: expect.stringContaining('FoxPro') });
  });
  it('a reader error is printed beside the rest of the output', () => {
    const t = show('app.api.bad');
    expect(t.status).toBe(0);
    expect(t.stdout).toMatch(/^code:\s+error: unknown reader 'nope'/m);
    expect(t.stdout).toContain('fqn:');
    expect(JSON.parse(show('app.api.bad', '--json').stdout).code.error).toMatch(/unknown reader 'nope'/);
  });
  it('a reader that finds no files: its reason, the reader kept', () => {
    expect(show('app.api.empty').stdout).toMatch(/^code:\s+reader 'drizzle' found no files$/m);
    expect(JSON.parse(show('app.api.empty', '--json').stdout).code).toEqual({ reader: 'drizzle', records: 0, reason: "reader 'drizzle' found no files" });
  });
  it('other kinds have no code line', () => {
    expect(show('app.api').stdout).not.toContain('code:');
    expect(JSON.parse(show('app.api', '--json').stdout)).not.toHaveProperty('code');
    expect(JSON.parse(show('app.api', '--json').stdout)).not.toHaveProperty('record');
  });
});

// STOR-4 (b336): `plan show <record>` lists the matched code record: where, how it matched, one row per field.
describe('plan show <record>', () => {
  it('text: a code line and one row per field (type, pk, null, fk)', () => {
    const t = show('app.api.main.users');
    expect(t.status).toBe(0);
    expect(t.stdout).toMatch(/^code:\s+src\/db\/db\/schema\/users\.ts:\d+-\d+ \(by name\)$/m);
    expect(t.stdout).toMatch(/^ {11}id +uuid +pk$/m);
    expect(t.stdout).toMatch(/^ {11}created_by +uuid +null +fk users\.id$/m);
  });
  it('json: record with fields and diffs; only for a matched record', () => {
    const j = JSON.parse(show('app.api.main.users', '--json').stdout);
    expect(j.record).toMatchObject({ file: 'src/db/db/schema/users.ts', by: 'name' });
    expect(j.record.fields.find((f: { name: string }) => f.name === 'created_by')).toMatchObject({ type: 'uuid', pk: false, nullable: true, fk: 'users.id' });
    expect(j.record.fields.find((f: { name: string }) => f.name === 'email').plan).toBe('app.api.main.users.email');
    expect(Array.isArray(j.record.diffs)).toBe(true);
    const missing = show('app.api.main.nothere');
    expect(missing.stdout).not.toContain('code:');
    expect(JSON.parse(show('app.api.main.nothere', '--json').stdout)).not.toHaveProperty('record');
  });
});
