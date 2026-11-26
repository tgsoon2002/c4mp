import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as planScan from '../src/scan/planScan';
import { buildView } from '../src/page/html';
import { runCheck } from '../src/query/check';
import { runStatus } from '../src/query/status';
import { needsCallIndex } from '../src/sim/run';
import { tryResolveProject } from '../src/outputs';
import type { Plan, PlanFinding } from '../src/types';

// Phase 25 T8 (b704, Q6): the scan reads every call only when an s-item has a function -> function step pair, so the
// pair rule of checkSims can judge it; a repo without such a pair scans as before. On test/fixtures/sim-shop (tmp copies):
// its s-1 steps 6-7 are src/orders.ts#createOrder -> [src/payments.ts#authorise, shop.api.payments], and createOrder
// calls authorise.

const FIXTURE = path.join(__dirname, 'fixtures', 'sim-shop');
const S1 = path.join('.c4mp', 'projects', 'sim-shop', 'sim', 's-1.json');
const dirs: string[] = [];

/** A tmp copy of sim-shop; `step6` / `step7` replace the targets of s-1 steps 6 and 7. */
function copyShop(targets: { step6?: string; step7?: string } = {}): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sim-calls-')));
  dirs.push(repo);
  fs.cpSync(FIXTURE, repo, { recursive: true });
  const file = path.join(repo, S1);
  const sim = JSON.parse(fs.readFileSync(file, 'utf8')) as { steps: { target: string | string[] }[] };
  if (targets.step6) sim.steps[5].target = targets.step6;
  if (targets.step7) sim.steps[6].target = targets.step7;
  fs.writeFileSync(file, JSON.stringify(sim, null, 2) + '\n');
  return repo;
}

/** runCheck with a spy on the scan: the collectCalls each scan got, the files whose calls it read, the s-1 pair findings. */
function checkWithSpy(repo: string): { collectCalls: unknown[]; callFiles: string[] | null; pairs: PlanFinding[]; plan: Plan } {
  const spy = jest.spyOn(planScan, 'scanWithPlan');
  try {
    const r = runCheck(repo, {}, {})!;
    return {
      collectCalls: spy.mock.calls.map((c) => c[3]?.collectCalls),
      callFiles: r.snapshot.calls ? r.snapshot.calls.map((c) => c.file).sort() : null,
      pairs: r.findings.filter((f) => f.id.startsWith('s-1:') && f.rule.startsWith('sim-step-')),
      plan: r.plan,
    };
  } finally {
    spy.mockRestore();
  }
}

const NO_PAIR = { step6: 'shop.api.orders' };   // a component: steps 5-6 and 6-7 have no function on both sides

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('needsCallIndex (T8)', () => {
  it('no project, or no function -> function pair: false; the fixture (path#name -> path#name): true', () => {
    const repo = copyShop();
    const plan = checkWithSpy(repo).plan;
    expect(needsCallIndex(null, plan)).toBe(false);
    expect(needsCallIndex(tryResolveProject(repo), plan)).toBe(true);
    expect(needsCallIndex(tryResolveProject(copyShop(NO_PAIR)), plan)).toBe(false);
  });

  it.each([
    ['a linked plan function by fqn -> a planned one by fqn', 'shop.api.cart.addItem', 'shop.api.orders.refund', true],
    ['a plan function -> a path#name ref (no scan: may be a function)', 'shop.api.cart.addItem', 'src/payments.ts#authorise', true],
    ['a plan function -> a component', 'shop.api.cart.addItem', 'shop.api.payments', false],
    ['a component -> a plan function', 'shop.api.orders', 'shop.api.cart.addItem', false],
  ])('%s: %s', (_name, step6, step7, needed) => {
    const repo = copyShop({ step6, step7 });
    expect(needsCallIndex(tryResolveProject(repo), checkWithSpy(repo).plan)).toBe(needed);
  });
});

describe('check reads the calls only when needed (T8)', () => {
  it('no function pair: the scan keeps its usual options (no calls read), no pair finding on s-1 steps 5-7', () => {
    const r = checkWithSpy(copyShop(NO_PAIR));
    expect(r.collectCalls).toEqual([undefined]);
    expect(r.callFiles).toBeNull();
    expect(r.pairs).toEqual([]);
  });

  it('a pair: collectCalls true, every file read, and createOrder -> authorise is connected (no finding)', () => {
    const r = checkWithSpy(copyShop());
    expect(r.collectCalls).toEqual([true]);
    expect(r.callFiles).toEqual(['src/cart.ts', 'src/orders.ts', 'src/payments.ts']);
    expect(r.pairs).toEqual([]);
  });

  it('the pair is judged: no call -> sim-step-unconnected; a planned function -> sim-step-unverified', () => {
    expect(checkWithSpy(copyShop({ step7: 'src/cart.ts#addItem' })).pairs).toEqual([{
      severity: 'info', rule: 'sim-step-unconnected', id: 's-1:6-7',
      message: 's-1 steps 6-7: no resolved call from src/orders.ts#createOrder to src/cart.ts#addItem within 3 calls',
    }]);
    expect(checkWithSpy(copyShop({ step7: 'shop.api.orders.refund' })).pairs).toEqual([{
      severity: 'info', rule: 'sim-step-unverified', id: 's-1:6-7',
      message: 's-1 steps 6-7: shop.api.orders.refund has no code yet (planned only), so the call from src/orders.ts#createOrder to shop.api.orders.refund cannot be checked',
    }]);
  });

  it('the page build and status choose the same: true with a pair, their usual value without; status counts = check counts', () => {
    const seen = (repo: string, run: () => unknown): unknown[] => {
      const spy = jest.spyOn(planScan, 'scanWithPlan');
      try {
        run();
        return spy.mock.calls.map((c) => c[3]?.collectCalls);
      } finally {
        spy.mockRestore();
      }
    };
    const pair = copyShop({ step7: 'shop.api.orders.refund' });
    const none = copyShop(NO_PAIR);
    expect([seen(pair, () => buildView({ repo: pair })), seen(none, () => buildView({ repo: none }))]).toEqual([[true], ['tests']]);
    expect([seen(pair, () => runStatus(pair, {})), seen(none, () => runStatus(none, {}))]).toEqual([[true], [undefined]]);
    const check = runCheck(pair, {}, {})!.findings;
    const count = (s: string) => check.filter((f) => f.severity === s).length;
    expect(runStatus(pair, {}).plan).toMatchObject({ critical: count('critical'), warning: count('warning'), info: count('info') });
  });
});
