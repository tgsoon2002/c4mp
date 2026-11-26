import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli as spawnCli } from './helpers/runCli';

// P6-T12: real run.
//
// Exercises T1-T11's claim-based ownership engine end to end through the actual CLI (ts-node,
// same invocation style as test/cli-t11.test.ts and test/cli-failon.test.ts), against real
// on-disk fixtures -- not direct unit calls into checkPlan/resolveOwnership/buildViewModel like
// test/ownership.test.ts and test/check.test.ts already cover. This is the integration proof
// that the wiring (parser -> resolve -> snapshot -> check/view) works on a real repo tree, not
// just on hand-built Plan/Snapshot objects.

const projectRoot = path.resolve(__dirname, '..');

function runCli(args: string[]) {
  return spawnCli([...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function extractViewData(html: string): any {
  const match = html.match(/window\.C4PM_DATA = (.*);<\/script>/);
  if (!match) {
    throw new Error('window.C4PM_DATA not found in rendered HTML');
  }
  return JSON.parse(match[1]);
}

describe('P6-T12 real run: plan-only fixture (zero src files)', () => {
  function buildPlanOnlyRepo(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t12-planonly-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'architecture.c4'),
      `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node, Telegram bot' }
    web = container 'Web' { technology 'React' }
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'feature.c4'),
      `model {
  extend app.api {
    orders = component 'Orders' {
      technology 'TypeScript'
      link ./orders.ts#placeOrder 'Entry'
      metadata {
        status 'in-progress'
      }
    }
  }

  extend app.web {
    checkout = component 'Checkout' {
      technology 'React'
      link ./Checkout.tsx 'Entry'
    }
  }
}
`
    );

    // No src/*.ts files at all -- this fixture reproduces the portable-build bug report's
    // scenario 1:1: a plan declaring containers/components with zero parsed code anywhere.
    return tmpDir;
  }

  it('c4pm view produces non-empty output: both containers + both components render with zero code', () => {
    const repo = buildPlanOnlyRepo();
    const outFile = path.join(repo, 'view.html');
    try {
      const result = runCli(['view', '--repo', repo, '--out', outFile]);
      expect(result.status).toBe(0);

      const html = fs.readFileSync(outFile, 'utf8');
      const data = extractViewData(html);

      // Exact findings, reported verbatim rather than just asserted: 2 components, both
      // containers present, API container's technology from the plan (not folder-scan default).
      expect(data.summary).toContain('2 components');

      const findNode = (node: any, id: string): any => {
        if (node.id === id) return node;
        for (const child of node.children ?? []) {
          const found = findNode(child, id);
          if (found) return found;
        }
        return null;
      };

      const api = findNode(data.root, 'app.api');
      const web = findNode(data.root, 'app.web');
      expect(api?.detail).toBe('Node, Telegram bot');
      expect(web?.name).toBe('Web');

      const orders = findNode(data.root, 'app.api.orders');
      const checkout = findNode(data.root, 'app.web.checkout');
      expect(orders?.name).toBe('Orders');
      expect(checkout?.name).toBe('Checkout');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('c4pm check runs cleanly against the plan-only fixture (no crash, no code to flag)', () => {
    const repo = buildPlanOnlyRepo();
    try {
      const result = runCli(['check', '--repo', repo]);
      expect(result.status).toBe(0);
      // Zero source files -> nothing can be unassigned/split/conflicting/shared; the only
      // possible claim-mode finding shape here is none at all.
      expect(result.stdout).not.toContain('Error');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('P6-T12 real run: Orders/Payments/Auth/Shared/Unassigned ownership scenario on disk', () => {
  // Same scenario shape as test/ownership.test.ts / test/check.test.ts's hand-built Plan+Snapshot
  // fixtures (and Document/v0.3-viewer-mock.html's fake-data scenario), but built as a real repo
  // on disk and exercised through the actual CLI pipeline (parser -> importer -> resolve ->
  // ownership -> check), not direct function calls -- this is what proves the real import scanner
  // produces the same fileEdges the unit tests assumed.
  function buildOwnershipRepo(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t12-ownership-'));
    const srcDir = path.join(tmpDir, 'src');
    const ordersDir = path.join(srcDir, 'orders');
    fs.mkdirSync(ordersDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'architecture.c4'),
      `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node' }
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'auth.c4'),
      `model {
  extend app.api {
    auth = component 'Auth' {
      technology 'TypeScript'
      link ./orders/ 'Orders folder (loses to function claims below)'
      link ./util.ts#formatDate 'Format date'
    }
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'orders.c4'),
      `model {
  extend app.api {
    orders = component 'Orders' {
      technology 'TypeScript'
      link ./orders/order.ts#createOrder 'Create order'
      link ./orders/order.ts#listOrders 'List orders'
    }
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'payments.c4'),
      `model {
  extend app.api {
    payments = component 'Payments' {
      technology 'TypeScript'
      link ./payments.ts#createPayment 'Create payment'
      link ./util.ts#formatDate 'Format date'
      link ./orders/order.ts#cancelOrder 'Cancel order'
    }
  }
}
`
    );

    // order.ts: 3 functions. createOrder/listOrders claimed by Orders (function claims beat
    // Auth's folder claim -> specificity conflict). cancelOrder claimed by Payments -> order.ts
    // ends up split across two real owners -> split-file finding. order.ts imports payments.ts,
    // so refundPayment (unclaimed) becomes shared-auto, used by both Orders and Payments (both
    // own functions in the importing file).
    fs.writeFileSync(
      path.join(ordersDir, 'order.ts'),
      `import { createPayment } from '../payments';

export function createOrder() {
  return createPayment();
}

export function listOrders() {
  return [];
}

export function cancelOrder() {
  return true;
}
`
    );

    // payments.ts: createPayment claimed by Payments; refundPayment unclaimed -> shared-auto
    // (imported by order.ts, which is owned by Orders+Payments).
    fs.writeFileSync(
      path.join(srcDir, 'payments.ts'),
      `export function createPayment() {
  return 'payment';
}

export function refundPayment() {
  return 'refund';
}
`
    );

    // util.ts: formatDate claimed by both Auth and Payments at the same (function) specificity
    // -> plan-order conflict, Auth wins (appears first in plan.elements). parseConfig is claimed
    // by nobody and imported by nobody claimed -> unassigned-code.
    fs.writeFileSync(
      path.join(srcDir, 'util.ts'),
      `export function formatDate() {
  return 'date';
}

export function parseConfig() {
  return {};
}
`
    );

    return tmpDir;
  }

  it('c4pm check reports all four new claim-mode finding types with the right severities', () => {
    const repo = buildOwnershipRepo();
    try {
      const result = runCli(['check', '--repo', repo]);
      expect(result.status).toBe(0);
      const out = result.stdout;

      // Exact findings reported verbatim (not just "non-empty"):
      //
      // component-claim-conflict (warning) x4 (elementIds are full plan fqns, nested under the
      // `api` container -- app.api.orders / app.api.auth / app.api.payments, not app.orders):
      //   - src/orders/order.ts#createOrder: app.api.orders over app.api.auth (specificity)
      //   - src/orders/order.ts#listOrders:  app.api.orders over app.api.auth (specificity)
      //   - src/orders/order.ts#cancelOrder: app.api.payments over app.api.auth (specificity)
      //   - src/util.ts#formatDate:          app.api.auth over app.api.payments (plan-order)
      // split-file (info) x1: src/orders/order.ts, owners app.api.orders/app.api.payments,
      //   minority app.api.payments (cancelOrder)
      // shared-auto (info) x1: src/payments.ts#refundPayment, used by app.api.orders, app.api.payments
      // unassigned-code (critical) x1: src/util.ts#parseConfig

      const conflictLines = out.split('\n').filter((l) => l.includes('component-claim-conflict'));
      expect(conflictLines).toHaveLength(4);
      expect(conflictLines.every((l) => l.startsWith('warning'))).toBe(true);
      expect(out).toContain('app.api.orders wins ownership of src/orders/order.ts#createOrder over app.api.auth (reason: specificity)');
      expect(out).toContain('app.api.orders wins ownership of src/orders/order.ts#listOrders over app.api.auth (reason: specificity)');
      expect(out).toContain('app.api.payments wins ownership of src/orders/order.ts#cancelOrder over app.api.auth (reason: specificity)');
      expect(out).toContain('app.api.auth wins ownership of src/util.ts#formatDate over app.api.payments (reason: plan-order)');

      const splitLines = out.split('\n').filter((l) => l.includes('split-file'));
      expect(splitLines).toHaveLength(1);
      expect(splitLines[0].startsWith('info')).toBe(true);
      expect(out).toContain('src/orders/order.ts is split across owners app.api.orders, app.api.payments; minority: app.api.payments (cancelOrder)');

      const sharedLines = out.split('\n').filter((l) => l.includes('shared-auto'));
      expect(sharedLines).toHaveLength(1);
      expect(sharedLines[0].startsWith('info')).toBe(true);
      expect(out).toContain('src/payments.ts#refundPayment is unclaimed but used by app.api.orders, app.api.payments; treated as shared code');

      const unassignedLines = out.split('\n').filter((l) => l.includes('unassigned-code'));
      expect(unassignedLines).toHaveLength(1);
      expect(unassignedLines[0].startsWith('critical')).toBe(true);
      expect(out).toContain('no component claims src/util.ts#parseConfig and nothing calls it');

      // No folder-mode unplanned-code findings leak in alongside the claim-mode ones.
      expect(out).not.toContain('unplanned-code');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
