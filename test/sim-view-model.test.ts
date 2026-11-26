import { buildViewSims, type SimRefKeys, type ViewSimsInput } from '../src/view/simModel';
import { storageModel, CLASSES } from './helpers/storage-view';
import { simModel } from './helpers/sim-view';
import type { PlanFinding, SimItem, SimStep, ViewKind, ViewModel, ViewNode, ViewSim } from '../src/types';

// Phase 25 (S4, UI1 b751): the page's s-items, resolved in the three view trees (UI_TASKS.md B1 rules 1-7). Pure: the
// sample model (nav-view sample + Drizzle storage view) with a few uids, a planId, a person, an external and an IO part
// added, hand-made s-items and a keysOf table standing in for the engine's resolver.

const ROUTES = 'api/src/routes/orders.ts#orderRoutes';
const CHARGE = 'api/src/payments/stripe.ts#charge';

/** ref -> keys, as page build's keysOf would give them; a ref not in the table resolves to nothing. */
const KEYS: Record<string, SimRefKeys> = {
  'u-api': { uid: 'u-api', ids: ['sample.api'] },
  'u-cart': { uid: 'u-cart', ids: ['shop.web.cart'] },
  'u-web': { uid: 'u-web', ids: ['shop.web'] },                               // one test puts it on both web trees (arch and IO)
  'u-classes': { uid: 'u-classes', ids: [CLASSES] },
  'sample.api.services': { uid: null, ids: ['sample.api.services'] },          // plan hit without a uid: the fqn finds the planId
  [ROUTES]: { uid: null, ids: [ROUTES] },                                       // code hit
  [CHARGE]: { uid: null, ids: [CHARGE] },
  'sample.api.planned': { uid: 'u-planned', ids: ['sample.api.planned'] },     // a plan element with no node
  'shop.web.cart.checkout': { uid: null, ids: ['shop.web.cart.checkout'] },
  'shop.web.home': { uid: 'u-home', ids: ['shop.web.home'] },
  customer: { uid: 'u-customer', ids: ['sample.customer'] },
  'sample.bank': { uid: null, ids: ['sample.bank'] },
  [CLASSES]: { uid: null, ids: [CLASSES] },
};

function node(id: string, kind: ViewKind, name: string, children: ViewNode[] = [], extra: Partial<ViewNode> = {}): ViewNode {
  return { id, kind, name, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra };
}

/** The sample with: uid u-api on the arch container api, planId on Services, uid u-classes on the record, a person and an external beside the system, a control part under the Cart screen. */
function model(): ViewModel {
  const m = storageModel();
  const api = m.root.children.find((c) => c.id === 'api')!;
  api.uid = 'u-api';
  api.children.find((c) => c.id === 'api/services')!.planId = 'sample.api.services';
  m.storageView!.root.children[0].children[0].children.find((r) => r.id === CLASSES)!.uid = 'u-classes';
  m.root.children.push(node('sample.customer', 'person', 'Customer', [], { uid: 'u-customer' }), node('sample.bank', 'external', 'Bank'));
  const cart = m.navView!.root.children[0].children.find((s) => s.id === 'shop.web.cart')!;
  cart.children.push(node('shop.web.cart.checkout', 'control' as string as ViewKind, 'Checkout button'));
  return m;
}

const step = (target: string[], view: SimStep['view'], extra: Partial<SimStep> = {}): SimStep => ({ target, view, ...extra });
const flow = (id: string, steps: SimStep[], extra: Partial<SimItem> = {}): SimItem => ({ schemaVersion: 1, id, kind: 'flow', title: id, steps, ...extra });

function build(items: SimItem[], findings: PlanFinding[] = [], m: ViewModel = model(), keys: Record<string, SimRefKeys> = KEYS): ViewSim[] {
  const input: ViewSimsInput = { items, findings, fileOf: (id) => `.c4pm/projects/shop/sim/${id}.json`, keysOf: (ref) => keys[ref] ?? null };
  return buildViewSims(m, input);
}

