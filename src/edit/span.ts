import type Parser from 'tree-sitter';
import type { CodeElement, FileOutline } from '../types';
import { ANNOTATION_LINE } from '../languages/testCases';
import { TEST_NAME_SEP } from '../languages/typescript/tests';
import { elementsNamed } from '../languages/treesitter';
import { EditError } from './errors';

// Phase 32 (ED-1): which lines an edit touches. Lines are 1-based and inclusive, as in CodeElement.

/** A run of lines, 1-based, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** The lines of one element: exactly the lines `c4pm show` prints for it (D5). */
export interface ElementSpan extends LineRange {
  element: CodeElement;
}

/** The ASCII form of the test name separator: `describe > it` names `describe › it`. */
const ASCII_TEST_SEP = ' > ';

/**
 * The element of `outline` named `name` (exact name, as `show` finds it; `describe > it` is read as `describe › it`)
 * and its lines (b782: a nested function `outer.inner` too). `lines` are the file's lines (no line endings). Throws EditError 'not-found', 'ambiguous'
 * (candidates `"<start>-<end>"`) or 'invalid' (the element ends past the file: the outline is stale).
 */
export function elementSpan(outline: FileOutline, lines: string[], name: string): ElementSpan {
  let matches = elementsNamed(outline, name);
  if (matches.length === 0 && name.includes(ASCII_TEST_SEP)) {
    const unicode = name.split(ASCII_TEST_SEP).join(TEST_NAME_SEP);
    matches = elementsNamed(outline, unicode);
  }
  if (matches.length === 0) throw new EditError('not-found', `No function, class, method or test '${name}' in '${outline.file}'`);
  if (matches.length > 1) {
    throw new EditError(
      'ambiguous',
      `'${name}' appears ${matches.length} times in '${outline.file}'`,
      matches.map((m) => `${m.startLine}-${m.endLine}`),
    );
  }
  const element = matches[0];
  if (element.endLine > lines.length) {
    throw new EditError('invalid', `'${outline.file}' has ${lines.length} lines but '${element.name}' ends at line ${element.endLine} (file changed since it was parsed)`);
  }
  return { element, start: element.startLine, end: element.endLine };
}

/** A line that holds only `export` (or `export default`): the declaration below it is the exported one. */
const BARE_EXPORT_LINE = /^export(?:\s+default)?$/;

/**
 * The lines `remove` takes (D5): `span` widened upward over the annotation lines directly above it (decorators,
 * attributes, doc comments and comments, see ANNOTATION_LINE) and a bare `export` line. A blank line stops it.
 */
export function removalSpan<T extends LineRange>(span: T, lines: string[]): T {
  let start = span.start;
  while (start > 1) {
    const above = lines[start - 2].trim();
    if (!ANNOTATION_LINE.test(above) && !BARE_EXPORT_LINE.test(above)) break;
    start--;
  }
  return { ...span, start };
}

/** Nodes that hold statements: the walk up from a test case stops there. */
const BLOCK_TYPES = new Set(['statement_block', 'program', 'class_body']);

/**
 * TS/JS: a test case or describe block (whose recorded lines are its callback's, see addTestCases) widened to the
 * whole `it(...)` / `describe(...)` statement: from the first token on its first line up to the first
 * `expression_statement`, when that one holds all its lines. Otherwise (no statement before the enclosing block, or
 * one that ends early, as in `foo(); it(...)`), the element's own lines.
 */
export function testStatementSpan(tree: Parser.Tree, element: Pick<CodeElement, 'startLine' | 'endLine'>): LineRange {
  const own: LineRange = { start: element.startLine, end: element.endLine };
  const row = element.startLine - 1;
  const lineText = tree.rootNode.text.split('\n')[row];
  if (lineText === undefined) return own;
  const column = lineText.length - lineText.trimStart().length;   // leading whitespace is ASCII: chars = bytes
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row, column });
  // Stop at the first statement up the chain, and never leave the enclosing block: in `const t = it(...)` the
  // describe statement above is not the case's.
  while (node && !BLOCK_TYPES.has(node.type)) {
    if (node.type === 'expression_statement') {
      const covers = node.startPosition.row <= row && node.endPosition.row + 1 >= element.endLine;
      return covers ? { start: node.startPosition.row + 1, end: node.endPosition.row + 1 } : own;
    }
    node = node.parent;
  }
  return own;
}
