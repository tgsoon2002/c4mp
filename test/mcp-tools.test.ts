import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildTools } from '../src/mcp/tools';
import { requireProject } from '../src/outputs';
import { boardFileFor } from '../src/board/load';
import { loadQueryContext } from '../src/query/context';
import { runStatus } from '../src/query/status';
import * as storageState from '../src/storage/storageState';
import type { ToolDef } from '../src/mcp/server';
import { CLI_JS } from './helpers/runCli';
import { makeSimRepo, runSimCli } from './helpers/simHarness';
import type { SimRepo } from './helpers/simHarness';
import { listing } from './helpers/planEditHarness';
import { planNoScan } from '../src/scan/planScan';

// P15-T7a: the MCP tools against the real CLI's --json output (same text), the cache (Decision 3) and error mapping.

const projectRoot = path.resolve(__dirname, '..');
const fixtures = path.resolve(__dirname, 'fixtures');

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }

async function call(tools: ToolDef[], name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return (await tool.handler(args)) as ToolResult;
}

/** stdout of `c4pm <args> --repo <repo> --json`, without the trailing newline. */
function cliJson(args: string[], repo: string): string {
  const r = spawnSync(process.execPath, [CLI_JS, ...args, '--repo', repo, '--json'], { cwd: projectRoot, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.trimEnd();
}

describe('tool registry', () => {
  it('lists find, search, show, plan_show, outline, deps, calls, callers, view_path, check, status, sim_list, sim_show, sim_apply, sim_remove with the required properties', () => {
    const tools = buildTools(path.join(fixtures, 'sample'), {});
    expect(tools.map((t) => t.name)).toEqual([
      'find', 'search', 'show', 'plan_show', 'outline', 'deps', 'calls', 'callers', 'view_path', 'check', 'status', 'sim_list', 'sim_show',
      'sim_apply', 'sim_remove',
    ]);
    const schema = (n: string): any => tools.find((t) => t.name === n)!.inputSchema;
    expect(schema('find').required).toEqual(['query']);
    expect(Object.keys(schema('find').properties)).toEqual(['query', 'kind', 'limit']);
    expect(schema('find').properties.kind.enum).toEqual(['function', 'class', 'method', 'type', 'test', 'file', 'record']);
    expect(schema('find').properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
    expect(Object.keys(schema('show').properties)).toEqual(['target', 'max_lines']);
    expect(schema('show').properties.max_lines).toMatchObject({ maximum: 400, default: 400 });
    expect(schema('plan_show').required).toEqual(['target']);
    expect(schema('outline').required).toEqual(['path']);
    expect(schema('deps').required).toEqual(['id']);
    expect(Object.keys(schema('deps').properties)).toEqual(['id', 'files', 'compare']);
    expect(schema('check').properties.min_severity).toMatchObject({ enum: ['info', 'warning', 'critical'], default: 'info' });
    expect(Object.keys(schema('check').properties)).toEqual(['min_severity', 'sprint']);
    expect(schema('check').required).toBeUndefined();
    expect(schema('status').properties).toEqual({});
    expect(Object.keys(schema('sim_list').properties)).toEqual(['kind']);
    expect(schema('sim_list').required).toBeUndefined();
    expect(schema('sim_show').required).toEqual(['id']);
    expect(Object.keys(schema('sim_apply').properties)).toEqual(['spec', 'yes', 'owner']);
    expect(schema('sim_apply').required).toEqual(['spec']);
    expect(Object.keys(schema('sim_remove').properties)).toEqual(['id', 'yes']);
    expect(schema('sim_remove').required).toEqual(['id']);
    for (const n of ['sim_apply', 'sim_remove']) {
      expect(schema(n).properties.yes).toMatchObject({ type: 'boolean', default: false });
      expect(tools.find((t) => t.name === n)!.description).toContain('dry run unless yes is true');
    }
    expect(tools.find((t) => t.name === 'sim_remove')!.description).toContain('Writes only .c4mp/projects/<id>/sim/ (.c4pm in an old repo)');
    expect(tools.map((t) => t.description).join('\n')).not.toMatch(/`c4pm /);
    expect(tools.find((t) => t.name === 'sim_apply')!.description).toContain('Refs are stored as uids');
  });
});

// T6 (b702): sim_list / sim_show on the demo Shop (test/fixtures/sim-demo-shop, as test/sim-demo-fixture.test.ts copies
// it). The CLI prints the object indented, the tool compact (as plan_show): the same object, keys in the same order, so
// the tool text is the CLI text re-serialised. A refusal is the CLI's `--json` refusal `{ok: false, command, error}`.
describe('sim_list and sim_show = c4pm sim list|show --json', () => {
  let root: string;
  let repo: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t6-')));
    repo = path.join(root, 'shop');
    fs.cpSync(path.join(fixtures, 'sim-demo-shop'), repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** `c4pm sim <args> --repo <repo> --json`: exit code and stdout re-serialised compact. */
  const cliSim = (args: string[]): { status: number | null; text: string } => {
    const r = spawnSync(process.execPath, [CLI_JS, 'sim', ...args, '--repo', repo, '--json'], { cwd: projectRoot, encoding: 'utf8' });
    return { status: r.status, text: JSON.stringify(JSON.parse(r.stdout)) };
  };

  it.each([
    ['sim_list', {}, ['list']],
    ['sim_list', { kind: 'journey' }, ['list', '--kind', 'journey']],
    ['sim_show', { id: 's-1' }, ['show', 's-1']],
    ['sim_show', { id: 's-2' }, ['show', 's-2']],
  ])('%s %j', async (tool, args, cliArgs) => {
    const r = await call(buildTools(repo, {}), tool, args);
    const cli = cliSim(cliArgs);
    expect(cli.status).toBe(0);
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toBe(cli.text);
  }, 120000);

  it('the list has s-1 (flow) and s-2 (journey); s-1 targets resolve against the plan', async () => {
    const tools = buildTools(repo, {});
    const list = JSON.parse((await call(tools, 'sim_list', {})).content[0].text);
    expect(list.sims.map((s: { id: string; kind: string }) => [s.id, s.kind])).toEqual([['s-1', 'flow'], ['s-2', 'journey']]);
    const s1 = JSON.parse((await call(tools, 'sim_show', { id: 's-1' })).content[0].text);
    expect(s1.steps[0].targets.every((t: { resolved: unknown }) => t.resolved !== null)).toBe(true);
  }, 120000);

  it.each([
    ['sim_show', { id: 's-9' }, ['show', 's-9'], 'not-found'],
    ['sim_list', { kind: 'story' }, ['list', '--kind', 'story'], 'invalid'],
  ])('%s %j -> isError with the CLI refusal', async (tool, args, cliArgs, code) => {
    const r = await call(buildTools(repo, {}), tool, args);
    const cli = cliSim(cliArgs);
    expect(cli.status).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(cli.text);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: { code } });
  }, 120000);

  it('reads the plan as the CLI does: the MCP --ignore does not hide .c4 files from the names', async () => {
    const cli = { ignore: ['**/*.c4'] };
    expect(loadQueryContext(repo, { cli }).plan).toBeNull();   // ctx.plan would name nothing here
    const r = await call(buildTools(repo, cli), 'sim_show', { id: 's-1' });
    expect(r.content[0].text).toBe(cliSim(['show', 's-1']).text);
  }, 120000);

  it.each([['sim_show', {}], ['sim_show', { id: 1 }], ['sim_list', { kind: 2 }]])('%s %j -> invalid', async (tool, args) => {
    const r = await call(buildTools(repo, {}), tool, args);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe('invalid');
  });
});

// T6b (b768): the first MCP writes. sim_apply / sim_remove call the same Simulation editing functions as
// `c4pm sim apply|remove` (runSimCli, in-process), so: a dry run writes nothing, `yes: true` writes the same bytes, the
// reply object is the CLI's `--json` object (compact vs indented), a refusal is that object with isError. The `yes`
// parity runs both on the SAME repo path (restored from a copy in between), so `file` and the minted ids match too.
describe('sim_apply and sim_remove = c4pm sim apply|remove --json', () => {
  const START = {
    's-1': { kind: 'flow', title: 'Buy', steps: [{ target: 'u-add', view: 'io' }] },
    's-2': { kind: 'journey', title: 'First buyer', stages: [{ name: 'Mail', outside: 'Sale email' }, { name: 'Buy', flow: 's-1' }] },
  };
  const SPEC = { sims: [
    { ref: 'co', kind: 'flow', title: 'Check out', steps: [{ target: 'Products', view: 'io' }] },
    { kind: 'journey', title: 'Gift', stages: [{ outside: 'Birthday' }, { flowRef: 'co' }] },
  ] };
  let repo: SimRepo;
  let side: string;   // the spec files and the copy of the repo
  beforeEach(() => {
    repo = makeSimRepo('c4pm-t6b-', START);
    side = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t6b-side-')));
    fs.cpSync(repo.root, path.join(side, 'copy'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(side, { recursive: true, force: true });
  });

  /** Put the repo back as it was before the test (same path). */
  const restore = (): void => {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.cpSync(path.join(side, 'copy'), repo.root, { recursive: true });
  };
  /** Every file under the repo's sim folder with its bytes. */
  const simBytes = (): Record<string, string> => {
    const dir = path.dirname(repo.file('s-1'));
    return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  };
  /** `c4pm sim <args> --repo <repo> --json` in-process: exit code and the stdout object re-serialised compact (as the MCP text). */
  const cli = async (args: string[]): Promise<{ code: number; text: string }> => {
    const r = await runSimCli([...args, '--repo', repo.root, '--json']);
    return { code: r.code, text: JSON.stringify(JSON.parse(r.stdout)) };
  };
  /** The spec as a `sim apply` file. */
  const specFile = (spec: unknown): string => {
    const f = path.join(side, 'spec.json');
    fs.writeFileSync(f, JSON.stringify(spec));
    return f;
  };
  const tool = (name: string, args: Record<string, unknown>): Promise<ToolResult> => call(buildTools(repo.root, {}), name, args);

  it.each([
    ['sim_apply', () => ({ spec: SPEC }), () => ['apply', specFile(SPEC)]],
    ['sim_apply', () => ({ spec: SPEC, yes: false }), () => ['apply', specFile(SPEC)]],
    ['sim_remove', () => ({ id: 's-2' }), () => ['remove', 's-2']],
  ])('%s dry run: writes nothing, the reply is the CLI --json object', async (name, args, cliArgs) => {
    const before = listing(repo.root);
    const r = await tool(name, args());
    expect(listing(repo.root)).toEqual(before);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, dryRun: true, written: false, error: null });
    const c = await cli(cliArgs());
    expect(c.code).toBe(0);
    expect(r.content[0].text).toBe(c.text);
  });

  it.each([
    ['sim_apply', { spec: SPEC, yes: true }, () => ['apply', specFile(SPEC), '--yes']],
    ['sim_remove', { id: 's-2', yes: true }, () => ['remove', 's-2', '--yes']],
  ])('%s yes: writes the same bytes as the CLI --yes, the same object', async (name, args, cliArgs) => {
    const before = simBytes();
    const r = await tool(name, args);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, dryRun: false, written: true, error: null });
    const written = simBytes();
    const files = listing(repo.root);
    expect(written).not.toEqual(before);
    restore();
    expect(simBytes()).toEqual(before);
    const c = await cli(cliArgs());
    expect(c.code).toBe(0);
    expect(simBytes()).toEqual(written);
    expect(listing(repo.root)).toEqual(files);   // no other file differs either
    expect(r.content[0].text).toBe(c.text);
  });

  it('sim_apply with owner adds code outside the plan with that owner, same structure as the CLI --owner', async () => {
    const spec = { sims: [{ kind: 'flow', title: 'Sum', steps: [{ target: 'src/cart.ts#total', view: 'arch' }] }] };
    const ownerOfTotal = (): unknown => planNoScan(repo.root)?.elements.find((e) => e.id === 'shop.api.cart.total')?.metadata.owner;
    const r = await tool('sim_apply', { spec, yes: true, owner: 'Jay' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, written: true });
    expect(ownerOfTotal()).toBe('Jay');
    restore();
    const c = await cli(['apply', specFile(spec), '--owner', 'Jay', '--yes']);
    expect(c.code).toBe(0);
    expect(ownerOfTotal()).toBe('Jay');
    const flat = (t: string): string => t.replace(/[0-9a-f-]{36}/g, 'UID');
    expect(flat(r.content[0].text)).toBe(flat(c.text));
  });

  it.each([
    ['a ref nothing names', { sims: [{ kind: 'flow', title: 'X', steps: [{ target: 'u-nothing', view: 'arch' }] }] }],
    ['no sims array', { nope: 1 }],
  ])('a bad spec (%s) -> isError with the CLI refusal and its reasons, nothing written', async (_label, spec) => {
    const before = listing(repo.root);
    for (const yes of [false, true]) {
      const r = await tool('sim_apply', { spec, yes });
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body).toMatchObject({ ok: false, command: 'sim apply', dryRun: !yes, written: false });
      expect(Array.isArray(body.error.reasons)).toBe(true);
      const c = await cli(['apply', specFile(spec), ...(yes ? ['--yes'] : [])]);
      expect(c.code).toBe(1);
      expect(r.content[0].text).toBe(c.text);
    }
    expect(listing(repo.root)).toEqual(before);
  });

  it('sim_remove is refused while a journey stage names the flow (the stage in reasons), nothing written', async () => {
    const before = listing(repo.root);
    const r = await tool('sim_remove', { id: 's-1', yes: true });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body).toMatchObject({ ok: false, command: 'sim remove', written: false, error: { code: 'invalid' } });
    expect(body.error.reasons).toEqual([expect.stringContaining("s-2 stage 2 'Buy'")]);
    expect(listing(repo.root)).toEqual(before);
    expect(r.content[0].text).toBe((await cli(['remove', 's-1', '--yes'])).text);
  });

  it('an unknown id is not-found; a yes that is not a boolean is invalid and nothing runs', async () => {
    const before = listing(repo.root);
    const unknown = await tool('sim_remove', { id: 's-9' });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.content[0].text).error.code).toBe('not-found');
    for (const [name, args] of [['sim_remove', { id: 's-2', yes: 'yes' }], ['sim_apply', { spec: SPEC, yes: 1 }], ['sim_remove', {}]] as const) {
      const r = await tool(name, args);
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error.code).toBe('invalid');
    }
    expect(listing(repo.root)).toEqual(before);
  });
});

describe.each(['sample', 'phofast'])('parity with CLI --json on %s', (fixture) => {
  const repo = path.join(fixtures, fixture);
  const ctx = loadQueryContext(repo);
  const file = ctx.snapshot.files.find((f) => f.elements.length > 0)!;
  const name = file.elements[0].name;
  const containerId = ctx.snapshot.containers[0].id;
  const tools = buildTools(repo, {});

  it.each([
    ['find', { query: name, limit: 5 }, ['find', name, '--limit', '5']],
    ['show', { target: file.file, max_lines: 7 }, ['show', file.file, '--max-lines', '7']],
    ['outline', { path: file.file }, ['outline', file.file]],
    ['outline', { path: 'package.json' }, ['outline', 'package.json']],
    ['show', { target: 'package.json#name' }, ['show', 'package.json#name']],
    ['deps', { id: containerId }, ['deps', containerId]],
    ['deps', { id: containerId, files: true }, ['deps', containerId, '--files']],
  ])('%s', async (tool, args, cliArgs) => {
    const r = await call(tools, tool, args);
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toBe(cliJson(cliArgs, repo));
  }, 300000);
});

describe('cache and staleness', () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t7a-'));
    repo = path.join(tmp, 'sample');
    fs.cpSync(path.join(fixtures, 'sample'), repo, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const found = async (tools: ToolDef[], query: string): Promise<number> =>
    JSON.parse((await call(tools, 'find', { query })).content[0].text).results.length;

  it('notices an added, edited and deleted file on the next call', async () => {
    const tools = buildTools(repo, {});
    expect(await found(tools, 'zzNewThing')).toBe(0);

    const added = path.join(repo, 'api', 'src', 'zzAdded.ts');
    fs.writeFileSync(added, 'export function zzNewThing(): number {\n  return 1;\n}\n');
    expect(await found(tools, 'zzNewThing')).toBeGreaterThan(0);

    // Edit: rename the function (a different size, so the fingerprint changes even within one mtime tick).
    fs.writeFileSync(added, 'export function zzRenamedThingLonger(): number {\n  return 1;\n}\n');
    expect(await found(tools, 'zzNewThing')).toBe(0);
    expect(await found(tools, 'zzRenamedThingLonger')).toBeGreaterThan(0);

    fs.unlinkSync(added);
    expect(await found(tools, 'zzRenamedThingLonger')).toBe(0);
  }, 120000);

  it('keeps the context while nothing changed', async () => {
    const tools = buildTools(repo, {});
    const a = (await call(tools, 'deps', { id: 'api' })).content[0].text;
    const b = (await call(tools, 'deps', { id: 'api' })).content[0].text;
    expect(b).toBe(a);
  }, 120000);
});

// STOR-4 (b336): plan_show of a record = `plan show <record> --json`; the storage is read once while nothing changes and
// read again when a migration (.sql, a reader extension the scan does not walk) changes.
describe('plan_show of a record', () => {
  let repo: string;
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
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-stor4-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}');
    fs.mkdirSync(path.join(repo, 'c4'));
    fs.writeFileSync(path.join(repo, 'c4', 'arch.c4'), PLAN);
    fs.cpSync(path.join(fixtures, 'schema-drizzle'), path.join(repo, 'src', 'db'), { recursive: true });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('returns the same JSON as the CLI', async () => {
    const r = await call(buildTools(repo, {}), 'plan_show', { target: 'app.api.main.users' });
    expect(r.isError).toBeUndefined();
    const cli = cliJson(['plan', 'show', 'app.api.main.users'], repo);
    // The CLI prints it indented, the tool compact: the same object, keys in the same order.
    expect(r.content[0].text).toBe(JSON.stringify(JSON.parse(cli)));
    const j = JSON.parse(r.content[0].text);
    expect(j).toEqual(JSON.parse(cli));
    expect(j.record.fields.find((f: { name: string }) => f.name === 'created_by')).toMatchObject({ type: 'uuid', pk: false, nullable: true, fk: 'users.id' });
  }, 120000);

  it('find and outline with records: MCP = CLI --json', async () => {
    const tools = buildTools(repo, {});
    const f = await call(tools, 'find', { query: 'users', kind: 'record' });
    expect(f.content[0].text).toBe(cliJson(['find', 'users', '--kind', 'record'], repo));
    expect(JSON.parse(f.content[0].text).results[0]).toMatchObject({ kind: 'record', name: 'users', path: 'src/db/db/schema/users.ts' });
    const all = await call(tools, 'find', { query: 'users' });
    expect(all.content[0].text).toBe(cliJson(['find', 'users'], repo));
  }, 120000);

  it('one storage read for two calls; a changed .sql migration makes the next call read again', async () => {
    const spy = jest.spyOn(storageState, 'readStorage');
    const tools = buildTools(repo, {});
    await call(tools, 'plan_show', { target: 'app.api.main' });
    await call(tools, 'plan_show', { target: 'app.api.main.users' });
    expect(spy).toHaveBeenCalledTimes(1);
    const sql = path.join(repo, 'migrations', '0001_init.sql');
    fs.mkdirSync(path.dirname(sql));
    fs.writeFileSync(sql, 'CREATE TABLE t (id int);\n');
    await call(tools, 'plan_show', { target: 'app.api.main' });
    expect(spy).toHaveBeenCalledTimes(2);
  }, 120000);
});

describe('view_path', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t7b3-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const viewPath = async (repo: string): Promise<any> => JSON.parse((await call(buildTools(repo, {}), 'view_path', {})).content[0].text);

  it('no anchor -> {path:null, exists:false} and nothing created', async () => {
    const repo = path.join(tmp, 'plain');
    fs.mkdirSync(repo);
    expect(await viewPath(repo)).toEqual({ path: null, exists: false });
    expect(fs.readdirSync(repo)).toEqual([]);
  });

  it('anchored, page not written -> path with exists:false', async () => {
    const repo = path.join(tmp, 'anchored');
    fs.mkdirSync(path.join(repo, '.c4pm'), { recursive: true });
    const r = await viewPath(repo);
    expect(typeof r.path).toBe('string');
    expect(r.exists).toBe(false);
    expect(r.modified).toBeUndefined();
  });

  it('with a page -> path and mtime ISO', async () => {
    const repo = path.join(tmp, 'paged');
    fs.mkdirSync(path.join(repo, '.c4pm'), { recursive: true });
    const { path: p } = await viewPath(repo);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '<html></html>');
    const when = new Date('2026-01-02T03:04:05.000Z');
    fs.utimesSync(p, when, when);
    expect(await viewPath(repo)).toEqual({ path: p, exists: true, modified: '2026-01-02T03:04:05.000Z' });
  });
});

describe('check and status', () => {
  const phofast = path.join(fixtures, 'phofast');
  const tools = buildTools(phofast, {});
  const cliCheck = (extra: string[]): unknown => {
    const r = spawnSync(process.execPath, [CLI_JS, 'check', '--repo', phofast, '--format', 'json', ...extra], { cwd: projectRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  };

  it.each([
    [{}, []],
    [{ min_severity: 'warning' }, ['--min-severity', 'warning']],
  ])('check %j has the same findings as `c4pm check --format json`', async (args, cliArgs) => {
    const r = await call(tools, 'check', args);
    expect(r.isError).toBeUndefined();
    const findings = JSON.parse(r.content[0].text);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings).toEqual(cliCheck(cliArgs));
  }, 300000);

  describe('with a board (P16-B9b): MCP check == c4pm check --format json', () => {
    let copy: string;
    beforeAll(() => {
      copy = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b9b-'));
      fs.cpSync(phofast, copy, { recursive: true });
      fs.mkdirSync(path.join(copy, '.c4pm'));   // the anchor
      const file = boardFileFor(requireProject(copy));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const item = { id: 'b1', title: 'T', kind: 'task', status: 'planned', dependsOn: [], links: ['no-such-element'], tags: [], due: '2000-01-01' };
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item] }] }));
    });
    afterAll(() => fs.rmSync(copy, { recursive: true, force: true }));

    it.each([
      [{}, []],
      [{ min_severity: 'warning' }, ['--min-severity', 'warning']],
    ])('check %j', async (args, cliArgs) => {
      const r = await call(buildTools(copy, {}), 'check', args);
      const findings = JSON.parse(r.content[0].text) as { rule: string }[];
      const cli = spawnSync(process.execPath, [CLI_JS, 'check', '--repo', copy, '--format', 'json', ...cliArgs], { cwd: projectRoot, encoding: 'utf8' });
      expect(cli.status).toBe(0);
      expect(findings).toEqual(JSON.parse(cli.stdout));
      expect(findings.map((f) => f.rule)).toContain('board-dead-link');
      expect(findings.map((f) => f.rule).includes('board-overdue')).toBe(cliArgs.length === 0);   // info: cut by warning
    }, 300000);
  });

  it('check on a repo without .c4 files -> {plan:false, findings:[]}', async () => {
    const r = await call(buildTools(path.join(fixtures, 'sample'), {}), 'check', {});
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ plan: false, findings: [] });
  }, 120000);

  it.each([{ min_severity: 'fatal' }, { min_severity: 3 }, { sprint: 5 }])('check %j -> invalid', async (args) => {
    const r = await call(tools, 'check', args);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe('invalid');
  }, 120000);

  it('status is the JSON of runStatus', async () => {
    const r = await call(tools, 'status', {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(JSON.stringify(runStatus(phofast, {})));
    expect(Object.keys(JSON.parse(r.content[0].text))).toEqual(['snapshot', 'history', 'plan', 'config']);
  }, 300000);
});

describe('QueryError mapping', () => {
  const tools = buildTools(path.join(fixtures, 'sample'), {});

  it('not-found carries candidates', async () => {
    const r = await call(tools, 'deps', { id: 'nope' });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('not-found');
    expect(typeof body.error.message).toBe('string');
    expect(Array.isArray(body.error.candidates)).toBe(true);
  }, 120000);

  it.each([
    ['find', { query: 'order', limit: 0 }],
    ['find', { query: 'order', kind: 'nope' }],
    ['find', {}],
    ['show', { target: 'api/src/routes/orders.ts', max_lines: 'abc' }],
  ])('%s %j -> invalid', async (tool, args) => {
    const r = await call(tools, tool, args);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe('invalid');
  }, 120000);

  it('show says not-found for a JSON key that does not exist', async () => {
    const r = await call(tools, 'show', { target: 'package.json#nope' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe('not-found');
  }, 120000);

  it('show refuses a path outside the repo', async () => {
    const r = await call(tools, 'show', { target: '../x' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe('out-of-repo');
  }, 120000);
});