describe('buildViewSims: targets (rules 1-5)', () => {
  test('a uid hits the node in each tree; the target carries uid, nodeId, view, kind and name', () => {
    const [sim] = build([flow('s-1', [step(['u-api'], 'arch'), step(['u-cart'], 'io'), step(['u-classes'], 'storage')])]);
    expect(sim.steps.map((s) => s.targets[0])).toEqual([
      { ref: 'u-api', uid: 'u-api', nodeId: 'api', view: 'arch', name: 'Api', kind: 'container', entryId: null, lane: 'api' },
      { ref: 'u-cart', uid: 'u-cart', nodeId: 'shop.web.cart', view: 'io', name: 'Cart', kind: 'screen', entryId: 'shop.web.cart', lane: 'shop.web' },
      { ref: 'u-classes', uid: 'u-classes', nodeId: CLASSES, view: 'storage', name: 'classes', kind: 'record', entryId: null, lane: 'app.api' },
    ]);
    expect(sim.steps.every((s) => s.missing === undefined)).toBe(true);
  });

  test('an fqn finds the node by planId; a code key finds the scanned function, named Component.name, lane = its container', () => {
    const [sim] = build([flow('s-1', [step(['sample.api.services', ROUTES], 'arch')])]);
    const [services, routes] = sim.steps[0].targets;
    expect(services).toMatchObject({ nodeId: 'api/services', uid: null, view: 'arch', name: 'Services', kind: 'component', lane: 'api' });
    expect(routes).toMatchObject({ nodeId: ROUTES, uid: null, name: 'Routes.orderRoutes', kind: 'function', lane: 'api' });
    expect(sim.lanes.find((l) => l.id === 'api')).toEqual({ id: 'api', name: 'Api', sub: 'container · Node.js / TypeScript', kind: 'container', rank: 2 });
  });

  test('a ref that resolves to nothing: nodeId null, the step view, the ref as name, listed in missing; a plan element with no node is not missing', () => {
    const [sim] = build([flow('s-1', [step(['nowhere', 'sample.api.planned'], 'io')])]);
    const [gone, planned] = sim.steps[0].targets;
    expect(gone).toEqual({ ref: 'nowhere', uid: null, nodeId: null, view: 'io', name: 'nowhere', kind: '', entryId: null, lane: null });
    expect(planned).toMatchObject({ uid: 'u-planned', nodeId: null, lane: null });
    expect(sim.steps[0].missing).toEqual(['nowhere']);
  });

  test('an IO node with no arch match gets a lane of its group; with a matching arch uid it runs in that arch container', () => {
    const [sim] = build([flow('s-1', [step(['u-cart'], 'io')])]);
    expect(sim.lanes.find((l) => l.id === 'shop.web')).toEqual({ id: 'shop.web', name: 'Web app', sub: 'container', kind: 'container', rank: 2 });   // the only container: first use, rank 2
    const m = model();
    m.navView!.root.children[0].uid = 'u-web';
    m.root.children.find((c) => c.id === 'web')!.uid = 'u-web';
    const [linked] = build([flow('s-1', [step(['u-cart'], 'io')])], [], m);
    expect(linked.steps[0].targets[0].lane).toBe('web');
    expect(linked.lanes.map((l) => l.id)).toEqual(['person', 'web']);   // the person: step 1's derived arrow starts there
  });

  test('an IO group or storage zone with no uid whose id resolves through keysOf to an arch uid runs in that arch lane; no extra lane', () => {
    // The demo case (b751 follow-up): the merged scanned container `web` carries the plan uid of `shop.web` but neither
    // its id nor a planId, so only the plan resolution of the group id finds it. The same for the storage zone `app.api`.
    const m = model();
    m.root.children.find((c) => c.id === 'web')!.uid = 'u-web';
    expect(m.navView!.root.children[0]).toMatchObject({ id: 'shop.web' });
    expect(m.navView!.root.children[0].uid).toBeUndefined();
    const keys = { ...KEYS, 'shop.web': { uid: 'u-web', ids: ['shop.web'] }, 'app.api': { uid: 'u-api', ids: ['app.api'] } };
    const [sim] = build([flow('s-1', [step(['u-cart'], 'io'), step(['u-classes'], 'storage')])], [], m, keys);
    expect(sim.steps.map((s) => s.targets[0].lane)).toEqual(['web', 'api']);
    expect(sim.lanes.map((l) => l.id)).toEqual(['person', 'web', 'api']);   // first use: web (step 1) before api, though api is first in the arch tree
    expect(sim.steps.map((s) => s.call && [s.call.fromLane, s.call.toLane])).toEqual([['person', 'web'], ['web', 'api']]);
  });

  test('a uid in both arch and IO: an io step lights the IO node, an arch step the arch node, a storage step falls back to B1 order (arch); calls stay arch', () => {
    const m = model();
    m.navView!.root.children[0].uid = 'u-web';
    m.root.children.find((c) => c.id === 'web')!.uid = 'u-web';
    const [sim] = build([flow('s-1', [
      step(['u-web'], 'io', { call: { from: 'u-web' } }), step(['u-web'], 'arch'), step(['u-web'], 'storage'),
    ])], [], m);
    expect(sim.steps.map((s) => [s.targets[0].nodeId, s.targets[0].view])).toEqual([['shop.web', 'io'], ['web', 'arch'], ['web', 'arch']]);
    expect(sim.steps.every((s) => s.targets[0].lane === 'web')).toBe(true);
    expect(sim.steps[0].call).toMatchObject({ from: 'web', fromLane: 'web' });
  });

  test('an IO part: entryId = its screen, a control is named Screen › Control without " button"', () => {
    const [sim] = build([flow('s-1', [step(['shop.web.cart.checkout'], 'io')])]);
    expect(sim.steps[0].targets[0]).toMatchObject({ nodeId: 'shop.web.cart.checkout', entryId: 'shop.web.cart', name: 'Cart › Checkout', lane: 'shop.web' });
  });

  test('rows resolve to the storage record with its PK columns; a key that is no record is missing', () => {
    const rows = [{ id: 'c-1', name: 'A' }];
    const [sim] = build([flow('s-1', [step(['u-api'], 'arch', { rows: { 'u-classes': rows, 'u-api': [], gone: [] } })])]);
    expect(sim.steps[0].rows).toEqual([
      { ref: 'u-classes', recordId: CLASSES, name: 'classes', pk: ['id'], rows },
      { ref: 'u-api', recordId: null, name: 'u-api', pk: [], rows: [] },
      { ref: 'gone', recordId: null, name: 'gone', pk: [], rows: [] },
    ]);
    expect(sim.steps[0].rows![0].rows[0]).not.toBe(rows[0]);
    expect(sim.steps[0].missing).toEqual(['u-api', 'gone']);
  });
});

