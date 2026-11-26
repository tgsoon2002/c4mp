import * as fs from 'fs';
import * as path from 'path';
import { runPlanCli, makeRepo, listing } from './helpers/planEditHarness';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';
import { requireProject } from '../src/outputs';

// b405 MV-3 (Document/Roadmap/PLAN_MOVE.md 7.3): `c4pm plan move` / `c4pm plan rename`, in-process on tmp repos.
// Fixtures: layers-claim (layers, model-level relations), io-shop (screens + a wireframe), lkf-replay (C4PM's plan
// before and after the hand migration LK-F, commit 46a2c31).
const FX = path.join(__dirname, 'fixtures');
const read = (...p: string[]) => fs.readFileSync(path.join(FX, ...p), 'utf-8');
const ORDERS = 'shop.api.logic.orders';
const LAYERS_PLAN = read('layers-claim', 'c4', 'plan.c4').replace('model {\n', `model {\n  // ${ORDERS} places orders\n`);
const SHOP = read('io-shop', 'c4', 'shop.c4');
const HOME_HTML = read('io-shop', 'c4', 'io', 'shop.web.home.html');

type Repo = ReturnType<typeof makeRepo>;
const reparse = (repo: Repo) => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
const cli = (repo: Repo, ...args: string[]) => runPlanCli(['plan', ...args, '--repo', repo.root]);

describe('c4pm plan move / rename on the layers plan (mentions in a doc, the board and a plan comment)', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = makeRepo('c4pm-move-', { 'plan.c4': LAYERS_PLAN });
    fs.mkdirSync(path.join(repo.root, 'docs'));
    fs.writeFileSync(path.join(repo.root, 'docs', 'notes.md'), `Orders: ${ORDERS}.\nNot these: ${ORDERS}_v2, x${ORDERS}\n`);
    const board = path.join(requireProject(repo.root).projectDir, 'board');
    fs.mkdirSync(board, { recursive: true });
    const items = [{ id: 'b7', title: `Split ${ORDERS}` }];
    fs.writeFileSync(path.join(board, 'board.json'), JSON.stringify({ boards: [{ id: 'main', items }] }, null, 2));
  });
  afterEach(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  // [name, args, exit code, lines the output (stdout + stderr) holds, text it must not hold]
  it.each<[string, string[], number, string[], string[]?]>([
    ['move: diff, moved root, rewritten refs, mentions, dry run', ['move', ORDERS, '--parent', 'shop.api.data'], 0, [
      'move 1 element to shop.api.data',
      "+        orders = component 'Orders' {",
      '+  shop.api.data.orders -> shop.api.data.store \'stores prices\'',
      `moved ${ORDERS} -> shop.api.data.orders`,
      'references rewritten: 2 in 1 file (plan.c4 2)',
      'mentions outside the plan (not edited):',
      `  docs/notes.md:1  ${ORDERS}`,
      `/board/board.json:8  ${ORDERS}  (b7)`,
      `/plan/plan.c4:9  ${ORDERS}`,
      'dry run: nothing written. Add --yes to apply.',
    ], ['docs/notes.md:2']],   // ${ORDERS}_v2 and x${ORDERS} are other names
    ['several elements land in argument order; --no-mentions skips the search', ['move', 'store', ORDERS, '--parent', 'shop.web', '--no-mentions'], 0, [
      'move 2 elements to shop.web',
      "+      store = component 'Store' {",
      "+      orders = component 'Orders' {",
      'moved shop.api.data.store -> shop.web.store',
      `moved ${ORDERS} -> shop.web.orders`,
    ], ['mentions outside the plan']],
    ['a layer moves with its components', ['move', 'shop.api.logic', '--parent', 'shop.web'], 0, [
      'moved shop.api.logic -> shop.web.logic  with 1 inside',
      'references rewritten: 2 in 1 file (plan.c4 2)',
    ]],
    ['same parent: moved to the end', ['move', 'shop.api.logic', '--parent', 'shop.api'], 0, [
      '+      logic = layer \'Logic\' {',
      'note: shop.api.logic already under shop.api: moved to the end',
    ]],
    ['rename: id token and references', ['rename', ORDERS, 'ordering'], 0, [
      `rename ${ORDERS}`,
      "+        ordering = component 'Orders' {",
      `renamed ${ORDERS} -> shop.api.logic.ordering`,
      `  docs/notes.md:1  ${ORDERS}`,
    ]],
    ['rename to the same id: no change', ['rename', ORDERS, 'orders'], 0, ['note: no change']],
    ['refused: kind rule', ['move', ORDERS, '--parent', 'shop.api.data.store'], 1, [
      "error: invalid: cannot move, nothing written:",
      "  - a component goes under a container or subregion, but 'shop.api.data.store' is a component",
    ]],
    ['refused: every problem is listed', ['move', 'shop.api', '--parent', 'shop.api.logic'], 1, [
      '  - cannot move shop.api into itself or its descendant shop.api.logic',
      "  - a container goes under a system or external, but 'shop.api.logic' is a subregion",
    ]],
    ['refused: unknown parent', ['move', ORDERS, '--parent', 'nope'], 1, ["error: not-found: --parent: no element matches 'nope'"]],
    ['refused: unknown element', ['move', 'nope', '--parent', 'shop.web'], 1, ["error: not-found: no element matches 'nope'"]],
    ['refused: rename to a taken fqn', ['rename', 'shop.api.logic', 'data'], 1, ["  - shop.api.data already exists (subregion 'Data')"]],
    ['refused: rename to a bad id', ['rename', ORDERS, '9x'], 1, ["  - invalid id '9x'"]],
  ])('%s', async (_name, args, code, lines, absent = []) => {
    const before = listing(repo.root);
    const r = await cli(repo, ...args);
    const out = `${r.stdout}\n${r.stderr}`;
    for (const l of lines) expect(out).toContain(l);
    expect(r.code).toBe(code);
    for (const l of absent) expect(out).not.toContain(l);
    expect(listing(repo.root)).toEqual(before);
  });

  it('--yes writes; --json is one object with every moved pair, rewritten counts and all mentions', async () => {
    const doc = fs.readFileSync(path.join(repo.root, 'docs', 'notes.md'));
    const r = await cli(repo, 'move', 'shop.api.logic', '--parent', 'shop.web', '--yes', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({
      ok: true, command: 'move', written: true, target: { fqn: 'shop.web', kind: 'container' },
      moved: [
        { from: 'shop.api.logic', to: 'shop.web.logic', uid: null },
        { from: ORDERS, to: 'shop.web.logic.orders', uid: null },
      ],
      rewritten: [{ file: expect.stringMatching(/plan\.c4$/), count: 2 }],
      wireframes: [],
      mentionsTotal: 4,
    });
    // sorted by repo-relative file; notes.md:2 names shop.api.logic.orders_v2: a descendant-shaped name of the moved layer counts
    expect(j.mentions.map((m: { file: string; line: number; item?: string }) => [path.basename(m.file), m.line, m.item])).toEqual([
      ['board.json', 8, 'b7'], ['plan.c4', 9, undefined], ['notes.md', 1, undefined], ['notes.md', 2, undefined],
    ]);
    const plan = reparse(repo);
    expect(plan.relations.map(x => `${x.from} -> ${x.to}`)).toEqual([
      'shop.web.logic.orders -> shop.api.data.store', 'shop.web.pages -> shop.web.logic.orders',
    ]);
    expect(plan.elements.find(e => e.id === 'shop.web.logic.orders')?.parent).toBe('shop.web.logic');
    expect(fs.readFileSync(repo.files['plan.c4'], 'utf-8')).toContain(`// ${ORDERS} places orders`);   // comments are never edited
    expect(fs.readFileSync(path.join(repo.root, 'docs', 'notes.md')).equals(doc)).toBe(true);
  });
});

