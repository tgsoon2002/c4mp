import * as fs from 'fs';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { makeRepo, runPlanCli } from './helpers/planEditHarness';
import { matchRecords } from '../src/storage/matchRecords';
import { commonSource, listStoreFiles, scanStoreHits } from '../src/schema/storeScan';
import { addStoreText } from '../src/c4/storeGenerate';
import { parsePlanTexts } from '../src/plan/parser';
import type { PlanElement } from '../src/types';
import type { RecordType, SchemaModel } from '../src/schema/types';

// b273 (D6): --view on plan show / tree / unplanned / generate, on a tmp repo with the Drizzle fixture.
const FIXTURE = path.join(__dirname, 'fixtures', 'schema-drizzle');

describe('matchRecords', () => {
  const rec = (name: string, key: string, file = 'src/db/a.ts'): RecordType =>
    ({ name, key, file, line: 1, endLine: 2, fields: [], primaryKey: [], indexes: [], checks: [] });
  const el = (id: string, title: string, links: PlanElement['links'] = []): PlanElement => ({
    id, kind: 'record', title, description: null, technology: null, links, metadata: {}, parent: 'a.b.s',
    source: { file: 'x.c4', line: 1 },
  });
  const link = (p: string, name: string): PlanElement['links'][number] => ({ raw: `${p}#${name}`, path: p, name, lines: null, title: null });
  const model = (...records: RecordType[]): SchemaModel => ({ records, unsupported: [] });

  it('matches by title, by local id and by the id made safe; the rest is unplanned or missing', () => {
    const users = rec('users', 'users');
    const orderItems = rec('order-items', 'orderItems');
    const audit = rec('audit', 'audit');
    const m = matchRecords([el('a.b.s.x', 'users'), el('a.b.s.order_items', 'Items'), el('a.b.s.gone', 'gone')], model(users, orderItems, audit));
    expect(m.matched.map(x => [x.element.id, x.code.name, x.by])).toEqual([['a.b.s.x', 'users', 'name'], ['a.b.s.order_items', 'order-items', 'name']]);
    expect(m.unplanned).toEqual([audit]);
    expect(m.missing.map(e => e.id)).toEqual(['a.b.s.gone']);
  });

  it('a link wins over a name: the record named by the link is taken even when another has the title', () => {
    const a = rec('accounts', 'accounts', 'src/db/a.ts');
    const b = rec('users', 'users', 'src/db/b.ts');
    // title says 'users' but the link points at accounts
    const m = matchRecords([el('a.b.s.users', 'users', [link('src/db/a.ts', 'accounts')])], model(b, a));
    expect(m.matched).toHaveLength(1);
    expect(m.matched[0]).toMatchObject({ code: a, by: 'link' });
    expect(m.unplanned).toEqual([b]);
  });

  it('a link may name the constant (key); a code record is used once; a link to nothing falls back to the name', () => {
    const users = rec('users', 'usersTable');
    const byKey = matchRecords([el('a.b.s.u', 'u', [link('src/db/a.ts', 'usersTable')])], model(users));
    expect(byKey.matched[0].by).toBe('link');
    const twice = matchRecords([el('a.b.s.one', 'users'), el('a.b.s.two', 'users')], model(users));
    expect(twice.matched.map(x => x.element.id)).toEqual(['a.b.s.one']);
    expect(twice.missing.map(e => e.id)).toEqual(['a.b.s.two']);
    const stale = matchRecords([el('a.b.s.users', 'users', [link('src/db/zzz.ts', 'users')])], model(users));
    expect(stale.matched[0].by).toBe('name');
  });
});

describe('addStoreText', () => {
  it('the whole drizzle fixture (checks, defaults, partial indexes, fields called title/description) parses back with 0 issues', () => {
    const hit = scanStoreHits(FIXTURE, listStoreFiles(FIXTURE, { ignore: [], languages: ['typescript'] }))[0];
    const base = "model {\n  app = system 'App' {\n    api = container 'Api'\n  }\n}\n";
    const made = addStoreText(base, 'app.api', { id: 'main', title: 'Main', technology: 'postgres', reader: 'drizzle', source: 'src/db', records: hit.model.records });
    const plan = parsePlanTexts(FIXTURE, new Map([['a.c4', made.text]]));
    expect(plan.issues).toEqual([]);
    expect(plan.elements.filter(e => e.kind === 'record' && e.parent === 'app.api.main')).toHaveLength(hit.model.records.length);
    expect(plan.elements.filter(e => e.kind === 'field')).toHaveLength(made.fields);
    expect(plan.elements.some(e => e.kind === 'field' && e.title === 'title' && e.id.endsWith('.title_'))).toBe(true);
  });
});

