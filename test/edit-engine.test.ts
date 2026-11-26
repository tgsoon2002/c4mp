import { getHandlers } from '../src/languages';
import { extractParsed } from '../src/parseCache';
import type { FileRole } from '../src/types';
import { splitLines } from '../src/util/text';
import { EditError } from '../src/edit/errors';
import { parseErrorCount } from '../src/edit/parseCheck';
import { elementSpan, removalSpan, testStatementSpan } from '../src/edit/span';
import { insertAfter, insertBefore, removeLines, replaceLines } from '../src/edit/textOps';

const ts = getHandlers(['typescript'])[0];

const SRC = [
  '/** Adds. */',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export class Box {',
  '  @dec()',
  '  open(): void {',
  '    go();',
  '  }',
  '}',
  '',
  'function dup() { return 1; }',
  'function dup() { return 2; }',
  '',
].join('\n');

const NESTED = [
  'export function outer(): number {',
  '  /** Doubles. */',
  '  function inner(b: number): number {',
  '    return b * 2;',
  '  }',
  '',
  '  return inner(1);',
  '}',
  '',
].join('\n');

const TEST = [
  "describe('box', () => {",
  "  it('opens', () => {",
  '    expect(1).toBe(1);',
  '  });',
  '  it(',
  "    'closes',",
  '    () => {',
  '      expect(2).toBe(2);',
  '    },',
  '  );',
  '});',
  '',
].join('\n');

type Op = 'replace' | 'before' | 'after' | 'remove';

/** One edit as ED-2 will run it: parse, find the span (a test case widened to its statement except for replace), edit. */
function edit(code: string, file: string, role: FileRole | undefined, target: string, op: Op, text = ''): string {
  const tree = ts.parse(code, file);
  const { outline } = extractParsed(ts, file, code, false, role);
  const lines = splitLines(code, { keepEol: false });
  const span = elementSpan(outline, lines, target);
  const stmt = span.element.kind === 'test' ? testStatementSpan(tree, span.element) : span;
  switch (op) {
    case 'replace': return replaceLines(code, span.start, span.end, text);
    case 'before': return insertBefore(code, removalSpan(stmt, lines).start, text);
    case 'after': return insertAfter(code, stmt.end, text);
    case 'remove': {
      const r = removalSpan(stmt, lines);
      return removeLines(code, r.start, r.end);
    }
  }
}

/** `code` with its 1-based lines `from`..`to` replaced by `add`. */
function spliced(code: string, from: number, to: number, add: string[]): string {
  const ls = code.split('\n');
  ls.splice(from - 1, to - from + 1, ...add);
  return ls.join('\n');
}

describe('edit engine (Phase 32 ED-1)', () => {
  it.each<[string, string, string, FileRole | undefined, string, Op, string, string]>([
    // function: replace keeps the JSDoc above (D5), remove takes it.
    ['replace a function', SRC, 'a.ts', undefined, 'add', 'replace', 'export const add = 1;\n', spliced(SRC, 2, 4, ['export const add = 1;'])],
    ['remove a function with its JSDoc', SRC, 'a.ts', undefined, 'add', 'remove', '', spliced(SRC, 1, 4, [])],
    ['insert after a function', SRC, 'a.ts', undefined, 'add', 'after', 'const x = 1;', spliced(SRC, 5, 4, ['const x = 1;'])],
    ['insert before a function, above its JSDoc', SRC, 'a.ts', undefined, 'add', 'before', '// top', `// top\n${SRC}`],
    // method: replace keeps the decorator, remove takes it.
    ['replace a method', SRC, 'a.ts', undefined, 'Box.open', 'replace', '  shut(): void {}', spliced(SRC, 8, 10, ['  shut(): void {}'])],
    ['remove a method with its decorator', SRC, 'a.ts', undefined, 'Box.open', 'remove', '', spliced(SRC, 7, 10, [])],
    ['insert after a method', SRC, 'a.ts', undefined, 'Box.open', 'after', '  x = 1;', spliced(SRC, 11, 10, ['  x = 1;'])],
    // duplicate names: the second is `dup#2`.
    ['replace the duplicate dup#2', SRC, 'a.ts', undefined, 'dup#2', 'replace', 'function dup2() {}', spliced(SRC, 14, 14, ['function dup2() {}'])],
    ['remove the first dup', SRC, 'a.ts', undefined, 'dup', 'remove', '', spliced(SRC, 13, 13, [])],
    // nested function (b782): `outer.inner`; replace keeps the JSDoc, remove takes it.
    ['replace a nested function', NESTED, 'a.ts', undefined, 'outer.inner', 'replace', '  function inner(b: number): number { return b; }', spliced(NESTED, 3, 5, ['  function inner(b: number): number { return b; }'])],
    ['remove a nested function with its JSDoc', NESTED, 'a.ts', undefined, 'outer.inner', 'remove', '', spliced(NESTED, 2, 5, [])],
    ['insert after a nested function', NESTED, 'a.ts', undefined, 'outer.inner', 'after', '  // after', spliced(NESTED, 6, 5, ['  // after'])],
    // test cases: replace = the callback lines (what show prints); insert / remove = the whole `it(...)` statement.
    ['replace a test case', TEST, 'a.test.ts', 'test', 'box › opens', 'replace', "  it('opens', () => {});", spliced(TEST, 2, 4, ["  it('opens', () => {});"])],
    ['remove a one-line-head test case', TEST, 'a.test.ts', 'test', 'box › opens', 'remove', '', spliced(TEST, 2, 4, [])],
    ['remove a test case split over lines (ASCII >)', TEST, 'a.test.ts', 'test', 'box > closes', 'remove', '', spliced(TEST, 5, 10, [])],
    ['insert after a split test case', TEST, 'a.test.ts', 'test', 'box › closes', 'after', '  // end', spliced(TEST, 11, 10, ['  // end'])],
    ['insert before a split test case', TEST, 'a.test.ts', 'test', 'box › closes', 'before', '  // mid', spliced(TEST, 5, 4, ['  // mid'])],
  ])('%s', (_label, code, file, role, target, op, text, expected) => {
    expect(edit(code, file, role, target, op, text)).toBe(expected);
  });

  it('widens a describe block (a TestBlock) to its statement', () => {
    const { outline } = extractParsed(ts, 'a.test.ts', TEST, false, 'test');
    const block = outline.testBlocks?.find((b) => b.kind === 'describe' && b.name === 'box');
    expect(block).toBeDefined();
    expect(testStatementSpan(ts.parse(TEST, 'a.test.ts'), block!)).toEqual({ start: 1, end: 11 });
  });

  const CRLF = 'a\r\nb\r\nc\r\n';
  it.each<[string, () => string, string]>([
    ['CRLF: replace keeps \\r\\n', () => replaceLines(CRLF, 2, 2, 'X\nY\n'), 'a\r\nX\r\nY\r\nc\r\n'],
    ['CRLF: remove', () => removeLines(CRLF, 2, 2), 'a\r\nc\r\n'],
    ['CRLF: insert after', () => insertAfter(CRLF, 2, 'X'), 'a\r\nb\r\nX\r\nc\r\n'],
    ['CRLF: insert at the end', () => insertBefore(CRLF, 4, 'X'), 'a\r\nb\r\nc\r\nX\r\n'],
    ['no final newline: replace the last line', () => replaceLines('a\nb\nc', 3, 3, 'X\n'), 'a\nb\nX'],
    ['no final newline: insert after the last line', () => insertAfter('a\nb', 2, 'X'), 'a\nb\nX'],
    ['no final newline: remove the last line', () => removeLines('a\nb', 2, 2), 'a'],
    ['final newline kept after removing the last line', () => removeLines('a\nb\n', 2, 2), 'a\n'],
    ['insert at the top', () => insertAfter('a\n', 0, 'X'), 'X\na\n'],
    ['text with \\r\\n into an LF file takes \\n', () => insertBefore('a\nb\n', 2, 'X\r\nY\r\n'), 'a\nX\nY\nb\n'],
    ['remove every line', () => removeLines('a\nb\n', 1, 2), ''],
    ['insert into an empty file', () => insertAfter('', 0, 'X'), 'X\n'],
  ])('%s', (_label, run, expected) => {
    expect(run()).toBe(expected);
  });

  it('inserts text as given, with no re-indenting', () => {
    expect(insertAfter('a\n', 1, '    deep\n  half')).toBe('a\n    deep\n  half\n');
  });

  it.each([
    ['a range past the end', () => replaceLines('a\nb\n', 2, 3, 'x')],
    ['line 0', () => removeLines('a\n', 0, 1)],
    ['an end before the start', () => removeLines('a\nb\n', 2, 1)],
    ['insert before a line past lines+1', () => insertBefore('a\n', 3, 'x')],
  ])('refuses %s (invalid)', (_label, run) => {
    expect(run).toThrow(expect.objectContaining({ code: 'invalid' }) as unknown as Error);
  });

  it.each([
    ['not-found', 'nope'],
    ['not-found', 'Box.shut'],
  ])('elementSpan throws %s for %s', (code, name) => {
    const { outline } = extractParsed(ts, 'a.ts', SRC, false);
    try {
      elementSpan(outline, splitLines(SRC, { keepEol: false }), name);
      throw new Error('no throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EditError);
      expect((err as EditError).code).toBe(code);
    }
  });

  it('elementSpan: a bare inner name of a nested function is not-found (b782)', () => {
    const { outline } = extractParsed(ts, 'a.ts', NESTED, false);
    expect(() => elementSpan(outline, splitLines(NESTED, { keepEol: false }), 'inner')).toThrow(
      expect.objectContaining({ code: 'not-found', message: "No function, class, method or test 'inner' in 'a.ts'" }) as unknown as Error
    );
  });

  it('elementSpan throws ambiguous with candidates when a name repeats', () => {
    const outline = { file: 'a.ts', lineCount: 4, parseError: false, elements: [
      { name: 'f', kind: 'function' as const, startLine: 1, endLine: 1, lineCount: 1 },
      { name: 'f', kind: 'function' as const, startLine: 3, endLine: 4, lineCount: 2 },
    ] };
    expect(() => elementSpan(outline, ['', '', '', ''], 'f')).toThrow(expect.objectContaining({ code: 'ambiguous', candidates: ['1-1', '3-4'] }) as unknown as Error);
  });

  it.each([
    ['clean code', SRC, 0],
    ['a missing closing brace', 'function f() {\n  return 1;\n', 1],
    ['two broken statements', 'const = 1;\nlet x = ;\n', 2],
  ])('parseErrorCount on %s', (_label, code, min) => {
    const n = parseErrorCount(ts.parse(code, 'a.ts'));
    if (min === 0) expect(n).toBe(0);
    else expect(n).toBeGreaterThanOrEqual(min);
  });

  it('parseErrorCount goes up when an edit breaks the code (D6)', () => {
    const before = parseErrorCount(ts.parse(SRC, 'a.ts'));
    const broken = replaceLines(SRC, 3, 3, '  return a + ;');
    expect(parseErrorCount(ts.parse(broken, 'a.ts'))).toBeGreaterThan(before);
  });
});
