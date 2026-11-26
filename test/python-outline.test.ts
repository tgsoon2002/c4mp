import * as fs from 'fs';
import * as path from 'path';
import { extractPythonOutline } from '../src/languages/python/outline';
import { pythonHandler } from '../src/languages/python';

const parsePython = (code: string) => pythonHandler.parse(code, '');

const fixtureDir = path.join(__dirname, 'fixtures/pyshop');

describe('extractPythonOutline', () => {
  it('extracts top-level functions from shop/__init__.py', () => {
    const file = path.join(fixtureDir, 'shop/__init__.py');
    const code = fs.readFileSync(file, 'utf-8');
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'shop/__init__.py', code);

    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0]).toEqual({
      name: 'create_app',
      kind: 'function',
      startLine: 5,
      endLine: 8,
      lineCount: 4,
    });
  });

  it('extracts decorated class with method from shop/models/order.py', () => {
    const file = path.join(fixtureDir, 'shop/models/order.py');
    const code = fs.readFileSync(file, 'utf-8');
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'shop/models/order.py', code);

    // Should have: Order class, Order.is_free method
    expect(outline.elements.length).toBe(2);

    // Check Order class (decorated, so starts at @dataclass)
    expect(outline.elements[0]).toEqual({
      name: 'Order',
      kind: 'class',
      startLine: 4,
      endLine: 10,
      lineCount: 7,
    });

    // Check Order.is_free method
    expect(outline.elements[1]).toEqual({
      name: 'Order.is_free',
      kind: 'method',
      startLine: 9,
      endLine: 10,
      lineCount: 2,
    });
  });

  it('extracts class with methods including stubs from shop/services/orders.py', () => {
    const file = path.join(fixtureDir, 'shop/services/orders.py');
    const code = fs.readFileSync(file, 'utf-8');
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'shop/services/orders.py', code);

    // Should have: OrderService class, OrderService.__init__, OrderService.create, OrderService.refund, list_orders function
    expect(outline.elements.length).toBe(5);

    // Check OrderService class
    expect(outline.elements[0]).toEqual({
      name: 'OrderService',
      kind: 'class',
      startLine: 5,
      endLine: 13,
      lineCount: 9,
    });

    // Check OrderService.__init__ (should NOT have a stub)
    expect(outline.elements[1]).toEqual({
      name: 'OrderService.__init__',
      kind: 'method',
      startLine: 6,
      endLine: 7,
      lineCount: 2,
    });
    expect(outline.elements[1].stub).toBeUndefined();

    // Check OrderService.create
    expect(outline.elements[2]).toEqual({
      name: 'OrderService.create',
      kind: 'method',
      startLine: 9,
      endLine: 10,
      lineCount: 2,
    });
    expect(outline.elements[2].stub).toBeUndefined();

    // Check OrderService.refund (should have stub: throws)
    expect(outline.elements[3]).toEqual({
      name: 'OrderService.refund',
      kind: 'method',
      startLine: 12,
      endLine: 13,
      lineCount: 2,
      stub: 'throws',
    });

    // Check list_orders function (should have stub: empty)
    expect(outline.elements[4]).toEqual({
      name: 'list_orders',
      kind: 'function',
      startLine: 16,
      endLine: 18,
      lineCount: 3,
      stub: 'empty',
    });
  });

  it('extracts function from shop/services/pricing.py', () => {
    const file = path.join(fixtureDir, 'shop/services/pricing.py');
    const code = fs.readFileSync(file, 'utf-8');
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'shop/services/pricing.py', code);

    // Should have: apply_discount function (no stub because it has a return statement)
    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0]).toEqual({
      name: 'apply_discount',
      kind: 'function',
      startLine: 1,
      endLine: 3,
      lineCount: 3,
    });
    expect(outline.elements[0].stub).toBeUndefined();
  });

  it('handles function with only docstring and TODO comment as todo stub', () => {
    const code = `def function_with_todo():
    # TODO: implement this
    ...
`;
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'test.py', code);

    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0]).toEqual({
      name: 'function_with_todo',
      kind: 'function',
      startLine: 1,
      endLine: 3,
      lineCount: 3,
      stub: 'todo',
    });
  });

  it('handles return None as returns-nothing stub', () => {
    const code = `def func():
    return None
`;
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'test.py', code);

    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0]).toEqual({
      name: 'func',
      kind: 'function',
      startLine: 1,
      endLine: 2,
      lineCount: 2,
      stub: 'returns-nothing',
    });
  });

  it('handles return without value as returns-nothing stub', () => {
    const code = `def func():
    return
`;
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'test.py', code);

    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0].stub).toBe('returns-nothing');
  });

  it('sorts elements by startLine then name', () => {
    const code = `def b():
    pass

def a():
    pass

class Z:
    def z():
        pass
    def a():
        pass
`;
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'test.py', code);

    // Elements should be sorted by startLine, then name
    expect(outline.elements[0].name).toBe('b');
    expect(outline.elements[1].name).toBe('a');
    expect(outline.elements[2].name).toBe('Z');
    // Z's methods are sorted by startLine (z comes before a because z is on line 8, a on line 9)
    expect(outline.elements[3].name).toBe('Z.z');
    expect(outline.elements[4].name).toBe('Z.a');
  });

  it('does not list nested functions', () => {
    const code = `def outer():
    def inner():
        pass
    pass
`;
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'test.py', code);

    // Should only have 'outer', not 'inner'
    expect(outline.elements.length).toBe(1);
    expect(outline.elements[0].name).toBe('outer');
  });

  it('handles empty file', () => {
    const code = '';
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'empty.py', code);

    expect(outline.elements.length).toBe(0);
    expect(outline.lineCount).toBe(0);
  });

  it('drops typing.overload stubs so the implementation keeps the plain name (like TS overload signatures)', () => {
    const code = `import typing
@overload
def f(a: int) -> int: ...
@typing.overload
def f(a: str) -> str: ...
def f(a):
    return a
class C:
    @overload
    @staticmethod
    def m(a: int) -> int: ...
    @staticmethod
    def m(a):
        return a
`;
    const outline = extractPythonOutline(parsePython(code), 'test.py', code);
    expect(outline.elements.map((e) => [e.name, e.startLine])).toEqual([
      ['f', 6], ['C', 8], ['C.m', 12],
    ]);
  });

  it('tracks parseError', () => {
    const code = 'def broken(:\n  pass';
    const tree = parsePython(code);
    const outline = extractPythonOutline(tree, 'broken.py', code);

    expect(outline.parseError).toBe(true);
  });
});

