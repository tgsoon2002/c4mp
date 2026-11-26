import * as fs from 'fs';
import { runPlanCli, makeRepo, listing } from './helpers/planEditHarness';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// P18-T16: `c4pm plan relate`, in-process on a tmp repo with a hand-written plan (two files).
const UID_AUTH = '00000000-0000-4000-8000-000000000002';
const UID_ORDERS = '00000000-0000-4000-8000-000000000003';
const API = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  `        metadata { uid '${UID_AUTH}' }`,
  '      }',
  "      orders = component 'Orders' {",
  `        metadata { uid '${UID_ORDERS}' }`,
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');
const WEB = [
  'extend app {',
  "  web = container 'Web' {",
  "    ui = component 'Ui'",
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
beforeEach(() => { repo = makeRepo('c4pm-relate-', { 'a.c4': API, 'b.c4': WEB }); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const relate = (...args: string[]) => runPlanCli(['plan', 'relate', ...args, '--repo', repo.root]);
const reparse = () => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
const rels = () => reparse().relations.map(r => ({ from: r.from, to: r.to, label: r.label }));
const bytes = (k: string) => fs.readFileSync(repo.files[k]);

describe('c4pm plan relate', () => {
  it('dry run changes nothing; --yes writes the line in the from element; only that line is added', async () => {
    const a = bytes('a.c4'); const b = bytes('b.c4'); const listed = listing(repo.root);
    const dry = await relate('orders', 'auth');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('+        -> app.api.auth');
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(bytes('a.c4').equals(a)).toBe(true);
    expect(listing(repo.root)).toEqual(listed);
    expect((await relate('orders', 'auth', '--yes')).code).toBe(0);
    expect(rels()).toEqual([{ from: 'app.api.orders', to: 'app.api.auth', label: null }]);
    expect(bytes('b.c4').equals(b)).toBe(true);
    expect(fs.readFileSync(repo.files['a.c4'], 'utf-8').replace(/ {8}-> app\.api\.auth\n/, '')).toBe(API.replace("orders = component 'Orders' {", "orders = component 'Orders' {"));
  });

  it('across containers: written in from\'s file; a label with quotes and a backslash round-trips; uid targets work', async () => {
    const r = await relate('ui', UID_AUTH, '--label', 'says "hi" \\ it\'s', '--yes');
    expect(r.code).toBe(0);
    expect(rels()).toEqual([{ from: 'app.web.ui', to: 'app.api.auth', label: 'says "hi" \\ it\'s' }]);
    expect(fs.readFileSync(repo.files['b.c4'], 'utf-8')).toContain('-> app.api.auth');
    expect(fs.readFileSync(repo.files['a.c4'], 'utf-8')).toBe(API);
  });

  it('a duplicate pair is refused (any label): a second identical run adds nothing', async () => {
    await relate('orders', 'auth', '--label', 'x', '--yes');
    const once = bytes('a.c4');
    const again = await relate('orders', 'auth', '--label', 'x', '--yes');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("app.api.orders -> app.api.auth already exists ('x'); nothing added");
    expect((await relate('orders', 'auth', '--label', 'other', '--yes')).code).toBe(1);
    expect(bytes('a.c4').equals(once)).toBe(true);
    expect(rels()).toHaveLength(1);
    // the reverse direction is a different relation
    expect((await relate('auth', 'orders', '--yes')).code).toBe(0);
    expect(rels()).toHaveLength(2);
  });

  it('refusals: self, unknown from/to (closest ids listed), ambiguous, empty label; nothing written', async () => {
    const a = bytes('a.c4');
    const cases: [string[], RegExp][] = [
      [['auth', 'auth'], /cannot relate to itself/],
      [['auth', 'nope'], /to: no element matches 'nope'/],
      [['nope', 'auth'], /from: no element matches 'nope'/],
      [['auth', 'app.api.autx'], /app\.api\.auth/],
      [['auth', 'orders', '--label', ''], /label must not be empty/],
    ];
    for (const [args, re] of cases) {
      const r = await relate(...args, '--yes');
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
      expect(r.stdout).toBe('');
    }
    expect(bytes('a.c4').equals(a)).toBe(true);
    expect(bytes('b.c4').equals(Buffer.from(WEB))).toBe(true);
  });

  it('tree shows the new edge afterwards (end to end with T11)', async () => {
    await relate('orders', 'auth', '--label', 'checks login', '--yes');
    const t = await runPlanCli(['plan', 'tree', 'c2', 'api', '--repo', repo.root]);
    expect(t.stdout).toContain('n_app_api_orders -->|"checks login"| n_app_api_auth');
  });

  it('--json: one object with the D15 keys', async () => {
    const out = JSON.parse((await relate('orders', 'auth', '--json')).stdout);
    expect(Object.keys(out).sort()).toEqual(['command', 'dryRun', 'error', 'files', 'findings', 'notes', 'ok', 'target', 'written']);
    expect(out).toMatchObject({ ok: true, command: 'relate', dryRun: true, written: false, target: { fqn: 'app.api.orders' } });
  });
});

// b276: a planned function (code kind) is a valid relate end; the IO view reads control -> function as a call.
describe('c4pm plan relate with a planned function', () => {
  const PLAN = [
    'model {',
    "  shop = system 'Shop' {",
    "    web = container 'Web' {",
    "      cart = screen 'Cart' {",
    "        checkout = control 'Checkout'",
    '      }',
    '    }',
    "    api = container 'Api' {",
    "      carts = component 'Carts' {",
    "        addItem = function 'addItem' {",
    "          metadata { status 'planned' }",
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('control -> function: dry run, --yes (gated by --check), the line parses and nav.calls has the call', async () => {
    const fn = makeRepo('c4pm-relate-fn-', { 'p.c4': PLAN });
    try {
      const run = (...a: string[]) => runPlanCli(['plan', 'relate', ...a, '--repo', fn.root]);
      const dry = await run('shop.web.cart.checkout', 'shop.api.carts.addItem');
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('+          -> shop.api.carts.addItem');
      expect(fs.readFileSync(fn.files['p.c4'], 'utf-8')).toBe(PLAN);
      const w = await run('shop.web.cart.checkout', 'shop.api.carts.addItem', '--yes', '--check');
      expect(w.code).toBe(0);
      const plan = parsePlan(fn.root, findPlanFiles(fn.root, loadConfig(fn.root, {})).files);
      expect(plan.relations.map(r => [r.from, r.to])).toEqual([['shop.web.cart.checkout', 'shop.api.carts.addItem']]);
      const { buildNav } = await import('../src/view/navModel');
      expect(buildNav(plan)!.calls).toEqual([expect.objectContaining({ from: 'shop.web.cart', via: 'shop.web.cart.checkout' })]);
      // a function as the source works; a missing function still errors
      expect((await run('shop.api.carts.addItem', 'shop.api.carts', '--yes')).code).toBe(0);
      const missing = await run('shop.web.cart.checkout', 'shop.api.carts.nope', '--yes');
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("to: no element matches 'shop.api.carts.nope'");
    } finally { fs.rmSync(fn.root, { recursive: true, force: true }); }
  });
});
