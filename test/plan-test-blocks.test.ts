import * as fs from 'fs';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { runPlanCli, makeRepo, writeSource } from './helpers/planEditHarness';
import { parseC4, parsePlan, parsePlanTexts } from '../src/plan/parser';
import { addTestText, locateElement, removeTestText, testBlockText } from '../src/c4/editMeta';
import { lostTestBlocks, matchPlannedTest } from '../src/c4/planTests';
import { evaluatePlanEdit } from '../src/c4/planTx';
import { generateC4 } from '../src/c4/generate';
import { c4Id } from '../src/names';
import { addRuleOf } from '../src/plan/kinds';
import { runSnapshot } from '../src/pipeline';
import { runCheck } from '../src/query/check';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// Phase 26 T26-13 (ATTACH-DESIGN.md section B, D16/D18): `test` blocks in the plan: tests to write and hand links.

/** A plan with one component `s.api.a` whose body holds `block`, then a sibling element `b` (it shows where `a` ends). */
const planWith = (block: string): string =>
  ['model {', "  s = system 'S' {", "    api = container 'Api' {", "      a = component 'A' {", ...block.split('\n').map((l) => `        ${l}`), "        b = component 'B'", '      }', '    }', '  }', '}', ''].join('\n');
const parse = (text: string) => parseC4(text, 'p.c4');
const ONE = "test 'cli help' { case 'test/cli.test.ts#help › lists' }";
const MULTI = "test 'cli help' {\n  case 'test/cli.test.ts#help › lists'\n}";

describe('grammar (parser.ts parseTest, editMeta.ts walk)', () => {
  it.each([
    ['to write', "test 'groups files' {}", [{ name: 'groups files', case: null, line: 5, endLine: 5 }], []],
    ['hand link, one line', ONE, [{ name: 'cli help', case: 'test/cli.test.ts#help › lists', line: 5, endLine: 5 }], []],
    ['hand link, multi-line', MULTI, [{ name: 'cli help', case: 'test/cli.test.ts#help › lists', line: 5, endLine: 7 }], []],
    ['no braces', "test 'bare'", [{ name: 'bare', case: null, line: 5, endLine: 5 }], []],
    ['two cases', "test 'x' { case 'a' case 'b' }", [{ name: 'x', case: 'a', line: 5, endLine: 5 }], ['test block takes one case']],
    ['stray token', "test 'x' { foo }", [{ name: 'x', case: null, line: 5, endLine: 5 }], ["unexpected 'foo' in test block"]],
    ['an element called test', "test = component 'T'", [], []],
  ])('%s', (_label, block, tests, issues) => {
    const r = parse(planWith(block));
    expect(r.issues.map((i) => i.message)).toEqual(issues);
    const a = r.elements.find((e) => e.id === 's.api.a')!;
    expect((a.tests ?? []).map((t) => ({ name: t.name, case: t.case, line: t.source.line, endLine: t.source.endLine }))).toEqual(tests);
    expect(r.elements.some((e) => e.id === 's.api.a.b')).toBe(true);   // the block never closes its parent early
    expect(locateElement(planWith(block), 's.api.a.b')).not.toBeNull();   // the edit walker agrees
  });

  // A6: a pre-1.5 reader does not know `test`: it skips the rest of the line after an unknown word (PS-3.18). An
  // unknown word in its place reads exactly like that reader: a one-line block is harmless, a multi-line one is not.
  it.each([
    ['one line', true, ONE],
    ['multi-line', false, MULTI],
  ])('an old reader and a %s block: same elements = %s', (_label, same, block) => {
    const ids = (text: string) => parse(text).elements.map((e) => e.id);
    const old = planWith(block).replace(/\btest '/, "unknown_word '");
    expect(ids(old).join() === ids(planWith(block)).join()).toBe(same);
    expect(ids(old).includes('s.api.a.b')).toBe(same);
    expect(parse(old).issues.length === 0).toBe(same);
  });

  it('the writers emit one line', () => {
    expect([testBlockText({ name: "it's", case: null }), testBlockText({ name: 'x', case: 'f#a › b' })]).toEqual([
      "test 'it\\'s' {}", "test 'x' { case 'f#a › b' }",
    ]);
    const added = addTestText(planWith(''), 's.api.a', { name: 'n', case: null });
    expect(added.text).toBe(planWith('').replace("        b = component 'B'\n", "        b = component 'B'\n        test 'n' {}\n"));   // end of the body
  });

  it.each([
    ['its own lines go', MULTI, ''],
    ['one-line block', ONE, ''],
    ['sharing a line: only the block', `title 'A' ${ONE}`, "title 'A'"],
  ])('removeTestText: %s', (_label, block, left) => {
    expect(removeTestText(planWith(block), 's.api.a', 'cli help').text).toBe(planWith(left).replace('        \n', ''));
  });
});

describe('matchPlannedTest (A9)', () => {
  const cases = ['parse › reads a file', 'write › reads a file', 'parse › skips comments', 'top level'].map((name) => ({ name }));
  it.each([
    ['parse › reads a file', 'parse › reads a file'],   // full chain
    ['skips comments', 'parse › skips comments'],       // unique leaf
    ['  top level ', 'top level'],                      // trimmed
    ['reads a file', null],                             // ambiguous leaf
    ['writes', null],
  ])('%s -> %s', (name, want) => {
    expect(matchPlannedTest({ name }, cases)?.name ?? null).toBe(want);
  });
});

describe('the gate keeps test blocks (A8)', () => {
  const texts = (t: string) => new Map([['p.c4', t]]);
  const before = planWith("test 'kept' {}");
  it.each([
    ['dropped', planWith(''), {}, ["test block lost by the edit: s.api.a test 'kept'"]],
    ['dropped, allowed', planWith(''), { allowLostTests: [{ parent: 's.api.a', name: 'kept' }] }, []],
    ['moved with its element', before.replace("a = component 'A'", "a2 = component 'A'"), { moved: new Map([['s.api.a', 's.api.a2'], ['s.api.a.b', 's.api.a2.b']]) }, []],
    ['its element removed (allowed)', before.replace(/ {6}a = component[\s\S]*? {6}\}\n/, ''), { allowLost: ['s.api.a', 's.api.a.b'] }, []],
  ])('%s', (_label, after, extra, reasons) => {
    const r = evaluatePlanEdit({ repoRoot: '/r', oldTexts: texts(before), newTexts: texts(after), ...extra });
    expect(r.reasons).toEqual(reasons);
  });

  it('lostTestBlocks counts each block once', () => {
    const p = (t: string) => parsePlanTexts('/r', texts(t));
    expect(lostTestBlocks(p(planWith("test 'x' {}\ntest 'x' {}")), p(planWith("test 'x' {}")))).toEqual([{ parent: 's.api.a', name: 'x' }]);
  });
});

