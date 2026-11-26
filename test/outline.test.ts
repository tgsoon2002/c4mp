import fs from 'fs';
import path from 'path';
import { parseSource } from '../src/languages/typescript/language';
import { extractOutline } from '../src/languages/typescript/outline';
import { elementsNamed } from '../src/languages/treesitter';

const fixtureRoot = path.join(__dirname, 'fixtures/sample');

describe('extractOutline', () => {
  it('should extract 4 elements from orderService.ts', () => {
    const file = 'api/src/services/orderService.ts';
    const fullPath = path.join(fixtureRoot, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    const { tree } = parseSource(code, file);

    const outline = extractOutline(tree, file, code);

    expect(outline.elements).toHaveLength(4);
    expect(outline.elements[0].name).toBe('OrderService');
    expect(outline.elements[0].kind).toBe('class');
    expect(outline.elements[1].name).toBe('OrderService.constructor');
    expect(outline.elements[1].kind).toBe('method');
    expect(outline.elements[2].name).toBe('OrderService.create');
    expect(outline.elements[2].kind).toBe('method');
    expect(outline.elements[3].name).toBe('OrderService.find');
    expect(outline.elements[3].kind).toBe('method');
  });

  it('should extract 2 elements from Cart.jsx and skip nested functions', () => {
    const file = 'web/src/components/Cart.jsx';
    const fullPath = path.join(fixtureRoot, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    const { tree } = parseSource(code, file);

    const outline = extractOutline(tree, file, code);

    expect(outline.elements).toHaveLength(2);
    expect(outline.elements[0].name).toBe('Cart');
    expect(outline.elements[0].kind).toBe('function');
    expect(outline.elements[0].startLine).toBe(5);
    expect(outline.elements[1].name).toBe('loadApp');
    expect(outline.elements[1].kind).toBe('function');
    expect(outline.elements[1].startLine).toBe(9);

    // Verify no validate, helper, or other nested functions appear
    const names = outline.elements.map((e) => e.name);
    expect(names).not.toContain('validate');
    expect(names).not.toContain('helper');
    expect(names).not.toContain('React');
  });

  it('should calculate correct line counts for files', () => {
    const file = 'api/src/lib/log.ts';
    const fullPath = path.join(fixtureRoot, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    const { tree } = parseSource(code, file);

    const outline = extractOutline(tree, file, code);

    expect(outline.lineCount).toBe(3);
    expect(outline.parseError).toBe(false);
  });

  it('should index the interface of order.ts as a type next to its function', () => {
    const file = 'api/src/models/order.ts';
    const fullPath = path.join(fixtureRoot, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    const { tree } = parseSource(code, file);

    const outline = extractOutline(tree, file, code);

    const byName = Object.fromEntries(outline.elements.map((e) => [e.name, e.kind]));
    expect(byName).toEqual({ Order: 'type', makeOrder: 'function' });
  });

  it('should index interface, type alias and enum (exported or not) as kind type', () => {
    const code = `export interface Handler { (c: number): string }
type Id = string | number;
export enum Color { Red, Green }
declare const x: number;`;
    const { tree } = parseSource(code, 'test.ts');

    const outline = extractOutline(tree, 'test.ts', code);

    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine])).toEqual([
      ['Handler', 'type', 1],
      ['Id', 'type', 2],
      ['Color', 'type', 3],
    ]);
  });

  it('should keep one element when a type shares its name with a function, class or earlier type', () => {
    const code = `export const Foo = () => 1;
export type Foo = number;
class Bar {}
interface Bar { x: number }
interface Baz { a: 1 }
interface Baz { b: 2 }`;
    const { tree } = parseSource(code, 'test.ts');

    const outline = extractOutline(tree, 'test.ts', code);

    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual([
      ['Foo', 'function'],
      ['Bar', 'class'],
      ['Baz', 'type'],
    ]);
  });

  it('should suffix later repeats of a function or method name with #2, #3 (types are still dropped)', () => {
    const code = `function g() {}
function g() {}
interface g { x: 1 }
function g() {}
class A { m() {} m() {} }`;
    const { tree } = parseSource(code, 'test.ts');

    const outline = extractOutline(tree, 'test.ts', code);

    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual([
      ['g', 'function'],
      ['g#2', 'function'],
      ['g#3', 'function'],
      ['A', 'class'],
      ['A.m', 'method'],
      ['A.m#2', 'method'],
    ]);
  });

  it.each([
    ['function IIFE', '(function () {\n  function a() { return 1; }\n  const b = () => 2;\n})();'],
    ['arrow IIFE', '(() => {\n  function a() { return 1; }\n  const b = () => 2;\n})();'],
    ['call inside parens', '(function () {\n  function a() { return 1; }\n  const b = () => 2;\n}());'],
    ['bang IIFE', '!function () {\n  function a() { return 1; }\n  const b = () => 2;\n}();'],
    ['.call(this)', '(function () {\n  function a() { return 1; }\n  const b = () => 2;\n}).call(this);'],
  ])('should walk into a %s', (_label, code) => {
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual([
      ['a', 'function'],
      ['b', 'function'],
    ]);
  });

  it('should not index calls that are not function wrappers', () => {
    const code = `foo(function () { function a() { return 1; } });\n(function () { function b() { return 1; } });`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(0);
  });

  it.each([
    ['obj.x = function', 'res.cookie = function (name) { return 1; };', [['res.cookie', 'method']]],
    ['named function expression', 'res.location = function location(u) { return u; };', [['res.location', 'method']]],
    ['obj.x = arrow', 'api.get = (a) => { return a; };', [['api.get', 'method']]],
    ['module.exports.x', 'module.exports.helper = function () { return 1; };', [['helper', 'function']]],
    ['exports.x', 'exports.other = () => 2;', [['other', 'function']]],
    ['Foo.prototype.x', 'Foo.prototype.bar = function () { return 1; };', [['Foo.bar', 'method']]],
    ['deep chain', 'a.b.c = function () {};', [['a.b.c', 'method']]],
    ['UMD inside an IIFE', '(function (root) {\n  root.lib = function () { return 1; };\n  exports.x = function () {};\n})(this);', [['root.lib', 'method'], ['x', 'function']]],
    ['module.exports = function is skipped', 'module.exports = function () { return 1; };', []],
    ['computed and this targets are skipped', 'a[b] = function () {};\nthis.x = function () {};\nfoo().x = function () {};', []],
    ['non-function value is skipped', 'res.x = 5;\nres.y = foo(function () {});', []],
    ['assignments in a function body are not indexed', 'function outer() { res.cookie = function () {}; app.on("x", function () {}); }', [['outer', 'function']]],
  ])('should index assigned functions: %s', (_label, code, expected) => {
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual(expected);
  });

  it('should list every method of an express-style response.js', () => {
    const code = `var res = Object.create(http.ServerResponse.prototype);
module.exports = res;
res.status = function status(code) { this.statusCode = code; return this; };
res.cookie = function (name, value) {
  return this.append('Set-Cookie', name);
};
res.clearCookie = function clearCookie(name) { return this.cookie(name, ''); };
function sendfile(res) { return res; }
`;
    const { tree } = parseSource(code, 'lib/response.js');

    const outline = extractOutline(tree, 'lib/response.js', code);

    expect(outline.elements.map((e) => e.name)).toEqual(['res.status', 'res.cookie', 'res.clearCookie', 'sendfile']);
  });

  it('should extract methods from object literals (shorthand and arrow functions)', () => {
    const code = `const Obj = {
  foo() {
    return 1;
  },
  bar: () => {
    return 2;
  }
};`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(2);
    expect(outline.elements[0].name).toBe('Obj.foo');
    expect(outline.elements[0].kind).toBe('method');
    expect(outline.elements[1].name).toBe('Obj.bar');
    expect(outline.elements[1].kind).toBe('method');
  });

  it('should skip objects with only non-function values', () => {
    const code = `const cfg = { port: 3000, host: 'localhost' };`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(0);
  });

  it('should mark stub on empty object method', () => {
    const code = `const O = {
  a() {},
  b: () => { throw new Error('x') }
};`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(2);
    expect(outline.elements[0].name).toBe('O.a');
    expect(outline.elements[0].stub).toBe('empty');
    expect(outline.elements[1].name).toBe('O.b');
    expect(outline.elements[1].stub).toBe('throws');
  });

  it('should never mark stub on constructor even if empty', () => {
    const code = `class OrderService {
  constructor() {}
  create() {}
}`;
    const { tree } = parseSource(code, 'test.ts');

    const outline = extractOutline(tree, 'test.ts', code);

    expect(outline.elements).toHaveLength(3);
    expect(outline.elements[1].name).toBe('OrderService.constructor');
    expect(outline.elements[1].stub).toBeUndefined();
    expect(outline.elements[2].name).toBe('OrderService.create');
    expect(outline.elements[2].stub).toBe('empty');
  });

  it('should mark stub on const arrow function', () => {
    const code = `const fn1 = () => { throw new Error('todo'); };
const fn2 = () => 42;`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(2);
    expect(outline.elements[0].name).toBe('fn1');
    expect(outline.elements[0].stub).toBe('throws');
    expect(outline.elements[1].name).toBe('fn2');
    expect(outline.elements[1].stub).toBeUndefined();
  });

  it('should not include stub key when function is fully implemented', () => {
    const code = `function doSomething() {
  console.log('working');
  return true;
}`;
    const { tree } = parseSource(code, 'test.js');

    const outline = extractOutline(tree, 'test.js', code);

    expect(outline.elements).toHaveLength(1);
    expect(outline.elements[0].name).toBe('doSomething');
    expect(outline.elements[0].stub).toBeUndefined();
  });

  it('should mark stub on sample fixture orderService.ts constructor as empty', () => {
    const file = 'api/src/services/orderService.ts';
    const fullPath = path.join(fixtureRoot, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    const { tree } = parseSource(code, file);

    const outline = extractOutline(tree, file, code);

    // Constructor should NOT have stub even though body is empty (per spec)
    const constructor = outline.elements.find((e) => e.name === 'OrderService.constructor');
    expect(constructor).toBeDefined();
    expect(constructor!.stub).toBeUndefined();
  });
});

describe('nested functions (b782)', () => {
  const NESTED_TS = [
    'export function outer(a: number): number {',
    '  function inner(b: number): number {',
    '    const deep = () => b * 2;',
    '    return deep();',
    '  }',
    '  const arrow = (x: number) => {',
    '    return x + 1;',
    '  };',
    '  [1].forEach(() => { function inCallback() {} });',
    '  class Local { m() { function notListed() {} } }',
    '  return inner(a) + arrow(a);',
    '}',
    'export class Box {',
    '  open(): void {',
    "    function helper() { throw new Error('x'); }",
    '    helper();',
    '  }',
    '}',
    'export const top = () => {',
    '  function inTop() { return 1; }',
    '  return inTop();',
    '};',
    '',
  ].join('\n');
  const LEGACY_JS = ['function Foo() {', '  function bar() {}', '}', 'Foo.bar = function () {};', ''].join('\n');
  const outlineOf = (code: string, file: string) => extractOutline(parseSource(code, file).tree, file, code);

  it('leaves elements unchanged', () => {
    const outline = outlineOf(NESTED_TS, 'src/n.ts');
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['outer', 'function', 1, 12], ['Box', 'class', 13, 18], ['Box.open', 'method', 14, 17], ['top', 'function', 19, 22],
    ]);
  });

  it('lists functions declared inside function bodies as parent.name', () => {
    const outline = outlineOf(NESTED_TS, 'src/n.ts');
    expect(outline.nested!.map((n) => [n.name, n.parent, n.outer, n.startLine, n.endLine, n.stub ?? null])).toEqual([
      ['outer.inner', 'outer', 'outer', 2, 5, null], ['outer.inner.deep', 'outer.inner', 'outer', 3, 3, null],
      ['outer.arrow', 'outer', 'outer', 6, 8, null], ['outer.inCallback', 'outer', 'outer', 9, 9, 'empty'],
      ['Box.open.helper', 'Box.open', 'Box.open', 15, 15, 'throws'], ['top.inTop', 'top', 'top', 20, 20, null],
    ]);
    expect(outline.nested!.every((n) => n.kind === 'function')).toBe(true);
    expect(outline.nested!.some((n) => n.name.includes('notListed') || n.name.endsWith('.m'))).toBe(false);
  });

  it('suffixes a nested name that clashes with an element name', () => {
    const outline = outlineOf(LEGACY_JS, 'src/legacy.js');
    expect(outline.elements.map((e) => e.name)).toEqual(['Foo', 'Foo.bar']);
    expect(outline.elements[1]).toMatchObject({ kind: 'method', startLine: 4 });
    expect(outline.nested).toHaveLength(1);
    expect(outline.nested![0]).toMatchObject({ name: 'Foo.bar#2', parent: 'Foo', outer: 'Foo', startLine: 2, endLine: 2, kind: 'function' });
  });

  it('elementsNamed finds elements first, then nested functions by full name only', () => {
    const outline = outlineOf(NESTED_TS, 'src/n.ts');
    const inner = elementsNamed(outline, 'outer.inner');
    expect(inner.map((e) => [e.startLine, e.endLine])).toEqual([[2, 5]]);
    expect(elementsNamed(outline, 'Box.open').map((e) => e.kind)).toEqual(['method']);
    expect(elementsNamed(outline, 'inner')).toEqual([]);
    const legacy = outlineOf(LEGACY_JS, 'src/legacy.js');
    expect(elementsNamed(legacy, 'Foo.bar').map((e) => e.kind)).toEqual(['method']);
    expect(elementsNamed(legacy, 'Foo.bar#2').map((e) => e.startLine)).toEqual([2]);
  });

  it('has no nested key for a file without nested functions', () => {
    const file = 'web/src/components/Cart.jsx';
    const code = fs.readFileSync(path.join(fixtureRoot, file), 'utf8');
    expect(extractOutline(parseSource(code, file).tree, file, code).nested).toBeUndefined();
  });

  it('lists the inner functions of extractOutline itself', () => {
    const file = 'src/languages/typescript/outline.ts';
    const code = fs.readFileSync(path.join(__dirname, '../src/languages/typescript/outline.ts'), 'utf8');
    const names = extractOutline(parseSource(code, file).tree, file, code).nested!.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining([
      'extractOutline.addNamed', 'extractOutline.iifeStatements', 'extractOutline.assignedFunction', 'extractOutline.visit',
    ]));
  });
});
