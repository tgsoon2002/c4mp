import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { loadConfig } from '../src/config';
import { configOptsFor, pickScanConfig } from '../src/outputs';
import { callIndex } from '../src/callGraph/callResolve';
import type { CallSite } from '../src/callGraph/callResolve';
import { pythonHandler } from '../src/languages/python';
import { extractPythonCalls } from '../src/languages/python/calls';
import type { FileCalls, Snapshot } from '../src/types';

// b592 (LG-2, PY-CALLS): Python calls through the kit's calls collector; the judge (callResolve.ts) is unchanged.

const FILES: Record<string, string> = {
  'm.py': `def f():
    return 1


class K:
    def m(self):
        return 2
`,
  'pkg/__init__.py': '',
  'pkg/sub/__init__.py': 'def f():\n    return 3\n',
  'pkg/sub/deep.py': 'def f():\n    return 4\n',
  'app.py': `import m
import os
from m import f, K
from m import f as g
from requests import get


class C:
    def n(self):
        self.m()
        self.gone()

    def m(self):
        pass

    @classmethod
    def build(cls):
        return cls.m()

    @staticmethod
    def s(self):
        return self.m()

    def outer(self):
        def inner():
            return self.m()

        def own(self):
            return self.m()

        return inner, own


def run(items):
    f()
    g()
    K()
    get('x')
    m.f()
    C.m(None)
    K.m(None)
    x = C()
    x.m()
    super().m()
    items[0]()
    print(len(items))
    os.path.join('a')
    local()


def local():
    return 1


local()
handlers = {'go': local}


def uses_demo(cb):
    keep = [f]
    cb(f=1)
    cb(key=m.f)
    return keep


def shadow(f):
    return f
`,
  'chains.py': `import pkg.sub.deep


def chains():
    pkg.sub.f()
    pkg.sub.deep.f()
`,
};

let repo: string;
let snapshot: Snapshot;
let sites: CallSite[];
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pycalls-'));
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  const config = loadConfig(repo, { languages: ['python'] }, configOptsFor(repo));
  snapshot = runSnapshot({ repo, write: false, quiet: true, config: pickScanConfig(config), collectCalls: true });
  sites = callIndex(snapshot).sites;
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const fileCalls = (file: string): FileCalls => snapshot.calls!.find((c) => c.file === file)!;
const verdictText = (s: CallSite): string => (s.verdict.kind === 'edge' ? `edge ${s.verdict.file}#${s.verdict.name}` : s.verdict.kind);
const siteOf = (file: string, caller: string, callee: string | null, nth = 0): CallSite =>
  sites.filter((s) => s.file === file && s.caller === caller && s.callee === callee)[nth];

describe('Python calls: the verdict table (judge unchanged)', () => {
  it.each([
    ['from-import of a function', 'app.py', 'run', 'f', 'edge m.py#f'],
    ['from-import with an alias', 'app.py', 'run', 'g', 'edge m.py#f'],
    ['from-import of a class: a constructor', 'app.py', 'run', 'K', 'unresolved'],
    ['from-import of an external module', 'app.py', 'run', 'get', 'external'],
    ['import m; m.f()', 'app.py', 'run', 'm.f', 'edge m.py#f'],
    ['same-file Class.m', 'app.py', 'run', 'C.m', 'edge app.py#C.m'],
    ['imported Class.m', 'app.py', 'run', 'K.m', 'edge m.py#K.m'],
    ['x = C(); x.m()', 'app.py', 'run', 'x.m', 'edge app.py#C.m'],
    ['same-file function', 'app.py', 'run', 'local', 'edge app.py#local'],
    ['builtin', 'app.py', 'run', 'print', 'external'],
    ['builtin in an argument', 'app.py', 'run', 'len', 'external'],
    ['builtin super()', 'app.py', 'run', 'super', 'external'],
    ['external module chain', 'app.py', 'run', 'os.path.join', 'external'],
    ['self.m() in a method', 'app.py', 'C.n', 'this.m', 'edge app.py#C.m'],
    ['self.m() of an inherited method', 'app.py', 'C.n', 'this.gone', 'unresolved'],
    ['cls.m() in a classmethod', 'app.py', 'C.build', 'this.m', 'edge app.py#C.m'],
    ['@staticmethod: the first parameter is no receiver', 'app.py', 'C.s', 'self.m', 'unresolved'],
    ['a closure keeps the method\'s self (owner: the method)', 'app.py', 'C.outer', 'this.m', 'edge app.py#C.m'],
    ['a nested def with its own self parameter', 'app.py', 'C.outer', 'self.m', 'unresolved'],
    ['top-level call: caller <module>', 'app.py', '<module>', 'local', 'edge app.py#local'],
    ['import a.b.c; 3-part chain', 'chains.py', 'chains', 'pkg.sub.f', 'unresolved'],
    ['import a.b.c; 4-part chain', 'chains.py', 'chains', 'pkg.sub.deep.f', 'unresolved'],
  ])('%s', (_label, file, caller, callee, verdict) => {
    const s = siteOf(file, caller, callee);
    expect(s).toBeDefined();
    expect(verdictText(s)).toBe(verdict);
  });

  it('super().m(), obj[i]() and f()() have a null callee: unresolved', () => {
    const nulls = sites.filter((s) => s.file === 'app.py' && s.caller === 'run' && s.callee === null);
    expect(nulls).toHaveLength(2);   // super().m() and items[0]()
    expect(nulls.every((s) => s.verdict.kind === 'unresolved' && s.at === undefined)).toBe(true);
  });
});