describe('wireframe files follow a moved or renamed screen (io-shop)', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = makeRepo('c4pm-move-io-', { 'shop.c4': SHOP });
    fs.mkdirSync(path.join(repo.planDir, 'io'));
    fs.writeFileSync(path.join(repo.planDir, 'io', 'shop.web.home.html'), HOME_HTML);
  });
  afterEach(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  it.each<[string, string[], string]>([
    ['move to another container', ['move', 'shop.web.home', '--parent', 'shop.cli'], 'shop.cli.home'],
    ['rename', ['rename', 'shop.web.home', 'start'], 'shop.web.start'],
  ])('%s', async (_name, args, now) => {
    const dry = await cli(repo, ...args);
    expect(dry.stdout).toContain(`renamed io/shop.web.home.html -> io/${now}.html`);
    const r = await cli(repo, ...args, '--yes');
    expect(r.code).toBe(0);
    expect(fs.readdirSync(path.join(repo.planDir, 'io'))).toEqual([`${now}.html`]);
    expect(fs.readFileSync(path.join(repo.planDir, 'io', `${now}.html`), 'utf-8')).toBe(HOME_HTML);   // refs are relative to the screen
    expect(reparse(repo).relations.some(x => x.to === now)).toBe(true);
    expect(r.stdout).toContain(`written: ${path.relative(repo.root, repo.files['shop.c4'])}, ${path.relative(repo.root, path.join(repo.planDir, 'io', `${now}.html`))}`);
  });
});

