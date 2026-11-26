import * as path from 'path';
import {
  buildImportGraph, measure, ratchet, runLayersCheck, summarize,
  type Baseline, type ImportEdge, type LayerTable, type Metrics,
} from '../scripts/layers-check';

// Layer ratchet (LAY-0, PHASE_28_LAYERS.md 0.3): the metrics of scripts/layers-check.ts may only fall below the
// baseline in layers.json. A rise names every current import of that metric with file:line and the rule.

describe('layers check on this repo', () => {
  test('no metric rises above the layers.json baseline', () => {
    const { table, metrics } = runLayersCheck(path.join(__dirname, '..'));
    expect(ratchet(metrics, table.baseline).rises.join('\n\n')).toBe('');
  });
});

// Tiny project: src/a <-> src/b is a value cycle in L1; types.ts <-> view is a type-only cycle; bin is the entry point.
const SOURCES = new Map<string, string>([
  ['src/types.ts', `import type { W } from './view/w';\nexport interface T { w: W }\n`],
  ['src/view/w.ts', `import { T } from '../types';\nexport interface W { x: number }\nexport const v = 1;\nexport type U = T;\n`],
  ['src/view/index.ts', `export { W } from './w';\nexport * from './w';\n`],
  ['src/a/x.ts', `import { y } from '../b/y';\nexport const x = y;\n`],
  ['src/b/y.ts', `import {\n  x,\n} from '../a/x';\nexport const y = 2;\nexport const z = () => x;\n`],
  ['src/b/z.ts', `export { type W } from '../view/w';\n`],
  ['src/c/k.ts', `import { W, U } from '../view';\nconst m = require('../b/y');\nexport type K = import('../view/w').W;\nimport pkg from '../../package.json';\n`],
  ['bin/cli.ts', `import { x } from '../src/a/x';\nimport { T } from '../src/types';\nimport * as V from '../src/view/w';\n`],
]);

const TABLE: LayerTable = {
  folders: { 'src/a': 'L1', 'src/b': 'L1', 'src/c': 'L2', 'src/view': 'L2', bin: 'L4' },
  files: { 'src/types.ts': 'L0' },
  baseline: { folderSccAll: [], folderSccValue: [], fileSccAll: [], fileSccValue: [], upward: 0, sameLayerCycle: 0, skipLayer: 0 },
};

const FILES = [...SOURCES.keys()];
const at = (e: ImportEdge) => `${e.from}:${e.line}`;

describe('import graph (TypeScript compiler API)', () => {
  let edges: ImportEdge[];
  beforeAll(() => { edges = buildImportGraph(SOURCES); });

  test.each([
    ['src/types.ts:1', 'src/view/w.ts', 'import', true], // import type
    ['src/view/w.ts:1', 'src/types.ts', 'import', true], // named import of an interface, no `type` keyword
    ['src/view/index.ts:1', 'src/view/w.ts', 'export-from', true],
    ['src/view/index.ts:2', 'src/view/w.ts', 'export-from', false], // export * is a runtime edge
    ['src/a/x.ts:1', 'src/b/y.ts', 'import', false],
    ['src/b/y.ts:1', 'src/a/x.ts', 'import', false], // multi-line import: line of the statement
    ['src/b/z.ts:1', 'src/view/w.ts', 'export-from', true], // inline type specifier
    ['src/c/k.ts:1', 'src/view/index.ts', 'import', true], // types through a re-export and export *
    ['src/c/k.ts:2', 'src/b/y.ts', 'require', false],
    ['src/c/k.ts:3', 'src/view/w.ts', 'import-type', true],
    ['bin/cli.ts:3', 'src/view/w.ts', 'import', false], // namespace import
  ])('%s -> %s (%s, type-only %s)', (where, to, kind, typeOnly) => {
    expect(edges.filter(e => at(e) === where)).toEqual([expect.objectContaining({ to, kind, typeOnly })]);
  });

  test('imports of non-source files (package.json) are not edges', () => {
    expect(edges.filter(e => e.from === 'src/c/k.ts').map(at)).toEqual(['src/c/k.ts:1', 'src/c/k.ts:2', 'src/c/k.ts:3']);
  });
});

describe('metrics and ratchet', () => {
  let metrics: Metrics;
  beforeAll(() => { metrics = measure(FILES, buildImportGraph(SOURCES), TABLE); });

  test.each<[keyof Baseline, unknown]>([
    ['folderSccAll', [2, 2]],
    ['folderSccValue', [2]],
    ['fileSccAll', [2, 2]],
    ['fileSccValue', [2]],
    ['upward', 2],
    ['sameLayerCycle', 2],
    ['skipLayer', 2],
  ])('%s = %j', (key, expected) => {
    expect(summarize(metrics)[key]).toEqual(expected);
  });

  test.each<['upward' | 'sameLayerCycle' | 'skipLayer', string[]]>([
    ['upward', ['src/b/z.ts:1', 'src/types.ts:1']],
    ['sameLayerCycle', ['src/a/x.ts:1', 'src/b/y.ts:1']],
    ['skipLayer', ['bin/cli.ts:1', 'bin/cli.ts:3']],
  ])('%s names the imports %j', (key, expected) => {
    expect(metrics[key].map(f => at(f.edge))).toEqual(expected);
  });

  test('a file rule overrides its folder', () => {
    const table = { ...TABLE, files: { ...TABLE.files, 'src/b/z.ts': 'L2' } };
    expect(measure(FILES, buildImportGraph(SOURCES), table).upward.map(f => at(f.edge))).toEqual(['src/types.ts:1']);
  });

  test('a file with no layer fails and names the file', () => {
    const table = { ...TABLE, folders: Object.fromEntries(Object.entries(TABLE.folders).filter(([d]) => d !== 'src/c')) };
    expect(() => measure(FILES, buildImportGraph(SOURCES), table)).toThrow('layers.json: no layer for 1 file(s): src/c/k.ts');
  });

  test.each<[string, Partial<Baseline>, number, number]>([
    ['equal', {}, 0, 0],
    ['metric fell', { upward: 5, folderSccAll: [3, 2] }, 0, 2],
    ['metric rose', { upward: 1 }, 1, 0],
  ])('baseline %s %j: rises %d, falls %d', (_name, change, rises, falls) => {
    const result = ratchet(metrics, { ...summarize(metrics), ...change });
    expect([result.rises.length, result.falls.length]).toEqual([rises, falls]);
  });

  test('a rise message names the import file:line and the rule', () => {
    const [message] = ratchet(metrics, { ...summarize(metrics), upward: 1 }).rises;
    expect(message).toContain('src/types.ts:1 -> src/view/w.ts');
    expect(message).toContain('upward: L0 (file src/types.ts) -> L2 (folder src/view)');
  });
});