describe('Python calls: positions, bindings, instances', () => {
  const lineOf = (file: string, text: string): number => FILES[file].split('\n').findIndex((l) => l.includes(text)) + 1;

  it('at is the line and column of the called name (the last identifier)', () => {
    const line = lineOf('app.py', '    m.f()');
    expect(siteOf('app.py', 'run', 'm.f').at).toEqual({ line, column: 7 });
    expect(siteOf('app.py', 'C.n', 'this.m').at).toEqual({ line: lineOf('app.py', 'self.m()'), column: 14 });
    expect(siteOf('app.py', 'run', 'local').at).toEqual({ line: lineOf('app.py', '    local()'), column: 5 });
  });

  it('bindings follow imports.ts specs; a called builtin gets an external <builtin> binding', () => {
    const code = 'import a.b\nimport m as x\nfrom n import f as g, h\nfrom . import y\nfrom ..p import q\nfrom z import *\n\nprint(len(g()))\n';
    const tree = pythonHandler.parse(code, 'w.py');
    const fc = extractPythonCalls(tree, pythonHandler.outline(tree, 'w.py', code));
    expect(fc.bindings).toEqual([
      { local: 'a', imported: '*', spec: 'a.b' },
      { local: 'x', imported: '*', spec: 'm' },
      { local: 'g', imported: 'f', spec: 'n', at: { line: 3, column: 15 } },
      { local: 'h', imported: 'h', spec: 'n', at: { line: 3, column: 23 } },
      { local: 'y', imported: '*', spec: '.y' },
      { local: 'q', imported: 'q', spec: '..p', at: { line: 5, column: 17 } },
      { local: 'print', imported: 'print', spec: '<builtin>', external: true },
      { local: 'len', imported: 'len', spec: '<builtin>', external: true },
    ]);
  });

  it('x = C(...) is an instance; a name two classes claim is left out', () => {
    const code = 'a = A()\nb = B()\nb = D()\nc = A(1)\nd = make().x\n';
    const tree = pythonHandler.parse(code, 'w.py');
    expect(extractPythonCalls(tree, pythonHandler.outline(tree, 'w.py', code)).instances).toEqual([
      { name: 'a', className: 'A' }, { name: 'c', className: 'A' },
    ]);
  });
});

describe('Python calls: value uses', () => {
  const usesIn = (fc: FileCalls, key: 'uses' | 'ownUses'): string[] => (fc[key] ?? []).map((u) => `${u.name}@${u.line}:${u.column}`);
  const lineOf = (text: string): number => FILES['app.py'].split('\n').findIndex((l) => l.includes(text)) + 1;

  it('an imported name passed as a value is a use; a keyword argument name and a shadowing parameter are not', () => {
    const uses = usesIn(fileCalls('app.py'), 'uses');
    expect(uses).toContain(`f@${lineOf('keep = [f]')}:13`);
    expect(uses).toContain(`m.f@${lineOf('cb(key=m.f)')}:12`);
    expect(uses.filter((u) => u.startsWith('f@'))).toHaveLength(1);   // not `cb(f=1)`, not `return f` under `def shadow(f)`
  });

  it('callees, imports and definitions are no uses; own names passed as values are ownUses', () => {
    const fc = fileCalls('app.py');
    expect(usesIn(fc, 'uses').some((u) => /^(get|g|K|os)[.@]/.test(u))).toBe(false);
    expect(usesIn(fc, 'ownUses')).toEqual([`local@${lineOf("handlers = {'go': local}")}:19`]);
  });
});