// LK-F replay: C4PM's plan before 46a2c31 + the 5 layer heads, then 5 `plan move --yes` in LK-F order, must equal the
// hand migration 46a2c31 (lines trimmed, blank lines dropped) minus the layer uids and the 3 hand-only edits.
describe('LK-F replay (46a2c31^ + 5 plan move = 46a2c31)', () => {
  const LKF = path.join(FX, 'lkf-replay');
  const LAYERS: [string, string[]][] = [
    ['entry', ['cli', 'mcp', 'plan_commands', 'viewer', 'scripts', 'tests', 'desktop_app']],
    ['services', ['query', 'report', 'git_hooks', 'calls_tools']],
    ['engines', ['scan_pipeline', 'grouper', 'snapshot', 'compare', 'plan_files', 'view_model', 'boards', 'call_graph']],
    ['readers', ['languages', 'parser', 'importer', 'history']],
    ['foundation', ['settings']],
  ];
  const lkf = (...p: string[]) => fs.readFileSync(path.join(LKF, ...p), 'utf-8');
  const norm = (text: string) => text.split('\n').map(l => l.trim()).filter(l => l !== '');
  const hand: { file: string; after: string[]; replay: string[] }[] = JSON.parse(lkf('hand-only.json')).edits;

  /** after/<file>, normalized, without the layer `metadata { uid }` blocks and with the hand-only edits undone. */
  function expected(file: string): string[] {
    const layerUids = new Set(LAYERS.map(([l]) => new RegExp(`^ {4}${l} = layer [\\s\\S]*?\\n {6}metadata \\{\\n {8}uid '([^']+)'`, 'm').exec(lkf('after', 'c4pm.c4'))![1]));
    let lines = norm(lkf('after', file));
    lines = lines.filter((l, i) => !(
      (l === 'metadata {' && layerUids.has(/^uid '([^']+)'$/.exec(lines[i + 1] ?? '')?.[1] ?? '')) ||
      layerUids.has(/^uid '([^']+)'$/.exec(l)?.[1] ?? '') ||
      (l === '}' && layerUids.has(/^uid '([^']+)'$/.exec(lines[i - 1] ?? '')?.[1] ?? ''))));
    for (const e of hand.filter(h => h.file === file)) {
      const at = lines.findIndex((_, i) => e.after.every((a, k) => lines[i + k] === a));
      expect(at).toBeGreaterThanOrEqual(0);
      lines = [...lines.slice(0, at), ...e.replay, ...lines.slice(at + e.after.length)];
    }
    return lines;
  }

  let repo: Repo;
  const runs: { ok: boolean; findings: { new: unknown[] }; rewritten: { file: string; count: number }[] }[] = [];
  beforeAll(async () => {
    // setup: the 5 layer heads with their description line (from after/, no metadata) at the top of extend c4pm.c4pm
    const after = lkf('after', 'c4pm.c4').split('\n');
    const heads = LAYERS.map(([l]) => {
      const i = after.findIndex(x => x.startsWith(`    ${l} = layer `));
      return `${after[i]}\n${after[i + 1]}\n    }\n`;
    }).join('');
    const c4pm = lkf('before', 'c4pm.c4').replace('  extend c4pm.c4pm {\n', `  extend c4pm.c4pm {\n${heads}`);
    repo = makeRepo('c4pm-lkf-', { 'architecture.c4': lkf('before', 'architecture.c4'), 'c4pm.c4': c4pm, 'io.c4': lkf('before', 'io.c4') });
    fs.cpSync(path.join(LKF, 'before', 'io'), path.join(repo.planDir, 'io'), { recursive: true });
    for (const [layer, ids] of LAYERS) {
      const r = await cli(repo, 'move', ...ids.map(id => `c4pm.c4pm.${id}`), '--parent', `c4pm.c4pm.${layer}`, '--yes', '--json');
      runs.push(JSON.parse(r.stdout));
    }
  }, 60000);
  afterAll(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  it('every move is written and the gate (fast mode) finds nothing new', () => {
    expect(runs.map(r => [r.ok, r.findings.new.length])).toEqual(LAYERS.map(() => [true, 0]));
  });

  it('114 relation ends rewritten: 44 in c4pm.c4, 70 in io.c4', () => {
    const per: Record<string, number> = {};
    for (const r of runs) for (const w of r.rewritten) per[path.basename(w.file)] = (per[path.basename(w.file)] ?? 0) + w.count;
    expect(per).toEqual({ 'c4pm.c4': 44, 'io.c4': 70 });
  });

  it.each(['c4pm.c4', 'io.c4'])('%s equals the hand migration', file => {
    expect(norm(fs.readFileSync(repo.files[file], 'utf-8'))).toEqual(expected(file));
  });

  it('architecture.c4 and the wireframes are untouched; all 24 component uids kept at the new fqns', () => {
    expect(fs.readFileSync(repo.files['architecture.c4'], 'utf-8')).toBe(lkf('before', 'architecture.c4'));
    expect(listing(path.join(repo.planDir, 'io'))).toEqual(listing(path.join(LKF, 'before', 'io')));
    const before = parsePlan(LKF, ['before/c4pm.c4']).elements.filter(e => e.kind === 'component');
    const now = new Map(reparse(repo).elements.map(e => [e.metadata.uid, e.id]));
    expect(before.map(e => now.get(e.metadata.uid))).toEqual(
      before.map(e => `c4pm.c4pm.${LAYERS.find(([, ids]) => ids.includes(e.id.split('.').pop()!))![0]}.${e.id.split('.').pop()}`));
    expect(before).toHaveLength(24);
  });
});