describe('nested functions (b782)', () => {
  const NESTED_PY = [
    'def outer():',
    '    def inner():',
    '        def deep():',
    '            pass',
    '        return deep',
    '    @wraps(outer)',
    '    def decorated():',
    '        return 1',
    '    class Local:',
    '        def m(self):',
    '            pass',
    '    return inner',
    '',
    'class Shop:',
    '    def total(self):',
    '        def add(x):',
    '            raise NotImplementedError',
    '        return add',
    '',
  ].join('\n');
  const outline = extractPythonOutline(pythonHandler.parse(NESTED_PY, 'shop/n.py'), 'shop/n.py', NESTED_PY);

  it('leaves elements unchanged', () => {
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['outer', 'function', 1, 12], ['Shop', 'class', 14, 18], ['Shop.total', 'method', 15, 18],
    ]);
  });

  it('lists defs inside function bodies as parent.name, skipping classes in a body', () => {
    expect(outline.nested!.map((n) => [n.name, n.parent, n.startLine, n.endLine, n.stub ?? null])).toEqual([
      ['outer.inner', 'outer', 2, 5, null], ['outer.inner.deep', 'outer.inner', 3, 4, 'empty'],
      ['outer.decorated', 'outer', 6, 8, null], ['Shop.total.add', 'Shop.total', 16, 17, 'throws'],
    ]);
    expect(outline.nested!.some((n) => n.name.includes('Local') || n.name.endsWith('.m'))).toBe(false);
  });
});
