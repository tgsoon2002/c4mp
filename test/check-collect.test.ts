import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectFindings } from '../src/check/collect';
import { compareFindings } from '../src/c4/check';
import { runCheck } from '../src/query/check';
import { runStatus } from '../src/query/status';
import { findPlan } from '../src/scan/planScan';
import { boardFileFor } from '../src/board/load';
import { tryResolveProject } from '../src/outputs';
import { initProject } from '../src/init';
import { buildTools } from '../src/mcp/tools';
import { makeRepo } from './helpers/planEditHarness';

const TODAY = '2026-11-03';
const FIX = path.join(__dirname, 'fixtures');

const item = (id: string, extra: object = {}) => ({ id, title: `T${id}`, kind: 'task', status: 'planned', ...extra });
const boardText = (items: object[]) => JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items }] });

/** phofast copy with an anchor; `items` (when given) become its board. b1 links to a uid that exists nowhere (a board finding). */
function repoWithBoard(items: object[] | null): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-collect-')));
  fs.cpSync(path.join(FIX, 'phofast'), dir, { recursive: true });
  initProject(dir);
  if (items) {
    const file = boardFileFor(tryResolveProject(dir)!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, boardText(items));
  }
  return dir;
}

const total = (p: { critical: number; warning: number; info: number }) => p.critical + p.warning + p.info;

describe('collectFindings (S4 aggregator)', () => {
  const withBoard = repoWithBoard([item('b1', { links: ['nope'] })]);
  const noBoard = repoWithBoard(null);

  it('no board: all is exactly the plan findings, board empty', () => {
    const r = runCheck(noBoard, {}, {})!;
    const c = collectFindings(noBoard, tryResolveProject(noBoard), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(noBoard, r.config).dir, config: r.config });
    expect(c.board).toEqual([]);
    expect(c.boardData).toBeNull();
    expect(c.all).toBe(c.plan);
    expect(c.all).toEqual(r.findings);
  });

  it('board findings join the plan findings, sorted by severity with plan first inside a severity', () => {
    const r = runCheck(withBoard, {}, {})!;
    const c = collectFindings(withBoard, tryResolveProject(withBoard), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(withBoard, r.config).dir, config: r.config });
    expect(c.board.length).toBeGreaterThan(0);
    expect(c.boardData).not.toBeNull();
    expect(c.all.length).toBe(c.plan.length + c.board.length);
    const rank = ['critical', 'warning', 'info'];
    const ranks = c.all.map((f) => rank.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(r.findings).toEqual(c.all);
  });

  it('minSeverity cuts plan and board findings alike', () => {
    const r = runCheck(withBoard, {}, {})!;
    const c = collectFindings(withBoard, tryResolveProject(withBoard), r.plan, r.snapshot, { today: TODAY, minSeverity: 'warning', planDir: findPlan(withBoard, r.config).dir, config: r.config });
    expect(c.all.length).toBeGreaterThan(0);
    expect(c.all.every((f) => f.severity !== 'info')).toBe(true);
  });

  it('b707: an unknown minSeverity throws instead of hiding every finding', () => {
    const r = runCheck(withBoard, {}, {})!;
    const opts = { today: TODAY, minSeverity: 'critcal' as 'critical', planDir: findPlan(withBoard, r.config).dir, config: r.config };
    expect(() => collectFindings(withBoard, tryResolveProject(withBoard), r.plan, r.snapshot, opts))
      .toThrow("unknown minimum severity 'critcal'; use info, warning, critical");
  });

  it('no plan: the board rules still run', () => {
    const r = runCheck(withBoard, {}, {})!;
    const c = collectFindings(withBoard, tryResolveProject(withBoard), null, r.snapshot, { today: TODAY, planDir: findPlan(withBoard, r.config).dir, config: r.config });
    expect(c.plan).toEqual([]);
    expect(c.board.length).toBeGreaterThan(0);
  });

  it('status counts board findings, so status and check agree', () => {
    const checkTotal = runCheck(withBoard, {}, {})!.findings.length;
    const plainTotal = runCheck(noBoard, {}, {})!.findings.length;
    const status = runStatus(withBoard, {}).plan as { critical: number; warning: number; info: number };
    expect(checkTotal).toBeGreaterThan(plainTotal);
    expect(total(status)).toBe(checkTotal);
    expect(total(runStatus(noBoard, {}).plan as typeof status)).toBe(plainTotal);
  });

  it('MCP check returns the same findings as the CLI path', () => {
    const tool = buildTools(withBoard, {}).find((t) => t.name === 'check')!;
    const out = JSON.parse((tool.handler({}) as { content: { text: string }[] }).content[0].text);
    expect(out).toEqual(runCheck(withBoard, {}, {})!.findings);
  });
});