describe('plan add test / plan remove --test / check / generate (a TS repo)', () => {
  const PLAN = [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      core = layer 'Core' {",
    "        billing = component 'Billing' {",
    '          link ../../../../src/billing.ts#charge',
    "          charge = function 'charge' {",
    "            metadata { status 'planned' }",
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo('c4pm-testblock-', { 'a.c4': PLAN });
    writeSource(repo.root, repo.planDir, 'src/billing.ts', 'export function charge(): number {\n  return 1;\n}\n');
    writeSource(repo.root, repo.planDir, 'test/helpers/make.ts', "import { charge } from '../../src/billing';\nexport const make = (): number => charge();\n");
    writeSource(repo.root, repo.planDir, 'test/billing.test.ts', "import { make } from './helpers/make';\ndescribe('billing', () => {\n  it('charges', () => expect(make()).toBe(1));\n});\n");
  });
  afterEach(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  const add = (...args: string[]) => runPlanCli(['plan', 'add', 'test', ...args, '--repo', repo.root]);
  const plan = () => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
  const testsOn = (fqn: string) => (plan().elements.find((e) => e.id === fqn)?.tests ?? []).map((t) => [t.name, t.case]);
  const notWritten = (cli: object = {}) => runCheck(repo.root, cli, {})!.findings.filter((f) => f.rule === 'planned-not-built' && f.message.startsWith('test '));

  it('kind table: test is an accessory (no KIND_TABLE row) with four parents', () => {
    expect(addRuleOf('test')).toEqual({ plan: 'test', parents: ['container', 'component', 'function', 'method'], code: false, accessory: true });
  });

  it.each([
    ['component', 'app.api.core.billing', [], 0, ''],
    ['container', 'app.api', [], 0, ''],
    ['planned function', 'app.api.core.billing.charge', [], 0, ''],
    ['hand link to a case', 'app.api.core.billing', ['--case', 'test/billing.test.ts#billing › charges'], 0, ''],
    ['hand link to a helper file', 'app.api.core.billing', ['--case', 'test/helpers/make.ts'], 0, ''],
    ['system', 'app', [], 1, 'goes under a container, component, function or method'],
    ['subregion', 'app.api.core', [], 1, "is a subregion"],
    ['dead --case', 'app.api.core.billing', ['--case', 'test/billing.test.ts#nope'], 1, 'is neither a test case id'],
    ['an element option', 'app.api.core.billing', ['--status', 'planned'], 1, 'takes only --parent and --case'],
  ])('plan add test under a %s', async (_label, parent, extra, code, err) => {
    const before = fs.readFileSync(repo.files['a.c4'], 'utf8');
    const dry = await add('refunds', '--parent', parent, ...extra);
    expect([dry.code, dry.stderr.includes(err)]).toEqual([code, true]);
    expect(fs.readFileSync(repo.files['a.c4'], 'utf8')).toBe(before);   // a dry run writes nothing
    if (code !== 0) return;
    expect(dry.stdout.split('\n').filter((l) => /^[+-](?![+-])/.test(l))).toEqual([expect.stringMatching(/^\+ +test 'refunds' \{/)]);   // one added line
    expect((await add('refunds', '--parent', parent, ...extra, '--yes')).code).toBe(0);
    expect(testsOn(parent)).toEqual([['refunds', extra[0] === '--case' ? extra[1] : null]]);
    expect((await add('refunds', '--parent', parent, '--yes')).stderr).toContain("already has test 'refunds'");
  });

  it('a test to write is planned-not-built until a case with that name exists', async () => {
    expect((await add('refunds', '--parent', 'app.api.core.billing', '--yes')).code).toBe(0);
    expect(notWritten().map((f) => [f.id, f.message])).toEqual([['app.api.core.billing', "test 'refunds' not written"]]);
    fs.writeFileSync(path.join(repo.root, 'test/billing.test.ts'), "describe('billing', () => {\n  it('refunds', () => expect(1).toBe(1));\n});\n");
    expect(notWritten()).toEqual([]);
  });

  it('no-tests is off by default; with tests.noTests a component without tests is reported', async () => {
    fs.writeFileSync(path.join(repo.root, 'test/billing.test.ts'), "it('nothing', () => expect(1).toBe(1));\n");
    fs.rmSync(path.join(repo.root, 'test/helpers'), { recursive: true });
    const noTests = (cli: object) => runCheck(repo.root, cli, {})!.findings.filter((f) => f.rule === 'no-tests').map((f) => f.id);
    expect(noTests({})).toEqual([]);
    expect(noTests({ tests: { noTests: true } })).toEqual(['app.api.core.billing']);
    expect((await add('refunds', '--parent', 'app.api.core.billing.charge', '--yes')).code).toBe(0);
    expect(noTests({ tests: { noTests: true } })).toEqual([]);   // a planned test below it counts
  });

  it('plan remove --test goes through the gate and removes only that block', async () => {
    expect((await add('refunds', '--parent', 'app.api.core.billing', '--yes')).code).toBe(0);
    expect((await add('voids', '--parent', 'app.api.core.billing', '--yes')).code).toBe(0);
    const remove = (...a: string[]) => runCli(['plan', 'remove', 'app.api.core.billing', ...a, '--repo', repo.root]);
    expect(remove('--test', 'nope').stderr).toContain("has no test 'nope' (tests: 'refunds', 'voids')");
    const dry = remove('--test', 'refunds');
    expect([dry.status, dry.stdout]).toEqual([0, expect.stringContaining("-          test 'refunds' {}")]);
    expect(remove('--test', 'refunds', '--yes').status).toBe(0);
    expect(testsOn('app.api.core.billing')).toEqual([['voids', null]]);
  });

  it('generate keeps test blocks: verbatim with the plan text, one line without it', () => {
    const snapshot = runSnapshot({ repo: repo.root, write: false, quiet: true });
    const first = generateC4(snapshot, null);
    const sys = c4Id(snapshot.system.id);
    const block = "test 'multi' {\n  case 'test/helpers/make.ts'\n}";
    const withBlocks = Object.fromEntries(Object.entries(first).map(([f, t]) => [f, t
      .replace(/(\n {4}metadata \{\n[^}]*\}\n)/, `$1    test 'on system' {}\n`)
      .replace(/(\n {6}metadata \{\n[^}]*\}\n)/, `$1      ${block.split('\n').join('\n      ')}\n`)]));
    const existing = parsePlanTexts(repo.root, new Map(Object.entries(withBlocks)));
    expect(existing.issues).toEqual([]);
    const tests = (files: Record<string, string>) => parsePlanTexts(repo.root, new Map(Object.entries(files))).elements
      .filter((e) => e.tests).map((e) => [e.id, (e.tests ?? []).map((t) => [t.name, t.case])]);
    expect(tests(withBlocks).map(([id]) => id)).toEqual([sys, `${sys}.${sys}`, `${sys}.${sys}.root_files`]);   // system, container, component
    const verbatim = generateC4(snapshot, existing, { planText: (f) => withBlocks[f] });
    expect(verbatim).toEqual(withBlocks);   // byte-equal: nothing lost, nothing reflowed
    const rebuilt = generateC4(snapshot, existing);
    expect(tests(rebuilt)).toEqual(tests(withBlocks));
    expect(Object.values(rebuilt).join('')).toContain("test 'multi' { case 'test/helpers/make.ts' }");
  });
});
