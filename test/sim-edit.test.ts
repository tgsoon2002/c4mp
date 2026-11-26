import * as fs from 'fs';
import * as path from 'path';
import { addSim, applySimFile, editSimStage, editSimStep, removeSim, setSim, upgradeSims } from '../src/services/simEdit';
import type { SimFlags, SimOpOutcome } from '../src/services/simEdit';
import * as simWrite from '../src/sim/write';
import { simFileFor } from '../src/sim/load';
import { DATA_DIR } from '../src/constants';
import { requireProject } from '../src/outputs';
import { planNoScan } from '../src/scan/planScan';
import type { PlanElement } from '../src/types';
import { listing, makeRepo, writeSource } from './helpers/planEditHarness';

// T4b (b700): the simulation editing service, in-process on a tmp repo. Refs resolve through one resolver
// (plan element by uid/fqn/id/name, else exact fqn or uid of any element, else code path#name added to the plan) and
// are stored as uids (b899); every write is a dry run unless yes.

const PLAN = `model {
  shop = system 'Shop' {
    web = container 'Shop web' {
      products = screen 'Products' {
        metadata { uid 'u-products' }
        add = control 'Add to cart button' {
          metadata { uid 'u-add' }
        }
      }
      cart = screen 'Cart' {
        metadata { uid 'u-cart' }
      }
    }
    api = container 'Shop api' {
      metadata { uid 'u-api' }
      cart = component 'Cart service' {
        link ../../../../src/cart.ts
        metadata {
          uid 'u-cartsvc'
          owner 'K'
        }
        addItem = function 'addItem' {
          metadata {
            status 'planned'
            signature 'addItem(id: string): void'
          }
        }
      }
      orders = component 'Orders' {
        link ../../../../src/orders.ts
      }
      db = store 'Shop db' {
        cart_items = record 'cart_items' {
          metadata { uid 'u-cartrec' }
        }
        orders = record 'orders'
      }
    }
  }
}
`;

const CART_TS = 'export function addItem(id: string): void {}\nexport function total(): number { return 0; }\n';

const UID = /^[0-9a-f-]{36}$/;
/** The plan element `fqn` as the repo holds it now. */
const planEl = (r: Repo, fqn: string): PlanElement | undefined => planNoScan(r.root)?.elements.find((e) => e.id === fqn);

interface Repo { root: string; plan: string; file: (id: string) => string; read: (id: string) => Record<string, unknown> }

