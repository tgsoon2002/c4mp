import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { testFileMatcher, ignoreReachMatcher, DEFAULT_TEST_GLOBS } from '../src/importer/testMatch';
import { listStoreFiles } from '../src/schema/storeScan';
import { saveToHistory, loadManifest, loadFromHistory } from '../src/history/store';
import { compareSnapshots } from '../src/compare';
import type { Snapshot, TestsConfig } from '../src/types';

// Phase 26 T26-1: config `tests` marks test files; the snapshot gives them role 'test', the store readers skip them.

describe('testFileMatcher: default tests.globs', () => {
  const isTest = testFileMatcher(undefined);
  it.each([
    ['src/a.test.ts', true],
    ['src/deep/b.spec.tsx', true],
    ['test/helpers.ts', true],                // helper below a test folder: role test too (D7)
    ['pkg/tests/conftest.py', true],
    ['Tests/SessionTests.swift', true],
    ['src/__tests__/c.ts', true],
    ['lib/test_utils.py', true],
    ['cmd/main_test.go', true],
    ['tests/AppTest.php', true],
    ['src/FooTests.cs', true],
    ['src/FooTest.cs', true],
    ['src/helper/testing/index.ts', false],   // hono's shipped testing helper is source
    ['Slim/Exception/HttpSpecializedException.php', false],
    ['src/contest.ts', false],
    ['src/latest/a.ts', false],
  ])('%s -> %s', (rel, expected) => {
    expect(isTest(rel)).toBe(expected);
  });

  it('the AI guide lists every default (the --tests help points there)', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'guide', 'ai.md'), 'utf8');
    expect(DEFAULT_TEST_GLOBS.filter((g) => !guide.includes(`\`${g}\``))).toEqual([]);
  });

  it('config globs replace the defaults; ignoreReach has no default', () => {
    const custom = testFileMatcher({ globs: ['spec/'] });
    expect([custom('spec/a.rb'), custom('src/a.test.ts')]).toEqual([true, false]);
    expect(ignoreReachMatcher(undefined)('src/log.ts')).toBe(false);
    expect(ignoreReachMatcher({ ignoreReach: ['src/log.ts', '**/paths.ts'] })('src/x/paths.ts')).toBe(true);
  });
});

describe('role test on a scanned fixture', () => {
  const FILES: Record<string, string> = {
    'src/app.ts': "import { util } from './util';\nexport function app() { return util(); }\n",
    'src/util.ts': 'export function util() { return 1; }\n',
    'src/app.test.ts': "import { app } from './app';\ndescribe('app', () => { it('runs', () => app()); });\n",
    'src/util.spec.ts': "import { util } from './util';\nit('util', () => util());\n",
    'test/helpers.ts': 'export function helper() { return 2; }\n',
    'src/testing/index.ts': 'export function mockApp() { return 3; }\n',
    'db/schema.sql': 'CREATE TABLE users (id integer PRIMARY KEY);\n',
    'test/data/schema.sql': 'CREATE TABLE fixture (id integer PRIMARY KEY);\n',
  };
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-role-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const scan = (tests?: TestsConfig): Snapshot => runSnapshot({ repo: root, write: false, quiet: true, config: tests ? { tests } : {} });
  const testFilesIn = (s: Snapshot) => s.files.filter((f) => f.role === 'test').map((f) => f.file);

  it.each([
    ['defaults', undefined, ['src/app.test.ts', 'src/util.spec.ts', 'test/helpers.ts']],
    ['custom globs', { globs: ['src/testing/'] }, ['src/testing/index.ts']],
    ['empty globs', { globs: [] }, []],
  ])('%s: only matching files carry role test, others have no role key', (_label, tests, expected) => {
    const snap = scan(tests as TestsConfig | undefined);
    expect(testFilesIn(snap)).toEqual(expected);
    expect(snap.files.filter((f) => !expected.includes(f.file)).every((f) => !('role' in f))).toBe(true);
    expect(snap.files.every((f) => f.componentId !== '')).toBe(true);   // a test file keeps its owner
    expect(snap.schemaVersion).toBe(2);
  });

  it('an old snapshot without role loads from history and compares with no change', () => {
    const now = scan();
    const old: Snapshot = { ...now, files: now.files.map(({ role: _r, ...f }) => f) };
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-role-store-'));
    try {
      const entry = saveToHistory(store, old);
      const loaded = loadFromHistory(store, now.system.id, loadManifest(store, now.system.id).entries.find((e) => e.id === entry.id)!);
      expect(testFilesIn(loaded)).toEqual([]);
      expect(compareSnapshots(loaded, now).changes).toEqual([]);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('store readers skip test files', () => {
    const files = listStoreFiles(root, { ignore: [], languages: ['typescript'] });
    expect(files.filter((f) => f.endsWith('.sql'))).toEqual(['db/schema.sql']);
    expect(files).not.toContain('src/app.test.ts');
  });
});
