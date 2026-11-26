import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { detectTestRunner, testRunCommand } from '../src/languages/testRunner';
import type { Container } from '../src/types';

// Phase 26 T26-9 (D12): the run command of a test case. The runner comes from the root of the container holding
// the test file; config `tests.command` wins; no runner and no config gives no command.

const FIX = path.join(__dirname, 'fixtures');
const RUNNERS = path.join(FIX, 'test-runners');   // one folder per runner: each is a container root
// A repo holding Project/ (jest): a temp copy of this project's jest files, so it works in the private repo (Project/ below the
// repo root) and in the public tree (this project at the root) alike (b963).
const C4PM = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-runner-')));
fs.mkdirSync(path.join(C4PM, 'Project'));
for (const f of ['package.json', 'jest.config.js']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(C4PM, 'Project', f));
afterAll(() => { fs.rmSync(C4PM, { recursive: true, force: true }); });

const container = (p: string): Container => ({ id: p, name: p, path: p, tech: 'Unknown', manifest: null });
const runnerOf = (repo: string, root: string, lang: string, command?: string) => detectTestRunner(repo, container(root), lang, command);

describe('detected runner: command and cwd per container', () => {
  it.each([
    ['jest', C4PM, 'Project', 'typescript', 'Project/test/timing.test.ts', 'timed › async fn and nested labels',
      'npx jest test/timing.test.ts -t "timed async fn and nested labels"'],
    ['vitest', RUNNERS, 'vitest', 'typescript', 'vitest/src/cart.test.ts', 'cart › adds an item (2)',
      'npx vitest run src/cart.test.ts -t "cart adds an item"'],
    ['mocha', RUNNERS, 'mocha', 'typescript', 'mocha/test/cart.spec.js', 'cart › adds', 'npx mocha test/cart.spec.js --grep "cart adds"'],
    ['pytest', RUNNERS, 'pytest', 'python', 'pytest/tests/test_orders.py', 'TestOrders.test_total',
      'pytest "tests/test_orders.py::TestOrders::test_total"'],
    ['cargo', RUNNERS, 'cargo', 'rust', 'cargo/tests/orders.rs', 'total_doubles', 'cargo test "total_doubles"'],
    ['dotnet', RUNNERS, 'dotnet', 'csharp', 'dotnet/OrderTests.cs', 'OrderTests.IsFree',
      'dotnet test --filter "FullyQualifiedName~OrderTests.IsFree"'],
    ['phpunit', RUNNERS, 'phpunit', 'php', 'phpunit/tests/OrderTest.php', 'OrderTest.testPays',
      'vendor/bin/phpunit --filter "OrderTest::testPays" tests/OrderTest.php'],
    ['swift', path.join(FIX, 'swiftshop'), '.', 'swift', 'Tests/ShopTests/ShopTests.swift', 'ShopTests.testOrder',
      'swift test --filter "ShopTests/testOrder"'],
  ])('%s', (id, repo, root, lang, file, name, command) => {
    const runner = runnerOf(repo, root, lang);
    expect(runner.id).toBe(id);
    expect(testRunCommand(runner, file, name)).toEqual({ command, cwd: root });
  });
});

describe('config tests.command wins over detection', () => {
  it.each([
    ['a detected jest container', C4PM, 'Project', 'typescript', 'Project/test/timing.test.ts', 'timed › async fn',
      'yarn jest {file} -t "{nameRegex}"', 'yarn jest test/timing.test.ts -t "timed async fn"'],
    ['gtest, where nothing is detected ({name} in gtest filter form)', path.join(FIX, 'cppshop'), '.', 'cpp',
      'test/order_test.cpp', 'TEST_F(OrderFixture, Total)', 'build/tests --gtest_filter={name}', 'build/tests --gtest_filter=OrderFixture.Total'],
  ])('%s', (_label, repo, root, lang, file, name, template, command) => {
    expect(testRunCommand(runnerOf(repo, root, lang, template), file, name)).toEqual({ command, cwd: root });
  });

  it('{nameRegex}: the describe chain joined with spaces, no (2) suffix, regex and shell escaped', () => {
    const run = testRunCommand(runnerOf(C4PM, 'Project', 'typescript', 'printf %s "{nameRegex}"'),
      'Project/test/x.test.ts', 'parse › a.b [x]+ "q" $HOME `id` \\d (2)')!;
    const regex = execFileSync('sh', ['-c', run.command], { encoding: 'utf8' });
    expect(regex).toBe('parse a\\.b \\[x\\]\\+ "q" \\$HOME `id` \\\\d');
    expect(new RegExp(regex).test('parse a.b [x]+ "q" $HOME `id` \\d')).toBe(true);
    expect(new RegExp(regex).test('parse aXb [x]+ "q" $HOME `id` \\d')).toBe(false);
  });
});

describe('no runner found: unknown, never a guessed command', () => {
  it.each([
    ['typescript', path.join(FIX, 'tscases'), '.', 'no jest, vitest, mocha found'],
    ['python', path.join(FIX, 'pyshop'), '.', 'no pytest found'],            // requirements.txt without pytest
    ['csharp', path.join(FIX, 'csharpshop'), 'Shop', 'no dotnet found'],     // a .csproj without Microsoft.NET.Test.Sdk
    ['cpp', path.join(FIX, 'cppshop'), '.', 'the gtest binary is known only to the build'],
  ])('%s', (lang, repo, root, why) => {
    const runner = runnerOf(repo, root, lang);
    expect(runner).toEqual({ id: null, reason: expect.stringContaining(why) });
    expect(runner.id === null && runner.reason).toMatch(/set config tests\.command$/);
    expect(testRunCommand(runner, 'x', 'y')).toBeNull();
  });
});

it('a test file outside the container root is an error', () => {
  expect(() => testRunCommand(runnerOf(RUNNERS, 'cargo', 'rust'), 'other/tests/a.rs', 'a')).toThrow('outside the container root cargo');
});