describe('collectFindings: storage rules (STOR-3)', () => {
  /** Drizzle fixture in src/db; a store with a missing record, and a screen (no io/ folder, so no wireframe finding). */
  const { root: store } = makeRepo('c4pm-collect-st-', { 'a.c4': [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      data = component 'Data' { link ../../../../src/db/ }",
    "      main = store 'Main' { technology 'postgres'\n metadata { reader 'drizzle' source 'src/db' }\n ghost_table = record 'ghost_table' }",
    '    }',
    '  }',
    '}',
    '',
  ].join('\n') });
  fs.cpSync(path.join(FIX, 'schema-drizzle'), path.join(store, 'src', 'db'), { recursive: true });
  afterAll(() => fs.rmSync(store, { recursive: true, force: true }));
  const noStorePlanRepo = repoWithBoard(null);   // phofast: a plan with no store
  const STORAGE_RULES = ['missing-store', 'store-unreadable', 'missing-record', 'planned-but-built', 'field-drift', 'unplanned-record', 'unplanned-store'];
  const isStorage = (f: { rule: string }) => STORAGE_RULES.includes(f.rule);

  it('the plan list carries the storage findings after checkPlan, and the result the storage state', () => {
    const r = runCheck(store, {}, {})!;
    const c = collectFindings(store, tryResolveProject(store), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(store, r.config).dir, config: r.config });
    const first = c.plan.findIndex(isStorage);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(c.plan.slice(first).every(isStorage)).toBe(true);
    expect(c.plan[first]).toEqual({ severity: 'warning', rule: 'missing-record', id: 'app.api.main.ghost_table', message: "record 'ghost_table' is not in the code of store app.api.main (reader drizzle)" });
    expect(c.storage?.stores.map((s) => [s.element.id, s.reader])).toEqual([['app.api.main', 'drizzle']]);
    expect(c.all).toEqual(r.findings);
  });

  it('a plan with no store: storage is null (Q4)', () => {
    const r = runCheck(noStorePlanRepo, {}, {})!;
    const c = collectFindings(noStorePlanRepo, tryResolveProject(noStorePlanRepo), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(noStorePlanRepo, r.config).dir, config: r.config });
    expect(c.storage).toBeNull();
    expect(c.plan.filter(isStorage)).toEqual([]);
  });

  it('status totals = check totals, MCP check = CLI check, with storage findings present', () => {
    const findings = runCheck(store, {}, {})!.findings;
    expect(findings.some(isStorage)).toBe(true);
    const status = runStatus(store, {}).plan as { critical: number; warning: number; info: number };
    expect(total(status)).toBe(findings.length);
    const tool = buildTools(store, {}).find((t) => t.name === 'check')!;
    expect(JSON.parse((tool.handler({}) as { content: { text: string }[] }).content[0].text)).toEqual(findings);
  });
});

