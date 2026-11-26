import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { loadConfig } from '../src/config';
import { configOptsFor, pickScanConfig } from '../src/outputs';
import { findPlanFiles } from '../src/plan/files';
import { parsePlan } from '../src/plan/parser';
import { extractClaims, isClaimModePlan, resolveOwnership } from '../src/c4/ownership';
import { attachTests, testIndexOf, testsOf, testsReport, treeIdOfPlan } from '../src/c4/testAttach';
import { checkTestBlocks } from '../src/c4/check';
import type { AttachInput, TestIndex } from '../src/c4/testAttach';
import type { C4pmConfig, TestsConfig } from '../src/types';

// Phase 26 T26-7: each test case hangs on the lowest common c-item it exercises (subject first, layers skipped,
// shared code outside any container, mocks excluded, helpers expanded; other languages by file imports).

const FIX = path.join(__dirname, 'fixtures');

/** The attachment input of a repo, built the way the page build does (config, plan, collectCalls 'tests', ownership). */
function inputOf(repo: string, cli: Partial<C4pmConfig> = {}, tests?: TestsConfig): AttachInput {
  const config = loadConfig(repo, cli, configOptsFor(repo));
  const planFiles = findPlanFiles(repo, config).files;
  const plan = planFiles.length > 0 ? parsePlan(repo, planFiles) : null;
  const snapshot = runSnapshot({ repo, write: false, quiet: true, config: pickScanConfig(config), plan: plan ?? undefined, collectCalls: 'tests' });
  const ownership = plan && isClaimModePlan(plan) ? resolveOwnership(extractClaims(plan), snapshot.files, snapshot.fileEdges) : null;
  return { snapshot, plan, ownership, tests: tests ?? config.tests };
}

// layers-claim (container api: layers logic > orders, data > store; container web: pages) plus a second orders
// function, unclaimed util/log (shared: store uses them), an unclaimed mocked module, a helper, a setup file.
const T = 'api/test/orders.test.ts';
const R = 'web/test/reach.test.ts';
const ADDED: Record<string, string> = {
  'api/src/orders.ts': "import { savePrice } from './store';\n\nexport function placeOrder(id: string): string {\n  return savePrice(id);\n}\n\nexport function cancelOrder(id: string): string {\n  return id;\n}\n",
  'api/src/store.ts': "import { fmt } from './util';\nimport { note } from './log';\n\nexport function savePrice(id: string): string {\n  note(id);\n  return fmt(`saved:${id}`);\n}\n",
  'api/src/util.ts': 'export function fmt(s: string): string {\n  return s;\n}\n\nexport function pad(s: string): string {\n  return ` ${s}`;\n}\n',
  'api/src/log.ts': 'export function note(s: string): void {\n  void s;\n}\n',
  'api/src/types.ts': 'export interface Shape {\n  id: number;\n}\n',
  'api/src/mocked.ts': 'export function gone(): number {\n  return 1;\n}\n',
  'api/test/helpers/make.ts': "import { savePrice } from '../../src/store';\n\nexport function make(): string {\n  return savePrice('h');\n}\n",
  'api/test/setup.ts': "import { savePrice } from '../src/store';\n\nsavePrice('s');\n",
  [T]: [
    "import { placeOrder, cancelOrder } from '../src/orders';",
    "import { savePrice } from '../src/store';",
    "import { renderPage } from '../../web/src/page';",
    "import type { Shape } from '../src/types';",
    "import { fmt, pad } from '../src/util';",
    "import { note } from '../src/log';",
    "import { gone } from '../src/mocked';",
    "import { make } from './helpers/make';",
    '',
    "jest.mock('../src/mocked');",
    '',
    "describe('orders', () => {",
    "  beforeEach(() => savePrice('b'));",
    "  it('places', () => placeOrder('1'));",
    "  it('setup only', () => expect(1).toBe(1));",
    "  it('orders and store', () => { placeOrder('1'); savePrice('2'); });",
    '});',
    "it('places and cancels', () => { placeOrder('1'); cancelOrder('1'); });",
    "it('page and order', () => { renderPage(); placeOrder('1'); });",
    "it('type only', () => { const s: Shape = { id: 1 }; expect(s.id).toBe(1); });",
    "it('helper', () => make());",
    "it('mocked', () => gone());",
    "it('shared and orders', () => { fmt('a'); placeOrder('1'); });",
    "it('one shared function', () => fmt('a'));",
    "it('two shared functions', () => { fmt('a'); pad('b'); });",
    "it('ignored and orders', () => { note('x'); placeOrder('1'); });",
    "it('ignored only', () => note('x'));",
    '',
  ].join('\n'),
  // T26-8 hidden reach: files read by path (exact scanned paths only), a helper that spawns a build output (hand link)
  'web/test/helpers/spawn.ts': "import { execFileSync } from 'child_process';\n\nexport function spawnCli(arg: string): string {\n  return execFileSync('node', ['web/dist/cli.js', arg]).toString();\n}\n",
  // T26-8b (D22): a helper whose second parameter goes into a file call (through a template and a local variable)
  'web/test/helpers/read.ts': "import * as fs from 'fs';\n\nexport function readRepo(label: string, rel: string): string {\n  const full = `${process.cwd()}/${rel}`;\n  return label + fs.readFileSync(full, 'utf8');\n}\n",
  [R]: [
    "import * as fs from 'fs';",
    "import * as path from 'path';",
    "import { spawnCli } from './helpers/spawn';",
    "import { readRepo } from './helpers/read';",
    "import { renderPage } from '../src/page';",
    '',
    "describe('reach', () => {",
    "  it('reads by relative path', () => fs.readFileSync(path.join(__dirname, '../src/page.ts'), 'utf8'));",
    "  it('reads by repo path', () => fs.readFileSync('web/src/page.ts', 'utf8'));",
    "  it('reads build output', () => fs.readFileSync('web/dist/page.js', 'utf8'));",
    "  it('spawns', () => spawnCli('help'));",
    "  it('spawns and reads', () => { spawnCli('x'); fs.readFileSync('api/src/store.ts', 'utf8'); });",
    "  it('hand linked', () => renderPage());",
    "  it('reads through a helper', () => readRepo('x', 'web/src/page.ts'));",
    "  it('reads through a variable', () => { const p = 'web/src/page.ts'; return fs.readFileSync(p, 'utf8'); });",
    "  it('data strings', () => { expect(['web/src/page.ts']).toHaveLength(1); readRepo('api/src/store.ts', 'none'); });",
    '});',
    '',
  ].join('\n'),
};
/** Hand links (D16) on container web: a helper file, a case id, and two that name nothing (test-link-dead). */
const HAND_LINKS = [
  "test 'cli runs' { case 'web/test/helpers/spawn.ts' }",
  `test 'pinned' { case '${R}#reach › hand linked' }`,
  `test 'gone' { case '${R}#reach › removed' }`,
  "test 'old helper' { case 'web/test/helpers/old.ts' }",
];