describe('buildViewSims: calls, person, lanes, views (rules 3, 6, QF3)', () => {
  test('derived calls: step 1 from the person, then from the previous step\'s last target lane to this step\'s first; reply when it goes to the person', () => {
    const [sim] = build([flow('s-1', [step(['u-cart'], 'io'), step([ROUTES, 'u-classes'], 'arch'), step(['customer'], 'arch')], { person: 'customer' })]);
    expect(sim.steps.map((s) => s.call)).toEqual([
      { from: 'sample.customer', to: 'shop.web', fromLane: 'sample.customer', toLane: 'shop.web', label: '', reply: false },
      { from: 'shop.web', to: 'api', fromLane: 'shop.web', toLane: 'api', label: '', reply: false },
      { from: 'app.api', to: 'sample.customer', fromLane: 'app.api', toLane: 'sample.customer', label: '', reply: true },
    ]);
  });

  test('a call in the file: ends resolved in the arch tree to node ids, label and reply kept; an absent end is derived; an unresolved end is missing', () => {
    const [sim] = build([flow('s-1', [
      step([CHARGE], 'arch', { call: { from: ROUTES, to: CHARGE, label: 'charge(12.00)' } }),
      step(['u-api'], 'arch', { call: { from: 'nowhere', label: 'back', reply: true } }),
      step(['u-api'], 'arch', { call: { from: 'u-cart' } }),   // an IO node is no arch end: derived
    ])]);
    expect(sim.steps[0].call).toEqual({ from: ROUTES, to: CHARGE, fromLane: 'api', toLane: 'api', label: 'charge(12.00)', reply: false });
    expect(sim.steps[1].call).toEqual({ from: 'api', to: 'api', fromLane: 'api', toLane: 'api', label: 'back', reply: true });
    expect(sim.steps[1].missing).toEqual(['nowhere']);
    expect(sim.steps[2].call).toMatchObject({ from: 'api', fromLane: 'api' });
    expect(sim.steps[2].missing).toBeUndefined();
  });

  test('person: a plan person gives its node id and lane; free text gives nodeId null and a lane named by the text', () => {
    const [planPerson, freeText] = build([
      flow('s-1', [step(['u-api'], 'arch')], { person: 'customer' }),
      flow('s-2', [step(['u-api'], 'arch')], { person: 'Mai, a buyer' }),
    ]);
    expect(planPerson.person).toEqual({ text: 'customer', nodeId: 'sample.customer' });
    expect(planPerson.lanes[0]).toEqual({ id: 'sample.customer', name: 'Customer', sub: 'person', kind: 'person', rank: 0 });
    expect(freeText.person).toEqual({ text: 'Mai, a buyer', nodeId: null });
    expect(freeText.lanes[0]).toEqual({ id: 'person', name: 'Mai, a buyer', sub: 'person', kind: 'person', rank: 0 });
  });

  test('views in IO, arch, storage order; lanes by rank: person, outside, containers in first-use order, externals', () => {
    const items: SimItem[] = [{
      schemaVersion: 1, id: 's-3', kind: 'journey', title: 'J', stages: [
        { target: ['u-classes'], view: 'storage' },
        { outside: 'Email', channel: 'email' },
        { target: ['sample.bank', 'u-cart'], view: 'io' },
        { target: [ROUTES], view: 'arch' },
      ],
    }];
    const [sim] = build(items);
    expect(sim.views).toEqual(['io', 'arch', 'storage']);
    // play order reaches person, app.api, outside, sample.bank, shop.web, api: the containers keep that order (a fallback
    // lane is a container like any other), the external goes after them though step 3 reached it first
    expect(sim.lanes.map((l) => [l.id, l.rank])).toEqual([['person', 0], ['outside', 1], ['app.api', 2], ['shop.web', 3], ['api', 4], ['sample.bank', 5]]);
    expect(sim.lanes.find((l) => l.id === 'outside')!.sub).toBe('not modelled · email');
    expect(sim.lanes.find((l) => l.id === 'sample.bank')!.sub).toBe('external system');
  });

  test('lanes in the order the path first reaches them, not the arch order: per step the call from, the call to, then the targets', () => {
    const m = model();
    m.navView!.root.children[0].uid = 'u-web';
    m.root.children.find((c) => c.id === 'web')!.uid = 'u-web';
    const archOrder = m.root.children.filter((c) => c.kind === 'container').map((c) => c.id);
    expect(archOrder.indexOf('api')).toBeLessThan(archOrder.indexOf('web'));   // the arch tree has api before web
    const [sim] = build([flow('s-1', [step(['sample.bank'], 'arch'), step(['u-cart'], 'io'), step(['u-api'], 'arch')])], [], m);
    expect(sim.steps.map((s) => s.call && [s.call.fromLane, s.call.toLane])).toEqual([['person', 'sample.bank'], ['sample.bank', 'web'], ['web', 'api']]);
    expect(sim.lanes.map((l) => [l.id, l.rank])).toEqual([['person', 0], ['web', 2], ['api', 3], ['sample.bank', 4]]);
    // a call that names its ends ranks by them before the step's targets: api (from) before web (to and target)
    const [called] = build([flow('s-2', [step(['u-cart'], 'io', { call: { from: 'u-api', to: 'u-cart' } })])], [], m);
    expect(called.lanes.map((l) => l.id)).toEqual(['api', 'web']);
  });
});

