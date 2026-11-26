import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallIndex, CallSite } from '../src/callGraph/callResolve';
import type { CodeElement, Plan, PlanElement, PlanFinding, PlanLink, SimItem, SimStep, Snapshot } from '../src/types';
import { resolveSimTarget } from '../src/sim/resolve';
import { checkSims, SIM_CALL_HOPS, type SimCheckContext } from '../src/sim/check';
import { simsForCheck } from '../src/sim/run';
import { tryResolveProject } from '../src/outputs';
import { runCli } from './helpers/runCli';

// Phase 25 T7 (b703): the s-item check rules on a built Plan and call index (pure), then the sim-shop fixture end to end.

const SRC = { file: 'a.c4', line: 1 };
const lnk = (raw: string): PlanLink => {
  const [p, n] = raw.split('#');
  return { raw, path: p, name: n ?? null, lines: null, title: null };
};
const el = (id: string, kind: string, opts: { links?: string[]; uid?: string } = {}): PlanElement => ({
  id, kind, title: id.slice(id.lastIndexOf('.') + 1), description: null, technology: null,
  links: (opts.links ?? []).map(lnk), metadata: opts.uid ? { uid: opts.uid } : {},
  parent: id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null, source: SRC,
});
const rel = (from: string, to: string) => ({ from, to, label: null, source: SRC });

const PLAN: Plan = {
  files: ['a.c4'],
  elements: [
    el('shop', 'system'),
    el('shop.web', 'container'),
    el('shop.web.home', 'screen', { uid: 'u-home' }),
    el('shop.web.home.menu', 'region'),
    el('shop.web.home.menu.go', 'control', { uid: 'u-go' }),
    el('shop.web.list', 'screen'),
    el('shop.web.list.pick', 'control'),
    el('shop.web.list.buy', 'control'),
    el('shop.web.alone', 'screen'),
    el('shop.api', 'container'),
    el('shop.api.cart', 'component', { links: ['src/cart.ts'] }),
    el('shop.api.cart.add', 'function', { links: ['src/cart.ts#add'] }),
    el('shop.api.orders', 'component', { links: ['src/orders/'] }),
    el('shop.api.orders.create', 'function', { links: ['src/orders/create.ts#create'] }),
    el('shop.api.orders.refund', 'function'),
    el('shop.api.db', 'store'),
    el('shop.api.db.orders', 'record', { uid: 'u-ord' }),
  ],
  relations: [
    rel('shop.web.home.menu.go', 'shop.web.list'),
    rel('shop.web.list.pick', 'shop.api.cart'),
    rel('shop.web.list.buy', 'shop.api.orders.create'),
  ],
  issues: [],
};

const code = (key: string, kind = 'function'): [string, CodeElement] =>
  [key, { name: key.slice(key.indexOf('#') + 1), kind, startLine: 1, endLine: 2, lineCount: 2 } as CodeElement];
const edge = (from: string, to: string, line = 1): CallSite => {
  const [file, caller] = from.split('#');
  const [tf, tn] = to.split('#');
  return { file, caller, line, callee: tn, verdict: { kind: 'edge', file: tf, name: tn } };
};
const untraced = (from: string, callee: string, line: number): CallSite => {
  const [file, caller] = from.split('#');
  return { file, caller, line, callee, verdict: { kind: 'unresolved' } };
};

// a -> b -> c -> d -> e (src/pay.ts); create has an untraced `svc.charge` call; Pay.charge is a method.
const INDEX: CallIndex = {
  elements: new Map([
    code('src/cart.ts#add'), code('src/orders/create.ts#create'), code('src/pay.ts#a'), code('src/pay.ts#b'),
    code('src/pay.ts#c'), code('src/pay.ts#d'), code('src/pay.ts#e'), code('src/pay.ts#Pay.charge', 'method'),
    code('src/pay.ts#Pay', 'class'),
  ]),
  sites: [
    edge('src/pay.ts#a', 'src/pay.ts#b'), edge('src/pay.ts#b', 'src/pay.ts#c'), edge('src/pay.ts#c', 'src/pay.ts#d'),
    edge('src/pay.ts#d', 'src/pay.ts#e'), untraced('src/orders/create.ts#create', 'svc.charge', 7),
  ],
};
const CTX: SimCheckContext = { plan: PLAN, code: INDEX, callFiles: new Set(['src/pay.ts', 'src/orders/create.ts', 'src/cart.ts']) };