describe('collectFindings: wireframe rules (W7)', () => {
  /** io-shop copy: io/ with one screen file, so the other three screens give wireframe-missing. */
  const shop = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-collect-wf-')));
  fs.cpSync(path.join(FIX, 'io-shop'), shop, { recursive: true });
  const isWire = (f: { rule: string }) => f.rule.startsWith('wireframe-');

  it('the plan list carries the wireframe findings sorted in with checkPlan (b615), and the result the load', () => {
    const r = runCheck(shop, {}, {})!;
    const c = collectFindings(shop, tryResolveProject(shop), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(shop, r.config).dir, config: r.config });
    expect(c.plan.filter(isWire).length).toBeGreaterThan(0);
    expect(c.plan).toEqual([...c.plan].sort(compareFindings));
    expect(c.wireframes).toMatchObject({ status: 'ok', hasIo: true, io: 'c4/io' });
    expect(c.all).toEqual(r.findings);
  });

  it('no plan: wireframes is null', () => {
    const r = runCheck(shop, {}, {})!;
    const c = collectFindings(shop, null, null, r.snapshot, { today: TODAY, planDir: findPlan(shop, r.config).dir, config: r.config });
    expect(c.wireframes).toBeNull();
    expect(c.plan).toEqual([]);
  });

  it('status totals = check totals, MCP check = CLI check, with a wireframe finding present', () => {
    const findings = runCheck(shop, {}, {})!.findings;
    expect(findings.some(isWire)).toBe(true);
    const status = runStatus(shop, {}).plan as { critical: number; warning: number; info: number };
    expect(total(status)).toBe(findings.length);
    const tool = buildTools(shop, {}).find((t) => t.name === 'check')!;
    expect(JSON.parse((tool.handler({}) as { content: { text: string }[] }).content[0].text)).toEqual(findings);
  });

  it('minSeverity warning drops the info wireframe findings', () => {
    expect(runCheck(shop, {}, { minSeverity: 'warning' })!.findings.filter(isWire)).toEqual([]);
  });
});

describe('collectFindings: s-item rules (Phase 25 T7)', () => {
  /** sim-shop copy: its anchor holds sim/s-1..3.json with warning and info sim findings. */
  const simShop = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-collect-sim-')));
  fs.cpSync(path.join(FIX, 'sim-shop'), simShop, { recursive: true });
  afterAll(() => fs.rmSync(simShop, { recursive: true, force: true }));
  const isSim = (f: { rule: string }) => f.rule.startsWith('sim-');
  const collect = (minSeverity?: 'warning') => {
    const r = runCheck(simShop, {}, {})!;
    return { r, c: collectFindings(simShop, tryResolveProject(simShop), r.plan, r.snapshot, { today: TODAY, minSeverity, planDir: findPlan(simShop, r.config).dir, config: r.config }) };
  };

  it('sim findings join, sorted by severity with plan, board, then sims inside a severity; simData holds the items', () => {
    const { r, c } = collect();
    expect(c.sims.length).toBeGreaterThan(0);
    expect(c.sims).toEqual([...c.sims].sort(compareFindings));
    expect(c.simData?.map((s) => s.id)).toEqual(['s-1', 's-2', 's-3']);   // s-3's unknown key is a note: it still loads
    expect(c.all.length).toBe(c.plan.length + c.board.length + c.sims.length);
    const rank = ['critical', 'warning', 'info'];
    const ranks = c.all.map((f) => rank.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const sev of rank) {
      const inSev = c.all.filter((f) => f.severity === sev);
      expect(inSev).toEqual([...c.plan, ...c.board, ...c.sims].filter((f) => f.severity === sev));
    }
    expect(r.findings).toEqual(c.all);
  });

  it('minSeverity cuts the sim findings too', () => {
    const { c } = collect('warning');
    expect(c.sims.length).toBeGreaterThan(0);
    expect(c.all.filter(isSim).every((f) => f.severity === 'warning')).toBe(true);
  });

  it('no sim folder: sims empty, simData null', () => {
    const plain = repoWithBoard(null);
    const r = runCheck(plain, {}, {})!;
    const c = collectFindings(plain, tryResolveProject(plain), r.plan, r.snapshot, { today: TODAY, planDir: findPlan(plain, r.config).dir, config: r.config });
    expect(c.sims).toEqual([]);
    expect(c.simData).toBeNull();
  });
});