describe('buildViewSims: journeys and findings (rule 7)', () => {
  const S1 = flow('s-1', [step(['u-cart'], 'io'), step([ROUTES], 'arch'), step([CHARGE], 'arch')], { person: 'customer' });
  const S2: SimItem = {
    schemaVersion: 1, id: 's-2', kind: 'journey', title: 'Spring sale buyer', person: 'customer', description: 'Three days', stages: [
      { name: 'Discover', outside: 'Email: sale', from: 'Newsletter tool', channel: 'email', goal: 'Find a gift', state: 'not signed in', caption: 'Mai gets the email.', durationSec: 4 },
      { name: 'Buy', flow: 's-1', goal: 'Buy the mug' },
      { flow: 's-9' },                                  // missing s-item: no steps
      { flow: 's-2' },                                  // itself (a journey): no steps
      { target: ['nowhere', 'sample.api.planned'], view: 'io', caption: 'inline' },
    ],
  };

  test('a journey plays its flow stages inline: one list numbered 1..N with stage, flow, inFlow and goal; stages give names and ranges', () => {
    const [, j] = build([S1, S2]);
    expect(j.steps.map((s) => [s.n, s.i, s.view, s.stage, s.flow, s.inFlow, s.goal])).toEqual([
      [1, 0, 'outside', 0, undefined, undefined, 'Find a gift'],
      [2, 1, 'io', 1, 's-1', 1, 'Buy the mug'],
      [3, 2, 'arch', 1, 's-1', 2, 'Buy the mug'],
      [4, 3, 'arch', 1, 's-1', 3, 'Buy the mug'],
      [5, 4, 'io', 4, undefined, undefined, undefined],
    ]);
    expect(j.stages).toEqual([
      { kind: 'outside', name: 'Discover', goal: 'Find a gift', firstStep: 0, stepCount: 1 },
      { kind: 'flow', name: 'Buy', goal: 'Buy the mug', flow: 's-1', firstStep: 1, stepCount: 3 },
      { kind: 'flow', name: 'Stage 3', flow: 's-9', firstStep: 4, stepCount: 0 },
      { kind: 'flow', name: 'Stage 4', flow: 's-2', firstStep: 4, stepCount: 0 },
      { kind: 'step', name: 'Stage 5', firstStep: 4, stepCount: 1 },
    ]);
    expect(j.steps[0]).toMatchObject({
      targets: [], outside: { text: 'Email: sale', from: 'Newsletter tool', channel: 'email' }, state: 'not signed in', caption: 'Mai gets the email.', durationSec: 4,
      call: { from: 'outside', to: 'sample.customer', fromLane: 'outside', toLane: 'sample.customer', label: '', reply: false },
    });
    expect(j.steps[1].call).toMatchObject({ from: 'sample.customer', to: 'shop.web' });   // after an outside step: from the person
    expect(j).toMatchObject({ id: 's-2', kind: 'journey', title: 'Spring sale buyer', description: 'Three days', file: '.c4pm/projects/shop/sim/s-2.json' });
  });

  test('findings, flow pair id s-1:N-M: marks its second step, in the flow and in the journey\'s inline copies', () => {
    const [f, j] = build([S1, S2], [
      { severity: 'info', rule: 'sim-step-unverified', id: 's-1:2-3', message: 'no resolved call orderRoutes -> charge' },
      { severity: 'info', rule: 'sim-step-unconnected', id: 's-1:1-2', message: 'no link Cart -> orderRoutes' },
      { severity: 'warning', rule: 'plan-rule', id: 's-1:2-3', message: 'ignored: not a sim step rule' },
    ]);
    expect(f.steps.map((s) => [s.unconnected, s.unverified])).toEqual([[undefined, undefined], ['no link Cart -> orderRoutes', undefined], [undefined, 'no resolved call orderRoutes -> charge']]);
    expect(j.steps[3].unverified).toBe('no resolved call orderRoutes -> charge');
    expect(j.steps[2].unconnected).toBe('no link Cart -> orderRoutes');
  });

  test('findings, flow step id s-1:N (sim-target-missing): the ref the message names joins missing, in the flow and its inline copy', () => {
    const [f, j] = build([S1, S2], [{ severity: 'warning', rule: 'sim-target-missing', id: 's-1:2', message: `target '${ROUTES}' resolves to nothing` }]);
    expect(f.steps.map((s) => s.missing)).toEqual([undefined, [ROUTES], undefined]);
    expect(j.steps[2].missing).toEqual([ROUTES]);
  });

  test('findings, journey stage id s-2:stage-N (sim-target-missing): every step of stage N; the old s-2:N form is ignored', () => {
    const [, j] = build([S1, S2], [
      { severity: 'warning', rule: 'sim-target-missing', id: 's-2:stage-5', message: "target 'sample.api.planned' resolves to nothing" },
      { severity: 'warning', rule: 'sim-target-missing', id: 's-2:stage-2', message: `target '${ROUTES}' resolves to nothing` },
      { severity: 'warning', rule: 'sim-target-missing', id: 's-2:5', message: "target 'u-api' resolves to nothing" },
    ]);
    expect(j.steps[4].missing).toEqual(['nowhere', 'sample.api.planned']);   // 'nowhere' from keysOf, the other from the finding
    expect(j.steps.map((s) => s.missing)).toEqual([undefined, undefined, [ROUTES], undefined, ['nowhere', 'sample.api.planned']]);
  });

  test('findings, journey stage id s-2:stage-N (sim-stage-missing): not mapped, the stage plays no steps', () => {
    const plain = build([S1, S2]);
    const withFinding = build([S1, S2], [{ severity: 'warning', rule: 'sim-stage-missing', id: 's-2:stage-3', message: 'no s-item s-9' }]);
    expect(withFinding).toEqual(plain);
    expect(plain[1].stages![2]).toMatchObject({ flow: 's-9', stepCount: 0 });
  });

  test('a flow has no stages and stage 0 everywhere; the model and the items are not mutated', () => {
    const m = model();
    const before = JSON.stringify(m);
    const items = [S1, S2];
    const itemsBefore = JSON.stringify(items);
    const [f] = build(items, [], m);
    expect(f.stages).toBeUndefined();
    expect(f.steps.every((s) => s.stage === 0)).toBe(true);
    expect(JSON.stringify(m)).toBe(before);
    expect(JSON.stringify(items)).toBe(itemsBefore);
  });
});

