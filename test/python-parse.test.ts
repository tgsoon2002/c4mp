import { pythonHandler } from '../src/languages/python';
import { parseSource } from '../src/languages/typescript/language';

const parsePython = (code: string) => pythonHandler.parse(code, '');

describe('python parse', () => {
  it('parses a simple Python function', () => {
    const code = 'def f():\n  pass\n';
    const tree = parsePython(code);

    expect(tree.rootNode.hasError).toBe(false);
    const treeStr = tree.rootNode.toString();
    expect(treeStr).toMatch(/^\(module \(function_definition/);
  });

  it('detects parse errors in broken Python code', () => {
    const brokenCode = 'def (';
    const tree = parsePython(brokenCode);

    expect(tree.rootNode.hasError).toBe(true);
  });

  it('interleaves TS and Python parsing in the same process', () => {
    // Parse TypeScript first
    const tsCode = 'function f(): string { return "ts"; }';
    const { tree: tsTree1 } = parseSource(tsCode, 'file.ts');
    expect(tsTree1.rootNode.hasError).toBe(false);

    // Parse Python
    const pyCode = 'def f():\n  return "py"\n';
    const pyTree = parsePython(pyCode);
    expect(pyTree.rootNode.hasError).toBe(false);

    // Parse TypeScript again
    const { tree: tsTree2 } = parseSource(tsCode, 'file.ts');
    expect(tsTree2.rootNode.hasError).toBe(false);

    // All should have valid root nodes
    expect(tsTree1.rootNode.toString()).toMatch(/^\(program/);
    expect(pyTree.rootNode.toString()).toMatch(/^\(module/);
    expect(tsTree2.rootNode.toString()).toMatch(/^\(program/);
  });

  it('parsing python before loading typescript/language still parses TypeScript (b137)', () => {
    // A fresh process, so the shared util slot starts empty and a python parse is the first to touch it.
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const path = require('path') as typeof import('path');
    const root = path.resolve(__dirname, '..');
    const script = [
      "require('./src/languages/python').default.parse('x = 1\\n', 'a.py');",
      "const { parseSource } = require('./src/languages/typescript/language');",
      "const r = parseSource('function f(): string { return 1; }', 'a.ts');",
      'process.stdout.write(String(r.tree.rootNode.hasError));',
    ].join('');
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe('false');
  });
});
