import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { EditError } from '../src/edit/errors';
import { parseErrorCount } from '../src/edit/parseCheck';
import { commitCodeEdit, planCodeEdit, readFileOutline, runCodeEdit } from '../src/services/codeEdit';
import type { CodeEditRequest } from '../src/services/codeEdit';
import { cmdError, failedReport } from '../src/services/planState';
import { makeRepo as makePlanRepo, writeSource } from './helpers/planEditHarness';

// Phase 32 (ED-2, ED-3): the code edit service, in process, on a temp repo.

const A_TS = [
  "import { x } from './x';",
  '',
  '/** Adds. */',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export class Box {',
  '  open(): void {}',
  '}',
  '',
  'export function sub(a: number, b: number): number {',
  '  return a - b;',
  '}',
  '',
].join('\n');

/** A_TS with lines `from`..`to` (1-based, inclusive) replaced by `lines`. */
function withLines(from: number, to: number, lines: string[]): string {
  const all = A_TS.split('\n');
  all.splice(from - 1, to - from + 1, ...lines);
  return all.join('\n');
}

const gitEnv = (date: string) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

function git(repo: string, args: string[], date = '2026-01-01T10:00:00Z'): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: gitEnv(date) });
}

function makeRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  return repo;
}

/** The EditError code `fn` throws (undefined when it does not throw one). */
function editErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof EditError) return e.code;
    throw e;
  }
  return undefined;
}

