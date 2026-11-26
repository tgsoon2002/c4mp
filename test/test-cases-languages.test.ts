import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { LANGUAGES } from '../src/languages/registry';
import { markTestCases, testCasePattern } from '../src/languages/testCases';
import type { Snapshot, TestsConfig } from '../src/types';

// Phase 26 T26-5: the test cases of Python, Rust, C#, PHP, C++ and Swift are their existing functions and
// methods, marked kind 'test' by the language's pattern, only in role-test files.

const FIX = path.join(__dirname, 'fixtures');

describe.each([
  ['python', 'pyshop', 'tests/test_orders.py', ['test_free', 'test_not_free', 'TestOrders.test_total', 'OrderCase.test_id']],
  ['rust', 'rustshop', 'tests/orders.rs', ['total_doubles', 'total_async', 'total_overflows']],
  ['csharp', 'csharpshop', 'Shop/OrderTests.cs', ['OrderTests.HasId', 'OrderTests.IsFree', 'OrderTests.Prices']],
  ['php', 'phpshop', 'tests/OrderTest.php', ['OrderTest.testPays', 'OrderTest.it_is_free', 'OrderTest.refunds']],
  ['cpp', 'cppshop', 'test/order_test.cpp', ['TEST(OrderTest, IsFree)', 'TEST_F(OrderFixture, Total)']],
  ['swift', 'swiftshop', 'Tests/ShopTests/ShopTests.swift', ['ShopTests.testOrder', 'KitTests.formats', 'KitTests.rounds', 'freeOrder']],
])('%s fixture %s', (language, fixture, file, expected) => {
  const scan = (tests?: TestsConfig): Snapshot =>
    runSnapshot({ repo: path.join(FIX, fixture), write: false, quiet: true, config: { languages: [language], ...(tests && { tests }) } });
  const elementsOf = (s: Snapshot) => s.files.find((f) => f.file === file)!.elements;
  let marked: Snapshot;
  let plain: Snapshot;
  beforeAll(() => {
    marked = scan();
    plain = scan({ globs: [] });   // same file, not a test file
  });

  it(`${file} lists its test cases (ids file#name), no other file has any`, () => {
    const allTests = marked.files.flatMap((f) => f.elements.filter((e) => e.kind === 'test').map((e) => `${f.file}#${e.name}`));
    expect(allTests).toEqual(expected.map((n) => `${file}#${n}`));
  });

  it('outside the test globs the same functions keep kind function or method; only kinds differ', () => {
    expect(plain.files.flatMap((f) => f.elements).filter((e) => e.kind === 'test')).toEqual([]);
    const kindOf = new Map(elementsOf(plain).map((e) => [e.name, e.kind]));
    expect(expected.map((n) => kindOf.get(n)).every((k) => k === 'function' || k === 'method')).toBe(true);
    expect(elementsOf(marked).map(({ kind: _k, ...e }) => e)).toEqual(elementsOf(plain).map(({ kind: _k, ...e }) => e));
  });
});

describe('patterns: look-alikes are not test cases', () => {
  it.each([
    ['rust', 'mod t {\n#[cfg(test)]\nfn helper() {}\n#[test_case(1)]\nfn table(n: u32) {}\n#[test]\nfn real() {}\n}\n', ['real']],
    ['csharp', 'class T {\n[TestFixture]\nvoid Setup() {}\n[TestCase(1), Category("x")]\nvoid Cases(int n) {}\n}\n', ['T.Cases']],
    ['php', '<?php\nclass T {\n/** @testdox does it */\npublic function helps() {}\n#[TestDox("x")]\npublic function more() {}\n#[Group("a"), \\PHPUnit\\Framework\\Attributes\\Test]\npublic function real() {}\n}\n', ['T.real']],
    ['swift', 'class T {\n@Testable func helper() {}\nfunc setUp() {}\nfunc testIt() {}\n}\nfunc testFree() {}\n', ['T.testIt']],
    ['python', 'def helper_test():\n    pass\n\nclass T:\n    def setUp(self):\n        pass\n    def test_it(self):\n        pass\n', ['T.test_it']],
    ['cpp', 'void TESTER(int a) {}\nTEST_P(Suite, Param) {}\n', ['TEST_P(Suite, Param)']],
  ])('%s', (language, code, expected) => {
    const handler = LANGUAGES.handlers[language];
    const outline = handler.outline(handler.parse(code, `t.${language}`), `t.${language}`, code);
    markTestCases(outline, code, testCasePattern(language)!);
    expect(outline.elements.filter((e) => e.kind === 'test').map((e) => e.name)).toEqual(expected);
  });
});
