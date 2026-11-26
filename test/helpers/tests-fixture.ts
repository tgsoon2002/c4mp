import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Phase 26: a repo with test cases attached to its c-items, shared by the T26-10 (map) and T26-12 (board) tests.
// layers-claim (api: layers logic > orders, data > store; web: pages) plus jest in api, unclaimed code used only by a
// test (util.ts), a setup file with no functions, and a web test whose container has no runner.

export const TEST_FILES: Record<string, string> = {
  'api/package.json': '{ "name": "layers-claim-api", "devDependencies": { "jest": "29.7.0" } }\n',
  'api/src/util.ts': 'export function fmt(s: string): string {\n  return s;\n}\n',
  'api/test/setup.ts': 'export {};\n',
  'api/test/orders.test.ts': [
    "import { placeOrder } from '../src/orders';",
    "import { savePrice } from '../src/store';",
    "import { fmt } from '../src/util';",
    '',
    "describe('orders', () => {",
    "  it('places', () => placeOrder('1'));",
    "  it('orders and store', () => { placeOrder('1'); savePrice('2'); });",
    '});',
    "it('formats', () => fmt('a'));",
    '',
  ].join('\n'),
  'web/test/page.test.ts': "import { renderPage } from '../src/page';\n\nit('renders', () => renderPage());\n",
};
export const ORDERS = 'shop.api.logic.orders';
export const PLACES = 'api/test/orders.test.ts#orders › places';
export const BOTH = 'api/test/orders.test.ts#orders › orders and store';
export const FORMATS = 'api/test/orders.test.ts#formats';
export const RENDERS = 'web/test/page.test.ts#renders';

// The plan of that repo plus uids, planned tests (`places` is matched by the case `orders › places`, the others are to
// write) and a plan-only component Later with only a planned test (T26-12 board, T26-14c panel). makeTestsRepo's `edit`.
const PLAN_EDITS: [string, string][] = [
  ["    api = container 'Api' {\n", "    api = container 'Api' {\n      metadata { uid 'u-api' }\n"],
  ["logic = layer 'Logic' {\n", "logic = layer 'Logic' {\n        metadata { uid 'u-logic' }\n"],
  ["orders = component 'Orders' {\n", "orders = component 'Orders' {\n          metadata { uid 'u-orders' }\n          test 'places' {}\n          test 'refunds' {}\n"],
  ["pages = component 'Pages' {\n", "pages = component 'Pages' {\n        metadata { uid 'u-pages' }\n        test 'renders twice' {}\n"],
  ["    web = container 'Web' {\n", "    web = container 'Web' {\n      later = component 'Later' {\n        metadata { uid 'u-later' status 'planned' }\n        test 'later works' {}\n      }\n"],
];
export const LATER = 'shop.web.later';
export const PLANNED_TESTS_EDIT: Record<string, (old: string) => string> = {
  'c4/plan.c4': (old) => PLAN_EDITS.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`tests fixture: the plan has no ${JSON.stringify(from)}`);
    return text.replace(from, to);
  }, old),
};

/** A tmp copy of that repo; `edit` changes files after the copy (rel path -> new text from the old one). Caller removes it. */
export function makeTestsRepo(prefix: string, edit: Record<string, (old: string) => string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'layers-claim'), repo, { recursive: true });
  for (const [rel, text] of Object.entries(TEST_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  for (const [rel, change] of Object.entries(edit)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, change(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''));
  }
  return repo;
}
