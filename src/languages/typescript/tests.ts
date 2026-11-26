import type Parser from 'tree-sitter';
import type { CodeElement, FileOutline, TestBlock } from '../../types';
import { log } from '../../log';
import { sortElements } from '../treesitter';
import { shadowedRanges } from './scope';

// Phase 26 (T26-4): test cases of a TypeScript / JavaScript test file (jest, vitest, mocha, playwright, Deno.test).
// Run only on files config `tests` marks as tests (role 'test'), after the outline: a source file calling its own
// `it` is not a test. A case is an element of kind 'test' named by its describe chain, e.g. 'timing › prints a
// table', spanning the lines of its callback. Describe blocks and hooks are kept as TestBlocks (FileOutline.testBlocks).

/** Joins the describe titles and the case title of a test name. */
export const TEST_NAME_SEP = ' › ';

type HookKind = Exclude<TestBlock['kind'], 'describe'>;
type Role = 'case' | 'describe' | HookKind;

/** The test functions by their usual global names. */
const GLOBALS = new Map<string, Role>([
  ['it', 'case'], ['test', 'case'], ['xit', 'case'], ['fit', 'case'], ['xtest', 'case'],
  ['describe', 'describe'], ['xdescribe', 'describe'], ['fdescribe', 'describe'],
  ['beforeAll', 'beforeAll'], ['beforeEach', 'beforeEach'], ['afterAll', 'afterAll'], ['afterEach', 'afterEach'],
  ['Deno.test', 'case'],
]);
/** `it.only(...)`: the member is the same kind of test function. */
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'failing', 'fails', 'sequential', 'shuffle', 'fixme', 'serial', 'parallel']);
/** `it.each(table)(...)`: a call of the member returns the test function; the title stays the template. */
const FACTORIES = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);
const FUNCTION_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

/** Role of a callee expression: `it`, an alias, `it.skip`, `it.each(t)`, `test.describe` (playwright), `Deno.test`; else undefined. */
function roleOf(n: Parser.SyntaxNode | null, aliases: Map<string, Role>): Role | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier') return aliases.get(n.text) ?? GLOBALS.get(n.text);
  if (n.type === 'parenthesized_expression') return roleOf(n.namedChild(0), aliases);
  if (n.type === 'member_expression') {
    const global = GLOBALS.get(n.text);   // `Deno.test`
    if (global) return global;
    const prop = n.childForFieldName('property')?.text ?? '';
    const base = roleOf(n.childForFieldName('object'), aliases);
    if (MODIFIERS.has(prop)) return base;
    const member = GLOBALS.get(prop);
    return base === 'case' && member !== undefined && member !== 'case' ? member : undefined;
  }
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    if (fn?.type !== 'member_expression' || !FACTORIES.has(fn.childForFieldName('property')?.text ?? '')) return undefined;
    return roleOf(fn.childForFieldName('object'), aliases);
  }
  return undefined;
}

/** Role of an alias value: a test function, or `cond ? it : it.skip`, `cond && it`, ... when the branches agree. */
function valueRole(n: Parser.SyntaxNode | null, aliases: Map<string, Role>): Role | undefined {
  if (!n) return undefined;
  const either = (a: Parser.SyntaxNode | null, b: Parser.SyntaxNode | null): Role | undefined => {
    const ra = valueRole(a, aliases);
    const rb = valueRole(b, aliases);
    return ra && rb ? (ra === rb ? ra : undefined) : ra ?? rb;
  };
  if (n.type === 'parenthesized_expression') return valueRole(n.namedChild(0), aliases);
  if (n.type === 'ternary_expression') return either(n.childForFieldName('consequence'), n.childForFieldName('alternative'));
  if (n.type === 'binary_expression' && ['||', '&&', '??'].includes(n.childForFieldName('operator')?.text ?? '')) {
    return either(n.childForFieldName('left'), n.childForFieldName('right'));
  }
  return roleOf(n, aliases);
}

/** `const chromeIt = cond ? it : it.skip` and the like, anywhere in the file (aliases of aliases too). */
function collectAliases(declarators: Parser.SyntaxNode[]): Map<string, Role> {
  const aliases = new Map<string, Role>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of declarators) {
      const name = d.childForFieldName('name');
      if (name?.type !== 'identifier' || aliases.has(name.text)) continue;
      const role = valueRole(d.childForFieldName('value'), aliases);
      if (role) { aliases.set(name.text, role); changed = true; }
    }
  }
  return aliases;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** Value of one escape sequence of a string literal (`\n`, `\'`, `é`, `\x41`, line continuation). */