function repo(withPlan = true): Repo {
  const { root, planDir, files } = makeRepo('c4pm-sim-edit-', withPlan ? { 'shop.c4': PLAN } : {});
  writeSource(root, planDir, 'src/cart.ts', CART_TS);
  writeSource(root, planDir, 'src/orders.ts', 'export function place(): void {}\n');
  writeSource(root, planDir, 'src/other.ts', 'export function lonely(): void {}\n');
  const project = requireProject(root);
  const file = (id: string): string => simFileFor(project, id);
  return { root, plan: files['shop.c4'] ?? '', file, read: (id) => JSON.parse(fs.readFileSync(file(id), 'utf8')) as Record<string, unknown> };
}
function writeSim(r: Repo, id: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(r.file(id)), { recursive: true });
  fs.writeFileSync(r.file(id), JSON.stringify({ schemaVersion: 1, id, ...body }, null, 2) + '\n');
}
const flow = (r: Repo, id: string, steps: unknown[] = []): void => writeSim(r, id, { kind: 'flow', title: `Flow ${id}`, steps });
const ok = (o: SimOpOutcome): Extract<SimOpOutcome, { result: unknown }> => {
  if ('error' in o) throw new Error(`refused: ${o.error}\n${o.reasons.join('\n')}`);
  return o;
};
const err = (o: SimOpOutcome): Extract<SimOpOutcome, { error: string }> => {
  if (!('error' in o)) throw new Error(`not refused: ${o.result.lines.join('\n')}`);
  return o;
};
/** Run `fn` as a dry run (nothing on disk changes), then with yes. */
function dryThenYes(r: Repo, fn: (yes: boolean) => SimOpOutcome): { dry: SimOpOutcome; done: SimOpOutcome } {
  const before = listing(r.root);
  const dry = ok(fn(false));
  expect(dry.written).toBe(false);
  expect(listing(r.root)).toEqual(before);
  const done = ok(fn(true));
  expect(done.written).toBe(done.changed);
  return { dry, done };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('addSim / setSim / removeSim', () => {
  it('add: dry run writes nothing, yes writes s-<max+1>.json; the minted id is returned', () => {
    const r = repo();
    const { dry, done } = dryThenYes(r, (yes) => addSim(r.root, { kind: 'flow', title: 'Buy a product', person: 'customer', yes }));
    expect(ok(dry).result.lines[0]).toBe("add s-1 (flow 'Buy a product'):");
    expect(ok(done).result.minted).toEqual(['s-1']);
    expect(ok(done).file).toBe(DATA_DIR + '/projects/' +path.basename(path.dirname(path.dirname(r.file('s-1')))) + '/sim/s-1.json');
    expect(r.read('s-1')).toEqual({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Buy a product', person: 'customer', steps: [] });
    // a broken file still holds its number
    fs.writeFileSync(r.file('s-7'), '{ broken');
    expect(ok(addSim(r.root, { kind: 'journey', title: 'First buy' })).result.minted).toEqual(['s-8']);
  });

  it.each<[string, SimFlags, RegExp]>([
    ['no kind', { title: 'x' }, /--kind must be flow or journey/],
    ['a bad kind', { kind: 'story', title: 'x' }, /found 'story'/],
    ['no title', { kind: 'flow' }, /--title is required/],
  ])('add refuses %s', (_label, flags, msg) => {
    expect(err(addSim(repo().root, flags)).error).toMatch(msg);
  });

  it('set: changes title, clears description with none, refuses clearing the title; nothing different = not changed', () => {
    const r = repo();
    writeSim(r, 's-1', { kind: 'flow', title: 'Old', description: 'text', steps: [] });
    const { dry } = dryThenYes(r, (yes) => setSim(r.root, 's-1', { title: 'New', description: 'none', person: 'buyer', yes }));
    expect(ok(dry).result.lines).toEqual(["set s-1 (flow 'Old'):", '  title: Old -> New', '  person: (none) -> buyer', '  description: text -> (none)']);
    expect(r.read('s-1')).toEqual({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'New', person: 'buyer', steps: [] });
    expect(ok(setSim(r.root, 's-1', { title: 'New' })).changed).toBe(false);
    expect(err(setSim(r.root, 's-1', { title: 'none' })).error).toMatch(/title is required/);
    expect(err(setSim(r.root, 's-9', { title: 'x' })).error).toBe("no s-item 's-9' (s-items: s-1)");
  });

  it('remove: refused while a journey stage names the id (the reasons list them); then removed', () => {
    const r = repo();
    flow(r, 's-1');
    writeSim(r, 's-2', { kind: 'journey', title: 'Journey', stages: [{ outside: 'ad' }, { name: 'Buy', flow: 's-1' }] });
    const refused = err(removeSim(r.root, 's-1', true));
    expect(refused.error).toMatch(/^s-1 is named by 1 journey stage; remove that stage first/);
    expect(refused.reasons).toEqual(["s-2 stage 2 'Buy' (journey 'Journey')"]);
    expect(fs.existsSync(r.file('s-1'))).toBe(true);
    dryThenYes(r, (yes) => removeSim(r.root, 's-2', yes));
    dryThenYes(r, (yes) => removeSim(r.root, 's-1', yes));
    expect(fs.existsSync(r.file('s-1'))).toBe(false);
  });

  it('a touched file that does not parse is refused (fix it by hand); other files still edit', () => {
    const r = repo();
    flow(r, 's-1');
    fs.writeFileSync(r.file('s-3'), '{"schemaVersion": 2}');
    const refused = err(setSim(r.root, 's-3', { title: 'x' }));
    expect(refused.error).toBe('s-3.json does not parse: fix s-3.json by hand first, nothing changed');
    expect(refused.reasons[0]).toMatch(/schemaVersion/);
    expect(ok(setSim(r.root, 's-1', { title: 'Fine' })).changed).toBe(true);
  });
});

describe('editSimStep', () => {
  it('add: every ref is stored as a uid; a planned function gets one; code not in the plan is added first; the view defaults to the first target; lines name what each resolved to', () => {
    const r = repo();
    flow(r, 's-1');
    const { dry } = dryThenYes(r, (yes) => editSimStep(r.root, 's-1', 'add', null, { target: 'Cart', state: 'cart: empty' }, yes));
    expect(ok(dry).result.lines).toEqual([
      "add step 1 to s-1 (flow 'Flow s-1'):",
      "  step 1: target u-cart (screen shop.web.cart 'Cart'), view io",
      '    state: cart: empty',
    ]);
    ok(editSimStep(r.root, 's-1', 'add', null, { target: 'shop.api.cart.addItem' }, true));
    ok(editSimStep(r.root, 's-1', 'add', null, { target: ['src/cart.ts#total', 'u-cartsvc'], caption: 'Sum.', duration: '4' }, true));
    ok(editSimStep(r.root, 's-1', 'add', 1, { target: 'cart_items', view: 'data' }, true));
    const A = planEl(r, 'shop.api.cart.addItem')?.metadata.uid as string;
    const T = planEl(r, 'shop.api.cart.total')?.metadata.uid as string;
    expect(A).toMatch(UID);
    expect(T).toMatch(UID);
    expect(r.read('s-1').steps).toEqual([
      { target: 'u-cartrec', view: 'storage' },
      { target: 'u-cart', view: 'io', state: 'cart: empty' },
      { target: A, view: 'arch' },
      { target: [T, 'u-cartsvc'], view: 'arch', caption: 'Sum.', durationSec: 4 },
    ]);
    const total = planEl(r, 'shop.api.cart.total');
    expect(total?.kind).toBe('function');
    expect(total?.metadata.status).toBe('done');
    expect(total?.metadata.owner).toBe('K');
  });

  it('add: call ends resolve like targets, label and reply as given; rows keys resolve to a record uid', () => {
    const r = repo();
    flow(r, 's-1');
    const rowsFile = path.join(r.root, 'rows.json');
    fs.writeFileSync(rowsFile, JSON.stringify({ cart_items: [{ product: 42, qty: 1 }] }));
    const done = ok(editSimStep(r.root, 's-1', 'add', null, {
      target: 'src/cart.ts#total', callFrom: 'Add to cart button', callTo: 'src/cart.ts#total', callLabel: 'POST /cart', reply: true, rowsFile,
    }, true));
    expect(done.result.lines).toContain("  plan: add function shop.api.cart.total 'total' (link src/cart.ts#total, status done, owner K)");
    expect(done.result.lines.filter((l) => /^    call: from u-add \(control shop\.web\.products\.add 'Add to cart button'\), to [0-9a-f-]{36} \(function shop\.api\.cart\.total 'total'\), label 'POST \/cart', reply$/.test(l))).toHaveLength(1);
    expect(done.result.lines).toContain("    rows u-cartrec (record shop.api.db.cart_items 'cart_items'): 1 row");
    const T = planEl(r, 'shop.api.cart.total')?.metadata.uid as string;
    expect(T).toMatch(UID);
    expect(r.read('s-1').steps).toEqual([{
      target: T, view: 'arch',
      call: { from: 'u-add', to: T, label: 'POST /cart', reply: true },
      rows: { 'u-cartrec': [{ product: 42, qty: 1 }] },
    }]);
  });

  it.each<[string, SimFlags, RegExp, (reasons: string[]) => void]>([
    ['no match: none with the closest 5', { target: 'Basket' }, /^--target 'Basket' matches no plan element/, (rs) => expect(rs.length).toBeLessThanOrEqual(5)],
    ['several matches: ambiguous, each listed', { target: 'orders' }, /^--target 'orders' matches 2 plan elements; give a uid or fqn/, (rs) => expect(rs).toHaveLength(2)],
    ['a code target whose name is not in the file', { target: 'src/cart.ts#nope' }, /no function, class or method 'nope' in src\/cart.ts/, (rs) => expect(rs).toEqual(['addItem', 'total'])],
    ['a code file that does not exist', { target: 'src/none.ts#x' }, /^--target 'src\/none.ts#x': /, () => undefined],
    ['a rows key that is no record', { target: 'Cart', rowsFile: 'ROWS' }, /^--rows-file key 'u-cartsvc' is component shop.api.cart 'Cart service', not a record/, () => undefined],
    ['a call end that resolves to nothing', { target: 'Cart', callTo: 'nowhere' }, /^--call-to 'nowhere' matches no plan element/, () => undefined],
    ['a code target whose planned twin is not linked', { target: 'src/cart.ts#addItem' }, /shop\.api\.cart\.addItem already exists \(function 'addItem'\) and does not link src\/cart\.ts#addItem/, () => undefined],
    ['a code target no component claims', { target: 'src/other.ts#lonely' }, /no component claims src\/other\.ts#lonely/, () => undefined],
    ['a code target added without an owner', { target: 'src/orders.ts#place' }, /needs an owner: .*set owner on shop\.api\.orders/, () => undefined],
    ['a bad view', { target: 'Cart', view: 'front-end' }, /--view 'front-end' must be arch, io or storage/, () => undefined],
    ['a bad duration', { target: 'Cart', duration: '0' }, /--duration '0' must be a number of seconds > 0/, () => undefined],
  ])('refused: %s; nothing written', (_label, flags, msg, reasonsCheck) => {
    const r = repo();
    flow(r, 's-1');
    const rowsFile = path.join(r.root, 'rows.json');
    fs.writeFileSync(rowsFile, JSON.stringify({ 'u-cartsvc': [{ a: 1 }] }));
    const before = listing(r.root);
    const refused = err(editSimStep(r.root, 's-1', 'add', null, { ...flags, ...(flags.rowsFile ? { rowsFile } : {}) }, true));
    expect(refused.error).toMatch(msg);
    reasonsCheck(refused.reasons);
    expect(listing(r.root)).toEqual(before);
  });

  it('several bad refs are reported together', () => {
    const r = repo();
    flow(r, 's-1');
    const refused = err(editSimStep(r.root, 's-1', 'add', null, { target: ['Basket', 'src/cart.ts#nope'] }, false));
    expect(refused.error).toBe('2 refs do not resolve, nothing changed');
    expect(refused.reasons.filter((l) => !l.startsWith('  '))).toEqual([
      "--target 1 'Basket' matches no plan element (closest below; a code target is path#name)",
      "--target 2 'src/cart.ts#nope': no function, class or method 'nope' in src/cart.ts",
    ]);
  });

  it('no plan: a plan ref is refused, a code target is refused too (it is added to the plan)', () => {
    const r = repo(false);
    flow(r, 's-1');
    expect(err(editSimStep(r.root, 's-1', 'add', null, { target: 'Cart' }, true)).error).toMatch(/^--target 'Cart': no plan found/);
    expect(err(editSimStep(r.root, 's-1', 'add', null, { target: 'src/cart.ts#addItem' }, true)).error).toMatch(/^--target 'src\/cart\.ts#addItem': no plan found .*a code target is added to the plan/);
  });

  it('b899: --owner wins over the component owner; the same code twice is one element and one uid', () => {
    const r = repo();
    flow(r, 's-1');
    dryThenYes(r, (yes) => editSimStep(r.root, 's-1', 'add', null, { target: 'src/cart.ts#total', callTo: 'src/cart.ts#total', owner: 'Jay' }, yes));
    expect(planEl(r, 'shop.api.cart.total')?.metadata.owner).toBe('Jay');
    const els = planNoScan(r.root)?.elements.filter((e) => e.id === 'shop.api.cart.total');
    expect(els).toHaveLength(1);
    const step = (r.read('s-1').steps as { target: string; call: { to: string } }[])[0];
    expect(step.call.to).toBe(els?.[0].metadata.uid);
    expect(step.target).toBe(step.call.to);
  });

  it('b899: plan and s-item are one write: a failing plan check rolls both back', () => {
    const r = repo();
    flow(r, 's-1');
    const planBefore = fs.readFileSync(r.plan, 'utf8');
    const simBefore = fs.readFileSync(r.file('s-1'), 'utf8');
    const real = simWrite.applySimWrites;
    jest.spyOn(simWrite, 'applySimWrites').mockImplementation((project, plan, extra) => {
      real(project, plan, extra && { ...extra, verify: () => 'forced' });
    });
    expect(() => editSimStep(r.root, 's-1', 'add', null, { target: 'src/cart.ts#total' }, true)).toThrow(/^rolled back: .*forced/);
    expect(fs.readFileSync(r.file('s-1'), 'utf8')).toBe(simBefore);
    expect(planEl(r, 'shop.api.cart.total')).toBeUndefined();
    expect(fs.readFileSync(r.plan, 'utf8')).toBe(planBefore);
  });

  it('b899: a uid typed for a planned function is kept', () => {
    const r = repo();
    flow(r, 's-1');
    ok(editSimStep(r.root, 's-1', 'add', null, { target: 'src/cart.ts#total', owner: 'Jay' }, true));
    const T = planEl(r, 'shop.api.cart.total')?.metadata.uid as string;
    const text = fs.readFileSync(r.plan, 'utf8');
    const done = ok(editSimStep(r.root, 's-1', 'add', null, { target: T }, true));
    expect(done.result.lines.some((l) => l.startsWith('  plan:'))).toBe(false);
    expect((r.read('s-1').steps as { target: string }[])[1].target).toBe(T);
    expect(fs.readFileSync(r.plan, 'utf8')).toBe(text);
  });

  it('set: fields change, none clears, call keys change one by one; the view stays unless --view', () => {
    const r = repo();
    flow(r, 's-1', [{ target: 'u-cart', view: 'io', state: 'a', call: { from: 'u-add', label: 'go' } }]);
    const { dry } = dryThenYes(r, (yes) => editSimStep(r.root, 's-1', 'set', 1, { target: 'Products', state: 'none', callFrom: 'none', callTo: 'Cart', caption: 'Hi' }, yes));
    expect(ok(dry).result.lines).toEqual([
      'set step 1 of s-1:',
      '  target: ["u-cart"] -> ["u-products"]',
      '  call: {"from":"u-add","label":"go"} -> {"label":"go","to":"u-cart"}',
      '  state: a -> (none)',
      '  caption: (none) -> Hi',
      "  --target 'Products' -> u-products: screen shop.web.products 'Products'",
      "  --call-to 'Cart' -> u-cart: screen shop.web.cart 'Cart'",
    ]);
    expect(r.read('s-1').steps).toEqual([{ target: 'u-products', view: 'io', call: { to: 'u-cart', label: 'go' }, caption: 'Hi' }]);
    ok(editSimStep(r.root, 's-1', 'set', 1, { callTo: 'none', callLabel: 'none' }, true));
    expect(r.read('s-1').steps).toEqual([{ target: 'u-products', view: 'io', caption: 'Hi' }]);
    expect(err(editSimStep(r.root, 's-1', 'set', null, { caption: 'x' }, true)).error).toMatch(/give the step number/);
  });

  it('remove and move (1-based); move needs --to', () => {
    const r = repo();
    flow(r, 's-1', [{ target: 'u-cart', view: 'io' }, { target: 'u-add', view: 'io' }, { target: 'u-cartrec', view: 'storage' }]);
    dryThenYes(r, (yes) => editSimStep(r.root, 's-1', 'move', 3, { to: '1' }, yes));
    expect((r.read('s-1').steps as { target: string }[]).map((s) => s.target)).toEqual(['u-cartrec', 'u-cart', 'u-add']);
    dryThenYes(r, (yes) => editSimStep(r.root, 's-1', 'remove', 2, {}, yes));
    expect((r.read('s-1').steps as { target: string }[]).map((s) => s.target)).toEqual(['u-cartrec', 'u-add']);
    expect(err(editSimStep(r.root, 's-1', 'move', 1, {}, true)).error).toMatch(/--to is required/);
    expect(err(editSimStep(r.root, 's-1', 'remove', 5, {}, true)).error).toMatch(/step 5 is out of range/);
  });

  it('a file changed between load and write is refused and keeps the other text', () => {
    const r = repo();
    flow(r, 's-1');
    const other = JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Changed meanwhile', steps: [] });
    const real = simWrite.applySimWrites;
    jest.spyOn(simWrite, 'applySimWrites').mockImplementation((project, plan, extra) => {
      fs.writeFileSync(r.file('s-1'), other);
      real(project, plan, extra);
    });
    expect(() => editSimStep(r.root, 's-1', 'add', null, { target: 'Cart' }, true)).toThrow(/changed/);
    expect(fs.readFileSync(r.file('s-1'), 'utf8')).toBe(other);
  });
});

describe('editSimStage', () => {
  it('add a flow, an outside and an inline step stage; remove one', () => {
    const r = repo();
    flow(r, 's-1');
    writeSim(r, 's-2', { kind: 'journey', title: 'Journey', person: 'customer', stages: [] });
    const { dry } = dryThenYes(r, (yes) => editSimStage(r.root, 's-2', 'add', null, { outside: 'Gets an email', from: 'Shop', channel: 'email', goal: 'Know' }, yes));
    expect(ok(dry).result.lines).toEqual([
      "add stage 1 to s-2 (journey 'Journey'):",
      '  stage 1: outside: Gets an email',
      '    goal: Know',
      '    from: Shop',
      '    channel: email',
    ]);
    ok(editSimStage(r.root, 's-2', 'add', 1, { flow: 's-1', name: 'Buy' }, true));
    ok(editSimStage(r.root, 's-2', 'add', null, { target: 'Products', goal: 'Look' }, true));
    expect(r.read('s-2').stages).toEqual([
      { name: 'Buy', flow: 's-1' },
      { outside: 'Gets an email', goal: 'Know', from: 'Shop', channel: 'email' },
      { target: 'u-products', goal: 'Look', view: 'io' },
    ]);
    dryThenYes(r, (yes) => editSimStage(r.root, 's-2', 'remove', 2, {}, yes));
    expect((r.read('s-2').stages as unknown[]).length).toBe(2);
  });

  it.each<[string, SimFlags, RegExp]>([
    ['no form', { goal: 'x' }, /give exactly one of --flow/],
    ['two forms', { flow: 's-1', outside: 'x' }, /found --flow, --outside/],
    ['a flow that is not an s-item', { flow: 's-9' }, /--flow 's-9' is not an s-item/],
    ['a flow that is a journey', { flow: 's-2' }, /--flow 's-2' is a journey, not a flow/],
    ['a flag outside its stage form (reader rule)', { flow: 's-1', state: 'x' }, /not allowed on a flow stage/],
  ])('add refuses %s', (_label, flags, msg) => {
    const r = repo();
    flow(r, 's-1');
    writeSim(r, 's-2', { kind: 'journey', title: 'Journey', stages: [] });
    const refused = err(editSimStage(r.root, 's-2', 'add', null, flags, true));
    expect([refused.error, ...refused.reasons].join('\n')).toMatch(msg);
  });

  it('stage commands on a flow are refused', () => {
    const r = repo();
    flow(r, 's-1');
    expect(err(editSimStage(r.root, 's-1', 'add', null, { outside: 'x' }, true)).error).toMatch(/s-1 is a flow/);
  });
});

describe('applySimFile', () => {
  it('new entries with refs: ids minted in file order, flowRef names the new flow, every ref resolved', () => {
    const r = repo();
    flow(r, 's-1');
    const spec = {
      sims: [
        { kind: 'journey', title: 'First buy', stages: [{ outside: 'Sees an ad' }, { flowRef: 'buy', goal: 'Buy' }] },
        {
          ref: 'buy', kind: 'flow', title: 'Buy',
          steps: [
            { target: 'Add to cart button', view: 'io', call: { to: 'shop.api.cart.addItem' } },
            { target: ['src/cart.ts#total'], view: 'arch', rows: { cart_items: [{ qty: 1 }] } },
          ],
        },
      ],
    };
    const { dry, done } = dryThenYes(r, (yes) => applySimFile(r.root, spec, yes));
    expect(ok(done).result.minted).toEqual(['s-2', 's-3']);
    expect(ok(done).file).toMatch(/sim\/$/);
    expect(ok(dry).result.lines).toEqual(expect.arrayContaining([
      'write 2 s-items: 2 new, 0 replaced',
      "  s-3 (ref buy) steps[0].target: 'Add to cart button' -> u-add (control shop.web.products.add 'Add to cart button')",
      "  s-3 (ref buy) steps[1].rows key: 'cart_items' -> u-cartrec (record shop.api.db.cart_items 'cart_items')",
    ]));
    expect(r.read('s-2').stages).toEqual([{ outside: 'Sees an ad' }, { flow: 's-3', goal: 'Buy' }]);
    const A = planEl(r, 'shop.api.cart.addItem')?.metadata.uid as string;
    const T = planEl(r, 'shop.api.cart.total')?.metadata.uid as string;
    expect(A).toMatch(UID);
    expect(T).toMatch(UID);
    expect(ok(dry).result.lines.filter((l) => /^  plan: uid [0-9a-f-]{36} for function shop\.api\.cart\.addItem$/.test(l))).toHaveLength(1);
    expect(r.read('s-3').steps).toEqual([
      { target: 'u-add', view: 'io', call: { to: A } },
      { target: T, view: 'arch', rows: { 'u-cartrec': [{ qty: 1 }] } },
    ]);
  });

  it('one bad ref refuses the whole file; an entry replacing a broken file is refused', () => {
    const r = repo();
    flow(r, 's-1');
    const before = listing(r.root);
    const refused = err(applySimFile(r.root, { sims: [{ kind: 'flow', title: 'A', steps: [{ target: 'Basket', view: 'io' }] }, { kind: 'flow', title: 'B' }] }, true));
    expect(refused.error).toMatch(/^s-2 steps\[0\]\.target 'Basket' matches no plan element/);
    expect(listing(r.root)).toEqual(before);
    fs.writeFileSync(r.file('s-4'), '{ broken');
    expect(err(applySimFile(r.root, { sims: [{ id: 's-4', kind: 'flow', title: 'Fix' }] }, true)).error).toMatch(/^s-4.json does not parse: fix by hand first/);
  });
});

describe('upgradeSims', () => {
  it('every stored ref becomes a uid; a file that does not parse is left; a second run changes nothing', () => {
    const r = repo();
    flow(r, 's-1', [
      { target: 'shop.api.cart.addItem', view: 'arch' },
      { target: 'src/cart.ts#total', view: 'arch', call: { from: 'src/cart.ts#total', to: 'u-cart' } },
      { target: 'u-cart', view: 'io' },
    ]);
    fs.writeFileSync(r.file('s-2'), '{ broken');
    const { dry } = dryThenYes(r, (yes) => upgradeSims(r.root, { yes }));
    expect(ok(dry).result.lines).toContain('  s-2.json does not parse: left as is');
    const steps = r.read('s-1').steps as { target: string; call?: { from: string; to: string } }[];
    expect(steps[0].target).toMatch(UID);
    expect(steps[1].target).toMatch(UID);
    expect(steps[1].call?.from).toMatch(UID);
    expect(steps[1].call?.to).toBe('u-cart');
    expect(steps[2].target).toBe('u-cart');
    const again = ok(upgradeSims(r.root, { yes: true }));
    expect(again.changed).toBe(false);
    expect(again.result.lines).toContain('  every ref is a uid already');
  });

  it('a ref that resolves to nothing refuses the whole upgrade; nothing is written', () => {
    const r = repo();
    flow(r, 's-1', [{ target: 'shop.api.cart.addItem', view: 'arch' }]);
    flow(r, 's-2', [{ target: 'u-gone', view: 'arch' }]);
    const before = listing(r.root);
    expect(err(upgradeSims(r.root, { yes: true })).error).toMatch(/matches no plan element/);
    expect(listing(r.root)).toEqual(before);
  });
});
