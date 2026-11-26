import * as fs from 'fs';
import { buildTools } from '../src/mcp/tools';
import type { ToolDef } from '../src/mcp/server';
import { formatTestsBlock } from '../src/query/format';
import type { ShownTestsReport } from '../src/query/itemTests';
import { runCli } from './helpers/runCli';
import { BOTH, ORDERS, PLACES, RENDERS, makeTestsRepo } from './helpers/tests-fixture';

// Phase 26 T26-11: a sub-agent asking c4pm about a c-item gets its tests to run (with run commands), to write and
// touching it: `plan show <c-item>` (text, --json), MCP `plan_show` (the same JSON) and `show <function>`.

// The shared tests repo plus a second Orders function, a component-level test of Orders, and two test blocks on
// Orders: 'voids' (to write) and 'places' (matched by the leaf of 'orders › places', so not to write); a store.
const CANCEL = 'api/test/cancel.test.ts#places and cancels';
const EDIT: Record<string, (old: string) => string> = {
  'api/src/orders.ts': () => "import { savePrice } from './store';\n\nexport function placeOrder(id: string): string {\n  return savePrice(id);\n}\n\nexport function cancelOrder(id: string): string {\n  return id;\n}\n",
  'api/test/cancel.test.ts': () => "import { placeOrder, cancelOrder } from '../src/orders';\n\nit('places and cancels', () => { placeOrder('1'); cancelOrder('1'); });\n",
  'c4/plan.c4': (plan) => plan
    .replace("#placeOrder 'Order entry'", "#placeOrder 'Order entry'\n          link ../api/src/orders.ts#cancelOrder\n          test 'voids' {}\n          test 'places' {}")
    .replace("web = container 'Web' {", "web = container 'Web' {\n      db = store 'Db' { technology 'PostgreSQL' }"),
};

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }
let repo: string;
let tools: ToolDef[];
const cached = new Map<string, any>();
beforeAll(() => {
  repo = makeTestsRepo('c4pm-plan-show-tests-', EDIT);
  tools = buildTools(repo, {});
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

/** `c4pm <args> --repo <repo> --json`, parsed; each command spawned once. */
function cliJson(...args: string[]): any {
  const key = args.join('\0');
  if (!cached.has(key)) {
    const r = runCli([...args, '--repo', repo, '--json']);
    expect(r.status).toBe(0);
    cached.set(key, JSON.parse(r.stdout));
  }
  return cached.get(key);
}
const mcp = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await tools.find((t) => t.name === name)!.handler(args)) as ToolResult;
/** id, relation, level, target of a test of a report. */
const brief = (t: { id: string; relation: string; level: string; target: string | null }): (string | null)[] => [t.id, t.relation, t.level, t.target];

const OWN_CANCEL = [CANCEL, 'own', 'component', ORDERS];
const CHILD_PLACES = [PLACES, 'child', 'element', 'api/src/orders.ts#placeOrder'];

describe('plan show <c-item> --json = MCP plan_show: tests to run, to write and touching', () => {
  it.each([
    [ORDERS, [OWN_CANCEL, CHILD_PLACES], [[ORDERS, 'voids']], [[BOTH, 'touch', 'container', 'api']]],
    ['shop.api.logic', [OWN_CANCEL, CHILD_PLACES], [[ORDERS, 'voids']], [[BOTH, 'touch', 'container', 'api']]],   // a layer: its components'
    ['shop.api', [[CANCEL, 'child', 'component', ORDERS], CHILD_PLACES, [BOTH, 'own', 'container', 'api']], [[ORDERS, 'voids']], []],
    ['shop.web.pages', [[RENDERS, 'child', 'element', 'web/src/page.ts#renderPage']], [], []],
  ])('%s', async (target, run, toWrite, touches) => {
    const j = cliJson('plan', 'show', target);
    const t = j.tests as ShownTestsReport;
    expect([t.run.map(brief), t.toWrite.map((w) => [w.parent, w.name]), t.touches.map(brief)]).toEqual([run, toWrite, touches]);
    expect(t.counts).toEqual({ run: run.length, toWrite: toWrite.length, touches: touches.length });
    const m = await mcp('plan_show', { target });
    expect(m.isError).toBeUndefined();
    expect(JSON.parse(m.content[0].text)).toEqual(j);
  }, 120000);

  it('run commands: jest in the api root; a container with no runner gives its reason instead', () => {
    const orders = cliJson('plan', 'show', ORDERS).tests as ShownTestsReport;
    expect(orders.run.map((t) => [t.run, t.noRun])).toEqual([
      [{ command: 'npx jest test/cancel.test.ts -t "places and cancels"', cwd: 'api' }, undefined],
      [{ command: 'npx jest test/orders.test.ts -t "orders places"', cwd: 'api' }, undefined],
    ]);
    const renders = (cliJson('plan', 'show', 'shop.web.pages').tests as ShownTestsReport).run[0];
    expect(renders.run).toBeNull();
    expect(renders.noRun).toMatch(/^typescript tests in web: .*set config tests\.command$/);
  });

  it('an element off the map (a store) has no tests; an unknown target is a not-found error with candidates', async () => {
    expect(cliJson('plan', 'show', 'shop.web.db')).not.toHaveProperty('tests');
    const m = await mcp('plan_show', { target: 'nope' });
    expect(m.isError).toBe(true);
    const { error } = JSON.parse(m.content[0].text);
    expect(error).toMatchObject({ code: 'not-found', message: "no element matches 'nope'" });
    expect(error.candidates.length).toBeGreaterThan(0);
  });
});

describe('plan show <c-item> text', () => {
  it('prints a tests block after the element: counts, then each test with [level target] and its run command', () => {
    const r = runCli(['plan', 'show', ORDERS, '--repo', repo, '--all']);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    const voids = (cliJson('plan', 'show', ORDERS).tests as ShownTestsReport).toWrite[0].source;
    expect(lines.slice(lines.indexOf('tests:     2 to run, 1 to write, 1 touching'))).toEqual([
      'tests:     2 to run, 1 to write, 1 touching',
      '  to run:',
      '    api/test/cancel.test.ts:3  places and cancels  [component shop.api.logic.orders]',
      '      cd api && npx jest test/cancel.test.ts -t "places and cancels"',
      '    api/test/orders.test.ts:6  orders › places  [element api/src/orders.ts#placeOrder]',
      '      cd api && npx jest test/orders.test.ts -t "orders places"',
      '  to write:',
      `    voids  [shop.api.logic.orders]  ${voids.file}:${voids.line}`,
      '  touching:',
      '    api/test/orders.test.ts:7  orders › orders and store  [container api]',
      '      cd api && npx jest test/orders.test.ts -t "orders orders and store"',
    ]);
  }, 120000);

  it('each list shows `limit` tests and says how many more; no tests at all is one line', () => {
    const t = cliJson('plan', 'show', ORDERS).tests as ShownTestsReport;
    const lines = formatTestsBlock(t, { limit: 1, more: '--all lists every test' });
    expect(lines.filter((l) => l.startsWith('    ... '))).toEqual(['    ... 1 more (--all lists every test)']);
    const none = { run: [], toWrite: [], touches: [], counts: { run: 0, toWrite: 0, touches: 0 } };
    expect(formatTestsBlock(none, { more: '' })).toEqual(['tests:     none']);
  });
});

describe('show <function> lists its tests', () => {
  it('own tests to run and the tests touching it (CLI --json = MCP show)', async () => {
    const j = cliJson('show', 'api/src/orders.ts#placeOrder');
    expect([j.tests.run.map(brief), j.tests.touches.map(brief)]).toEqual([
      [[PLACES, 'own', 'element', 'api/src/orders.ts#placeOrder']],
      [[CANCEL, 'touch', 'component', ORDERS], [BOTH, 'touch', 'container', 'api']],
    ]);
    const m = await mcp('show', { target: 'api/src/orders.ts#placeOrder' });
    expect(JSON.parse(m.content[0].text)).toEqual(j);
    expect(cliJson('show', 'api/src/orders.ts')).not.toHaveProperty('tests');   // a whole file: no tests
  }, 120000);
});
