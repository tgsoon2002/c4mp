import Parser from 'tree-sitter';
import { StubKind } from '../../types';
import { log } from '../../log';

const INTENTIONAL_COMMENT = /\b(nop|no-?op|noop|intentionally|does nothing)\b/i;
const INTENTIONAL_NAME = /^(handler|callback|cb|noop|nop|mock\w*|stub\w*|dummy\w*|default\w*|on[A-Z]\w*)$/;

/** True for a function declared to return `never`: it throws on purpose, so a lone `throw` is its job. */
function returnsNever(fn: Parser.SyntaxNode): boolean {
  const rt = fn.childForFieldName('return_type');
  return rt !== null && /^:?\s*never$/.test(rt.text.trim());
}

/** True for an empty arrow function whose position says "placeholder on purpose" (see the list above). */
function isIntentionalNoopArrow(fn: Parser.SyntaxNode): boolean {
  if (fn.type !== 'arrow_function') return false;
  const parent = fn.parent;
  if (!parent) return false;
  if (['pair', 'assignment_pattern', 'arguments', 'required_parameter', 'optional_parameter'].includes(parent.type)) return true;
  if (parent.type !== 'variable_declarator') return false;
  if (INTENTIONAL_NAME.test(parent.childForFieldName('name')?.text ?? '')) return true;
  // a comment right above the declaration (`export const x = ...` has the export_statement in between)
  let stmt: Parser.SyntaxNode | null = parent.parent;
  if (stmt?.parent?.type === 'export_statement') stmt = stmt.parent;
  return stmt?.previousSibling?.type === 'comment' && INTENTIONAL_COMMENT.test(stmt.previousSibling.text);
}

/**
 * Determine if a function/method body is not implemented (a stub).
 * Body = fn.childForFieldName('body'). Arrow with expression body (no statement_block) → null.
 * Statements = named children of body excluding `comment`.
 *
 * - 0 statements → `todo` if any comment matches /TODO|FIXME|XXX|not implemented/i, else `empty`.
 * - Exactly 1 statement:
 *   - `throw_statement` → `throws`
 *   - `return_statement` with no value, or value null/undefined → `returns-nothing`
 * - Otherwise → null
 *
 * Intentional code is not a stub (B19): a `never` return type (throw helper); an empty body whose
 * comment says nop / no-op / noop / intentionally / does nothing; an empty arrow function given as a
 * default, object value, argument, or to a variable named like a handler/callback/mock/noop.
 *
 * Caller skips constructors, not this function.
 */
export function stubKind(fn: Parser.SyntaxNode): StubKind | null {
  const body = fn.childForFieldName('body');

  // Arrow function with expression body (no statement_block) → not a stub
  if (!body || body.type !== 'statement_block') {
    log('stubs', 'arrow-expr-body', { fnType: fn.type, bodyType: body?.type });
    return null;
  }

  if (returnsNever(fn)) {
    log('stubs', 'never-return', { fnType: fn.type });
    return null;
  }

  // Collect named children, excluding braces and comments
  const statements: Parser.SyntaxNode[] = [];
  let hasComment = false;
  let commentText = '';

  for (const child of body.children) {
    if (child.type === '{' || child.type === '}') {
      // Skip braces
      continue;
    }
    if (child.type === 'comment') {
      hasComment = true;
      commentText += child.text + '\n';
      continue;
    }
    // Named child (a statement)
    statements.push(child);
  }

  // 0 statements
  if (statements.length === 0) {
    const isTodo = /TODO|FIXME|XXX|not implemented/i.test(commentText);
    if (!isTodo && (INTENTIONAL_COMMENT.test(commentText) || isIntentionalNoopArrow(fn))) {
      log('stubs', 'intentional-noop', { fnType: fn.type });
      return null;
    }
    const kind = isTodo ? 'todo' : 'empty';
    log('stubs', 'decision', { fnType: fn.type, statements: 0, isTodo, kind });
    return kind;
  }

  // Exactly 1 statement
  if (statements.length === 1) {
    const stmt = statements[0];

    if (stmt.type === 'throw_statement') {
      log('stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, kind: 'throws' });
      return 'throws';
    }

    if (stmt.type === 'return_statement') {
      // Check if it has a return value by looking at children
      // return_statement children are: 'return', [optional value], ';'
      const valueNode = stmt.children.find(c => c.type !== 'return' && c.type !== ';');

      if (!valueNode) {
        // return; with no value
        log('stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, hasValue: false, kind: 'returns-nothing' });
        return 'returns-nothing';
      }

      // Check if return value is null or undefined
      if (valueNode.type === 'null' || valueNode.type === 'undefined') {
        log('stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, valueType: valueNode.type, kind: 'returns-nothing' });
        return 'returns-nothing';
      }

      // Has a real return value
      log('stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, valueType: valueNode.type, kind: null });
      return null;
    }

    // Single statement that is neither throw nor return
    log('stubs', 'decision', { fnType: fn.type, statements: 1, stmtType: stmt.type, kind: null });
    return null;
  }

  // Multiple statements → not a stub
  log('stubs', 'decision', { fnType: fn.type, statements: statements.length, kind: null });
  return null;
}
