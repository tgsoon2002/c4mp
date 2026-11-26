import Parser from 'tree-sitter';
import { StubKind } from '../../types';
import { log } from '../../log';

/**
 * Determine if a Python function/method body is not implemented (a stub).
 *
 * Body = fn.childForFieldName('body'). Should be a block.
 * Statements = named children of body excluding `comment` nodes and a leading docstring.
 * Leading docstring = an `expression_statement` whose only child is a `string`.
 *
 * - 0 statements → `todo` if any comment in the body matches /TODO|FIXME|XXX|not implemented/i, else `empty`.
 * - Exactly 1 statement:
 *   - `raise_statement` → `throws`
 *   - `return_statement` with no value or `none` → `returns-nothing`
 * - Otherwise → null
 *
 * Caller skips constructors (__init__), not this function.
 */
export function pythonStubKind(fn: Parser.SyntaxNode): StubKind | null {
  const body = fn.childForFieldName('body');

  // Must have a block body
  if (!body || body.type !== 'block') {
    log('python-stubs', 'no-block-body', { fnType: fn.type, bodyType: body?.type });
    return null;
  }

  // First, collect comments from the function_definition's children (not the block's children)
  let commentText = '';
  for (const child of fn.children) {
    if (child.type === 'comment') {
      commentText += child.text + '\n';
    }
  }

  // Collect statements from the block body
  const statements: Parser.SyntaxNode[] = [];
  let seenDocstring = false;

  for (const child of body.children) {
    // Check for leading docstring (expression_statement with a string child)
    if (!seenDocstring && child.type === 'expression_statement') {
      // Check if this is a string (docstring)
      const stringNode = child.children.find((c) => c.type === 'string');
      if (stringNode && child.children.length === 1) {
        // This is a docstring, skip it
        seenDocstring = true;
        continue;
      }
    }

    // This is a real statement
    statements.push(child);
  }

  // Helper to check if should be 'empty' or 'todo'
  const checkEmptyOrTodo = (): StubKind => {
    const isTodo = /TODO|FIXME|XXX|not implemented/i.test(commentText);
    return isTodo ? 'todo' : 'empty';
  };

  // 0 statements
  if (statements.length === 0) {
    const kind = checkEmptyOrTodo();
    log('python-stubs', 'decision', { fnType: fn.type, statements: 0, kind });
    return kind;
  }

  // Exactly 1 statement
  if (statements.length === 1) {
    const stmt = statements[0];

    if (stmt.type === 'raise_statement') {
      log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, kind: 'throws' });
      return 'throws';
    }

    if (stmt.type === 'return_statement') {
      // Check if return has a value
      // return_statement structure: 'return' keyword, optional value, optional newline
      // Children include the keyword and optionally a value
      const valueNode = stmt.children.find((c) => c.type !== 'return');

      if (!valueNode) {
        // return; with no value
        log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, hasValue: false, kind: 'returns-nothing' });
        return 'returns-nothing';
      }

      // Check if return value is none
      if (valueNode.type === 'none') {
        log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, valueType: valueNode.type, kind: 'returns-nothing' });
        return 'returns-nothing';
      }

      // Has a real return value
      log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, valueType: valueNode.type, kind: null });
      return null;
    }

    // Check for pass_statement
    if (stmt.type === 'pass_statement') {
      const kind = checkEmptyOrTodo();
      log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, kind });
      return kind;
    }

    // Check for expression_statement with ellipsis
    if (stmt.type === 'expression_statement') {
      const ellipsisNode = stmt.children.find((c) => c.type === 'ellipsis');
      if (ellipsisNode && stmt.children.length === 1) {
        const kind = checkEmptyOrTodo();
        log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, exprType: 'ellipsis', kind });
        return kind;
      }
    }

    // Single statement that is neither throw nor return nor pass nor ellipsis
    log('python-stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, kind: null });
    return null;
  }

  // Multiple statements → not a stub
  log('python-stubs', 'decision', { fnType: fn.type, statements: statements.length, kind: null });
  return null;
}
