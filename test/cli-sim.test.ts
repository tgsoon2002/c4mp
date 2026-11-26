import * as fs from 'fs';
import * as path from 'path';
import { makeSimRepo, runSimCli } from './helpers/simHarness';
import type { SimRepo } from './helpers/simHarness';
import { listing } from './helpers/planEditHarness';
import { removeSim } from '../src/services/simEdit';
import { simWriteJson } from '../src/query/sim';

// T5b (b701): `c4mp sim ...` in-process on a tmp repo. Dry run writes nothing, --yes writes, --json is one object of
// the guarded-write shape (the same builder as MCP, simWriteJson), refusals print `error: <code>: ...` and exit 1.

const START = {
  's-1': {
    kind: 'flow', title: 'Buy', person: 'customer',
    steps: [
      { target: 'u-add', view: 'io', call: { from: 'u-person', label: 'presses Add' }, state: 'cart: empty' },
      { target: 'shop.api.cart.addItem', view: 'arch' },
      { target: ['src/cart.ts#total', 'u-gone'], view: 'arch', rows: { 'u-orders': [{ id: 1 }] } },
    ],
  },
  's-2': {
    kind: 'journey', title: 'First buyer',
    stages: [{ name: 'Mail', outside: 'Sale email', channel: 'email' }, { name: 'Buy', flow: 's-1', goal: 'Buy' }],
  },
};