describe('buildViewSims: flow depths (b853 S1)', () => {
  // Every step carries its boxes, arrow and merge key at the four C4 depths (step.at), every s-item its merge groups and
  // lanes per depth (sim.depth). Box rules: the b853 spec, section 1.
  const depths = ['context', 'container', 'component', 'code'] as const;
  const linked = (): { m: ViewModel; keys: Record<string, SimRefKeys> } => {
    const m = model();
    m.root.children.find((c) => c.id === 'web')!.uid = 'u-web';
    return { m, keys: { ...KEYS, 'shop.web': { uid: 'u-web', ids: ['shop.web'] }, 'app.api': { uid: 'u-api', ids: ['app.api'] } } };
  };

  test('io, storage and arch steps roll up per depth: groups merge consecutive equal boxes, lanes are the boxes of the depth', () => {
    const { m, keys } = linked();
    const [sim] = build([flow('s-1', [step(['u-cart'], 'io'), step(['u-classes'], 'storage'), step([ROUTES], 'arch')], { person: 'customer' })], [], m, keys);
    expect(depths.map((d) => sim.depth[d].groups)).toEqual([[[0, 1, 2]], [[0], [1, 2]], [[0], [1], [2]], [[0], [1], [2]]]);
    // context: the system box (the screen and the table run in containers of it), and the person
    expect(sim.depth.context.lanes.map((l) => [l.id, l.kind])).toEqual([['sample.customer', 'person'], ['sample-shop', 'system']]);
    expect(sim.steps[0].at.context).toEqual({ boxes: ['sample-shop'], from: 'sample.customer', to: 'sample-shop', key: 'sample-shop' });
    // container: today's lanes and arrows
    expect(sim.depth.container.lanes).toEqual(sim.lanes);
    expect(sim.steps.map((s) => s.at.container.boxes)).toEqual([['web'], ['api'], ['api']]);
    // component: an arch target shows its component, an io / storage target stays at its container
    expect(sim.steps.map((s) => s.at.component.boxes)).toEqual([['web'], ['api'], ['api/routes']]);
    // code: the screen's lane, the table, the function
    expect(sim.steps.map((s) => s.at.code.boxes)).toEqual([['web'], [CLASSES], [ROUTES]]);
    expect(sim.steps[1].at.code).toMatchObject({ from: 'web', to: CLASSES });
    expect(sim.steps[0].at.code.key).toBe('shop.web.cart');   // at code the key is the target node ids (the io screen, not its lane)
    const code = new Map(sim.depth.code.lanes.map((l) => [l.id, l]));
    expect(code.get(CLASSES)).toMatchObject({ kind: 'record', sub: 'table', name: 'classes' });
    expect(code.get(ROUTES)).toMatchObject({ kind: 'code', sub: 'function', name: 'Routes.orderRoutes' });
    expect(sim.depth.component.lanes.find((l) => l.id === 'api/routes')).toMatchObject({ kind: 'component', sub: 'component', name: 'Routes' });
  });

  test('today\'s fields stay: at container every arrow is call.fromLane > call.toLane, the lanes are sim.lanes, code groups are one per step', () => {
    for (const sim of simModel().sims!) {
      for (const s of sim.steps) expect([s.i, s.at.container.from, s.at.container.to]).toEqual([s.i, s.call!.fromLane, s.call!.toLane]);
      expect(sim.depth.container.lanes).toEqual(sim.lanes);
      expect(sim.depth.code.groups).toEqual(sim.steps.map((s) => [s.i]));
    }
  });

  test('helper fixture: s-1 groups per depth; journey s-2 never merges across a stage and keeps its outside steps single', () => {
    const [s1, s2] = simModel().sims!;
    expect(s1.depth.context.groups).toEqual([[0, 1], [2, 3], [4], [5], [6]]);   // the fallback lanes shop.web / app.api are their own box
    expect(s1.depth.container.groups).toEqual([[0, 1], [2, 3], [4], [5], [6]]);
    expect(s1.depth.component.groups).toEqual([[0, 1], [2], [3], [4], [5], [6]]);
    for (const d of depths) {
      const groups = s2.depth[d].groups;
      expect(groups.flat()).toEqual(s2.steps.map((s) => s.i));
      for (const g of groups) {
        expect(new Set(g.map((i) => s2.steps[i].stage)).size).toBe(1);
        if (g.some((i) => s2.steps[i].view === 'outside')) expect(g).toHaveLength(1);
      }
    }
    expect(s2.depth.container.groups).toEqual([[0], [1, 2], [3, 4], [5], [6], [7], [8]]);
    expect(s2.steps[0].at.container).toEqual({ boxes: [], from: 'outside', to: 'person', key: null });
  });

  test('a function in Shared is a container box (its lane stays null); a container under an external rolls up to that external', () => {
    const { m, keys } = linked();
    const HELPER = 'lib/x.ts#helper';
    m.root.children.push(node('sample-shop::shared', 'shared', 'Shared', [node(HELPER, 'function', 'helper')]));
    const bank = m.root.children.find((c) => c.id === 'sample.bank')!;
    bank.children.push(node('bank.ledger', 'container', 'Ledger', [node('bank.ledger/core', 'component', 'Core')]));
    const more = { ...keys, [HELPER]: { uid: null, ids: [HELPER] }, 'bank.ledger/core': { uid: null, ids: ['bank.ledger/core'] } };
    const [sim] = build([flow('s-1', [step([HELPER], 'arch'), step(['bank.ledger/core'], 'arch')])], [], m, more);
    expect(sim.steps[0].targets[0].lane).toBeNull();
    expect(depths.map((d) => sim.steps[0].at[d].boxes)).toEqual([['sample-shop'], ['sample-shop::shared'], ['sample-shop::shared'], [HELPER]]);
    expect(sim.depth.container.lanes.find((l) => l.id === 'sample-shop::shared')).toMatchObject({ kind: 'container', sub: 'Shared', name: 'Shared' });
    expect(sim.lanes.some((l) => l.id === 'sample-shop::shared')).toBe(false);
    expect(depths.map((d) => sim.steps[1].at[d].boxes)).toEqual([['sample.bank'], ['bank.ledger'], ['bank.ledger/core'], ['bank.ledger/core']]);
    expect(sim.depth.context.lanes.find((l) => l.id === 'sample.bank')).toMatchObject({ kind: 'external', sub: 'external system' });
  });
});
