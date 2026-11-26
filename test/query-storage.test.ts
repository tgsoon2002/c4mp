import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import { recordShow, storageOf } from '../src/query/storage';
import * as storageState from '../src/storage/storageState';

// STOR-4 (b336): the storage of a query context (storageOf, read once) and the code record of a plan record (recordShow).
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
  "          ghost = field 'ghost'",
  '        }',
  "        nothere = record 'nothere'",
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const repoWith = (plan: string | null): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qstorage-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  if (plan !== null) {
    fs.mkdirSync(path.join(dir, 'c4'));
    fs.writeFileSync(path.join(dir, 'c4', 'arch.c4'), plan);
  }
  fs.cpSync(FIXTURE, path.join(dir, 'src', 'db'), { recursive: true });
  return dir;
};

describe('storageOf / recordShow', () => {
  let repo: string;
  beforeAll(() => { repo = repoWith(PLAN); });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });
  afterEach(() => jest.restoreAllMocks());

  it('reads the storage once per context', () => {
    const spy = jest.spyOn(storageState, 'readStorage');
    const ctx = loadQueryContext(repo);
    const a = storageOf(ctx);
    expect(storageOf(ctx)).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a!.stores.map((s) => s.element.id)).toEqual(['app.api.main']);
  });

  it('null without a plan or without a store, and no read', () => {
    const spy = jest.spyOn(storageState, 'readStorage');
    const noPlan = repoWith(null);
    const noStore = repoWith("model {\n  app = system 'App' {\n  }\n}\n");
    try {
      expect(storageOf(loadQueryContext(noPlan))).toBeNull();
      expect(storageOf(loadQueryContext(noStore))).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(noPlan, { recursive: true, force: true });
      fs.rmSync(noStore, { recursive: true, force: true });
    }
  });

  it('a matched record: place, how it matched, fields with pk / nullable / fk, the plan field and the diffs', () => {
    const ctx = loadQueryContext(repo);
    const el = ctx.plan!.elements.find((e) => e.id === 'app.api.main.users')!;
    const r = recordShow(storageOf(ctx)!, el, ctx.plan!)!;
    expect(r).toMatchObject({ file: 'src/db/db/schema/users.ts', by: 'name' });
    expect(r.endLine).toBeGreaterThan(r.line);
    const field = (n: string) => r.fields.find((f) => f.name === n);
    expect(field('id')).toEqual({ name: 'id', type: 'uuid', nullable: false, pk: true, fk: null, onDelete: null, plan: null });
    expect(field('created_by')).toMatchObject({ type: 'uuid', nullable: true, pk: false, fk: 'users.id', plan: null });
    expect(field('email')!.plan).toBe('app.api.main.users.email');
    expect(r.diffs).toContainEqual({ record: 'users', field: 'ghost', kind: 'extra' });
    expect(r.diffs.every((d) => d.record === 'users')).toBe(true);
  });

  it('null for a plan record the code does not have and for a non-record', () => {
    const ctx = loadQueryContext(repo);
    const state = storageOf(ctx)!;
    expect(recordShow(state, ctx.plan!.elements.find((e) => e.id === 'app.api.main.nothere')!, ctx.plan!)).toBeNull();
    expect(recordShow(state, ctx.plan!.elements.find((e) => e.id === 'app.api')!, ctx.plan!)).toBeNull();
  });
});
