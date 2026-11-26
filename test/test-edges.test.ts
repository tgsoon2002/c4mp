import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { parsePlan } from '../src/plan/parser';
import { compareSnapshots } from '../src/compare';
import type { Snapshot, TestsConfig } from '../src/types';

// Phase 26 T26-3 (D8, D17): a test file gives no component edge (arrow); snapshot.fileEdges keeps its imports.
// Both rollup call sites: folder mode (pipeline) and claim mode (buildSnapshot re-roll with a plan). The plan holds a
// `#function` link: without one it is a folder-mode plan (PS-5.10, isClaimModePlan) and the re-roll never runs.
// Folder mode forms no test component (T26-14b, D9): the test file's componentId is 'unassigned'. In claim mode the
// plan's components are the boxes, so the Tests box stays and only its arrows go.

const FILES: Record<string, string> = {
  'package.json': '{ "name": "shop" }\n',
  'src/app.ts': "import { util } from '../lib/util';\nexport function app() { return util(); }\n",
  'lib/util.ts': 'export function util() { return 1; }\n',
  // No test case in the test file: T26-4 cases exist only when tests.globs matches, so a case would show up in compare too.
  'test/app.test.ts': "import { app } from '../src/app';\nimport { util } from '../lib/util';\nconsole.log(app() + util());\n",
  'c4/plan.c4': `specification {
  element system
  element component
}
model {
  shop = system 'Shop' {
    app = component 'App' { link ../src/app.ts#app }
    util = component 'Util' { link ../lib/ }
    tests = component 'Tests' { link ../test/ }
  }
}
`,
};

describe('test files give no component edges', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-edges-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // `tests.globs: []` marks no test file: the edges every importer gave before T26-3.
  const scan = (claim: boolean, tests?: TestsConfig): Snapshot =>
    runSnapshot({
      repo: root, write: false, quiet: true,
      config: tests ? { tests } : {},
      plan: claim ? parsePlan(root, ['c4/plan.c4']) : undefined,
    });
  const ownerOf = (s: Snapshot, file: string) => s.files.find((f) => f.file === file)!.componentId;
  const edgeKeys = (s: Snapshot) => s.componentEdges.map((e) => `${e.from} -> ${e.to}`);

  describe.each([
    ['folder mode', false, 'unassigned'],
    ['claim mode', true, 'shop.tests'],
  ])('%s', (_mode, claim, testOwner) => {
    let snap: Snapshot;
    let before: Snapshot;
    beforeAll(() => {
      snap = scan(claim as boolean);
      before = scan(claim as boolean, { globs: [] });
    });

    it('a source file importing another component gives an edge; the test file importing both gives none', () => {
      const test = ownerOf(snap, 'test/app.test.ts');
      expect(test).toBe(testOwner);
      expect(edgeKeys(snap)).toEqual([`${ownerOf(snap, 'src/app.ts')} -> ${ownerOf(snap, 'lib/util.ts')}`]);
      expect(snap.componentEdges.some((e) => e.from === test || e.to === test)).toBe(false);
      expect(snap.components.map((c) => c.id).includes(test)).toBe(testOwner !== 'unassigned');   // a box only in claim mode
    });

    it('snapshot.fileEdges keeps the test importers', () => {
      expect(snap.fileEdges.filter((e) => e.from === 'test/app.test.ts')).toEqual([
        { from: 'test/app.test.ts', to: 'lib/util.ts' },
        { from: 'test/app.test.ts', to: 'src/app.ts' },
      ]);
    });

    it('compare across the change shows only the removed test edges (and in folder mode the test box)', () => {
      const test = ownerOf(before, 'test/app.test.ts');   // the test folder's owner while no file was a test
      const removed = edgeKeys(before).filter((k) => !edgeKeys(snap).includes(k));
      expect(removed.length).toBeGreaterThan(0);
      expect(removed.every((k) => k.startsWith(`${test} -> `))).toBe(true);
      const box = testOwner === 'unassigned' ? [`component removed ${test}`] : [];
      expect(compareSnapshots(before, snap).changes.map((c) => `${c.type} ${c.kind} ${c.id}`)).toEqual(
        [...box, ...removed.map((k) => `edge removed ${k}`)]
      );
    });
  });
});
