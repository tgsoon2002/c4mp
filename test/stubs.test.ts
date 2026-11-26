import Parser from 'tree-sitter';
import { parseSource } from '../src/languages/typescript/language';
import { stubKind } from '../src/languages/typescript/stubs';

describe('stubKind', () => {
  /**
   * Helper to extract the function node from parsed source.
   * For function declarations, returns the function_declaration node.
   * For const with arrow/function, returns the arrow_function/function_expression node.
   */
  function extractFunctionNode(code: string, filePath: string): Parser.SyntaxNode {
    const { tree } = parseSource(code, filePath);
    let fnNode: Parser.SyntaxNode | null = null;

    // Walk all top-level nodes to find a function
    for (const node of tree.rootNode.children) {
      if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
        fnNode = node;
        break;
      }

      if (node.type === 'export_statement') {
        const decl = node.childForFieldName('declaration');
        if (decl?.type === 'function_declaration' || decl?.type === 'generator_function_declaration') {
          fnNode = decl;
          break;
        }
      }

      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (const d of node.children) {
          if (d.type === 'variable_declarator') {
            const value = d.childForFieldName('value');
            if (value?.type === 'arrow_function' || value?.type === 'function_expression') {
              fnNode = value;
              break;
            }
          }
        }
        if (fnNode) break;
      }
    }

    if (!fnNode) {
      throw new Error(`Could not extract function node from: ${code}`);
    }

    return fnNode;
  }

  // B19: intentional code is not a stub
  test.each([
    ['never return type (arrow)', 'const f = (s: string): never => { throw new Error(s) }'],
    ['never return type (declaration)', 'function f(): never { throw new Error("x") }'],
    ['nop comment', 'function f() { // nop\n }'],
    ['no-op comment', 'function f() { /* no-op */ }'],
    ['intentionally comment', 'function f() { // intentionally empty\n }'],
    ['empty arrow named handler', 'export const handler = () => {}'],
    ['empty arrow with "does nothing" comment above', '// This hook currently does nothing.\nexport const useX = (): void => {}'],
    ['empty arrow as object value', 'const o = { mkdir: async () => {} }'],
    ['empty arrow as argument', 'run(() => {})'],
    ['empty arrow as default parameter', 'function g(cb = () => {}) { return cb }'],
  ])('intentional, not a stub: %s', (_label, code) => {
    const { tree } = parseSource(code, 'test.ts');
    const fnNode = tree.rootNode.descendantsOfType(['arrow_function', 'function_declaration'])
      .filter(n => n.childForFieldName('name')?.text !== 'g' )[0];
    expect(stubKind(fnNode)).toBeNull();
  });

  test.each([
    ['TODO in a nop-named arrow', 'const handler = () => { // TODO later\n }', 'todo'],
    ['not-implemented throw returning void', 'function f(): void { throw new Error("Method not implemented.") }', 'throws'],
    ['throw without never', 'const f = () => { throw new Error("x") }', 'throws'],
    ['empty arrow in an unrelated variable', 'const f = () => {}', 'empty'],
    ['empty declaration', 'function f() {}', 'empty'],
  ])('real stub still flagged: %s', (_label, code, expected) => {
    const { tree } = parseSource(code, 'test.ts');
    const fnNode = tree.rootNode.descendantsOfType(['arrow_function', 'function_declaration'])[0];
    expect(stubKind(fnNode)).toBe(expected);
  });

  test('empty function body', () => {
    const fnNode = extractFunctionNode('function a() {}', 'test.ts');
    expect(stubKind(fnNode)).toBe('empty');
  });

  test('function with TODO comment', () => {
    const fnNode = extractFunctionNode('function a() { // TODO x\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('todo');
  });

  test('function with FIXME comment', () => {
    const fnNode = extractFunctionNode('function a() { // FIXME something\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('todo');
  });

  test('function with XXX comment', () => {
    const fnNode = extractFunctionNode('function a() { // XXX hack\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('todo');
  });

  test('function with "not implemented" comment', () => {
    const fnNode = extractFunctionNode('function a() { // not implemented\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('todo');
  });

  test('empty function with regular comment', () => {
    const fnNode = extractFunctionNode('function a() { // regular comment\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('empty');
  });

  test('function with throw statement', () => {
    const fnNode = extractFunctionNode("function a() { throw new Error('nope'); }", 'test.ts');
    expect(stubKind(fnNode)).toBe('throws');
  });

  test('function with return void (no value)', () => {
    const fnNode = extractFunctionNode('function a() { return; }', 'test.ts');
    expect(stubKind(fnNode)).toBe('returns-nothing');
  });

  test('function with return null', () => {
    const fnNode = extractFunctionNode('function a() { return null; }', 'test.ts');
    expect(stubKind(fnNode)).toBe('returns-nothing');
  });

  test('function with return undefined', () => {
    const fnNode = extractFunctionNode('function a() { return undefined; }', 'test.ts');
    expect(stubKind(fnNode)).toBe('returns-nothing');
  });

  test('function with return value (not null/undefined)', () => {
    const fnNode = extractFunctionNode('function a() { return 1; }', 'test.ts');
    expect(stubKind(fnNode)).toBeNull();
  });

  test('function with return string', () => {
    const fnNode = extractFunctionNode('function a() { return "hello"; }', 'test.ts');
    expect(stubKind(fnNode)).toBeNull();
  });

  test('arrow function with expression body', () => {
    const fnNode = extractFunctionNode('const f = () => 1', 'test.ts');
    expect(stubKind(fnNode)).toBeNull();
  });

  test('arrow function with empty block body', () => {
    const fnNode = extractFunctionNode('const f = () => {}', 'test.ts');
    expect(stubKind(fnNode)).toBe('empty');
  });

  test('function with TODO comment and body with statements (Checkout-like)', () => {
    const code = `function Checkout() {
  const [items, setItems] = useState([]);
  // TODO: finalize design
  return <div>Checkout</div>;
}`;
    const fnNode = extractFunctionNode(code, 'test.tsx');
    expect(stubKind(fnNode)).toBeNull();
  });

  test('function with multiple statements', () => {
    const fnNode = extractFunctionNode('function a() { const x = 1; return x; }', 'test.ts');
    expect(stubKind(fnNode)).toBeNull();
  });

  test('function with only comments and no statements', () => {
    const fnNode = extractFunctionNode('function a() { // comment 1\n // comment 2\n }', 'test.ts');
    expect(stubKind(fnNode)).toBe('empty');
  });

  test('arrow function with throw', () => {
    const fnNode = extractFunctionNode('const f = () => { throw new Error("nope"); }', 'test.ts');
    expect(stubKind(fnNode)).toBe('throws');
  });

  test('function with return object literal', () => {
    const fnNode = extractFunctionNode('function a() { return { key: "value" }; }', 'test.ts');
    expect(stubKind(fnNode)).toBeNull();
  });
});