let repo: SimRepo;
beforeEach(() => { repo = makeSimRepo('c4mp-sim-cli-', START); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const run = (...args: string[]) => runSimCli([...args, '--repo', repo.root]);
const steps = (id: string) => repo.read(id).steps as Record<string, unknown>[];

describe('dry run is the default', () => {
  it.each([
    [['add', '--kind', 'flow', '--title', 'New']],
    [['set', 's-1', '--title', 'Buy it']],
    [['remove', 's-2']],
    [['step', 'add', 's-1', '--target', 'u-login']],
    [['step', 'set', 's-1', '1', '--caption', 'Hi']],
    [['step', 'remove', 's-1', '2']],
    [['step', 'move', 's-1', '3', '--to', '1']],
    [['stage', 'add', 's-2', '--outside', 'A call']],
    [['stage', 'remove', 's-2', '1']],
  ])('%j prints the change and writes nothing', async (args) => {
    const before = listing(repo.root);
    const r = await run(...args);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(listing(repo.root)).toEqual(before);
  });
});

describe('--yes writes', () => {
  it('add prints the minted id and writes s-3', async () => {
    const r = await run('add', '--kind', 'journey', '--title', 'Back again', '--person', 'customer', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("add s-3 (journey 'Back again'):");
    expect(r.stdout).toContain('written: .c4mp/');
    expect(repo.read('s-3')).toEqual({ schemaVersion: 1, id: 's-3', kind: 'journey', title: 'Back again', person: 'customer', stages: [] });
  });

  it('step add stores uids (a code path#name is added to the plan first) and the call; --at places it', async () => {
    const r = await run('step', 'add', 's-1', '--target', 'Login', '--target', 'src/cart.ts#total', '--call-from', 'shop.web',
      '--call-label', 'GET /login', '--reply', '--duration', '2', '--at', '1', '--yes');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(steps('s-1')[0]).toEqual({ target: ['u-login', expect.stringMatching(/^[0-9a-f-]{36}$/)], view: 'io', call: { from: 'u-web', label: 'GET /login', reply: true }, durationSec: 2 });
    expect(steps('s-1')).toHaveLength(4);
  });

  it('step set: none clears, --reply none clears the reply, other fields stay', async () => {
    await run('step', 'add', 's-1', '--target', 'u-login', '--reply', '--caption', 'x', '--yes');
    expect((await run('step', 'set', 's-1', '4', '--reply', 'none', '--caption', 'none', '--state', 'signed in', '--yes')).code).toBe(0);
    expect(steps('s-1')[3]).toEqual({ target: 'u-login', view: 'io', state: 'signed in' });
  });

  it('step move and remove', async () => {
    expect((await run('step', 'move', 's-1', '3', '--to', '1', '--yes')).code).toBe(0);
    expect(steps('s-1')[0].target).toEqual(['src/cart.ts#total', 'u-gone']);
    expect((await run('step', 'remove', 's-1', '1', '--yes')).code).toBe(0);
    expect(steps('s-1').map((s) => s.target)).toEqual(['u-add', 'shop.api.cart.addItem']);
  });

  it('stage add: outside with name, from, channel; an inline step at --at; stage remove', async () => {
    expect((await run('stage', 'add', 's-2', '--name', 'Call', '--outside', 'Support calls', '--from', 'Support', '--channel', 'phone', '--yes')).code).toBe(0);
    expect((await run('stage', 'add', 's-2', '--target', 'u-login', '--goal', 'Sign in', '--at', '1', '--yes')).code).toBe(0);
    const stages = repo.read('s-2').stages as Record<string, unknown>[];
    expect(stages[0]).toEqual({ target: 'u-login', goal: 'Sign in', view: 'io' });
    expect(stages[3]).toEqual({ name: 'Call', outside: 'Support calls', from: 'Support', channel: 'phone' });
    expect((await run('stage', 'remove', 's-2', '1', '--yes')).code).toBe(0);
    expect((repo.read('s-2').stages as unknown[]).length).toBe(3);
  });

  it('set and remove', async () => {
    expect((await run('set', 's-1', '--person', 'none', '--description', 'One buyer.', '--yes')).code).toBe(0);
    expect(repo.read('s-1')).toMatchObject({ title: 'Buy', description: 'One buyer.' });
    expect(repo.read('s-1').person).toBeUndefined();
    expect((await run('remove', 's-2', '--yes')).code).toBe(0);
    expect(fs.existsSync(repo.file('s-2'))).toBe(false);
  });

  it('apply: a dry run, then one write of every entry with refs resolved', async () => {
    const spec = path.join(repo.root, 'sims.json');
    fs.writeFileSync(spec, JSON.stringify({ sims: [
      { ref: 'co', kind: 'flow', title: 'Check out', steps: [{ target: 'Products', view: 'io' }] },
      { kind: 'journey', title: 'Gift', stages: [{ outside: 'Birthday' }, { flowRef: 'co' }] },
    ] }));
    const before = listing(repo.root);
    expect((await run('apply', spec)).stdout).toContain('s-3  new  flow  Check out');
    expect(listing(repo.root)).toEqual(before);
    const j = JSON.parse((await run('apply', spec, '--yes', '--json')).stdout);
    expect(j).toMatchObject({ ok: true, command: 'sim apply', dryRun: false, written: true, minted: ['s-3', 's-4'], error: null });
    expect(steps('s-3')[0].target).toBe('u-products');
    expect((repo.read('s-4').stages as Record<string, unknown>[])[1]).toEqual({ flow: 's-3' });
  });
});

describe('--json', () => {
  it('a write prints {ok, command, dryRun, written, file, changes, minted?, error}', async () => {
    const j = JSON.parse((await run('add', '--kind', 'flow', '--title', 'X', '--json')).stdout);
    expect(Object.keys(j)).toEqual(['ok', 'command', 'dryRun', 'written', 'file', 'changes', 'minted', 'error']);
    expect(j).toMatchObject({ ok: true, command: 'sim add', dryRun: true, written: false, minted: ['s-3'], error: null });
    expect(j.file).toBe('.c4mp/projects/' + path.basename(path.dirname(path.dirname(repo.file('s-3')))) + '/sim/s-3.json');
  });

  it('is byte-identical to simWriteJson of the service outcome (the MCP text, T6b)', async () => {
    const cli = (await run('remove', 's-2', '--json')).stdout;
    expect(cli).toBe(JSON.stringify(simWriteJson('sim remove', removeSim(repo.root, 's-2', false), false), null, 2));
    const refused = await run('remove', 's-1', '--json');
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe(JSON.stringify(simWriteJson('sim remove', removeSim(repo.root, 's-1', false), false), null, 2));
  });

  it('a refusal is {ok:false, ..., error: {code, message, reasons}} with every reason', async () => {
    const r = await run('remove', 's-1', '--json');
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(['ok', 'command', 'dryRun', 'written', 'error']);
    expect(j.error.code).toBe('invalid');
    expect(j.error.reasons).toEqual(["s-2 stage 2 'Buy' (journey 'First buyer')"]);
  });
});

describe('refusals exit 1 with error: <code>: <message>', () => {
  it.each([
    [['set', 's-9', '--title', 'X'], "error: not-found: no s-item 's-9'"],
    [['remove', 's-1'], 'error: invalid: s-1 is named by 1 journey stage'],
    [['add', '--kind', 'story', '--title', 'X'], 'error: invalid: --kind must be flow or journey'],
    [['step', 'add', 's-1', '--target', 'u-add', '--at', 'two'], "error: invalid: --at 'two' must be a whole number"],
    [['step', 'set', 's-1', 'x', '--caption', 'c'], "error: invalid: step number 'x' must be a whole number"],
    [['step', 'add', 's-1', '--target', 'Nothing here'], "error: invalid: --target 'Nothing here' matches no plan element"],
    [['step', 'move', 's-1', '1'], 'error: invalid: --to is required'],
    [['stage', 'add', 's-2', '--flow', 's-1', '--outside', 'x'], 'error: invalid: give exactly one of --flow'],
    [['apply', 'missing.json'], 'error: not-found: no such file: '],
  ])('%j', async (args, first) => {
    const before = listing(repo.root);
    const r = await run(...args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n')[0]).toContain(first);
    expect(listing(repo.root)).toEqual(before);
  });

  it('apply: a file that is not JSON', async () => {
    const bad = path.join(repo.root, 'bad.json');
    fs.writeFileSync(bad, '{bad');
    const r = await run('apply', bad);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: invalid: .*bad\.json is not valid JSON/);
  });
});

describe('list and show (read-only)', () => {
  it('list: one line per s-item; --kind filters; --json; a bad --kind exits 1', async () => {
    const before = listing(repo.root);
    const t = await run('list');
    expect(t.stdout.split('\n')).toEqual(['s-1  flow  Buy  (3 steps)  person customer', 's-2  journey  First buyer  (2 stages)']);
    const j = JSON.parse((await run('list', '--kind', 'journey', '--json')).stdout);
    expect(j.sims.map((s: { id: string }) => s.id)).toEqual(['s-2']);
    expect(j).toMatchObject({ issues: [], notes: [] });
    const bad = await run('list', '--kind', 'story');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toBe("error: invalid: unknown --kind 'story'; use flow or journey");
    expect(listing(repo.root)).toEqual(before);
  });

  it('list reports a file that does not parse and still lists the others', async () => {
    fs.writeFileSync(repo.file('s-5'), '{ "schemaVersion": 1');
    const r = await run('list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('s-1  flow  Buy');
    expect(r.stdout).toContain('issues (files not loaded):\n  s-5.json: ');
  });

  it('show --json resolves every ref: plan element (uid, fqn), planned function, code, missing; the person', async () => {
    const r = await run('show', 's-1', '--json');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.person).toEqual({ ref: 'customer', resolved: { kind: 'person', fqn: 'customer', title: 'Customer', uid: 'u-person' } });
    expect(s.steps[0].targets).toEqual([{ ref: 'u-add', resolved: { kind: 'control', fqn: 'shop.web.products.add', title: 'Add to cart button', uid: 'u-add' } }]);
    expect(s.steps[0].call.from.resolved.fqn).toBe('customer');
    expect(s.steps[1].targets[0].resolved).toEqual({ kind: 'function', fqn: 'shop.api.cart.addItem', title: 'addItem' });
    expect(s.steps[2].targets).toEqual([
      { ref: 'src/cart.ts#total', resolved: { kind: 'code', fqn: 'src/cart.ts#total', title: 'total' } },
      { ref: 'u-gone', resolved: null },
    ]);
    expect(s.steps[2].rows).toEqual([{ record: { ref: 'u-orders', resolved: { kind: 'record', fqn: 'shop.api.db.orders', title: 'orders', uid: 'u-orders' } }, rows: [{ id: 1 }] }]);
  });

  it('show text: a journey with its stages', async () => {
    const r = await run('show', 's-2');
    expect(r.stdout).toContain("s-2  journey  First buyer");
    expect(r.stdout).toContain("  1 'Mail'  outside: Sale email\n       channel: email");
    expect(r.stdout).toContain("  2 'Buy'  flow s-1 ('Buy')\n       goal: Buy");
  });

  it('show: an unknown id and a file that does not parse exit 1', async () => {
    const r = await run('show', 's-9');
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: not-found: no s-item 's-9' (s-items: s-1, s-2)");
    fs.writeFileSync(repo.file('s-5'), '[]');
    const broken = await run('show', 's-5', '--json');
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ ok: false, command: 'sim show', error: { code: 'invalid' } });
  });
});
