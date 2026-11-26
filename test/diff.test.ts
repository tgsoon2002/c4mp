import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Snapshot } from '../src/types';
import { runSnapshot } from '../src/pipeline';
import { compareSnapshots } from '../src/compare/index';
import { formatText } from '../src/compare/report';

describe('diff', () => {
  let v1: any;
  let v2: any;

  beforeAll(() => {
    const samplePath = path.join(__dirname, 'fixtures/sample');
    const sampleV2Path = path.join(__dirname, 'fixtures/sample-v2');

    v1 = runSnapshot({ repo: samplePath, write: false, quiet: true });
    v2 = runSnapshot({ repo: sampleV2Path, write: false, quiet: true });
  });

  describe('compareSnapshots', () => {
    it('should produce correct summary', () => {
      const diff = compareSnapshots(v1, v2);

      // Expected summary per spec §3.2:
      // components +1 −1 renamed 1 changed 3 · files +1 −1 renamed 2 changed 4 · elements +3 −2 changed 3
      // edges +2 −2 · cycles +1 −1 · lines 69 → 79
      // b568: content hashes add two same-length edits the line counts missed: api/src/server.ts (re-export path
      // './lib/log' -> './utils/log', 9 lines both) is a changed file; web/src/App.tsx#App (renders text instead of
      // <Cart />, 3 lines both) is a changed function. App.tsx itself was already changed (5 -> 3 lines).
      expect(diff.summary).toEqual({
        componentsAdded: 1,
        componentsRemoved: 1,
        componentsRenamed: 1,
        componentsModified: 3,
        filesAdded: 1,
        filesRemoved: 1,
        filesRenamed: 2,
        filesModified: 4,
        elementsAdded: 3,
        elementsRemoved: 2,
        elementsModified: 3,
        edgesAdded: 2,
        edgesRemoved: 2,
        cyclesAdded: 1,
        cyclesRemoved: 1,
        linesBefore: 69,
        linesAfter: 79,
      });
    });

    it('should produce 30 changes in correct order', () => {
      const diff = compareSnapshots(v1, v2);

      // Expected 28 changes per spec §3.2, + 2 same-length content edits (b568, see the summary test)
      const expectedRows = [
        // WARNING (4)
        ['warning', 'component', 'modified', 'api/services', null, 17, 36, 'component-grew'],
        ['warning', 'component', 'removed', 'web/components', null, 14, null, 'component-removed'],
        ['warning', 'file', 'modified', 'api/src/services/orderService.ts', null, 17, 36, 'file-grew'],
        ['warning', 'cycle', 'added', 'api/routes <-> api/services', null, null, null, 'cycle-added'],
        // INFO (26)
        ['info', 'component', 'added', 'api/payments', null, null, 5, 'component-added'],
        ['info', 'component', 'modified', 'api/routes', null, 10, 12, 'component-changed'],
        ['info', 'component', 'renamed', 'api/utils', 'api/lib', 6, 6, 'component-renamed'],
        ['info', 'component', 'modified', 'web/_root', null, 5, 3, 'component-changed'],
        ['info', 'file', 'added', 'api/src/payments/stripe.ts', null, null, 5, 'file-added'],
        ['info', 'file', 'modified', 'api/src/routes/orders.ts', null, 10, 12, 'file-changed'],
        ['info', 'file', 'modified', 'api/src/server.ts', null, 9, 9, 'file-changed'],
        ['info', 'file', 'renamed', 'api/src/utils/log.ts', 'api/src/lib/log.ts', 3, 3, 'file-renamed'],
        ['info', 'file', 'renamed', 'api/src/utils/missing-user.ts', 'api/src/lib/missing-user.ts', 3, 3, 'file-renamed'],
        ['info', 'file', 'modified', 'web/src/App.tsx', null, 5, 3, 'file-changed'],
        ['info', 'file', 'removed', 'web/src/components/Cart.jsx', null, 14, null, 'file-removed'],
        ['info', 'element', 'added', 'api/src/payments/stripe.ts#charge', null, null, 3, 'element-added'],
        ['info', 'element', 'modified', 'api/src/routes/orders.ts#orderRoutes', null, 7, 8, 'element-changed'],
        ['info', 'element', 'modified', 'api/src/services/orderService.ts#OrderService', null, 15, 33, 'element-changed'],
        ['info', 'element', 'added', 'api/src/services/orderService.ts#OrderService.bulkCreate', null, null, 13, 'element-added'],
        ['info', 'element', 'added', 'api/src/services/orderService.ts#OrderService.register', null, null, 3, 'element-added'],
        ['info', 'element', 'modified', 'web/src/App.tsx#App', null, 3, 3, 'element-changed'],
        ['info', 'element', 'removed', 'web/src/components/Cart.jsx#Cart', null, 3, null, 'element-removed'],
        ['info', 'element', 'removed', 'web/src/components/Cart.jsx#loadApp', null, 4, null, 'element-removed'],
        ['info', 'edge', 'added', 'api/routes -> api/payments', null, null, 1, 'edge-added'],
        ['info', 'edge', 'added', 'api/services -> api/routes', null, null, 1, 'edge-added'],
        ['info', 'edge', 'removed', 'web/_root -> web/components', null, 1, null, 'edge-removed'],
        ['info', 'edge', 'removed', 'web/components -> web/_root', null, 1, null, 'edge-removed'],
        ['info', 'cycle', 'removed', 'web/_root <-> web/components', null, null, null, 'cycle-removed'],
        ['info', 'external', 'removed', 'react', null, null, null, 'external-removed'],
        ['info', 'external', 'added', 'stripe', null, null, null, 'external-added'],
      ];

      expect(diff.changes.length).toBe(30);

      for (let i = 0; i < expectedRows.length; i++) {
        const [
          expectedSeverity,
          expectedType,
          expectedKind,
          expectedId,
          expectedRenamedFrom,
          expectedBefore,
          expectedAfter,
          expectedRule,
        ] = expectedRows[i];

        const change = diff.changes[i];

        expect([change.severity, i]).toEqual([expectedSeverity, i]);
        expect([change.type, i]).toEqual([expectedType, i]);
        expect([change.kind, i]).toEqual([expectedKind, i]);
        expect([change.id, i]).toEqual([expectedId, i]);
        expect([change.renamedFrom ?? null, i]).toEqual([expectedRenamedFrom, i]);
        expect([change.before ?? null, i]).toEqual([expectedBefore, i]);
        expect([change.after ?? null, i]).toEqual([expectedAfter, i]);
        expect([change.rule, i]).toEqual([expectedRule, i]);
      }
    });

    it('should produce correct text report', () => {
      const diff = compareSnapshots(v1, v2);
      const text = formatText(diff);

      // Expected text per spec §3.2 (from line 2 onwards, skipping first line header)
      const expectedText =
        `Summary: components +1 -1 renamed 1 changed 3 | files +1 -1 renamed 2 changed 4 | functions +3 -2 changed 3 | dependencies +2 -2 | cycles +1 -1 | lines 69 → 79 (+10)

CRITICAL (0)
WARNING (4)
  component grew: api/services 17 → 36 lines (x2.1)
  component removed: web/components (14 lines)
  file grew: api/src/services/orderService.ts 17 → 36 lines (x2.1)
  cycle added: api/routes <-> api/services
INFO (26)
  component added: api/payments (5 lines)
  component changed: api/routes 10 → 12 lines
  component renamed: api/lib → api/utils
  component changed: web/_root 5 → 3 lines
  file added: api/src/payments/stripe.ts (5 lines)
  file changed: api/src/routes/orders.ts 10 → 12 lines
  file changed: api/src/server.ts 9 → 9 lines
  file renamed: api/src/lib/log.ts → api/src/utils/log.ts
  file renamed: api/src/lib/missing-user.ts → api/src/utils/missing-user.ts
  file changed: web/src/App.tsx 5 → 3 lines
  file removed: web/src/components/Cart.jsx (14 lines)
  function added: api/src/payments/stripe.ts#charge (3 lines)
  function changed: api/src/routes/orders.ts#orderRoutes 7 → 8 lines
  class changed: api/src/services/orderService.ts#OrderService 15 → 33 lines
  method added: api/src/services/orderService.ts#OrderService.bulkCreate (13 lines)
  method added: api/src/services/orderService.ts#OrderService.register (3 lines)
  function changed: web/src/App.tsx#App 3 → 3 lines
  function removed: web/src/components/Cart.jsx#Cart (3 lines)
  function removed: web/src/components/Cart.jsx#loadApp (4 lines)
  dependency added: api/routes -> api/payments
  dependency added: api/services -> api/routes
  dependency removed: web/_root -> web/components
  dependency removed: web/components -> web/_root
  cycle removed: web/_root <-> web/components
  package removed: react
  package added: stripe`;

      const lines = text.split('\n');
      const reportText = lines.slice(1).join('\n');

      expect(reportText).toBe(expectedText);
    });

    it('should return 0 changes when comparing snapshot with itself', () => {
      const diff = compareSnapshots(v1, v1);
      expect(diff.changes.length).toBe(0);
    });
  });

  // b568 + b582: a content hash per file and element, so edits that keep the line count are changes too.
  describe('content hash (b568, b582)', () => {
    const A = 'export function f(x: number): number {\n  return x + 1;\n}\nconst g = (y: number) => y;\n';
    const dirs: string[] = [];
    // Each snapshot scans a new temp folder; the repo folder inside it is always 'shop' (container ids are its name).
    const snapOf = (code: string): Snapshot => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-diffhash-'));
      dirs.push(tmp);
      const dir = path.join(tmp, 'shop');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), code);
      return runSnapshot({ repo: dir, write: false, quiet: true });
    };
    const changed = (a: Snapshot, b: Snapshot) =>
      compareSnapshots(a, b).changes.map((c) => [c.type, c.kind, c.id, c.before, c.after]);
    const withoutHashes = (snap: Snapshot): Snapshot => ({
      ...snap,
      files: snap.files.map(({ hash, ...f }) => ({ ...f, elements: f.elements.map(({ hash: h, ...e }) => e) })),
    });
    afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

    it('a body edit with the same line count changes the function and its file', () => {
      expect(changed(snapOf(A), snapOf(A.replace('x + 1', 'x * 2')))).toEqual([
        ['file', 'modified', 'src/a.ts', 4, 4],
        ['element', 'modified', 'src/a.ts#f', 3, 3],
      ]);
    });

    it('adding export in front of a const changes that element (b582)', () => {
      expect(changed(snapOf(A), snapOf(A.replace('const g', 'export const g')))).toEqual([
        ['file', 'modified', 'src/a.ts', 4, 4],
        ['element', 'modified', 'src/a.ts#g', 1, 1],
      ]);
    });

    it('an unchanged file in another folder, or with CRLF line ends, is no change (same hashes)', () => {
      const a = snapOf(A);
      const b = snapOf(A);
      const crlf = snapOf(A.replace(/\n/g, '\r\n'));
      expect(changed(a, b)).toEqual([]);
      expect(changed(a, crlf)).toEqual([]);
      expect(b.files[0].hash).toMatch(/^[0-9a-f]{16}$/);
      expect(b.files[0].elements.map((e) => e.hash)).toEqual(a.files[0].elements.map((e) => e.hash));
    });

    it('a snapshot without hashes (older history) compares by line count: no flood of changes', () => {
      const old = withoutHashes(snapOf(A));
      expect(changed(old, snapOf(A))).toEqual([]);
      expect(changed(snapOf(A), old)).toEqual([]);
      expect(changed(old, snapOf(A.replace('x + 1', 'x * 2')))).toEqual([]);   // same-length edits need both hashes
      expect(changed(old, snapOf(A + 'function h() {}\n'))).toEqual([
        ['component', 'modified', 'shop/_root', 4, 5],
        ['file', 'modified', 'src/a.ts', 4, 5],
        ['element', 'added', 'src/a.ts#h', undefined, 1],
      ]);
    });
  });
});
