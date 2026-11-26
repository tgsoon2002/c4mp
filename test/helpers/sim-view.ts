import { renderViewHtml } from '../../src/page/html';
import { buildViewSims, type SimRefKeys } from '../../src/view/simModel';
import { storageModel, CLASSES } from './storage-view';
import type { PlanFinding, SimItem, ViewModel } from '../../src/types';

// Phase 25 UI3 (b753): a page with s-items for the viewer tests (sim.js and the later sim-*.js files). The sims are made by
// the real builder (buildViewSims, UI1) on storageModel() (nav-view sample + Drizzle storage view), from hand-written s-items,
// a small keysOf table (standing in for the engine's resolveSimTarget) and one check finding, so the steps are shaped exactly
// as the page gets them and the fixture cannot drift from the builder.

export const CREATE = 'api/src/services/orderService.ts#OrderService.create';

/** ref -> keys, as page build's keysOf gives them (uid refs for the IO screens, node ids for the rest). */
export const SIM_KEYS: Record<string, SimRefKeys> = {
  'u-login': { uid: 'u-login', ids: ['shop.web.login'] },
  'u-home': { uid: 'u-home', ids: ['shop.web.home'] },
  'u-cart': { uid: 'u-cart', ids: ['shop.web.cart'] },
  'api/routes': { uid: null, ids: ['api/routes'] },
  [CREATE]: { uid: null, ids: [CREATE] },
  'api/payments': { uid: null, ids: ['api/payments'] },
  [CLASSES]: { uid: null, ids: [CLASSES] },
};

/**
 * Flow s-1 (7 steps): io Login -> io Home -> arch Routes -> arch OrderService.create (call from Routes, unverified by the
 * finding s-1:3-4) -> storage classes with its first rows -> arch Payments (a changed cell and a new row) -> io Cart.
 * Journey s-2: outside stage (email), flow stage s-1 (its 7 steps inline), outside stage: 9 steps.
 */
export function simItems(): SimItem[] {
  return [
    {
      schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Place an order', person: 'Customer',
      steps: [
        { target: ['u-login'], view: 'io', state: 'signed out' },
        { target: ['u-home'], view: 'io' },
        { target: ['api/routes'], view: 'arch', caption: 'POST /orders' },
        { target: [CREATE], view: 'arch', call: { from: 'api/routes', to: CREATE, label: 'create(order)' } },
        { target: [CLASSES], view: 'storage', rows: { [CLASSES]: [{ id: 'c-1', name: 'Yoga', seats: 10 }] } },
        { target: ['api/payments'], view: 'arch', rows: { [CLASSES]: [{ id: 'c-1', name: 'Yoga', seats: 9 }, { id: 'c-2', name: 'Pilates', seats: 12 }] } },
        { target: ['u-cart'], view: 'io', durationSec: 6 },
      ],
    },
    {
      schemaVersion: 1, id: 's-2', kind: 'journey', title: 'Come back and buy', person: 'Customer',
      stages: [
        { name: 'Discover', outside: 'Reads the newsletter', from: 'Newsletter tool', channel: 'email' },
        { name: 'Buy', flow: 's-1', goal: 'Place the order' },
        { name: 'Follow-up', outside: 'Gets the receipt by email', channel: 'email' },
      ],
    },
  ];
}

export const SIM_FINDINGS: PlanFinding[] = [
  { severity: 'info', rule: 'sim-step-unverified', id: 's-1:3-4', message: 'no call found from Routes to OrderService.create' },
];

/** storageModel() with `sims` built by buildViewSims from simItems(). */
export function simModel(): ViewModel {
  const m = storageModel();
  m.sims = buildViewSims(m, {
    items: simItems(), findings: SIM_FINDINGS,
    fileOf: (id) => `.c4pm/projects/shop/sim/${id}.json`,
    keysOf: (ref) => SIM_KEYS[ref] ?? null,
  });
  return m;
}

/** The page of `model` (default simModel()). */
export function simHtml(model: ViewModel = simModel()): string {
  return renderViewHtml(model);
}