function unescape(seq: string): string {
  const c = seq.slice(1);
  const hex = /^(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))$/.exec(c);
  if (hex) return String.fromCodePoint(parseInt(hex[1] ?? hex[2] ?? hex[3], 16));
  if (c.startsWith('\n') || c.startsWith('\r')) return '';
  return ESCAPES[c] ?? c;
}

/** Title as written: a string's value, a template's text between the backticks, else the expression's source. */
function titleOf(arg: Parser.SyntaxNode): string {
  if (arg.type === 'string') return arg.namedChildren.map((c) => (c.type === 'escape_sequence' ? unescape(c.text) : c.text)).join('');
  if (arg.type === 'template_string') return arg.text.slice(1, -1);
  return arg.text;
}

const linesOf = (n: Parser.SyntaxNode): [number, number] => [n.startPosition.row + 1, n.endPosition.row + 1];

/**
 * The outline of a test file with its test cases added (kind 'test', sorted in with the other elements) and its
 * describe blocks and hooks as `testBlocks` (set only when there are some). A repeated case name gets ` (2)`, ` (3)`.
 */
export function addTestCases(tree: Parser.Tree, outline: FileOutline): FileOutline {
  const root = tree.rootNode;
  const aliases = collectAliases(root.descendantsOfType('variable_declarator'));
  // where a global test name is a parameter or a local (`(test) => test(n)`): calls there are not tests
  const shadowed = shadowedRanges(root, (name) => GLOBALS.has(name) && !aliases.has(name));
  const isShadowed = (callee: Parser.SyntaxNode | null, at: number): boolean => {
    while (callee && callee.type !== 'identifier') {
      callee = callee.type === 'member_expression' ? callee.childForFieldName('object')
        : callee.type === 'call_expression' ? callee.childForFieldName('function') : callee.namedChild(0);
    }
    return !!callee && (shadowed.get(callee.text) ?? []).some(([s, e]) => s <= at && at < e);
  };

  const taken = new Set(outline.elements.map((e) => e.name));
  const cases: CodeElement[] = [];
  const blocks: TestBlock[] = [];
  const describes: { chain: string; end: number }[] = [];
  let insideCaseEnd = -1;   // calls inside a case or hook are not tests (cases do not nest)

  for (const call of root.descendantsOfType('call_expression')) {
    if (call.startIndex < insideCaseEnd) continue;
    while (describes.length > 0 && describes[describes.length - 1].end <= call.startIndex) describes.pop();
    const callee = call.childForFieldName('function');
    const role = roleOf(callee, aliases);
    if (!role || isShadowed(callee, call.startIndex)) continue;
    const args = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type !== 'comment') ?? [];
    const callback = args.find((a) => FUNCTION_TYPES.has(a.type));
    const span = callback ?? call;
    const [startLine, endLine] = linesOf(span);
    const chain = describes.length > 0 ? describes[describes.length - 1].chain : '';

    if (role !== 'case' && role !== 'describe') {   // hook: beforeEach(fn)
      if (args.length === 0) continue;
      blocks.push({ kind: role, name: chain, startLine, endLine });
      insideCaseEnd = span.endIndex;
      continue;
    }
    // A title, then a body (only `.todo` has none): `test(c)` with one argument is some other function.
    if (args.length === 0 || (args.length < 2 && !callee?.text.endsWith('.todo'))) continue;
    const title = titleOf(args[0]).replace(/\s+/g, ' ').trim();
    const name = chain ? `${chain}${TEST_NAME_SEP}${title}` : title;
    if (role === 'describe') {
      blocks.push({ kind: 'describe', name, startLine, endLine });
      describes.push({ chain: name, end: span.endIndex });
      continue;
    }
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = `${name} (${n})`;
    taken.add(unique);
    cases.push({ name: unique, kind: 'test', startLine, endLine, lineCount: endLine - startLine + 1 });
    insideCaseEnd = span.endIndex;
  }

  log('tests', 'result', { file: outline.file, cases: cases.length, blocks: blocks.length });
  if (cases.length === 0 && blocks.length === 0) return outline;
  const elements = [...outline.elements, ...cases];
  sortElements(elements);
  blocks.sort((a, b) => a.startLine - b.startLine);
  return { ...outline, elements, ...(blocks.length > 0 && { testBlocks: blocks }) };
}