describe('code edit service (ED-2)', () => {
  let dir: string;
  const file = () => path.join(dir, 'a.ts');
  const read = () => fs.readFileSync(file(), 'utf8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ce-'));
    fs.writeFileSync(file(), A_TS);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const NEW_ADD = 'export function add(a: number, b: number): number {\n  return b + a;\n}\n';
  it.each<[string, CodeEditRequest, string]>([
    ['replace keeps the doc comment', { op: 'replace', target: 'a.ts#add', text: NEW_ADD },
      withLines(4, 6, ['export function add(a: number, b: number): number {', '  return b + a;', '}'])],
    ['insert --after', { op: 'insert', target: 'a.ts#add', where: 'after', text: '\nexport const z = 1;\n' },
      withLines(7, 6, ['', 'export const z = 1;'])],
    ['insert --before goes above the doc comment', { op: 'insert', target: 'a.ts#add', where: 'before', text: 'export const z = 1;\n\n' },
      withLines(3, 2, ['export const z = 1;', ''])],
    ['insert --into a class', { op: 'insert', target: 'a.ts#Box', where: 'into', text: '  close(): void {}\n' },
      withLines(10, 9, ['  close(): void {}'])],
    ['replace a method', { op: 'replace', target: 'a.ts#Box.open', text: '  open(): boolean { return true; }' },
      withLines(9, 9, ['  open(): boolean { return true; }'])],
    ['remove takes the doc comment and one of the two blank lines', { op: 'remove', target: 'a.ts#add' },
      withLines(3, 7, [])],
    ['remove the last function (the blank line above goes: one final newline)', { op: 'remove', target: 'a.ts#sub' },
      withLines(11, 14, [])],
    ['remove the only method of a class', { op: 'remove', target: 'a.ts#Box.open' },
      withLines(9, 9, [])],
  ])('%s: dry run writes nothing, yes writes', (_label, req, expected) => {
    const dry = runCodeEdit(dir, {}, req, {});
    expect(dry).toMatchObject({ ok: true, dryRun: true, written: false, error: null, command: `edit ${req.op}` });
    expect(dry.files).toHaveLength(1);
    expect(dry.files[0].file).toBe('a.ts');
    expect(dry.files[0].diff).toContain('--- a/a.ts');
    expect(read()).toBe(A_TS);

    const done = runCodeEdit(dir, {}, req, { yes: true });
    expect(done).toMatchObject({ ok: true, dryRun: false, written: true, error: null });
    expect(read()).toBe(expected);
  });

  it('a replacement that adds parse errors is refused (parse-worse) and writes nothing', () => {
    const r = runCodeEdit(dir, {}, { op: 'replace', target: 'a.ts#add', text: 'export function add( {\n' }, { yes: true });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('parse-worse');
    expect(r.written).toBe(false);
    expect(read()).toBe(A_TS);
  });

  it('a file changed between plan and commit is refused (changed) and keeps the other text', () => {
    const plan = planCodeEdit(dir, {}, { op: 'remove', target: 'a.ts#sub' });
    const other = A_TS + '// someone else\n';
    fs.writeFileSync(file(), other);
    const r = commitCodeEdit(plan);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('changed');
    expect(read()).toBe(other);
  });

  it.each<[string, string, string]>([
    ['outside the repo', '../x.ts#f', 'invalid'],
    ['no #name', 'a.ts', 'invalid'],
    ['a line range', 'a.ts#L4-L6', 'invalid'],
    ['an unknown name', 'a.ts#nope', 'not-found'],
    ['a missing file', 'b.ts#f', 'not-found'],
    ['a file of a language not scanned', 'a.py#f', 'invalid'],
  ])('target %s (%s)', (_label, target, code) => {
    expect(editErrorCode(() => planCodeEdit(dir, {}, { op: 'remove', target }))).toBe(code);
    expect(runCodeEdit(dir, {}, { op: 'remove', target }, { yes: true }).error?.code).toBe(code);
    expect(read()).toBe(A_TS);
  });

  it('insert --into a function is refused; insert with no placement is refused', () => {
    expect(editErrorCode(() => planCodeEdit(dir, {}, { op: 'insert', target: 'a.ts#add', where: 'into', text: 'x();' }))).toBe('invalid');
    expect(editErrorCode(() => planCodeEdit(dir, {}, { op: 'insert', target: 'a.ts#add', text: 'x();' }))).toBe('invalid');
  });

  it('b782: a nested function is a target; bare name not-found; --into refused', () => {
    const nTs = 'export function outer(): number {\n  function inner(b: number): number {\n    return b * 2;\n  }\n  return inner(1);\n}\n';
    fs.writeFileSync(path.join(dir, 'n.ts'), nTs);
    const inner = '  function inner(b: number): number { return b; }';
    expect(runCodeEdit(dir, {}, { op: 'replace', target: 'n.ts#outer.inner', text: inner }, { yes: true })).toMatchObject({ ok: true, written: true });
    expect(fs.readFileSync(path.join(dir, 'n.ts'), 'utf8')).toBe(`export function outer(): number {\n${inner}\n  return inner(1);\n}\n`);
    expect(editErrorCode(() => planCodeEdit(dir, {}, { op: 'replace', target: 'n.ts#inner', text: 'x' }))).toBe('not-found');
    expect(editErrorCode(() => planCodeEdit(dir, {}, { op: 'insert', target: 'n.ts#outer.inner', where: 'into', text: 'x();' }))).toBe('invalid');
  });

  it('remove the last function of a file with no final newline: still none, no blank line left', () => {
    fs.writeFileSync(file(), A_TS.replace(/\n$/, ''));
    runCodeEdit(dir, {}, { op: 'remove', target: 'a.ts#sub' }, { yes: true });
    expect(read()).toBe(withLines(11, 14, []).replace(/\n$/, ''));
  });

  it('CRLF file: the edit keeps \\r\\n', () => {
    fs.writeFileSync(file(), A_TS.replace(/\n/g, '\r\n'));
    runCodeEdit(dir, {}, { op: 'replace', target: 'a.ts#Box.open', text: '  open(): boolean { return true; }\n' }, { yes: true });
    expect(read()).toBe(withLines(9, 9, ['  open(): boolean { return true; }']).replace(/\n/g, '\r\n'));
  });

  it('D4: a file with uncommitted changes gets a note; a clean one does not', () => {
    const repo = makeRepo('c4pm-ce-git-');
    try {
      fs.writeFileSync(path.join(repo, 'a.ts'), A_TS);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'one']);
      expect(planCodeEdit(repo, {}, { op: 'remove', target: 'a.ts#sub' }).report.notes).toEqual([]);
      fs.appendFileSync(path.join(repo, 'a.ts'), '// more\n');
      expect(planCodeEdit(repo, {}, { op: 'remove', target: 'a.ts#sub' }).report.notes).toEqual(['a.ts has uncommitted changes']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('test edit service (ED-3): test-case targets and the plan in step (D7)', () => {
  const A_TEST = [
    "describe('suite', () => {",
    "  it('one', () => {",
    '    expect(1).toBe(1);',
    '  });',
    '',
    "  it('two', () => expect(2).toBe(2));",
    '',
    "  it('three', () => expect(3).toBe(3));",
    '',
    "  it.each(['a', 'b'])('takes %s', (x) => {",
    '    expect(x).toBeTruthy();',
    '  });',
    '});',
    '',
  ].join('\n');
  const CASE = (name: string) => `test/a.test.ts#suite › ${name}`;
  const PLAN = [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      core = component 'Core' {",
    `        test 'first' { case '${CASE('one')}' }`,
    `        test 'each' { case '${CASE('takes %s')}' }`,
    `        test 'two here' { case '${CASE('two')}' }`,
    '      }',
    "      other = component 'Other' {",
    `        test 'two there' { case '${CASE('two')}' }`,
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  let repo: ReturnType<typeof makePlanRepo>;
  const code = () => fs.readFileSync(path.join(repo.root, 'test/a.test.ts'), 'utf8');
  const planText = () => fs.readFileSync(repo.files['a.c4'], 'utf8');
  /** A_TEST with lines `from`..`to` (1-based, inclusive) replaced by `lines`. */
  const testWith = (from: number, to: number, lines: string[]): string => {
    const all = A_TEST.split('\n');
    all.splice(from - 1, to - from + 1, ...lines);
    return all.join('\n');
  };
  const planWithout = (block: string): string => PLAN.split('\n').filter(l => !l.includes(`test '${block}'`)).join('\n');

  beforeEach(() => {
    repo = makePlanRepo('c4pm-ce3-', { 'a.c4': PLAN });
    writeSource(repo.root, repo.planDir, 'test/a.test.ts', A_TEST);
  });
  afterEach(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  it.each<[string, string, string, number, number, string]>([
    ['a case of several lines (and the blank line after it: first in its block)', 'one', 'first', 2, 5, ''],
    ['an it.each case named by its %s template (and the blank line above it: last in its block)', 'takes %s', 'each', 9, 12, ''],
    ['a case named in the ASCII form describe > it', 'one', 'first', 2, 5, 'suite > one'],
  ])('remove %s: the whole it(...) statement and the plan test block naming it go', (_label, name, block, from, to, ascii) => {
    const target = ascii ? `test/a.test.ts#${ascii}` : CASE(name);
    const dry = runCodeEdit(repo.root, {}, { op: 'remove', target }, {});
    expect(dry).toMatchObject({ ok: true, dryRun: true, written: false, error: null });
    expect(dry.files.map(f => f.file)).toEqual(['test/a.test.ts', expect.stringMatching(/a\.c4$/)]);
    expect(dry.files[1].diff).toContain(`-        test '${block}'`);
    expect(dry.notes).toContain(`the plan test block '${block}' of app.api.core names this case: it is removed too`);
    expect([code(), planText()]).toEqual([A_TEST, PLAN]);   // a dry run writes nothing

    const done = runCodeEdit(repo.root, {}, { op: 'remove', target }, { yes: true });
    expect(done).toMatchObject({ ok: true, dryRun: false, written: true, error: null });
    expect(code()).toBe(testWith(from, to, []));
    expect(planText()).toBe(planWithout(block));
  });

  it('remove a case that no plan block names: code only', () => {
    const done = runCodeEdit(repo.root, {}, { op: 'remove', target: CASE('three') }, { yes: true });
    expect(done).toMatchObject({ ok: true, written: true });
    expect(done.files).toHaveLength(1);
    expect(code()).toBe(testWith(8, 9, []));
    expect(planText()).toBe(PLAN);
  });

  it('replace a case: the whole statement is replaced, the plan is unchanged', () => {
    const text = "  it('one', () => expect(true).toBe(true));\n";
    const done = runCodeEdit(repo.root, {}, { op: 'replace', target: CASE('one'), text }, { yes: true });
    expect(done).toMatchObject({ ok: true, written: true });
    expect(done.files).toHaveLength(1);
    expect(code()).toBe(testWith(2, 4, ["  it('one', () => expect(true).toBe(true));"]));
    expect(planText()).toBe(PLAN);
  });

  it.each<[string, CodeEditRequest, string]>([
    ['--into a describe: above its closing line', { op: 'insert', target: 'test/a.test.ts#suite', where: 'into', text: "\n  it('four', () => {});\n" },
      testWith(13, 12, ['', "  it('four', () => {});"])],
    ['--after a case: below its whole statement', { op: 'insert', target: CASE('one'), where: 'after', text: "  it('1b', () => {});\n" },
      testWith(5, 4, ["  it('1b', () => {});"])],
    ['--before a case: above its whole statement', { op: 'insert', target: CASE('takes %s'), where: 'before', text: "  it('0', () => {});\n" },
      testWith(10, 9, ["  it('0', () => {});"])],
  ])('insert %s; the plan is unchanged', (_label, req, expected) => {
    expect(runCodeEdit(repo.root, {}, req, { yes: true })).toMatchObject({ ok: true, written: true });
    expect(code()).toBe(expected);
    expect(planText()).toBe(PLAN);
  });

  it('insert --into an unknown describe is not-found', () => {
    expect(editErrorCode(() => planCodeEdit(repo.root, {}, { op: 'insert', target: 'test/a.test.ts#nope', where: 'into', text: 'x();' }))).toBe('not-found');
  });

  it('two plan blocks naming the case: ambiguous, neither code nor plan written', () => {
    const r = runCodeEdit(repo.root, {}, { op: 'remove', target: CASE('two') }, { yes: true });
    expect(r).toMatchObject({ ok: false, written: false });
    expect(r.error?.code).toBe('ambiguous');
    expect(r.notes).toEqual(["candidates: app.api.core 'two here', app.api.other 'two there'"]);
    expect([code(), planText()]).toEqual([A_TEST, PLAN]);
  });

  it('a plan write that fails after the code write puts the code back (rolled-back)', () => {
    const plan = planCodeEdit(repo.root, {}, { op: 'remove', target: CASE('one') });
    expect(plan.planSync?.holder).toEqual({ el: 'app.api.core', test: 'first' });
    const r = commitCodeEdit(plan, spec => failedReport(spec.command, spec.opts, cmdError('invalid', 'disk full')));
    expect(r).toMatchObject({ ok: false, written: false });
    expect(r.error?.code).toBe('rolled-back');
    expect(r.error?.message).toContain('invalid: disk full');
    expect([code(), planText()]).toEqual([A_TEST, PLAN]);
  });
});

describe('readFileOutline (T4a, b698): one repo file read and parsed once', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-rfo-')));
    fs.writeFileSync(path.join(dir, 'a.ts'), A_TS);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a code file: its text, real path and outline (functions, class, method)', () => {
    const f = readFileOutline(dir, {}, 'a.ts');
    expect(f).toMatchObject({ rel: 'a.ts', absFile: path.join(dir, 'a.ts'), code: A_TS });
    expect(f.handler.id).toBe('typescript');
    expect(f.outline.parseError).toBe(false);
    expect(f.outline.elements.map((e) => e.name)).toEqual(['add', 'Box', 'Box.open', 'sub']);
  });

  it.each<[string, string, string]>([
    ['a missing file', 'b.ts', 'not-found'],
    ['a path outside the repo', '../x.ts', 'invalid'],
    ['a language not scanned', 'a.py', 'invalid'],
  ])('%s is refused (%s)', (_label, rel, code) => {
    expect(editErrorCode(() => readFileOutline(dir, {}, rel))).toBe(code);
  });

  it('a file with a parse error still parses: the error is flagged and the readable functions are listed', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), A_TS + 'export function broken( {\n');
    const f = readFileOutline(dir, {}, 'a.ts');
    expect(f.outline.parseError).toBe(true);
    expect(parseErrorCount(f.tree)).toBeGreaterThan(0);
    expect(f.outline.elements.map((e) => e.name)).toEqual(expect.arrayContaining(['add', 'Box']));
  });
});