const ORDERS = 'shop.api.logic.orders';
const STORE = 'shop.api.data.store';
let repo: string;
let ix: TestIndex;
let input: AttachInput;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-attach-'));
  fs.cpSync(path.join(FIX, 'layers-claim'), repo, { recursive: true });
  const planFile = path.join(repo, 'c4/plan.c4');
  const plan = fs.readFileSync(planFile, 'utf8');
  fs.writeFileSync(planFile, plan
    .replace("#placeOrder 'Order entry'", "#placeOrder 'Order entry'\n          link ../api/src/orders.ts#cancelOrder")
    .replace("web = container 'Web' {", `web = container 'Web' {\n${HAND_LINKS.map((l) => `      ${l}\n`).join('')}`));
  for (const [rel, text] of Object.entries(ADDED)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  input = inputOf(repo, {}, { ignoreReach: ['api/src/log.ts'] });
  ix = attachTests(input);
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const at = (name: string) => ix.attachments.get(`${T}#${name}`)!;

describe('one case, one place (claim mode, layers)', () => {
  it.each([
    ['orders › places', 'element', 'api/src/orders.ts#placeOrder', 'body'],               // subject first: setup savePrice not counted
    ['orders › setup only', 'element', 'api/src/store.ts#savePrice', 'setup'],            // body reaches nothing: the hook counts
    ['orders › orders and store', 'container', 'api', 'body'],                            // two components of two layers (D4)
    ['places and cancels', 'component', ORDERS, 'body'],                                  // two functions of one component
    ['page and order', 'system', 'SYSTEM', 'body'],                                       // a flow across containers
    ['type only', 'none', null, 'none'],                                                  // import type never counts (D3)
    ['helper', 'element', 'api/src/store.ts#savePrice', 'body'],                          // through api/test/helpers/make.ts
    ['mocked', 'none', null, 'none'],                                                     // a mocked module is not reach (D5)
    ['shared and orders', 'container', 'api', 'body'],                                    // shared code + one container (C26)
    ['one shared function', 'element', 'api/src/util.ts#fmt', 'body'],                   // A3: one shared function
    ['two shared functions', 'system', 'SYSTEM', 'body'],                                 // only code outside containers
    ['ignored and orders', 'element', 'api/src/orders.ts#placeOrder', 'body'],            // ignoreReach file dropped (rung 1)
    ['ignored only', 'element', 'api/src/log.ts#note', 'body+ignored'],                   // nothing else: rung 2 keeps it
  ])('%s -> %s %s (%s)', (name, level, target, step) => {
    const a = at(name);
    expect([a.level, a.target, a.step, a.via]).toEqual([level, target === 'SYSTEM' ? ix.tree.systemId : target, step, 'calls']);
  });

  it('touches lists the reached code and its components, not the target', () => {
    expect(at('orders › orders and store').touches).toEqual(['api/src/orders.ts#placeOrder', 'api/src/store.ts#savePrice', STORE, ORDERS].sort());
    expect(at('shared and orders').touches).toEqual(['api/src/orders.ts#placeOrder', 'api/src/util.ts#fmt', ORDERS]);
  });

  it('mocked modules and helpers are listed per case', () => {
    expect([at('mocked').mocked, at('helper').helpers, at('places and cancels').helpers]).toEqual([['api/src/mocked.ts'], ['api/test/helpers/make.ts'], []]);
  });

  it('a helper file gets no attachment; a test file without cases that no test imports is one pseudo case by its imports', () => {
    const files = [...ix.attachments.keys()].filter((id) => id.startsWith('api/') && !id.startsWith(`${T}#`));
    expect(files).toEqual(['api/test/setup.ts']);
    expect(ix.attachments.get('api/test/setup.ts')).toMatchObject({ level: 'component', target: STORE, via: 'imports' });
  });
});

describe('hidden reach and hand links (T26-8)', () => {
  const PAGES = 'shop.web.pages';
  it.each([
    ['reads by relative path', 'component', PAGES, 'calls', []],                 // '../src/page.ts' from web/test/ (viewer-panel style)
    ['reads by repo path', 'component', PAGES, 'calls', []],                     // 'web/src/page.ts' as written
    ['reads build output', 'none', null, 'calls', []],                           // not a scanned path: no dist/ -> src/ guess
    ['spawns', 'container', 'web', 'calls', []],                                 // helper link: every case using the helper gets web
    ['spawns and reads', 'system', 'SYSTEM', 'calls', ['shop.api.data.store', 'web']],   // the helper link adds reach, it does not override
    ['hand linked', 'container', 'web', 'hand', [PAGES, 'web/src/page.ts#renderPage']],   // A4: the case link overrides; the derived place and touches stay
    ['reads through a helper', 'component', PAGES, 'calls', []],                 // D22: readRepo's 2nd parameter goes into fs.readFileSync
    ['reads through a variable', 'component', PAGES, 'calls', []],               // D22: the variable it initialises is read
    ['data strings', 'none', null, 'calls', []],                                 // D22: real paths as data, or a helper parameter that is no path
  ])('%s -> %s %s (%s)', (name, level, target, via, touches) => {
    const a = ix.attachments.get(`${R}#reach › ${name}`)!;
    expect([a.level, a.target, a.via, a.touches]).toEqual([level, target === 'SYSTEM' ? ix.tree.systemId : target, via, touches]);
  });

  it('records path-like string literals (not module specifiers) with the file call or the calls they go into', () => {
    const where = (file: string) => input.snapshot.calls!.find((c) => c.file === file)!.pathLiterals!
      .map((l) => [l.value, l.call ?? l.args?.map((a) => `${a.callee}[${a.index}]`) ?? null]);
    expect([...where(R), ...where('web/test/helpers/spawn.ts')]).toEqual([
      ['../src/page.ts', 'path.join'], ['web/src/page.ts', 'fs.readFileSync'], ['web/dist/page.js', 'fs.readFileSync'],
      ['api/src/store.ts', 'fs.readFileSync'], ['web/src/page.ts', ['readRepo[1]']], ['web/src/page.ts', 'fs.readFileSync'],
      ['web/src/page.ts', ['expect[0]']], ['api/src/store.ts', ['readRepo[0]']], ['web/dist/cli.js', 'child_process.execFileSync'],
    ]);
    expect(['web/test/helpers/read.ts', 'web/test/helpers/spawn.ts'].map((f) => input.snapshot.calls!.find((c) => c.file === f)!.pathParams)).toEqual([
      [{ fn: 'readRepo', index: 1, call: 'fs.readFileSync' }], [{ fn: 'spawnCli', index: 0, call: 'child_process.execFileSync' }],
    ]);
  });

  it('a hand link naming no test case and no test file is test-link-dead', () => {
    const dead = checkTestBlocks(input.plan!, input.snapshot, input.ownership, input.tests).filter((f) => f.rule === 'test-link-dead');
    expect(dead.map((f) => [f.severity, f.id, f.message])).toEqual(
      ['gone', 'old helper'].map((n) => ['warning', 'shop.web', expect.stringContaining(`test '${n}' links`)]),
    );
  });
});

describe('readers', () => {
  const ids = (names: string[]) => names.map((n) => (n.includes('/') ? n : `${T}#${n}`));   // a case of T, or a file's pseudo case
  it.each([
    [ORDERS, {}, { own: ['places and cancels'], children: [], touches: [] }],
    [ORDERS, { children: true }, { own: ['places and cancels'], children: ['orders › places', 'ignored and orders'], touches: [] }],
    [ORDERS, { children: true, touches: true }, {
      own: ['places and cancels'],
      children: ['orders › places', 'ignored and orders'],
      touches: ['orders › orders and store', 'page and order', 'shared and orders'],
    }],
    ['api', { children: true }, {
      own: ['orders › orders and store', 'shared and orders'],
      children: ['orders › places', 'orders › setup only', 'places and cancels', 'helper', 'ignored and orders', 'api/test/setup.ts'],
      touches: [],
    }],
  ])('testsOf(%s, %j)', (id, o, expected) => {
    expect(testsOf(ix, id, o)).toEqual({ own: ids(expected.own), children: ids(expected.children), touches: ids(expected.touches) });
  });

  it('treeIdOfPlan maps the system, a container (to its scanned id), a component', () => {
    const el = (id: string) => input.plan!.elements.find((e) => e.id === id)!;
    expect(['shop', 'shop.api', ORDERS, 'shop.api.logic'].map((id) => treeIdOfPlan(ix, el(id)))).toEqual([ix.tree.systemId, 'api', ORDERS, null]);
  });

  it('testsReport: run = own + children with run commands from the caller, touches apart', () => {
    const r = testsReport(ix, ORDERS, input.plan, null, (t) => ({ command: `run ${t.name}`, cwd: '.' }));
    expect(r.counts).toEqual({ run: 3, toWrite: 0, touches: 3 });
    expect(r.run.map((t) => [t.name, t.relation, t.run?.command])).toEqual([
      ['orders › places', 'child', 'run orders › places'],
      ['places and cancels', 'own', 'run places and cancels'],
      ['ignored and orders', 'child', 'run ignored and orders'],
    ]);
  });

  it('testsReport toWrite: test blocks (own and below) that no test of the report matches by full chain or unique leaf (T26-13)', () => {
    const src = { file: 'c4/plan.c4', line: 1, endLine: 1 };
    const block = (name: string, c: string | null = null) => ({ name, case: c, source: src });
    const plan = input.plan!;
    const tests: Record<string, ReturnType<typeof block>[]> = {
      'shop.api': [block('refunds')],
      [ORDERS]: [block('places and cancels'), block('places'), block('page and order'), block('voids'), block('cli help', `${T}#mocked`)],
    };
    const planned = { ...plan, elements: plan.elements.map((e) => (tests[e.id] ? { ...e, tests: tests[e.id] } : e)) };
    const api = planned.elements.find((e) => e.id === 'shop.api')!;
    const r = testsReport(ix, 'api', planned, api, () => null);
    expect(r.toWrite.map((t) => [t.parent, t.name])).toEqual([['shop.api', 'refunds'], [ORDERS, 'voids']]);
    expect(r.counts.toWrite).toBe(r.toWrite.length);
  });

  it('testIndexOf keeps one index per snapshot; a snapshot without calls is refused', () => {
    expect(testIndexOf(input)).toBe(testIndexOf(input));
    const noCalls = { ...input, snapshot: { ...input.snapshot, calls: undefined } };
    expect(() => attachTests(noCalls)).toThrow(/collectCalls/);
  });
});

describe('other languages: file imports (folder mode)', () => {
  it('every PHP case (no calls) reaches what its file imports; touches are components', () => {
    const php = attachTests(inputOf(path.join(FIX, 'phpshop'), { languages: ['php'] }));
    expect([...php.attachments.values()].map((a) => [a.testId, a.level, a.target, a.via])).toEqual(
      ['testPays', 'it_is_free', 'refunds'].map((n) => [`tests/OrderTest.php#OrderTest.${n}`, 'component', 'phpshop/models', 'imports']),
    );
  });
});

describe('Python: the calls ladder (b592)', () => {
  it('a case attaches by what it calls; a case that calls nothing traced (a pytest fixture, setup_method state) is none', () => {
    const py = attachTests(inputOf(path.join(FIX, 'pyshop'), { languages: ['python'] }));
    expect([...py.attachments.values()].map((a) => [a.testId, a.level, a.target, a.via, a.step])).toEqual([
      ['tests/test_orders.py#test_free', 'none', null, 'calls', 'none'],
      ['tests/test_orders.py#test_not_free', 'element', 'shop/models/order.py#Order', 'calls', 'body'],   // through make_order
      ['tests/test_orders.py#TestOrders.test_total', 'none', null, 'calls', 'none'],
      ['tests/test_orders.py#OrderCase.test_id', 'element', 'shop/models/order.py#Order', 'calls', 'body'],
    ]);
  });
});

// D21 (the engine against measure.js's subject-first policy on the live repo) is no jest test: live numbers move with
// every plan or test edit. Run Document/Roadmap/Phase26/tools/compare-engine.js on the current repo instead.