const step = (target: string | string[], more: Partial<SimStep> = {}): SimStep =>
  ({ target: Array.isArray(target) ? target : [target], view: 'arch', ...more });
const flow = (id: string, steps: SimStep[]): SimItem => ({ schemaVersion: 1, id, kind: 'flow', title: id, steps });
/** checkSims of one flow of the given targets. */
const pairs = (targets: (string | string[])[], ctx: SimCheckContext = CTX): PlanFinding[] => checkSims([flow('s-1', targets.map((t) => step(t)))], ctx);
const rules = (fs: PlanFinding[]) => fs.map((f) => `${f.rule} ${f.id}`);

describe('resolveSimTarget (T7)', () => {
  it.each([
    ['uid', 'u-go', 'plan shop.web.home.menu.go'],
    ['fqn', 'shop.web.list', 'plan shop.web.list'],
    ['fqn of a planned function (not a c-item kind)', 'shop.api.orders.refund', 'plan shop.api.orders.refund'],
    ['code path#name', 'src/pay.ts#a', 'code src/pay.ts#a'],
    ['a title is not a stored ref', 'list', 'missing'],
    ['nothing', 'nope', 'missing'],
  ])('%s', (_name, ref, want) => {
    const hit = resolveSimTarget(ref, PLAN, INDEX.elements);
    expect(hit.kind === 'plan' ? `plan ${hit.el.id}` : hit.kind === 'code' ? `code ${hit.key}` : 'missing').toBe(want);
  });
  it('a function element carries its code key; others none; no plan and no code: missing', () => {
    expect(resolveSimTarget('shop.api.cart.add', PLAN, null)).toMatchObject({ kind: 'plan', code: 'src/cart.ts#add' });
    expect(resolveSimTarget('shop.api.cart', PLAN, null)).toMatchObject({ kind: 'plan', code: null });
    expect(resolveSimTarget('src/pay.ts#a', null, null)).toEqual({ kind: 'missing' });
  });
  it('b899: the uid of a planned function resolves it, with its code key', () => {
    const plan: Plan = {
      ...PLAN,
      elements: PLAN.elements.map((e) => (e.id === 'shop.api.cart.add' ? el(e.id, 'function', { links: ['src/cart.ts#add'], uid: 'u-fn-add' }) : e)),
    };
    expect(resolveSimTarget('u-fn-add', plan, null)).toMatchObject({ kind: 'plan', el: { id: 'shop.api.cart.add' }, code: 'src/cart.ts#add' });
    expect(resolveSimTarget('u-go', PLAN, null)).toMatchObject({ kind: 'plan', el: { id: 'shop.web.home.menu.go' } });
  });
});

