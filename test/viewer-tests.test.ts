import * as fs from 'fs';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { loadQueryContext } from '../src/query/context';
import { testsOfContext } from '../src/query/testsContext';
import { forEachNode } from '../src/view/tree';
import type { ViewModel, ViewNode } from '../src/types';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { BOTH, FORMATS, LATER, ORDERS, PLACES, PLANNED_TESTS_EDIT, RENDERS, makeTestsRepo } from './helpers/tests-fixture';

// Phase 26 T26-10 (D8): tests on the map. No test file box; each c-item carries the tests attached to it, below it and
// touching it (ViewNode.tests, indexes into C4PM_DATA.tests); a count pill on the box; a Tests panel section with run
// commands; the Files tab keeps test files (role 'test') and flags test-only code.
// T26-14c: the section also lists the tests to write (planned test blocks no case matches); the count pill keeps off the
// box's text.

const FIX = path.join(__dirname, 'fixtures');

let repo: string;
let model: ViewModel;
let html: string;
const nodes = new Map<string, ViewNode>();
beforeAll(() => {
  repo = makeTestsRepo('c4pm-view-tests-', PLANNED_TESTS_EDIT);
  ({ model, html } = buildView({ repo }));
  forEachNode(model.root, (n) => { nodes.set(n.id, n); });
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

/** The test ids of one list of a node. */
const ids = (id: string, list: 'ids' | 'children' | 'touches'): string[] =>
  (nodes.get(id)!.tests?.[list] ?? []).map((i) => model.tests!.cases[i].id);

describe('view model', () => {
  it.each([
    // node, attached here, attached below, touching it
    ['api/src/orders.ts#placeOrder', [PLACES], [], [BOTH]],
    [ORDERS, [], [PLACES], [BOTH]],
    ['shop.api.logic', [], [PLACES], [BOTH]],   // a layer: its components' tests
    ['api', [BOTH], [PLACES], []],
    ['web/src/page.ts#renderPage', [RENDERS], [], []],
  ])('%s: own, children and touches come from the attachment engine', (id, own, below, touch) => {
    expect([ids(id, 'ids'), ids(id, 'children'), ids(id, 'touches')]).toEqual([own, below, touch]);
    expect(nodes.get(id)!.tests!.count).toBe(own.length + below.length);
  });

  it('the system counts every attached case, also one on code the map does not draw (test-only code)', () => {
    expect(ids(model.root.id, 'children')).toEqual([PLACES, BOTH, FORMATS, RENDERS]);
    expect(model.root.tests!.count).toBe(model.tests!.cases.length);
    expect(nodes.get('shop.api.data.store')!.tests).toEqual({ count: 0, ids: [], touches: [model.tests!.cases.findIndex((c) => c.id === BOTH)] });
    expect([...nodes.values()].filter((n) => n.kind === 'component' && !n.tests).map((n) => n.id)).toEqual([]);
  });

  it('no test file is a box: no file, slice or element node of a test file, and no test file in emptyFiles', () => {
    const inTests = (p?: string) => !!p && /^(api|web)\/test\//.test(p);
    expect([...nodes.values()].filter((n) => inTests(n.file) || n.id.includes('/test/')).map((n) => n.id)).toEqual([]);
    const unassigned = [...nodes.values()].find((n) => n.kind === 'unassigned');
    expect((unassigned?.emptyFiles ?? []).filter(inTests)).toEqual([]);
  });

  it('run commands: jest in the api root; the web container has no runner and says why', () => {
    const { cases, runners } = model.tests!;
    const byId = new Map(cases.map((c) => [c.id, c]));
    expect(byId.get(PLACES)!.run).toBe('npx jest test/orders.test.ts -t "orders places"');
    expect(runners[byId.get(PLACES)!.runner]).toEqual({ cwd: 'api' });
    expect(byId.get(RENDERS)!.run).toBeUndefined();
    expect(runners[byId.get(RENDERS)!.runner].reason).toContain('set config tests.command');
  });

  it('b506 (G5): the page and the query readers share one tests binding: same run command and runner for every case', () => {
    const { runOf, runnerOf } = testsOfContext(loadQueryContext(repo));
    const { cases, runners } = model.tests!;
    const fromQuery = cases.map((c) => {
      const file = c.id.slice(0, c.id.indexOf('#'));
      const runner = runnerOf(file);
      return {
        run: runOf({ id: c.id, file, name: c.id.slice(file.length + 1), line: c.line, endLine: c.line })?.command,
        runner: runner.id === null ? { reason: runner.reason } : { cwd: runner.cwd },
      };
    });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.map((c) => ({ run: c.run, runner: runners[c.runner] }))).toEqual(fromQuery);
  });

  it('Files tab: test files keep their row with role test and no flag; code used only by tests is flagged test-only', () => {
    const files = new Map(model.files.map((f) => [f.path, f]));
    expect(['api/test/orders.test.ts', 'api/test/setup.ts', 'web/test/page.test.ts'].map((p) => [files.get(p)!.role, files.get(p)!.flag]))
      .toEqual([['test', undefined], ['test', undefined], ['test', undefined]]);
    expect(files.get('api/src/util.ts')!.flag).toBe('test-only');
  });

  it('a repo without test files has no test data at all', () => {
    const plain = buildView({ repo: path.join(FIX, 'layers-claim') }).model;
    expect(plain.tests).toBeUndefined();
    forEachNode(plain.root, (n) => expect(n.tests).toBeUndefined());
  });
});

describe('page', () => {
  let h: HarnessResult;
  const copied: string[] = [];
  beforeEach(() => {
    copied.length = 0;
    h = runViewerScripts(html, { globals: { navigator: { clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } } } });
    h.frames.runToCompletion();
  });
  const map = () => h.sandbox.C4PM_MAP as any;
  const drawn = (): string[] => { h.fillTextLog.length = 0; map().draw(); return h.fillTextLog.slice(); };
  const byClass = (root: FakeEl, cls: string): FakeEl[] => {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => (n.children || []).forEach((c) => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });
    walk(root);
    return out;
  };

  const rowTexts = (root: FakeEl): string[] => byClass(root, 'pn-test').map((r) => serializeText(r).replace(/\s+/g, ' '));

  it('the test count pill is drawn on a box with tests and goes with the Tests overlay', () => {
    const on = drawn();
    map().setOverlay('tests', false);
    const off = drawn();
    const label = String(nodes.get('api')!.tests!.count);
    expect(on.filter((t) => t === label).length - off.filter((t) => t === label).length).toBeGreaterThan(0);
    expect(on.length).toBeGreaterThan(off.length);
  });

  it('the legend lists a Tests toggle on a page with tests', () => {
    expect(serializeText((h.sandbox.document as any).getElementById('legend'))).toContain('Tests');
  });

  const testsSection = (id: string): FakeEl => {
    map().select(id);
    return byClass(h.panel, 'pn-section').find((s) => serializeText(s.children[0]).startsWith('Tests'))!;
  };

  it('Tests section: rows to run (here / via a child), to write, touching it; each case with level, place and run command', () => {
    const rows = rowTexts(testsSection(ORDERS));
    expect(rows[0]).toContain('orders › places');
    expect(rows[0]).toContain('element');
    expect(rows[0]).toContain('via placeOrder');
    expect(rows[0]).toContain('npx jest test/orders.test.ts -t "orders places"');
    expect(rows[1]).toBe(`refunds on ${ORDERS}`);
    expect(rows[2]).toContain('touches this; attached to Api');
    expect(rows[2]).toContain('container');
  });

  it.each([
    // node, heading counts, tests to write (`places` is planned too, but the case `orders › places` matches it)
    [ORDERS, '1 to run · 1 to write · 1 touching', [`refunds on ${ORDERS}`]],
    ['api', '2 to run · 1 to write', [`refunds on ${ORDERS}`]],
    [LATER, '1 to write', [`later works on ${LATER}`]],   // only a planned test: listed, no "0 to run"
    ['shop.api.data.store', '1 touching', []],
  ])('%s: the heading counts only lists with rows (%s); tests to write are dashed rows', (id, counts, write) => {
    const sec = testsSection(id);
    expect(serializeText(sec.children[0])).toBe(`Tests ${counts}`);
    expect(byClass(sec, 'pn-test-write').map((r) => serializeText(r).replace(/\s+/g, ' '))).toEqual(write);
  });

  it.each([
    // the api container drawn as a bubble of width x height screen px: name drawn, count pill drawn
    ['a standard bubble: the text is centred, the top right corner is free', 170, 64, true, true],
    ['a small box at container zoom (t26-14a): the pill would cover its text', 60, 20, true, false],
    ['a box too small for any text: nothing to cover', 30, 20, false, true],
  ])('count pill: %s', (_case, width, height, named, pilled) => {
    const api = map().nodeById('api');
    h.fillTextLog.length = 0;
    (h.sandbox.C4PM_RENDER as any).beans.drawBubble({ n: api, R: { x: 100, y: 100, w: width, h: height }, a: 1 });
    expect([h.fillTextLog.includes(api.name), h.fillTextLog.includes(String(api.tests.count))]).toEqual([named, pilled]);
  });

  it('a case on code the map does not draw says so', () => {
    map().select(model.root.id);
    const row = rowTexts(h.panel).find((t) => t.includes('formats'))!;
    expect(row).toContain('via code not drawn on the map');
  });

  it('Copy puts the command, run from its container root, on the clipboard; no runner shows why', () => {
    map().select('web/src/page.ts#renderPage');
    expect(serializeText(byClass(h.panel, 'pn-test')[0])).toContain('no run command:');
    map().select(ORDERS);
    const copy = byClass(byClass(h.panel, 'pn-test')[0], 'pn-copy')[0];
    (copy as any).onclick({});   // panel.js sets the onclick property (FakeEl.click only runs listeners)
    expect(copied).toEqual(["cd api && npx jest test/orders.test.ts -t \"orders places\""]);
  });
});
