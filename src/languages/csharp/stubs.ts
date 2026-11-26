import type Parser from 'tree-sitter';
import type { StubKind } from '../../types';

/**
 * A C# method whose whole body is `throw new NotImplementedException(...)` (block body with that one
 * statement, or expression body `=> throw new NotImplementedException()`) is a 'throws' stub.
 * Anything else, including an empty body, is not.
 */
export function csharpStubKind(fn: Parser.SyntaxNode): StubKind | null {
  const body = fn.childForFieldName('body');
  if (!body) return null;
  let thrown: Parser.SyntaxNode | undefined;
  if (body.type === 'block') {
    const statements = body.namedChildren.filter((c) => c.type !== 'comment');
    if (statements.length === 1 && statements[0].type === 'throw_statement') thrown = statements[0].namedChildren[0];
  } else if (body.type === 'arrow_expression_clause') {
    const expr = body.namedChildren.find((c) => c.type !== 'comment');
    if (expr?.type === 'throw_expression') thrown = expr.namedChildren[0];
  }
  if (thrown?.type !== 'object_creation_expression') return null;
  const type = thrown.childForFieldName('type')?.text ?? '';
  return /(^|\.)NotImplementedException$/.test(type) ? 'throws' : null;
}