describe('checkSims: sim-target-missing (T7, QF1, Q3, Q7)', () => {
  it('a target, call.from, call.to and rows keys (missing, not a record, code) of a step; id s-1:<step>', () => {
    const item = flow('s-1', [
      step('u-home'),
      step(['shop.web.list', 'gone'], {
        call: { from: 'ghost', to: 'shop.web.list', label: 'x' },
        rows: { 'u-ord': [], nope: [], 'shop.api.cart': [], 'src/pay.ts#a': [] },
      }),
      step('u-home', { call: { to: 'missing-to' } }),
    ]);
    const out = checkSims([{ ...item, person: 'not a plan person' }], CTX);
    expect(out.map((f) => [f.rule, f.severity, f.id, f.message])).toEqual([
      ['sim-target-missing', 'warning', 's-1:2', "s-1 step 2: target 'gone' resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)"],
      ['sim-target-missing', 'warning', 's-1:2', "s-1 step 2: call.from 'ghost' resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)"],
      ['sim-target-missing', 'warning', 's-1:2', "s-1 step 2: rows key 'nope' names no record (no plan element has this uid or fqn)"],
      ['sim-target-missing', 'warning', 's-1:2', "s-1 step 2: rows key 'shop.api.cart' is the component shop.api.cart, not a record"],
      ['sim-target-missing', 'warning', 's-1:2', "s-1 step 2: rows key 'src/pay.ts#a' is code, not a plan record"],
      ['sim-target-missing', 'warning', 's-1:3', "s-1 step 3: call.to 'missing-to' resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)"],
    ]);
  });
  it('an inline journey stage: id s-2:stage-<n>; outside stages and person are free text', () => {
    const journey: SimItem = { schemaVersion: 1, id: 's-2', kind: 'journey', title: 'j', person: 'anyone', stages: [
      { outside: 'Sees an ad', from: 'a friend', channel: 'email' },
      { ...step('nope'), goal: 'x' },
      { ...step('u-home') },
    ] };
    expect(rules(checkSims([journey], CTX))).toEqual(['sim-target-missing s-2:stage-2']);
  });
});

describe('checkSims: sim-stage-missing (T7)', () => {
  it('a flow stage naming nothing, a journey, or itself; a flow is fine', () => {
    const j: SimItem = { schemaVersion: 1, id: 's-2', kind: 'journey', title: 'j', stages: [
      { flow: 's-1' }, { flow: 's-9' }, { flow: 's-3' }, { flow: 's-2' },
    ] };
    const other: SimItem = { schemaVersion: 1, id: 's-3', kind: 'journey', title: 'k', stages: [] };
    expect(checkSims([flow('s-1', []), j, other], CTX).map((f) => [f.severity, f.id, f.message])).toEqual([
      ['warning', 's-2:stage-2', "s-2 stage 2: flow 's-9' names no s-item"],
      ['warning', 's-2:stage-3', "s-2 stage 3: flow 's-3' is a journey, not a flow"],
      ['warning', 's-2:stage-4', "s-2 stage 4: flow 's-2' is this journey itself"],
    ]);
  });
});

describe('checkSims: pair 1, io -> io entry (navigation)', () => {
  it.each([
    ['a part with a relation to the screen', ['u-go', 'shop.web.list']],
    ['a screen whose part has the relation', ['u-home', 'shop.web.list']],
    ['a part to its own screen (same owning entry)', ['u-go', 'u-home']],
  ])('connected: %s', (_n, targets) => {
    expect(pairs(targets)).toEqual([]);
  });
  it('no relation: sim-step-unconnected, id s-1:1-2', () => {
    expect(pairs(['shop.web.list', 'shop.web.alone'])).toEqual([{
      severity: 'info', rule: 'sim-step-unconnected', id: 's-1:1-2',
      message: 's-1 steps 1-2: no navigation from shop.web.list to shop.web.alone (no relation from shop.web.list or its parts to shop.web.alone)',
    }]);
  });
  it('io -> a part of a screen is not judged', () => {
    expect(pairs(['shop.web.alone', 'shop.web.list.pick'])).toEqual([]);
  });
});

describe('checkSims: pair 2, io -> arch (implements)', () => {
  it.each([
    ['relation to the component of the function', ['shop.web.list.pick', 'shop.api.cart.add']],
    ['relation to an element under the component', ['shop.web.list.buy', 'shop.api.orders']],
    ['relation to the component itself', ['shop.web.list.pick', 'shop.api.cart']],
    ['code target in a file the component links', ['shop.web.list.pick', 'src/cart.ts#add']],
    ['code target of a linked function', ['shop.web.list.buy', 'src/orders/create.ts#create']],
  ])('connected: %s', (_n, targets) => {
    expect(pairs(targets)).toEqual([]);
  });
  it('a screen above the control does not inherit the control relation; unconnected names the parents', () => {
    expect(pairs(['shop.web.list', 'shop.api.cart']).map((f) => f.message))
      .toEqual(['s-1 steps 1-2: no relation from shop.web.list to shop.api.cart, its component or an element under it']);
    expect(pairs(['u-go', 'shop.api.cart']).map((f) => f.message))
      .toEqual(['s-1 steps 1-2: no relation from shop.web.home.menu.go (or its parents up to shop.web.home) to shop.api.cart, its component or an element under it']);
  });
});

