import type Parser from 'tree-sitter';
import type { StubKind } from '../../types';

/**
 * A PHP function/method whose whole body is one `throw ...;` is a stub ('throws').
 * Empty bodies are not stubs (constructors and no-op hooks are normal); abstract and
 * interface methods have no body and are not stubs either.
 */
export function phpStubKind(fn: Parser.SyntaxNode): StubKind | null {
  const body = fn.childForFieldName('body');
  if (!body || body.type !== 'compound_statement') return null;
  const statements = body.namedChildren.filter((c) => c.type !== 'comment');
  if (statements.length !== 1) return null;
  const only = statements[0];
  return only.type === 'expression_statement' && only.namedChildren[0]?.type === 'throw_expression' ? 'throws' : null;
}
