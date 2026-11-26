import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { depsOf } from '../src/query/deps';
import { getModel } from '../src/query/elements';
import { QueryError } from '../src/query/errors';
import { formatDeps } from '../src/query/format';
import { runSnapshot } from '../src/pipeline';
import { historyDir, saveToHistory } from '../src/history/store';
import { runCli } from './helpers/runCli';
import type { GitInfo } from '../src/types';

// b468: `c4pm deps <element> --compare <ref>` = per target box, the weight at a stored snapshot -> now.
// Stored snapshots are plan-less (as `c4pm history` stores them); the store is a temp folder given as config `store`.

const FIX = path.join(__dirname, 'fixtures');
const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qdcmp-'));
  tmps.push(d);
  return d;
}

function copy(name: string): { repo: string; store: string } {
  const dir = tmpDir();
  const repo = path.join(dir, name);
  fs.cpSync(path.join(FIX, name), repo, { recursive: true });
  return { repo, store: path.join(dir, 'store') };
}

const git = (n: number): GitInfo => ({
  commit: `${String(n).repeat(7)}${'f'.repeat(33)}`, branch: 'main', date: `2026-0${n}-01T10:00:00Z`, depth: n,
});

/** Save a plan-less snapshot of the tree as it is now (what `c4pm history` stores), with a fake commit. */
function save(repo: string, store: string, n: number): string {
  return saveToHistory(store, runSnapshot({ repo, write: false, quiet: true, meta: { git: git(n) } })).id;
}

const ctxOf = (repo: string, store: string): QueryContext => loadQueryContext(repo, { cli: { store } });
const errOf = (fn: () => unknown): QueryError => {
  try { fn(); } catch (e) { return e as QueryError; }
  throw new Error('expected a QueryError');
};

/** Every container, layer and component of the map. */
function boxes(ctx: QueryContext): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (['container', 'subregion', 'component'].includes(n.kind)) out.push(n.id);
    [...(n.subregions ?? []), ...n.children].forEach(walk);
  };
  walk(getModel(ctx).root);
  return out;
}