describe('checkSims: pair 2 through the second step\'s call (b783)', () => {
  // web: page (screen) with add + go (controls), store (component); mob: shell (component); api: cart, orders.
  // store -> cart.add and shell -> cart are the call relations; go -> shell links the io side to another app.
  const CALL_PLAN: Plan = {
    files: ['a.c4'],
    elements: [
      el('shop', 'system'),
      el('shop.web', 'container'),
      el('shop.web.page', 'screen'),
      el('shop.web.page.add', 'control'),
      el('shop.web.page.go', 'control'),
      el('shop.web.store', 'component'),
      el('shop.mob', 'container'),
      el('shop.mob.shell', 'component'),
      el('shop.api', 'container'),
      el('shop.api.cart', 'component'),
      el('shop.api.cart.add', 'function'),
      el('shop.api.orders', 'component'),
      el('shop.api.orders.place', 'function'),
    ],
    relations: [
      rel('shop.web.store', 'shop.api.cart.add'),
      rel('shop.mob.shell', 'shop.api.cart'),
      rel('shop.web.page.go', 'shop.mob.shell'),
    ],
    issues: [],
  };
  const ctx: SimCheckContext = { plan: CALL_PLAN, code: INDEX, callFiles: null };
  /** checkSims of io step `io` then arch step `target` whose call goes from -> to. */
  const viaCall = (io: string, target: string, from: string, to: string): PlanFinding[] =>
    checkSims([flow('s-1', [step(io), step(target, { call: { from, to, label: 'POST' } })])], ctx);
  const UNCONNECTED = (target: string): string[] =>
    [`s-1 steps 1-2: no relation from shop.web.page.add (or its parents up to shop.web.page) to ${target}, its component or an element under it`];

  it.each([
    ['(a) same-app call.from relates to an element under the step component', 'shop.web.page.add', 'shop.api.cart', 'shop.web.store', 'shop.api.cart'],
    ['(a) call.to is the step function itself', 'shop.web.page.add', 'shop.api.cart.add', 'shop.web.store', 'shop.api.cart.add'],
    ['(a) call.to is the component above the step function', 'shop.web.page.add', 'shop.api.cart.add', 'shop.web.store', 'shop.api.cart'],
    ['(a) call.from in another app that the io side relates to', 'shop.web.page.go', 'shop.api.cart', 'shop.mob.shell', 'shop.api.cart'],
  ])('connected: %s', (_n, io, target, from, to) => {
    expect(viaCall(io, target, from, to)).toEqual([]);
  });

  it('(b) call.from in another container, no relation from the io side to it: unconnected, the message as before', () => {
    expect(viaCall('shop.web.page.add', 'shop.api.cart', 'shop.mob.shell', 'shop.api.cart').map((f) => f.message))
      .toEqual(UNCONNECTED('shop.api.cart'));
  });

  it('(c) the call relation goes to a different component than the step target: unconnected', () => {
    // call.to = cart (store relates to cart.add) but the step is orders: the call does not end at the step.
    expect(viaCall('shop.web.page.add', 'shop.api.orders', 'shop.web.store', 'shop.api.cart').map((f) => f.message))
      .toEqual(UNCONNECTED('shop.api.orders'));
    // call.to ends at the step (orders.place) but no relation goes from store to orders, its parts or above.
    expect(viaCall('shop.web.page.add', 'shop.api.orders.place', 'shop.web.store', 'shop.api.orders.place').map((f) => f.message))
      .toEqual(UNCONNECTED('shop.api.orders.place'));
  });

  it('(d) call.from is a code key, or the step has no call: the rule as before', () => {
    expect(viaCall('shop.web.page.add', 'shop.api.cart', 'src/cart.ts#add', 'shop.api.cart').map((f) => f.message))
      .toEqual(UNCONNECTED('shop.api.cart'));
    expect(checkSims([flow('s-1', [step('shop.web.page.add'), step('shop.api.cart')])], ctx).map((f) => f.message))
      .toEqual(UNCONNECTED('shop.api.cart'));
  });
});

