import * as fs from 'fs';
import * as path from 'path';
import { extractCppOutline } from '../src/languages/cpp/outline';
import { cppHandler } from '../src/languages/cpp';
import { getHandlers, handlerFor } from '../src/languages';
import { loadQueryContext } from '../src/query/context';
import { findElements, outlineFile } from '../src/query/find';
import { showTarget } from '../src/query/show';

const parseCpp = (code: string) => cppHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/cppshop');

function outlineOf(rel: string, codeOverride?: string) {
  const code = codeOverride ?? fs.readFileSync(path.join(FIX, rel), 'utf-8');
  const tree = parseCpp(code);
  return { tree, outline: extractCppOutline(tree, rel, code) };
}

describe('C++ outline', () => {
  it('header: struct, class with in-class methods, template function, enum; parses clean', () => {
    const { tree, outline } = outlineOf('src/order.hpp');
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.parseError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['Point', 'class', 6, 10],
      ['Point.sum', 'method', 9, 9],
      ['Order', 'class', 12, 21],
      ['Order.isFree', 'method', 15, 15],
      ['maxOf', 'function', 24, 26],
      ['Status', 'type', 28, 28],
    ]);
  });

  it('source: out-of-class methods are Class.method, pointer return and free function are functions', () => {
    const { tree, outline } = outlineOf('src/order.cpp');
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['Order.Order', 'method', 5, 5],
      ['Order.refund', 'method', 7, 9],
      ['makeId', 'function', 11, 13],
      ['findOrder', 'function', 15, 17],
    ]);
    expect(outline.elements.every((e) => e.stub === undefined)).toBe(true);
  });

  it('header guards and extern "C" do not hide definitions', () => {
    const { outline } = outlineOf('x.h', '#ifndef X_H\n#define X_H\nextern "C" {\nint add(int a, int b) { return a + b; }\n}\n#endif\n');
    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual([['add', 'function']]);
  });

  it('a *_BEGIN_NAMESPACE / *_END_NAMESPACE macro line is transparent (lines keep their numbers)', () => {
    const { outline } = outlineOf('ns.h', 'FMT_BEGIN_NAMESPACE\ntemplate <typename T> struct A { int f() { return 1; } };\nvoid g() {}\nFMT_END_NAMESPACE\n');
    expect(outline.parseError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.startLine])).toEqual([['A', 2], ['A.f', 2], ['g', 3]]);
  });

  // b573: export / namespace macros (fmt, nlohmann/json) made the whole file a parse error with no elements.
  it.each([
    ['FMT_EXPORT before template and class', 'b.h',
      'FMT_BEGIN_NAMESPACE\nFMT_EXPORT template <typename Context> class store2 { public: void clear() {} };\n'
      + 'FMT_EXPORT class store3 { public: void clear() {} };\nFMT_END_NAMESPACE\n',
      [['store2', 2], ['store2.clear', 2], ['store3', 3], ['store3.clear', 3]]],
    ['X_NAMESPACE_BEGIN / _END lines and an ALL_CAPS line above a class', 'c.hpp',
      'NLOHMANN_JSON_NAMESPACE_BEGIN\nclass basic_json { public: void dump() {} };\nNLOHMANN_JSON_NAMESPACE_END\n'
      + 'NLOHMANN_BASIC_JSON_TPL_DECLARATION\nclass iter_impl { public: void next() {} };\n',
      [['basic_json', 2], ['basic_json.dump', 2], ['iter_impl', 5], ['iter_impl.next', 5]]],
    ['class API name, and a macro before inline', 'd.hpp',
      'namespace x {\nclass JSON_API basic2 { public: void dump() {} };\nFMT_CONSTEXPR inline void cfn() {}\n}\n',
      [['basic2', 2], ['basic2.dump', 2], ['cfn', 3]]],
  ])('a macro the grammar cannot read: %s (b573)', (_form, file, code, expected) => {
    const { outline } = outlineOf(file, code);
    expect(outline.parseError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.startLine])).toEqual(expected);
  });

  it('macro retry: an ALL_CAPS type before const is kept; a clean file is never blanked (b573)', () => {
    const code = 'FMT_EXPORT class A { public: void f() {} };\ntypedef int FOO;\nFOO const* get() { return 0; }\n';
    const { tree, outline } = outlineOf('e.h', code);
    expect(outline.elements.map((e) => [e.name, e.startLine])).toEqual([['A', 1], ['A.f', 1], ['get', 3]]);
    expect(tree.rootNode.descendantsOfType('function_definition')[1].childForFieldName('type')!.text).toBe('FOO');
    const clean = 'const char* s = "API class x";\nint f() { return 1; }';
    expect(parseCpp(clean).rootNode.text).toBe(clean);
  });

  it('nested classes and member template classes are listed under their plain name with their methods (b575)', () => {
    const code = 'struct Outer {\n  struct Inner { void innerMethod() {} };\n  template<class T> struct Tmpl { void tm() {} };\n'
      + '  bool operator==(const Outer&) const { return true; }\n  static void staticOne() {}\n'
      + '  class Deep {\n   public:\n    struct Deeper { int d() { return 1; } };\n  };\n  struct Declared;\n};\n';
    const { outline } = outlineOf('nested.cpp', code);
    expect(outline.parseError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['Outer', 'class', 1, 11],
      ['Inner', 'class', 2, 2], ['Inner.innerMethod', 'method', 2, 2],
      ['Tmpl', 'class', 3, 3], ['Tmpl.tm', 'method', 3, 3],
      ['Outer.operator==', 'method', 4, 4], ['Outer.staticOne', 'method', 5, 5],
      ['Deep', 'class', 6, 9], ['Deeper', 'class', 8, 8], ['Deeper.d', 'method', 8, 8],
    ]);
  });

  it('a name written over several lines has each whitespace run collapsed to one space (b205)', () => {
    const { outline } = outlineOf('x.h', 'template <> struct is_x<\n    int,   char> { int f() { return 1; } };\n');
    expect(outline.elements.map((e) => [e.name, e.startLine, e.endLine])).toEqual([
      ['is_x< int, char>', 1, 2], ['is_x< int, char>.f', 2, 2],
    ]);
  });

  it('a gtest TEST / TEST_F body is named by its macro arguments, not TEST#N', () => {
    const { outline } = outlineOf('t.cc', 'TEST(util, parse) {\n  int a = 1;\n}\nTEST_F(Fixture,   run) { go(); }\nvoid g() {}\n');
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['TEST(util, parse)', 'function', 1, 3], ['TEST_F(Fixture, run)', 'function', 4, 4], ['g', 'function', 5, 5],
    ]);
  });

  it('handler reads includes; selected by --lang cpp for all C++ extensions', () => {
    const { tree } = outlineOf('src/order.cpp');
    expect(cppHandler.imports(tree).map((i) => i.spec)).toEqual(['order.hpp']);
    const handlers = getHandlers(['cpp']);
    for (const f of ['a.cpp', 'a.cc', 'a.cxx', 'a.hpp', 'a.hh', 'a.hxx', 'a.h']) {
      expect(handlerFor(f, handlers)?.id).toBe('cpp');
    }
  });
});

describe('C++ find / show / outline', () => {
  const ctx = loadQueryContext(FIX, { cli: { languages: ['cpp'] } });

  it('scan lists all files (headers included) without parse errors', () => {
    expect(ctx.snapshot.files.map((f) => f.file).sort()).toEqual(['include/shop/util.h', 'libs/gtest/gtest/gtest.h', 'src/main.cpp', 'src/order.cpp', 'src/order.hpp', 'test/order_test.cpp']);
    expect(ctx.snapshot.files.every((f) => !f.parseError)).toBe(true);
  });

  it('find and outline see methods declared in the header and defined in the source', () => {
    const rows = findElements(ctx, { query: 'Order.refund' }).results;
    expect(rows[0]).toMatchObject({ path: 'src/order.cpp', name: 'Order.refund', kind: 'method', startLine: 7 });
    const order = outlineFile(ctx, 'src/order.hpp').elements.find((e) => e.name === 'Order')!;
    expect(order.children!.map((c) => c.name)).toEqual(['Order.isFree']);
  });

  it('show returns the function source', () => {
    const r = showTarget(ctx, 'src/order.cpp#makeId');
    expect(r.startLine).toBe(11);
    expect(r.code.join('\n')).toContain('return seed * 31;');
  });
});