describe('commonSource', () => {
  it('folder, single file, repo root', () => {
    expect(commonSource(['src/db/a.ts', 'src/db/x/b.ts'])).toBe('src/db');
    expect(commonSource(['src/db/a.ts'])).toBe('src/db/a.ts');
    expect(commonSource(['a/x.ts', 'b/y.ts'])).toBeNull();
  });
});

const PLAN = (extra = '') => [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      data = component 'Data' { link ../../../../src/db/ }",
  extra,
  '    }',
  "    web = container 'Web'",
  '  }',
  '}',
  '',
].join('\n');

let roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Tmp repo: plan under .c4pm, the Drizzle fixture copied to src/db. `link` = false leaves no component claiming it. */
function repo(plan: string = PLAN()): { root: string; planFile: string } {
  const r = makeRepo('c4pm-viewstorage-', { 'a.c4': plan });
  roots.push(r.root);
  fs.cpSync(FIXTURE, path.join(r.root, 'src', 'db'), { recursive: true });
  return { root: r.root, planFile: r.files['a.c4'] };
}
const c4 = (root: string, ...args: string[]) => runCli([...args, '--repo', root]);
const unclaimedPlan = PLAN().replace(' link ../../../../src/db/ ', ' ');

describe('plan generate --view storage', () => {
  it('is a dry run by default, --yes writes, a second run is a no-op', () => {
    const { root, planFile } = repo();
    const before = fs.readFileSync(planFile, 'utf8');
    const dry = c4(root, 'plan', 'generate', '--view', 'storage');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/store app\.api\.drizzle_\w+: \d+ records, \d+ fields \(reader drizzle, source src\/db/);
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(fs.readFileSync(planFile, 'utf8')).toBe(before);

    const wrote = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(wrote.status).toBe(0);
    expect(wrote.stdout).toContain('written:');
    const after = fs.readFileSync(planFile, 'utf8');
    expect(after).toMatch(/= store 'drizzle \w+'/);
    expect(after).toMatch(/reader 'drizzle'/);
    expect(after).toMatch(/= record 'users'/);
    expect(after).toMatch(/fk '[a-z_]+\.[a-z_]+'/);

    const again = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already covers it');
    expect(again.stdout).not.toContain('written:');
    expect(fs.readFileSync(planFile, 'utf8')).toBe(after);

    // the written plan reads back: the new store shows its code, and nothing is left unplanned
    const un = c4(root, 'plan', 'unplanned', '--view', 'storage');
    expect(un.stdout.trim()).toBe('nothing unplanned');
  });

  it('a store owner inside a layer: the store goes in the container, not the layer', () => {
    const layered = PLAN().replace(
      "      data = component 'Data' { link ../../../../src/db/ }",
      "      core = layer 'Core' {\n        data = component 'Data' { link ../../../../src/db/ }\n      }",
    );
    const { root, planFile } = repo(layered);
    const r = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('no component owns its files');
    const stores = parsePlanTexts(root, new Map([['a.c4', fs.readFileSync(planFile, 'utf8')]])).elements.filter((e) => e.kind === 'store');
    expect(stores.map((e) => e.parent)).toEqual(['app.api']);
  });

  it('with no component owning the files: skips, lists them, and --container places the store', () => {
    const { root, planFile } = repo(unclaimedPlan);
    const before = fs.readFileSync(planFile, 'utf8');
    const r = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no component owns its files');
    expect(r.stdout).toContain('--container <target>');
    expect(fs.readFileSync(planFile, 'utf8')).toBe(before);

    const forced = c4(root, 'plan', 'generate', '--view', 'storage', '--yes', '--container', 'app.web');
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(planFile, 'utf8')).toMatch(/web = container 'Web' \{[\s\S]*= store /);
    const notContainer = c4(root, 'plan', 'generate', '--view', 'storage', '--container', 'app');
    expect(notContainer.status).toBe(1);
    expect(notContainer.stderr).toContain('--container must name a container');
  });

  it('a repo with no reader hit writes nothing', () => {
    const { root, planFile } = repo();
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const before = fs.readFileSync(planFile, 'utf8');
    const r = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to generate: no reader finds records');
    expect(fs.readFileSync(planFile, 'utf8')).toBe(before);
  });

  it('io says nothing to generate; a bad view and the storage-only options are refused; arch needs none of them', () => {
    const { root } = repo();
    const io = c4(root, 'plan', 'generate', '--view', 'io');
    expect(io.status).toBe(0);
    expect(io.stdout).toContain('nothing to generate: no reader for io yet');
    const bad = c4(root, 'plan', 'generate', '--view', 'nope');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown --view 'nope'");
    const stray = c4(root, 'plan', 'generate', '--yes');
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain('only work with --view storage');
  });

  it('W5 (b301): the container has an extend block in a second file holding a store: the new store goes there', () => {
    const { root, planFile } = repo();
    const second = path.join(path.dirname(planFile), 'b.c4');
    const B = "model {\n  extend app.api {\n    cache = store 'Cache' { technology 'redis' }\n  }\n}\n";
    fs.writeFileSync(second, B);
    const before = fs.readFileSync(planFile, 'utf8');
    const r = c4(root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('written:');
    expect(fs.readFileSync(planFile, 'utf8')).toBe(before);
    const after = fs.readFileSync(second, 'utf8');
    expect(after.startsWith("model {\n  extend app.api {\n    cache = store 'Cache' { technology 'redis' }\n    drizzle_")).toBe(true);
    const plan = parsePlanTexts(root, new Map([['a.c4', before], ['b.c4', after]]));
    expect(plan.issues).toEqual([]);
    const made = plan.elements.filter((e) => e.kind === 'store' && e.id !== 'app.api.cache');
    expect(made.map((e) => [e.parent, e.source.file])).toEqual([['app.api', 'b.c4']]);
    expect(plan.elements.filter((e) => e.kind === 'record' && e.parent === made[0].id).length).toBeGreaterThan(0);
    expect(plan.elements.filter((e) => e.kind === 'record').every((e) => e.source.file === 'b.c4')).toBe(true);
  });

  it('does not touch an existing store that covers the code', () => {
    const own = repo(PLAN("      main = store 'Main' { technology 'postgres'\n metadata { reader 'drizzle' source 'src/db' } }"));
    const before = fs.readFileSync(own.planFile, 'utf8');
    const r = c4(own.root, 'plan', 'generate', '--view', 'storage', '--yes');
    expect(r.stdout).toContain('store app.api.main already covers it');
    expect(fs.readFileSync(own.planFile, 'utf8')).toBe(before);
  });
});

describe('plan unplanned --view', () => {
  it('lists an unplanned store, then an unplanned record once a store exists', async () => {
    const { root } = repo();
    const un = c4(root, 'plan', 'unplanned', '--view', 'storage');
    expect(un.status).toBe(0);
    expect(un.stdout).toMatch(/^unplanned-store \(1\): .*c4mp plan generate --view storage$/m);
    expect(un.stdout).toMatch(/src\/db {2}drizzle finds \d+ records in \d+ files, no store covers them/);

    const withStore = repo(PLAN("      main = store 'Main' { technology 'postgres'\n metadata { reader 'drizzle' source 'src/db' }\n users = record 'users' }"));
    const r = c4(withStore.root, 'plan', 'unplanned', '--view', 'storage', '--json');
    const groups = JSON.parse(r.stdout).groups as { rule: string; hint: string; items: { id: string; message: string }[] }[];
    expect(groups.map(g => g.rule)).toEqual(['unplanned-record']);
    expect(groups[0].hint).toContain('c4mp plan add record <name> --parent <store>');
    expect(groups[0].items.length).toBeGreaterThan(0);
    expect(groups[0].items.some(i => i.id.endsWith('#users'))).toBe(false);
  });

  it('io has no reader yet (exit 0); a bad view is refused; arch is unchanged', async () => {
    const { root } = repo();
    const io = c4(root, 'plan', 'unplanned', '--view', 'io');
    expect(io.status).toBe(0);
    expect(io.stdout).toContain('no code reader for the io view yet');
    const bad = await runPlanCli(['plan', 'unplanned', '--view', 'x', '--repo', root]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("unknown --view 'x'");
    const arch = c4(root, 'plan', 'unplanned');
    expect(arch.stdout).not.toContain('unplanned-store');
    expect(c4(root, 'plan', 'unplanned', '--view', 'arch').stdout).toBe(arch.stdout);
  });

  it('a store whose reader fails is shown as a warning, not dropped', () => {
    const { root } = repo(PLAN("      bad = store 'Bad' { metadata { reader 'nope' } }"));
    const r = c4(root, 'plan', 'unplanned', '--view', 'storage');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^warning: store app\.api\.bad: unknown reader 'nope'/m);
  });
});

describe('plan tree --view and plan show --view', () => {
  const STORE_PLAN = PLAN([
    "      main = store 'Main' {",
    "        technology 'postgres'",
    "        users = record 'users' { id = field 'id' { metadata { type 'uuid' } } }",
    '      }',
    "      login = screen 'Login'",
  ].join('\n'));

  it('tree <container> --view storage draws the stores only; a store is a target; the two-argument form is refused', async () => {
    const { root } = repo(STORE_PLAN);
    const t = await runPlanCli(['plan', 'tree', 'app.api', '--view', 'storage', '-r', '--format', 'text', '--repo', root]);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('app.api.main  [store]');
    expect(t.stdout).toContain('app.api.main.users  [record]');
    expect(t.stdout).toContain('app.api.main.users.id  [field]');
    expect(t.stdout).not.toContain('Login');
    expect(t.stdout).not.toContain('app.api.data');
    const io = await runPlanCli(['plan', 'tree', 'app.api', '--view', 'io', '--format', 'text', '--repo', root]);
    expect(io.stdout).toContain('app.api.login  [screen]');
    expect(io.stdout).not.toContain('[store]');
    const store = await runPlanCli(['plan', 'tree', 'app.api.main', '--view', 'storage', '--format', 'text', '--repo', root]);
    expect(store.stdout).toContain('app.api.main.users  [record]');
    const two = await runPlanCli(['plan', 'tree', 'c2', 'app.api', '--view', 'storage', '--repo', root]);
    expect(two.code).toBe(1);
    expect(two.stderr).toContain('give only the target');
    const wrong = await runPlanCli(['plan', 'tree', 'app.api.data', '--view', 'storage', '--repo', root]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('is a component; with --view storage the target is a container or an element of the storage view');
  });

  it('tree without --view keeps its two arguments (arch unchanged)', async () => {
    const { root } = repo(STORE_PLAN);
    const arch = await runPlanCli(['plan', 'tree', 'c2', 'app.api', '--repo', root]);
    const explicit = await runPlanCli(['plan', 'tree', 'c2', 'app.api', '--view', 'arch', '--repo', root]);
    expect(arch.code).toBe(0);
    expect(explicit.stdout).toBe(arch.stdout);
    const one = await runPlanCli(['plan', 'tree', 'app.api', '--repo', root]);
    expect(one.code).toBe(1);
    expect(one.stderr).toContain('tree needs a level and a target');
  });

  it('show without a target lists one view; no --view lists everything; a target ignores --view', () => {
    const { root } = repo(STORE_PLAN);
    const all = c4(root, 'plan', 'show');
    expect(all.stdout).toMatch(/\d+ elements, \d+ relations/);
    const st = c4(root, 'plan', 'show', '--view', 'storage');
    expect(st.stdout).toMatch(/, 3 elements \(storage view\), 0 relations/);
    expect(st.stdout).toContain('app.api.main.users.id  [field]');
    expect(st.stdout).not.toContain('[container]');
    expect(c4(root, 'plan', 'show', '--view', 'io').stdout).toMatch(/1 elements \(io view\)/);
    expect(c4(root, 'plan', 'show', '--view', 'bogus').status).toBe(1);
    expect(c4(root, 'plan', 'show', 'app.api.main', '--view', 'io').stdout).toBe(c4(root, 'plan', 'show', 'app.api.main').stdout);
  });
});