describe('checkSims: pair 3, function -> function (resolved calls, Q4)', () => {
  it(`connected directly and along up to ${SIM_CALL_HOPS} calls`, () => {
    expect(pairs(['src/pay.ts#a', 'src/pay.ts#b'])).toEqual([]);
    expect(pairs(['src/pay.ts#a', 'src/pay.ts#d'])).toEqual([]);
  });
  it('a longer chain is unconnected and the message names the path', () => {
    expect(pairs(['src/pay.ts#a', 'src/pay.ts#e'])).toEqual([{
      severity: 'info', rule: 'sim-step-unconnected', id: 's-1:1-2',
      message: 's-1 steps 1-2: no resolved call from src/pay.ts#a to src/pay.ts#e within 3 calls; it reaches it only through 4 calls: src/pay.ts#a -> src/pay.ts#b -> src/pay.ts#c -> src/pay.ts#d -> src/pay.ts#e',
    }]);
  });
  it('no call at all: unconnected', () => {
    expect(pairs(['src/pay.ts#b', 'src/pay.ts#a']).map((f) => f.message))
      .toEqual(['s-1 steps 1-2: no resolved call from src/pay.ts#b to src/pay.ts#a within 3 calls']);
  });
  it('a planned function without code: unverified', () => {
    expect(pairs(['shop.api.orders.create', 'shop.api.orders.refund'])).toEqual([{
      severity: 'info', rule: 'sim-step-unverified', id: 's-1:1-2',
      message: 's-1 steps 1-2: shop.api.orders.refund has no code yet (planned only), so the call from shop.api.orders.create to shop.api.orders.refund cannot be checked',
    }]);
  });
  it('an untraced call whose last segment is the second name: unverified', () => {
    expect(pairs(['shop.api.orders.create', 'src/pay.ts#Pay.charge']).map((f) => [f.rule, f.message])).toEqual([[
      'sim-step-unverified',
      "s-1 steps 1-2: src/orders/create.ts#create has an untraced call 'svc.charge' (line 7) that may reach src/pay.ts#Pay.charge",
    ]]);
  });
  it('calls not read (Q6: callFiles null, or not this file): no finding', () => {
    expect(pairs(['src/pay.ts#b', 'src/pay.ts#a'], { ...CTX, callFiles: null })).toEqual([]);
    expect(pairs(['shop.api.orders.create', 'shop.api.orders.refund'], { ...CTX, callFiles: null })).toEqual([]);
    expect(pairs(['src/pay.ts#b', 'src/pay.ts#a'], { ...CTX, callFiles: new Set(['src/cart.ts']) })).toEqual([]);
  });
  it('a class is not a function: function -> class not judged', () => {
    expect(pairs(['src/pay.ts#a', 'src/pay.ts#Pay'])).toEqual([]);
  });
});

describe('checkSims: several targets, skipped and unjudged pairs', () => {
  it('connected when any target of step i connects to any target of step i+1', () => {
    expect(pairs([['shop.web.alone', 'u-go'], 'shop.web.list'])).toEqual([]);
    expect(pairs([['src/pay.ts#b', 'src/pay.ts#a'], ['src/pay.ts#e', 'src/pay.ts#b']])).toEqual([]);
  });
  it('none connects: the first unverified wins over unconnected, and the message says several', () => {
    const out = pairs([['src/pay.ts#b', 'shop.api.orders.create'], ['src/pay.ts#a', 'shop.api.orders.refund']]);
    expect(rules(out)).toEqual(['sim-step-unverified s-1:1-2']);
    expect(out[0].message).toMatch(/; no target of step 1 connects to a target of step 2$/);
  });
  it('a missing target skips the pair (only sim-target-missing)', () => {
    expect(rules(pairs(['shop.web.list', ['gone', 'shop.web.alone']]))).toEqual(['sim-target-missing s-1:2']);
  });
  it.each([
    ['arch -> storage', ['src/pay.ts#a', 'u-ord']],
    ['storage -> io', ['u-ord', 'shop.web.list']],
    ['component -> component', ['shop.api.cart', 'shop.api.orders']],
    ['arch -> io', ['src/pay.ts#a', 'shop.web.list']],
  ])('%s is not judged', (_n, targets) => {
    expect(pairs(targets)).toEqual([]);
  });
});

