import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CollectCalls, runSnapshot } from '../src/pipeline';
import { callIndex } from '../src/callGraph/callResolve';
import { historyDir, loadFromHistory, saveToHistory } from '../src/history/store';
import type { FileCalls, Snapshot } from '../src/types';

// Phase 26 T26-6: the call data the test attachment needs (ATTACH-DESIGN A1). Calls in a test case belong to the
// case, describe bodies and hooks to <module>; import uses, type-only imports and mocks are recorded; collectCalls
// 'tests' parses calls of test files only; history never stores calls.
const FILES: Record<string, string> = {
  'src/lib.ts': 'export function save() {}\nexport class Store { put() {} }\nexport type Row = { id: number };\n',
  'src/db.ts': 'export function connect() {}\n',
  'src/lib.test.ts': [
    "import { save, Store } from './lib';",                   // 1
    "import type { Row } from './lib';",                      // 2
    "import { type Row as R2, save as keep } from './lib';",  // 3
    "import * as db from './db';",                            // 4
    "jest.mock('./db');",                                     // 5
    "jest.mock('fs');",                                       // 6
    'type K = typeof keep;',                                  // 7: a type position is not a use
    '',
    "describe('lib', () => {",                                // 9
    '  beforeEach(() => db.connect());',                      // 10: hook -> <module>
    "  it('saves', () => {",                                  // 11
    '    const s = new Store();',                             // 12
    '    expect(keep).toBe(save);',                           // 13
    '    save();',                                            // 14
    '  });',
    "  it('one line', () => save());",                        // 16
    "  it('shadowed', () => { const Store = 1; return Store; });",   // 17: the local Store is not the import
    '});',
    '',
  ].join('\n'),
};

let root: string;
let snap: Snapshot;          // collectCalls 'tests'
let testCalls: FileCalls;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-calls-tests-'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  snap = runSnapshot({ repo: root, write: false, quiet: true, collectCalls: 'tests' });
  testCalls = snap.calls!.find((fc) => fc.file === 'src/lib.test.ts')!;
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('calls of a test file', () => {
  it.each([
    ['save', [['lib › saves', 14], ['lib › one line', 16]]],
    ['db.connect', [['<module>', 10]]],
    ['it', [['<module>', 11], ['<module>', 16], ['<module>', 17]]],   // the declaring call is not inside its case
  ])('%s: caller and line', (callee, expected) => {
    expect(testCalls.calls.filter((c) => c.callee === callee).map((c) => [c.caller, c.line])).toEqual(expected);
  });

  it('import type and `type X` specifiers are typeOnly', () => {
    expect(testCalls.bindings.filter((b) => b.typeOnly).map((b) => b.local)).toEqual(['Row', 'R2']);
  });

  it('value uses of imported names outside callee position, not in types or shadowed scopes', () => {
    expect(testCalls.uses).toEqual([{ name: 'Store', line: 12, column: 19 }, { name: 'keep', line: 13, column: 12 }, { name: 'save', line: 13, column: 23 }]);
  });

  it('b682: bindings carry the position of the imported name as written (none for `* as`); calls the called name', () => {
    expect(testCalls.bindings.map((b) => [b.local, b.imported, b.at])).toEqual([
      ['save', 'save', { line: 1, column: 10 }], ['Store', 'Store', { line: 1, column: 16 }], ['Row', 'Row', { line: 2, column: 15 }],
      ['R2', 'Row', { line: 3, column: 15 }], ['keep', 'save', { line: 3, column: 26 }], ['db', '*', undefined],
    ]);
    expect(testCalls.calls.filter((c) => c.callee === 'db.connect').map((c) => [c.line, c.at])).toEqual([[10, { line: 10, column: 23 }]]);
  });

  it('jest.mock lists the mocked specifier; an internal one gets its file', () => {
    expect(testCalls.mocks).toEqual([{ spec: './db', target: 'src/db.ts', line: 5 }, { spec: 'fs', line: 6 }]);
  });

  it('callIndex (parser layer) judges the sites: case -> function, hook -> imported namespace member', () => {
    const edges = callIndex(snap).sites.flatMap((s) => (s.verdict.kind === 'edge' ? [`${s.caller} -> ${s.verdict.file}#${s.verdict.name}`] : []));
    expect(edges).toEqual(['<module> -> src/db.ts#connect', 'lib › saves -> src/lib.ts#save', 'lib › one line -> src/lib.ts#save']);
  });
});

