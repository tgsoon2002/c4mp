import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { runCli } from './helpers/runCli';
import type { Snapshot, SnapshotFile, TestsConfig } from '../src/types';

// Phase 26 T26-4: test cases of TypeScript / JavaScript test files are elements of kind 'test', named by their
// describe chain; describe blocks and hooks are kept as testBlocks. Only role-test files get them.

const FIXTURE = path.join(__dirname, 'fixtures', 'tscases');
const scan = (tests?: TestsConfig): Snapshot => runSnapshot({ repo: FIXTURE, write: false, quiet: true, config: tests ? { tests } : {} });
const fileOf = (s: Snapshot, file: string): SnapshotFile => s.files.find((f) => f.file === file)!;
const casesOf = (f: SnapshotFile) => f.elements.filter((e) => e.kind === 'test').map((e) => e.name);

describe('test cases of a TypeScript / JavaScript test file', () => {
  let snap: Snapshot;
  beforeAll(() => { snap = scan(); });

  it('names cases by describe chain: nested, duplicate, .each template, aliases, loop, escapes, todo', () => {
    expect(casesOf(fileOf(snap, 'test/cases.spec.ts'))).toEqual([
      'outer › adds',
      'outer › adds (2)',
      'outer › inner › works',
      'outer › inner › maps %i to %i',
      'outer › inner › table $a',
      'outer › inner › to write',
      'outer › per %s › handles ${k}',
      'outer › opens a page',
      'outer › alias of an alias',
      'lts only › replays',
      'loop ${n}',
      "it's escaped once",
    ]);
  });

  it('a case spans its callback lines; the local helper stays a function', () => {
    const f = fileOf(snap, 'test/cases.spec.ts');
    expect(f.elements.find((e) => e.name === 'outer › adds')).toMatchObject({ kind: 'test', startLine: 13, endLine: 15, lineCount: 3 });
    expect(f.elements.find((e) => e.name === 'pick')?.kind).toBe('function');
  });

  it('records describe blocks and hooks with the chain they belong to', () => {
    expect(fileOf(snap, 'test/cases.spec.ts').testBlocks).toEqual([
      { kind: 'beforeAll', name: '', startLine: 7, endLine: 7 },
      { kind: 'describe', name: 'outer', startLine: 9, endLine: 39 },
      { kind: 'beforeEach', name: 'outer', startLine: 10, endLine: 10 },
      { kind: 'afterEach', name: 'outer', startLine: 11, endLine: 11 },
      { kind: 'describe', name: 'outer › inner', startLine: 20, endLine: 31 },
      { kind: 'afterAll', name: 'outer › inner', startLine: 21, endLine: 21 },
      { kind: 'describe', name: 'outer › per %s', startLine: 33, endLine: 35 },
      { kind: 'describe', name: 'lts only', startLine: 41, endLine: 43 },
    ]);
  });

  it('JavaScript and Deno.test', () => {
    expect(casesOf(fileOf(snap, 'test/legacy.test.js'))).toEqual(['legacy › runs', 'deno case']);
  });

  it.each([
    ['a source file calling its own describe/it', 'src/runner.ts'],
    ['a test helper without cases', 'test/helpers.ts'],
  ])('%s has no test elements and no testBlocks', (_label, file) => {
    const f = fileOf(snap, file);
    expect(casesOf(f)).toEqual([]);
    expect(f).not.toHaveProperty('testBlocks');
  });

  it('a file outside tests.globs gets no cases, also when the same file was scanned as a test before', () => {
    const none = scan({ globs: [] });
    expect(none.files.flatMap(casesOf)).toEqual([]);
    expect(none.files.some((f) => f.testBlocks)).toBe(false);
  });
});

describe('c4pm outline of a test file', () => {
  it('lists the cases of test/timing.test.ts', () => {
    const r = runCli(['outline', 'test/timing.test.ts', '--repo', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').filter((l) => /^\s+\d+-\d+\s+test\s+timed › /.test(l))).toHaveLength(4);
  });
});
