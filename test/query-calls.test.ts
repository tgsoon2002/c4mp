import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadQueryContext } from '../src/query/context';
import { callersOf, callsOf, callStats } from '../src/query/calls';
import { QueryError } from '../src/query/errors';
import { buildTools } from '../src/mcp/tools';
import { formatCallers } from '../src/query/format';
import { CLI_JS } from './helpers/runCli';

// P8: calls / callers on a small TypeScript repo covering each resolution rule once.
const FILES: Record<string, string> = {
  'lib.ts': `export function helper() { return 1; }
export class Repo {
  save() { return this.check(); }
  check() { return helper(); }
  static make() { return new Repo(); }
}
`,
  'util.ts': `export function ping() {}
export function helper() {}
`,
  'app.ts': `import * as fs from 'fs';
import { helper, Repo } from './lib';
import * as util from './util';

function local() { return 2; }

export function run(items: number[]) {
  const repo = new Repo();
  repo.save();
  Repo.make();
  util.ping();
  fs.readFileSync('x');
  console.log(local());
  items.forEach((i) => helper());
  mystery();
  return items.map((x) => x).length;
}

const handlers = { go() { local(); } };
handlers.go();
setTimeout(() => local(), 1);
`,
  // Phase 26 T26-6: a test file (default tests globs); calls in a case belong to the case, hook calls to <module>.
  'app.test.ts': `import { run } from './app';
import * as util from './util';

describe('app', () => {
  beforeEach(() => util.ping());
  it('runs', () => {
    expect(run([1])).toBe(1);
  });
  it('one line', () => run([]));
});
`,
  // b682: call-site positions (two calls from one caller, a call over two lines, a non-ASCII character before a call).
  'pos.ts': `export function target() { return 1; }
export function twice() {
  target();
  if (target()) return;
}
const o = { go() { return 1; } };
export function chained() {
  return o
    .go();
}
export function wide() { const é = 'ü'; return target(); }
`,
};

let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-calls-'));
  for (const [f, text] of Object.entries(FILES)) fs.writeFileSync(path.join(repo, f), text);
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const names = (refs: { name: string; file: string }[]): string[] => refs.map((r) => `${r.file}#${r.name}`);

describe('calls', () => {
  it('traces same-file, imported, instance, static and namespace calls; counts the rest', () => {
    const r = callsOf(loadQueryContext(repo), 'app.ts#run');
    expect(names(r.calls)).toEqual(['app.ts#local', 'lib.ts#helper', 'lib.ts#Repo.save', 'lib.ts#Repo.make', 'util.ts#ping']);
    expect(r.calls.every((c) => c.resolved)).toBe(true);
    expect(r.calls.find((c) => c.name === 'Repo.save')).toMatchObject({ file: 'lib.ts', line: 3 });
    expect(r.external).toBe(2);       // fs.readFileSync, console.log
    expect(r.unresolved).toBe(3);     // mystery(), items.forEach(), items.map()
  });

  it('resolves this.method inside a class; a callback call belongs to the enclosing named function', () => {
    const ctx = loadQueryContext(repo);
    expect(names(callsOf(ctx, 'lib.ts#Repo.save').calls)).toEqual(['lib.ts#Repo.check']);
    expect(names(callsOf(ctx, 'Repo.check').calls)).toEqual(['lib.ts#helper']);
    expect(names(callsOf(ctx, 'app.ts#run').calls)).toContain('lib.ts#helper');   // inside items.forEach((i) => ...)
  });

  it('puts calls outside any named function under <module>; object-literal methods use the qualified name', () => {
    const ctx = loadQueryContext(repo);
    expect(names(callsOf(ctx, 'app.ts#<module>').calls)).toEqual(['app.ts#local', 'app.ts#handlers.go']);
    expect(names(callsOf(ctx, 'app.ts#handlers.go').calls)).toEqual(['app.ts#local']);
  });

  it('unknown and ambiguous names are QueryErrors', () => {
    const ctx = loadQueryContext(repo);
    expect(() => callsOf(ctx, 'nope')).toThrow(QueryError);
    let err: unknown;
    try { callsOf(ctx, 'helper'); } catch (e) { err = e; }
    expect((err as QueryError).code).toBe('ambiguous');
    expect((err as QueryError).candidates).toEqual(['lib.ts#helper', 'util.ts#helper']);
  });
});

describe('callers', () => {
  it('lists each caller once, including <module>', () => {
    const ctx = loadQueryContext(repo);
    expect(names(callersOf(ctx, 'app.ts#local').callers)).toEqual(['app.ts#run', 'app.ts#handlers.go', 'app.ts#<module>']);
    expect(names(callersOf(ctx, 'lib.ts#helper').callers)).toEqual(['app.ts#run', 'lib.ts#Repo.check']);
    expect(callersOf(ctx, 'util.ts#helper').callers).toEqual([]);
    expect(callStats(ctx.snapshot).edge).toBeGreaterThan(5);
  });

  it('names the test case a call sits in; hook and describe calls stay <module>', () => {
    const ctx = loadQueryContext(repo);
    expect(callersOf(ctx, 'app.ts#run').callers.map((r) => [`${r.file}#${r.name}`, r.line])).toEqual([
      ['app.test.ts#app › runs', 7], ['app.test.ts#app › one line', 9],   // b682: the call's line, not the case's first line
    ]);
    expect(names(callersOf(ctx, 'util.ts#ping').callers)).toEqual(['app.test.ts#<module>', 'app.ts#run']);
  });
});

