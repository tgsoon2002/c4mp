import type Parser from 'tree-sitter';
import type { ElementKind, FileOutline } from '../../types';
import { createOutlineBuilder } from '../treesitter';

// Kind mapping (same convention as Rust/C#): class, struct and actor are 'class' (data plus methods);
// enum and protocol are 'type' (like a Rust enum/trait or a C# enum/interface), protocol requirements
// listed as its methods. tree-sitter-swift parses class, struct, enum, actor and extension all as
// class_declaration, told apart by the `declaration_kind` field. A function is 'function' at file level,
// 'method' inside a type, named `Type.method` (initializer: `Type.init`). An extension is not an element:
// its members are listed under the extended type's name (`extension A.B` -> `B.method`). A nested type is
// listed under its plain name with its own methods. Properties, enum cases, subscripts, deinit and
// typealiases are not listed. `#if` directives are separate nodes, so their declarations are found as usual.
const TYPE_KINDS: Record<string, ElementKind> = {
  class: 'class',
  struct: 'class',
  actor: 'class',
  enum: 'type',
  protocol: 'type',
};
const FUNCTION_TYPES = ['function_declaration', 'protocol_function_declaration'];

/** Base name of an extension's `user_type`: A.B -> B, Array<Int> -> Array. */
function extendedName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  const parts = node.namedChildren.filter((c) => c.type === 'type_identifier');
  return parts.length > 0 ? parts[parts.length - 1].text : node.text || null;
}

export function extractSwiftOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('swift-outline', tree, file, code);

  // One class_declaration or protocol_declaration: the type itself (not for an extension) and its body.
  function typeDeclaration(node: Parser.SyntaxNode): void {
    const declKind = node.childForFieldName('declaration_kind')?.text ?? '';
    const nameNode = node.childForFieldName('name');
    const owner = declKind === 'extension' ? extendedName(nameNode) : nameNode?.text;
    if (!owner) return;
    if (declKind !== 'extension') {
      const kind = TYPE_KINDS[declKind];
      if (!kind) return;
      out.add(owner, kind, node);
    }
    const body = node.childForFieldName('body');
    if (body) walk(body, owner);
  }

  // Declarations of the file (owner null) or of a type body (owner = the type name).
  function walk(parent: Parser.SyntaxNode, owner: string | null): void {
    for (const node of parent.namedChildren) {
      if (FUNCTION_TYPES.includes(node.type)) {
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        if (owner) out.add(`${owner}.${name}`, 'method', node);
        else if (node.type === 'function_declaration') out.add(name, 'function', node);
      } else if (node.type === 'init_declaration') {
        if (owner) out.add(`${owner}.init`, 'method', node);
      } else if (node.type === 'class_declaration' || node.type === 'protocol_declaration') {
        typeDeclaration(node);
      }
    }
  }
  walk(tree.rootNode, null);
  return out.finish();
}
