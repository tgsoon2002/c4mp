import type Parser from 'tree-sitter';
import type { FileOutline } from '../../types';
import { createOutlineBuilder } from '../treesitter';
import { phpStubKind } from './stubs';

// Kind mapping, same as TypeScript/Python: class and trait are 'class' (their methods are
// 'method', named `Class.method`); interface and enum are 'type' (members not listed, like TS).
const CLASS_KINDS: Record<string, 'class' | 'type'> = {
  class_declaration: 'class',
  trait_declaration: 'class',
  interface_declaration: 'type',
  enum_declaration: 'type',
};
// Nodes that can hold declarations: namespace { }, { }, and `if (!function_exists(..)) { function ..}`
const CONTAINERS = new Set(['namespace_definition', 'compound_statement', 'if_statement']);

export function extractPhpOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('php-outline', tree, file, code);

  function visit(node: Parser.SyntaxNode): void {
    for (const child of node.namedChildren) {
      if (child.type === 'function_definition') {
        const name = child.childForFieldName('name')?.text;
        if (name) out.add(name, 'function', child, phpStubKind(child));
      } else if (CLASS_KINDS[child.type]) {
        const name = child.childForFieldName('name')?.text;
        if (!name) continue;
        out.add(name, CLASS_KINDS[child.type], child);
        if (CLASS_KINDS[child.type] === 'class') {
          for (const member of child.childForFieldName('body')?.namedChildren ?? []) {
            const methodName = member.type === 'method_declaration' ? member.childForFieldName('name')?.text : undefined;
            if (methodName) out.add(`${name}.${methodName}`, 'method', member, phpStubKind(member));
          }
        }
      } else if (CONTAINERS.has(child.type)) {
        visit(child.type === 'namespace_definition' ? (child.childForFieldName('body') ?? child) : child);
      }
    }
  }

  visit(tree.rootNode);
  return out.finish();
}