describe('collectCalls option', () => {
  it.each<[CollectCalls | undefined, string[] | undefined]>([
    [true, ['src/db.ts', 'src/lib.test.ts', 'src/lib.ts']],
    ['tests', ['src/lib.test.ts']],
    [undefined, undefined],
  ])('%s -> calls of %j', (collectCalls, expected) => {
    const s = collectCalls === 'tests' ? snap : runSnapshot({ repo: root, write: false, quiet: true, collectCalls });
    expect(s.calls?.map((fc) => fc.file)).toEqual(expected);
  });

  it('a history save keeps no calls', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-calls-store-'));
    try {
      const entry = saveToHistory(store, snap);
      expect(JSON.parse(fs.readFileSync(path.join(historyDir(store, snap.system.id), entry.file), 'utf8'))).not.toHaveProperty('calls');
      expect(loadFromHistory(store, snap.system.id, entry)).toEqual({ ...snap, calls: undefined, imports: undefined });
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});

describe('require declarations (T26-7: test files that require the code they test)', () => {
  it('top-level `const x = require(s)` and `const { a, b: c } = require(s)` bind like imports; the declared names are no uses', () => {
    const file = path.join(root, 'src/req.test.js');
    fs.writeFileSync(file, "const lib = require('./lib');\nconst { save, Store: S } = require('./lib');\nit('r', () => { lib.save(); save(); return S; });\n");
    try {
      const s = runSnapshot({ repo: root, write: false, quiet: true, collectCalls: 'tests' });
      const fc = s.calls!.find((c) => c.file === 'src/req.test.js')!;
      expect([fc.bindings, fc.uses]).toEqual([
        [{ local: 'lib', imported: '*', spec: './lib', target: 'src/lib.ts' },
          { local: 'save', imported: 'save', spec: './lib', target: 'src/lib.ts', at: { line: 2, column: 9 } },
          { local: 'S', imported: 'Store', spec: './lib', target: 'src/lib.ts', at: { line: 2, column: 15 } }],
        [{ name: 'S', line: 3, column: 44 }],
      ]);
      expect(fc.bindings.map((b) => b.at)).toEqual([undefined, { line: 2, column: 9 }, { line: 2, column: 15 }]);   // b682: `{ a: b }` gives the key
      expect(callIndex(s).sites.filter((x) => x.file === 'src/req.test.js' && x.verdict.kind === 'edge').map((x) => x.callee)).toEqual(['lib.save', 'save']);
    } finally {
      fs.rmSync(file);
    }
  });
});

describe('own-name value uses (b682: FileCalls.ownUses)', () => {
  it('a callback, `export { f }` and `new K()` are uses; the declaration, a call and a shadowing parameter are not', () => {
    const file = path.join(root, 'src/own.test.ts');
    fs.writeFileSync(file, [
      'function f(x: number) { return x; }',      // 1: declaration
      'export class K {}',                        // 2
      'export { f };',                            // 3: use
      '[1].map(f);',                              // 4: use (callback)
      'function g(f: number) { return f; }',      // 5: the parameter f is not the function
      'const k = new K();',                       // 6: use
      'f(1);',                                    // 7: a call, not a use
      '',
    ].join('\n'));
    try {
      const s = runSnapshot({ repo: root, write: false, quiet: true, collectCalls: 'tests' });
      expect(s.calls!.find((c) => c.file === 'src/own.test.ts')!.ownUses).toEqual([
        { name: 'f', line: 3, column: 10 }, { name: 'f', line: 4, column: 9 }, { name: 'K', line: 6, column: 15 },
      ]);
    } finally {
      fs.rmSync(file);
    }
  });
});