describe('simsForCheck + c4pm check on test/fixtures/sim-shop (T7)', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-shop-')));
  fs.cpSync(path.join(__dirname, 'fixtures', 'sim-shop'), repo, { recursive: true });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  const EMPTY = { files: [] } as unknown as Snapshot;

  it('no project or no sim folder: no data, no finding', () => {
    expect(simsForCheck(null, PLAN, EMPTY)).toEqual({ data: null, findings: [] });
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-none-')));
    fs.mkdirSync(path.join(bare, '.c4pm'));
    try {
      expect(simsForCheck(tryResolveProject(bare), PLAN, EMPTY)).toEqual({ data: null, findings: [] });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a sim folder that cannot be read: one sim-parse warning with id sim/ (never an empty id)', () => {
    const bad = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-bad-')));
    fs.mkdirSync(path.join(bad, '.c4pm'));
    try {
      const project = tryResolveProject(bad)!;
      fs.mkdirSync(project.projectDir, { recursive: true });
      fs.writeFileSync(path.join(project.projectDir, 'sim'), 'not a folder');   // readdir fails: ENOTDIR
      const out = simsForCheck(project, PLAN, EMPTY);
      expect(out.data).toEqual([]);
      expect(out.findings.map((f) => [f.severity, f.rule, f.id])).toEqual([['warning', 'sim-parse', 'sim/']]);
      expect(out.findings[0].message).toMatch(/^cannot read /);
    } finally {
      fs.rmSync(bad, { recursive: true, force: true });
    }
  });

  it('check --format json: every sim rule, sorted by severity, rule, id (stable)', () => {
    const r = runCli(['check', '--repo', repo, '--format', 'json']);
    expect(r.status).toBe(0);
    const all = JSON.parse(r.stdout) as PlanFinding[];
    const rank = ['critical', 'warning', 'info'];
    expect(all.map((f) => rank.indexOf(f.severity))).toEqual(all.map((f) => rank.indexOf(f.severity)).sort((a, b) => a - b));
    expect(all.filter((f) => f.rule.startsWith('sim-'))).toEqual([
      { severity: 'warning', rule: 'sim-parse', id: 's-3.json', message: "unknown key 'colour' (kept as written)" },
      { severity: 'warning', rule: 'sim-stage-missing', id: 's-2:stage-4', message: "s-2 stage 4: flow 's-9' names no s-item" },
      { severity: 'warning', rule: 'sim-target-missing', id: 's-1:8', message: "s-1 step 8: call.from 'shop.api.nope' resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)" },
      { severity: 'warning', rule: 'sim-target-missing', id: 's-2:stage-5', message: "s-2 stage 5: target 'u-gone' resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)" },
      { severity: 'warning', rule: 'sim-target-missing', id: 's-3:2', message: "s-3 step 2: rows key 'shop.api.cart' is the component shop.api.cart, not a record" },
      { severity: 'info', rule: 'sim-step-unconnected', id: 's-3:1-2', message: 's-3 steps 1-2: no navigation from shop.web.products to shop.web.done (no relation from shop.web.products or its parts to shop.web.done)' },
      { severity: 'info', rule: 'sim-step-unconnected', id: 's-3:2-3', message: 's-3 steps 2-3: no relation from shop.web.done to shop.api.cart, its component or an element under it' },
    ]);
  });
});
