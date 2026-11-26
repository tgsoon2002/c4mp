import type Parser from 'tree-sitter';

// b682: scope rules shared by the call reader (calls.ts: imported and own names) and the test reader (tests.ts: test
// globals). One copy; each caller says which declarations count.

/** The block a declaration is visible in: the nearest statement block, or the whole file. */
function blockOf(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let p = n.parent;
  while (p && p.type !== 'statement_block' && p.type !== 'program') p = p.parent;
  return p;
}

/**
 * Byte ranges where a name is declared again (parameter, variable, function), by name: inside a range the name is the
 * local one. `accept(name, scope, declaration)` picks the declarations that count (`scope` is the range's node, the
 * `program` for a top-level declaration; `declaration` is the parameter, arrow function, variable declarator or
 * function declaration). Destructuring patterns are not followed.
 */
export function shadowedRanges(
  root: Parser.SyntaxNode,
  accept: (name: string, scope: Parser.SyntaxNode, declaration: Parser.SyntaxNode) => boolean,
): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  const add = (name: Parser.SyntaxNode | null, scope: Parser.SyntaxNode | null | undefined, declaration: Parser.SyntaxNode): void => {
    if (name?.type !== 'identifier' || !scope || !accept(name.text, scope, declaration)) return;
    out.set(name.text, [...(out.get(name.text) ?? []), [scope.startIndex, scope.endIndex]]);
  };
  for (const n of root.descendantsOfType(['required_parameter', 'optional_parameter', 'arrow_function', 'variable_declarator', 'function_declaration'])) {
    if (n.type === 'arrow_function') add(n.childForFieldName('parameter'), n, n);
    else if (n.type === 'variable_declarator' || n.type === 'function_declaration') add(n.childForFieldName('name'), blockOf(n), n);
    else add(n.childForFieldName('pattern'), n.parent?.parent, n);   // parameter -> formal_parameters -> function
  }
  return out;
}