describe('callers: call-site positions (b682)', () => {
  const site = (line: number, column: number) => ({ line, column });

  it('a member call gives the line and column of the called name', () => {
    expect(callersOf(loadQueryContext(repo), 'lib.ts#Repo.save').callers).toEqual([
      { name: 'run', file: 'app.ts', line: 9, column: 8, resolved: true, sites: [site(9, 8)] },
    ]);
  });

  it('two calls from one caller: one row at the first site, both in sites; the text adds "(also ...)"', () => {
    const r = callersOf(loadQueryContext(repo), 'pos.ts#target');
    expect(r.callers.find((c) => c.name === 'twice')).toMatchObject({ line: 3, column: 3, sites: [site(3, 3), site(4, 7)] });
    expect(formatCallers(r).split('\n').slice(1, 3)).toEqual(['callers:', '  pos.ts:3:3  twice  (also 4:7)']);
  });

  it('a call over two lines gives the line of the called name', () => {
    expect(callersOf(loadQueryContext(repo), 'pos.ts#o.go').callers).toMatchObject([{ name: 'chained', line: 9, column: 6 }]);
  });

  it('a non-ASCII character before the call: the column indexes the JS string of the line', () => {
    const text = FILES['pos.ts'].split('\n')[10];
    const wide = callersOf(loadQueryContext(repo), 'pos.ts#target').callers.find((c) => c.name === 'wide')! as { line: number; column: number };
    expect([wide.line, wide.column]).toEqual([11, text.indexOf('target()') + 1]);
    expect(Buffer.byteLength(text.slice(0, wide.column - 1))).toBeGreaterThan(wide.column - 1);   // not a byte column
  });
});

describe('CLI --json and MCP return the same object', () => {
  it.each([['calls', 'app.ts#run'], ['callers', 'lib.ts#helper']])('%s %s', async (cmd, fn) => {
    const cli = spawnSync(process.execPath, [CLI_JS, cmd, fn, '--repo', repo, '--json'], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const tool = buildTools(repo, {}).find((t) => t.name === cmd)!;
    const res = (await tool.handler({ function: fn })) as { content: { text: string }[] };
    expect(res.content[0].text).toBe(cli.stdout.trimEnd());
  });
});

// b592 (PY-CALLS): a Python repo through the same queries; CLI --json and MCP agree.
describe('Python repo: calls and callers (b592)', () => {
  const PY: Record<string, string> = {
    'lib.py': 'def helper():\n    return 1\n\n\nclass Repo:\n    def save(self):\n        return self.check()\n\n    def check(self):\n        return helper()\n',
    'app.py': 'from lib import helper, Repo\nimport lib\n\n\ndef run():\n    repo = Repo()\n    repo.save()\n    lib.helper()\n    print(helper())\n',
  };
  let py: string;
  beforeAll(() => {
    py = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pycalls-q-'));
    for (const [f, text] of Object.entries(PY)) fs.writeFileSync(path.join(py, f), text);
  });
  afterAll(() => fs.rmSync(py, { recursive: true, force: true }));
  const pyCtx = () => loadQueryContext(py, { cli: { languages: ['python'] } });

  it('traces from-import, instance, self and module.attr calls; the constructor stays unresolved, print external', () => {
    const r = callsOf(pyCtx(), 'app.py#run');
    expect(names(r.calls)).toEqual(['lib.py#helper', 'lib.py#Repo.save']);
    expect([r.unresolved, r.external]).toEqual([1, 1]);   // Repo(); print
    expect(names(callersOf(pyCtx(), 'lib.py#helper').callers)).toEqual(['app.py#run', 'lib.py#Repo.check']);
    expect(callersOf(pyCtx(), 'lib.py#Repo.check').callers).toMatchObject([{ name: 'Repo.save', line: 7, column: 21 }]);
  });

  it.each([['calls', 'app.py#run'], ['callers', 'lib.py#helper']])('CLI --json and MCP: %s %s', async (cmd, fn) => {
    const cli = spawnSync(process.execPath, [CLI_JS, cmd, fn, '--repo', py, '--lang', 'python', '--json'], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const tool = buildTools(py, { languages: ['python'] }).find((t) => t.name === cmd)!;
    const res = (await tool.handler({ function: fn })) as { content: { text: string }[] };
    expect(res.content[0].text).toBe(cli.stdout.trimEnd());
  });
});