describe('depsOf with compare (b468)', () => {
  it('folder mode: new, gone and changed arrows; text marks them and counts the unchanged', () => {
    const { repo, store } = copy('sample');
    save(repo, store, 1);
    // routes: drop the lib import (gone), import the models (new), a second routes file imports the services (changed)
    const orders = path.join(repo, 'api/src/routes/orders.ts');
    fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace("import log from '@lib/log';", "import { makeOrder } from '../models/order';"));
    fs.writeFileSync(path.join(repo, 'api/src/routes/extra.ts'), "import { OrderService } from '../services/orderService';\nexport const s = new OrderService();\n");

    const r = depsOf(ctxOf(repo, store), 'api/routes', { compare: 'latest' });
    expect(r.compare!.uses).toEqual([
      { id: 'api/models', title: 'Models', before: 0, after: 1, status: 'new' },
      { id: 'api/lib', title: 'Lib', before: 1, after: 0, status: 'gone' },
      { id: 'api/services', title: 'Services', before: 1, after: 2, status: 'changed' },
    ]);
    expect(r.compare!.usedBy).toEqual([{ id: 'api/_root', title: expect.any(String), before: 1, after: 1, status: 'same' }]);
    expect(r.compare!.entry).toEqual({ id: '2026-01-01T100000Z--1111111', commit: git(1).commit, commitDate: git(1).date });

    const text = formatDeps(r);
    expect(text).toContain('compare: latest (2026-01-01T100000Z--1111111, 1111111, 2026-01-01) -> now\nuses (was -> now):\n'
      + '  + api/models  Models  0 -> 1  new\n  - api/lib  Lib  1 -> 0  gone\n  ~ api/services  Services  1 -> 2\n'
      + 'used by (was -> now): no change (1 unchanged)');
    // the plain uses / used by blocks print as without --compare
    expect(text.startsWith(formatDeps(depsOf(ctxOf(repo, store), 'api/routes')))).toBe(true);
  });

  it.each(['sample', 'layers-claim', 'phofast'])('an unchanged tree compares all same, with the weights deps prints: %s', (name) => {
    const { repo, store } = copy(name);
    save(repo, store, 1);
    const ctx = ctxOf(repo, store);
    let rows = 0;
    for (const id of boxes(ctx)) {
      const r = depsOf(ctx, id, { compare: 'latest' });
      for (const [rowsOf, edges] of [[r.compare!.uses, r.uses], [r.compare!.usedBy, r.usedBy]] as const) {
        expect(rowsOf.filter((x) => x.status !== 'same')).toEqual([]);
        expect(rowsOf.map((x) => ({ id: x.id, title: x.title, weight: x.after }))).toEqual(edges);
        rows += rowsOf.length;
      }
    }
    expect(rows).toBeGreaterThan(0);
  });

  it('claim mode: the stored snapshot is plan-less, yet its files count for today\'s plan boxes', () => {
    const { repo, store } = copy('layers-claim');
    const id = save(repo, store, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(historyDir(store, ctxOf(repo, store).snapshot.system.id), `${id}.json`), 'utf8'));
    expect(stored.components[0].mode).not.toBe('claim');
    // now: pages also imports the store directly (a new arrow that skips the logic layer)
    const page = path.join(repo, 'web/src/page.ts');
    fs.writeFileSync(page, "import { savePrice } from '../../api/src/store';\n" + fs.readFileSync(page, 'utf8').replace("return placeOrder('1');", "return placeOrder('1') + savePrice('2');"));
    const r = depsOf(ctxOf(repo, store), 'shop.web.pages', { compare: 'latest' });
    expect(r.compare!.uses).toEqual([
      { id: 'shop.api.data.store', title: 'Store', before: 0, after: 1, status: 'new' },
      { id: 'shop.api.logic.orders', title: 'Orders', before: 2, after: 2, status: 'same' },   // import + plan relation
    ]);
    // the layer rolls up the same way
    const data = depsOf(ctxOf(repo, store), 'shop.api.data', { compare: 'latest' });
    expect(data.compare!.usedBy.map((x) => [x.id, x.before, x.after, x.status])).toEqual([
      ['shop.web.pages', 0, 1, 'new'],
      ['shop.api.logic', 2, 2, 'same'],
    ]);
  });

  it('refs: prev, a commit prefix, a date; an unknown ref lists the known ids; no store gives the init hint', () => {
    const { repo, store } = copy('sample');
    const first = save(repo, store, 1);
    fs.writeFileSync(path.join(repo, 'api/src/routes/extra.ts'), "import { OrderService } from '../services/orderService';\nexport const s = new OrderService();\n");
    const second = save(repo, store, 2);
    const ctx = ctxOf(repo, store);
    const servicesBefore = (ref: string): number => depsOf(ctx, 'api/routes', { compare: ref }).compare!.uses.find((x) => x.id === 'api/services')!.before;
    expect(depsOf(ctx, 'api/routes', { compare: 'prev' }).compare!.entry.id).toBe(first);
    expect(servicesBefore('prev')).toBe(1);
    expect(servicesBefore('2222222')).toBe(2);
    expect(servicesBefore('2026-01-15')).toBe(1);
    expect(depsOf(ctx, 'api/routes', { compare: 'latest' }).compare!.entry.id).toBe(second);

    const unknown = errOf(() => depsOf(ctx, 'api/routes', { compare: 'nope' }));
    expect(unknown).toBeInstanceOf(QueryError);
    expect(unknown.code).toBe('invalid');
    expect(unknown.message).toContain(first);
    expect(unknown.message).toContain(second);

    const noStore = errOf(() => depsOf(loadQueryContext(repo), 'api/routes', { compare: 'latest' }));
    expect(noStore.code).toBe('invalid');
    expect(noStore.message).toMatch(/c4mp init/);
    expect(fs.existsSync(path.join(repo, '.c4pm'))).toBe(false);
  });
});

describe('deps --compare through the real CLI (b468)', () => {
  it('--compare prev --json --store: one object with compare; the repo is not written', () => {
    const { repo, store } = copy('sample');
    save(repo, store, 1);
    fs.writeFileSync(path.join(repo, 'api/src/routes/extra.ts'), "import { OrderService } from '../services/orderService';\nexport const s = new OrderService();\n");
    save(repo, store, 2);
    const listing = (): string[] => fs.readdirSync(repo, { recursive: true }).map(String).sort();
    const before = listing();
    const r = runCli(['deps', 'api/routes', '--repo', repo, '--compare', 'prev', '--store', store, '--json']);
    expect([r.status, r.stderr]).toEqual([0, '']);
    const obj = JSON.parse(r.stdout);
    expect(obj.compare).toMatchObject({ ref: 'prev', entry: { commit: git(1).commit } });
    expect(obj.compare.uses.find((x: any) => x.id === 'api/services')).toEqual({ id: 'api/services', title: 'Services', before: 1, after: 2, status: 'changed' });
    expect(Object.keys(obj)).toContain('usedBy');
    const text = runCli(['deps', 'api/routes', '--repo', repo, '--compare', 'prev', '--store', store]);
    expect(text.stdout).toContain('  ~ api/services  Services  1 -> 2\n');
    const bad = runCli(['deps', 'api/routes', '--repo', repo, '--compare', 'nope', '--store', store]);
    expect([bad.status, bad.stdout]).toEqual([1, '']);
    expect(bad.stderr).toMatch(/^error: invalid: Unknown snapshot ref 'nope'/);
    expect(listing()).toEqual(before);
  }, 120000);
});
