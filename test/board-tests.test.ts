import * as fs from 'fs';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { boardFileFor } from '../src/board/load';
import { requireProject } from '../src/outputs';
import * as queryContext from '../src/query/context';
import type { ViewModel } from '../src/types';
import { runBoardCli } from './helpers/boardHarness';
import { BOTH, ORDERS, PLACES, PLANNED_TESTS_EDIT, RENDERS, makeTestsRepo } from './helpers/tests-fixture';
import { BOARD_EXTRA_IDS } from './helpers/viewer-board-fixture';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';

// Phase 26 T26-12 (D19): a board task lists the tests of the c-items it links: to run (with run commands), to write
// (planned test blocks no case matches) and touching. `board show --with-tests` (text, --json) scans; plain `board show`
// does not. The board drawer of the page lists the same, from the page's test data.

// The tests fixture with planned tests (PLANNED_TESTS_EDIT); b1 links a component, b2 a layer (its components), a component
// and the plan-only one, b4 a container and a component inside it (each test once).
const item = (id: string, links: string[]) => ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links, tags: [] });
const BOARD = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [item('b1', ['u-orders']), item('b2', ['u-logic', 'u-pages', 'u-later']), item('b3', []), item('b4', ['u-orders', 'u-api'])] }] };

let repo: string;
beforeAll(() => {
  repo = makeTestsRepo('c4pm-board-tests-', PLANNED_TESTS_EDIT);
  fs.mkdirSync(path.join(repo, '.git'));   // the anchor the board file lives under
  const file = boardFileFor(requireProject(repo));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(BOARD, null, 2) + '\n');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const show = (...args: string[]) => runBoardCli(['show', ...args, '--repo', repo]);
const RUN_PLACES = 'cd api && npx jest test/orders.test.ts -t "orders places"';

// item, tests to run, tests to write (name, parent), touching
const EXPECTED: [string, string[], [string, string][], string[]][] = [
  ['b1', [PLACES], [['refunds', ORDERS]], [BOTH]],
  ['b2', [PLACES, RENDERS], [['refunds', ORDERS], ['renders twice', 'shop.web.pages'], ['later works', 'shop.web.later']], [BOTH]],
  ['b3', [], [], []],
  ['b4', [PLACES, BOTH], [['refunds', ORDERS]], []],   // BOTH: attached to the container, so to run, not touching
];

describe('board show --with-tests', () => {
  it.each(EXPECTED)('%s --json: tests to run, to write and touching of the linked c-items', async (id, run, toWrite, touches) => {
    const r = await show(id, '--with-tests', '--json');
    expect([r.code, r.stderr]).toEqual([0, '']);
    const { tests } = JSON.parse(r.stdout);
    expect(tests.run.map((t: { id: string }) => t.id)).toEqual(run);
    expect(tests.toWrite.map((t: { name: string; parent: string }) => [t.name, t.parent])).toEqual(toWrite);
    expect(tests.touches.map((t: { id: string }) => t.id)).toEqual(touches);
    expect(tests.counts).toEqual({ run: run.length, toWrite: toWrite.length, touches: touches.length });
  });

  it('json: each test to run carries its run command (null when no runner is found)', async () => {
    const { tests } = JSON.parse((await show('b2', '--with-tests', '--json')).stdout);
    expect(tests.run.map((t: { run: unknown }) => t.run)).toEqual([{ cwd: 'api', command: 'npx jest test/orders.test.ts -t "orders places"' }, null]);
  });

  it('text: counts, then each test to run with its command, then the tests to write', async () => {
    const r = await show('b2', '--with-tests');
    expect(r.code).toBe(0);
    const tail = r.stdout.slice(r.stdout.indexOf('tests:')).split('\n');
    expect(tail).toEqual([
      'tests:       2 to run, 3 to write, 1 touching (attached elsewhere; --json lists them)',
      '  to run:    api/test/orders.test.ts:6  orders › places  (element api/src/orders.ts#placeOrder)',
      `               ${RUN_PLACES}`,
      '             web/test/page.test.ts:3  renders  (element web/src/page.ts#renderPage)',
      '               no run command: no test runner found (config tests.command sets one)',
      `  to write:  refunds  (on ${ORDERS}, c4/plan.c4:17)`,
      '             renders twice  (on shop.web.pages, c4/plan.c4:34)',
      '             later works  (on shop.web.later, c4/plan.c4:30)',
    ]);
  });

  it('plain board show reads files only: no scan, no tests', async () => {
    const scan = jest.spyOn(queryContext, 'loadQueryContext');
    try {
      const text = await show('b1');
      const json = JSON.parse((await show('b1', '--json')).stdout);
      expect([text.stdout.includes('tests:'), 'tests' in json, scan.mock.calls.length]).toEqual([false, false, 0]);
      await show('b1', '--with-tests');
      expect(scan.mock.calls.length).toBe(1);
    } finally {
      scan.mockRestore();
    }
  });
});

describe('board drawer', () => {
  let model: ViewModel;
  let h: HarnessResult;
  beforeAll(() => {
    let html: string;
    ({ model, html } = buildView({ repo }));
    h = runViewerScripts(html, { extraIds: BOARD_EXTRA_IDS });
    h.frames.runToCompletion();
  });
  const byClass = (root: FakeEl, cls: string): FakeEl[] => {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => (n.children || []).forEach((c) => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });
    walk(root);
    return out;
  };
  const testsSection = (id: string): FakeEl | undefined => {
    (h.sandbox.C4PM_BOARD as { select: (id: string) => void }).select(id);
    return byClass(h.panel, 'pn-section').find((s) => serializeText(s.children[0]).startsWith('Tests'));
  };
  const flat = (e: FakeEl): string => serializeText(e).replace(/\s+/g, ' ').trim();

  it('the page carries the tests to write of a linked c-item (ViewNode.tests.toWrite into C4PM_DATA.tests.toWrite)', () => {
    const orders = (function find(n: typeof model.root): typeof model.root | undefined {
      return n.id === ORDERS ? n : [...n.children, ...(n.subregions ?? [])].map(find).find(Boolean);
    })(model.root)!;
    expect(orders.tests!.toWrite!.map((i) => model.tests!.toWrite![i])).toEqual([{ name: 'refunds', parent: ORDERS }]);
  });

  it('an item that links no c-item has no Tests section', () => {
    expect(testsSection('b3')).toBeUndefined();
  });

  it.each(EXPECTED.filter(([id]) => id !== 'b3'))('%s: the Tests section lists to run, to write and touching', (id, run, toWrite, touches) => {
    const sec = testsSection(id)!;
    expect(flat(sec.children[0])).toBe(`Tests (${run.length} to run · ${toWrite.length} to write · ${touches.length} touching)`);
    const rows = byClass(sec, 'pn-test').map(flat);
    const names = (ids: string[]) => ids.map((t) => t.slice(t.indexOf('#') + 1));
    expect(rows.slice(0, run.length).map((r, k) => r.startsWith(names(run)[k]))).toEqual(run.map(() => true));
    expect(byClass(sec, 'pn-test-write').map(flat)).toEqual(toWrite.map(([name, parent]) => `${name} on ${parent}`));
    expect(rows.slice(run.length + toWrite.length).map((r) => r.includes('touches this'))).toEqual(touches.map(() => true));
    expect(rows[0]).toContain(RUN_PLACES.slice('cd api && '.length));
  });
});
