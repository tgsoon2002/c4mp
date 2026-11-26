import type Parser from 'tree-sitter';
import type { StubKind } from '../../types';

const TODO_MACROS = ['todo', 'unimplemented'];

/**
 * A Rust function whose whole body is `todo!()` or `unimplemented!()` (with or without a
 * trailing semicolon or message) is a 'todo' stub. Anything else, including an empty body, is not.
 */
export function rustStubKind(fn: Parser.SyntaxNode): StubKind | null {
  const body = fn.childForFieldName('body');
  if (!body || body.type !== 'block') return null;
  const statements = body.namedChildren.filter((c) => c.type !== 'line_comment' && c.type !== 'block_comment');
  if (statements.length !== 1) return null;
  const stmt = statements[0];
  const expr = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : stmt;
  if (expr?.type !== 'macro_invocation') return null;
  const name = expr.childForFieldName('macro')?.text;
  return name && TODO_MACROS.includes(name) ? 'todo' : null;
}
