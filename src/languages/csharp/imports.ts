import type Parser from 'tree-sitter';
import type { RawImport } from '../../types';
import { collectImports } from '../treesitter';
import type { ImportRule } from '../treesitter';

/**
 * The spec of one `using_directive`: its text between `using` and `;`, without a leading `global`,
 * whitespace collapsed. Comments inside the directive are dropped.
 */
function directiveSpec(node: Parser.SyntaxNode): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.type === 'using' || child.type === ';' || child.type === 'comment') continue;
    if (child.type === 'global' && parts.length === 0) continue;   // `global using`, not `global::`
    parts.push(child.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').replace(/\s*=\s*/, ' = ').replace(/\s*([.<>,:])\s*/g, '$1').trim();
}

// `using (var x = ...)` is a using_statement and `using var x = ...;` a local_declaration_statement:
// neither is a using_directive, so they are not imports.
const RULES: Record<string, ImportRule> = {
  using_directive: { hits: (node) => [{ spec: directiveSpec(node) }] },
};

/**
 * Imports of one C# file, as written (kind 'import'). Spec grammar:
 *  - `using A.B;` and `global using A.B;`  -> 'A.B'
 *  - `using static A.B.Type;`             -> 'static A.B.Type'
 *  - `using X = A.B.Type;`                -> 'X = A.B.Type' (the resolver uses the right-hand side)
 *  - `global::` and generic arguments stay as written ('global::A.B', 'L = System.Collections.Generic.List<int>').
 * Usings inside a namespace block are read too. `extern alias` is not an import.
 */
export function extractCSharpImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'csharp-imports');
}
