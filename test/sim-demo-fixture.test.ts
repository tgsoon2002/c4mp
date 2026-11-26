import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { runCheck } from '../src/query/check';
import { forEachNode } from '../src/view/tree';
import { loadSims } from '../src/sim/load';
import { tryResolveProject } from '../src/outputs';
import type { Plan, PlanElement, ViewModel, ViewNode } from '../src/types';

// Phase 25 UI0 (b750): test/fixtures/sim-demo-shop is the demo's made-up Shop (Document/v0.9-simulations-demo.html) as a
// real repo: the page built from it shows the demo's Architecture, IO and Storage boxes, and it holds the demo's
// simulations s-1 (flow) and s-2 (journey). Project id 'shop' (package.json name 'Shop'), so the plan and the s-items
// live in .c4pm/projects/shop/. The code sits in api/, web/ and mobile/ (one package.json each) so the scanned
// containers merge with the plan containers of the same id; Payments has no code (s-1 step 8 stays unverified).

const FIXTURE = path.join(__dirname, 'fixtures', 'sim-demo-shop');
const SIM_DIR = path.join('.c4pm', 'projects', 'shop', 'sim');

/** Fixture copy in a fresh tmp folder with a `.git` marker, as makeRepo (test/helpers/planEditHarness.ts) does. */
function copyRepo(): string {
  const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-demo-'))), 'shop');
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

const nodesOf = (root: ViewNode): ViewNode[] => {
  const out: ViewNode[] = [];
  forEachNode(root, (n) => out.push(n));
  return out;
};

/** Every element ref an s-item names: step targets, call from/to and rows keys (journeys: their inline steps). */
interface SimJson { id: string; kind: string; person?: string; steps?: StepJson[]; stages?: (StepJson & { flow?: string; outside?: string })[] }
interface StepJson { target?: string | string[]; call?: { from?: string; to?: string }; rows?: Record<string, unknown[]> }
const refsOf = (sim: SimJson): string[] =>
  [...(sim.steps ?? []), ...(sim.stages ?? [])].flatMap((st) => [
    ...(st.target === undefined ? [] : ([] as string[]).concat(st.target)),
    ...(st.call?.from ? [st.call.from] : []),
    ...(st.call?.to ? [st.call.to] : []),
    ...Object.keys(st.rows ?? {}),
  ]);

describe('sim-demo-shop fixture (UI0 b750): the demo Shop as a repo', () => {
  let repo: string;
  let model: ViewModel;
  let plan: Plan;
  let byFqn: Map<string, PlanElement>;
  let byUid: Map<string, PlanElement>;
  let findings: { severity: string; rule: string; id: string }[];

  beforeAll(() => {
    repo = copyRepo();
    ({ model } = buildView({ repo }));
    const check = runCheck(repo, {}, {})!;   // the query behind `c4pm check --format json`
    plan = check.plan;
    findings = check.findings;
    byFqn = new Map(plan.elements.map((e) => [e.id, e]));
    byUid = new Map(plan.elements.filter((e) => e.metadata.uid).map((e) => [e.metadata.uid, e]));
  });
  afterAll(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

  it('arch: the persons and the external beside the system, the containers of the demo inside it', () => {
    expect(model.root.kind).toBe('context');
    const top = model.root.children;
    // C1 A1 (b828): the context is a holder; its children are the persons, the system, then the external (the demo's tree)
    expect(top.map((n) => n.id)).toEqual(['customer', 'staff', 'shop', 'payment_gateway']);
    expect(top.filter((n) => n.kind !== 'system').map((n) => [n.id, n.kind]).sort()).toEqual([
      ['customer', 'person'], ['payment_gateway', 'external'], ['staff', 'person'],
    ]);
    const system = top.find((n) => n.kind === 'system')!;
    expect(system.name).toBe('Shop');
    // Containers by the uid of their plan element (a container that merged with the scan keeps the scanned id, `api`).
    const containers = new Map(system.children.filter((n) => n.kind === 'container').map((n) => [n.uid, n]));
    const expected: [string, string, string][] = [
      ['shop.web', 'Web app', 'React'], ['shop.mobile', 'Shop mobile app', 'iOS / Android'], ['shop.api', 'API', 'Node.js (REST)'],
      ['shop.cli', 'shop-admin', 'Command line tool (CLI)'], ['shop.db', 'Shop DB', 'Postgres'], ['shop.docs', 'Events', 'MongoDB collection'],
      ['shop.files', 'Config', 'JSON file'],
    ];
    for (const [fqn, name, detail] of expected) {
      const node = containers.get(byFqn.get(fqn)!.metadata.uid);
      expect([fqn, node?.name, node?.detail]).toEqual([fqn, name, detail]);
    }
    // The api components (Payments planned, no code) and the planned function charge.
    const api = containers.get(byFqn.get('shop.api')!.metadata.uid)!;
    expect(api.children.map((c) => c.name).sort()).toEqual(['Auth', 'Cart', 'Catalog', 'Orders', 'Payments']);
    const payments = api.children.find((c) => c.name === 'Payments')!;
    expect([payments.origin!.kind, payments.children.map((c) => [c.id, c.kind])]).toEqual(['plan', [['shop.api.payments.charge', 'function']]]);
  });

  it('IO: 7 screens of the web app, and the CLI, API and MCP entries', () => {
    const groups = model.nav!.groups;
    const entries = (fqn: string) => groups.find((g) => g.fqn === fqn)!.entries.map((e) => [e.kind, e.fqn]);
    expect(entries('shop.web')).toEqual(
      ['login', 'home', 'products', 'product', 'cart', 'checkout', 'confirmation'].map((s) => ['screen', `shop.web.${s}`]));
    expect(groups.find((g) => g.fqn === 'shop.web')!.entries.every((e) => e.wireframe && !e.wireframe.error)).toBe(true);
    expect(entries('shop.cli')).toEqual([['command', 'shop.cli.import'], ['command', 'shop.cli.report']]);
    expect(entries('shop.api')).toEqual([['route', 'shop.api.get_products'], ['route', 'shop.api.post_orders']]);
    expect(entries('shop.mcp')).toEqual([['tool', 'shop.mcp.find_product']]);
    expect(groups.map((g) => g.word)).toEqual(['App', 'CLI', 'API', 'MCP']);
    expect(model.nav!.edges.length).toBe(8);   // the 8 navigations of the demo (Sign in, Shop now, Open, ...)
  });

  it('storage: the seven Shop DB tables read from db/migrations (both), Events and config.json plan only', () => {
    const records = nodesOf(model.storageView!.root).filter((n) => n.kind === 'record');
    expect(records.map((r) => [r.id, r.storage!.origin])).toEqual([
      ...['customers', 'products', 'orders', 'order_items', 'payments', 'addresses', 'categories'].map((t) => [`shop.db.main.${t}`, 'both']),
      ['shop.docs.events.events', 'plan'],
      ['shop.files.config.config_json', 'plan'],
    ]);
  });

  it('s-1 and s-2: file name = id, and every target, call end and rows key is a plan uid or fqn', () => {
    // loadSims (T1) reads both files as written: two items, no issue, no note (no unknown key).
    const loaded = loadSims(tryResolveProject(repo));
    expect([loaded.dir, loaded.fileIds, loaded.items.map((s) => s.id), loaded.issues, loaded.notes])
      .toEqual([path.join(repo, SIM_DIR), ['s-1', 's-2'], ['s-1', 's-2'], [], []]);
    const sims = loaded.items as unknown as SimJson[];
    expect(sims.map((s) => [s.id, s.kind, s.person])).toEqual([['s-1', 'flow', 'customer'], ['s-2', 'journey', 'customer']]);
    expect(byFqn.get('customer')!.kind).toBe('person');
    expect(sims[0].steps).toHaveLength(9);
    expect(sims[1].stages!.map((st) => st.flow ?? st.outside)).toEqual(['Email: "Spring sale, mugs -20%"', 's-1', 'Email: "Your order is on its way"']);
    const refs = sims.flatMap(refsOf);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((r) => !byUid.has(r) && !byFqn.has(r));
    expect(missing).toEqual([]);
    // uid where the element has one: an fqn ref is only used for an element without a uid (the planned-code functions).
    expect(refs.filter((r) => byFqn.has(r) && byFqn.get(r)!.metadata.uid)).toEqual([]);
    // rows keys are the record uids of orders and order_items
    const rowKeys = sims[0].steps!.flatMap((st) => Object.keys(st.rows ?? {}));
    expect([...new Set(rowKeys.map((k) => byUid.get(k)!.id))]).toEqual(['shop.db.main.orders', 'shop.db.main.order_items']);
  });

  it('check: no critical finding (the two plan-only stores warn, the planned charge is info)', () => {
    expect(findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(findings.filter((f) => !f.rule.startsWith('sim-')).map((f) => [f.severity, f.rule, f.id])).toEqual([
      ['warning', 'missing-store', 'shop.docs.events'],
      ['warning', 'missing-store', 'shop.files.config'],
      ['info', 'planned-not-built', 'shop.api.payments.charge'],
    ]);
  });

  it('check: the sim findings of the demo, one sim-step-unverified on s-1 steps 7-8 (placeOrder -> the planned charge)', () => {
    const sim = findings.filter((f) => f.rule.startsWith('sim-'));
    // The demo (Document/Roadmap/Phase25/demo-lines-ref.html SIMS) marks only step 8 unverified. T8 reads every call
    // because steps 7-8 are function -> function, so the planned charge (no code) is judged.
    expect(sim.filter((f) => f.rule !== 'sim-step-unconnected')).toEqual([{
      severity: 'info', rule: 'sim-step-unverified', id: 's-1:7-8',
      message: 's-1 steps 7-8: shop.api.payments.charge has no code yet (planned only), so the call from shop.api.orders.placeOrder to shop.api.payments.charge cannot be checked',
    }]);
    // b783: connected through call.from (cart_store, router). Steps 2-3 and 6-7 go from a control to the api; the plan has
    // no relation from the control (or its screen) to the api, but step 3 / 7 has a call from shop.web.cart_store /
    // shop.web.router (same container as the screen) and the plan relates it to shop.api.cart.addItem /
    // shop.api.orders.placeOrder, under / at the step target. Like the demo: no unconnected step.
    expect(sim.filter((f) => f.rule === 'sim-step-unconnected').map((f) => f.id)).toEqual([]);
  });

  it('flow depths (b853 S1): s-1 merges per depth inside one stage; every depth lane is a box or arrow end a step uses', () => {
    const [s1, s2] = model.sims!;
    expect(s1.depth.context.groups).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8]]);   // all inside the system Shop
    expect(s1.depth.container.groups).toEqual([[0, 1], [2, 3], [4], [5], [6, 7], [8]]);   // web, api, Shop DB, web, api, web
    expect(s1.depth.component.groups).toEqual([[0, 1], [2, 3], [4], [5], [6], [7], [8]]);   // Cart twice; Orders, then Payments
    // code: the key is the target node ids, so step 2 (the Add to cart control) stays apart from step 1 (its Product screen)
    expect(s1.depth.code.groups).toEqual([[0], [1], [2], [3], [4], [5], [6], [7], [8]]);
    expect(s2.depth.code.groups).toHaveLength(11);
    // the storage step's arrow ends in its table: the call goes to the Shop DB store, the first target's container
    expect(s1.steps[4].at.code).toMatchObject({ boxes: ['shop.db.main.orders', 'shop.db.main.order_items'], to: 'shop.db.main.orders' });
    for (const sim of [s1, s2]) {
      for (const d of ['context', 'container', 'component', 'code'] as const) {
        const groups = sim.depth[d].groups;
        expect(groups.flat()).toEqual(sim.steps.map((s) => s.i));   // consecutive, every step once
        for (const g of groups) expect(new Set(g.map((i) => sim.steps[i].stage)).size).toBe(1);
        const used = new Set(sim.steps.flatMap((s) => [s.at[d].from, s.at[d].to, ...s.at[d].boxes]));
        expect(sim.depth[d].lanes.filter((l) => !used.has(l.id) && l.kind !== 'person').map((l) => l.id)).toEqual([]);
      }
      expect(sim.depth.container.lanes).toEqual(sim.lanes);
      expect(sim.depth.code.groups).toEqual(sim.steps.map((s) => [s.i]));   // Code = today's page: one group per step
      for (const s of sim.steps) expect([s.at.container.from, s.at.container.to]).toEqual([s.call!.fromLane, s.call!.toLane]);
    }
  });
});
