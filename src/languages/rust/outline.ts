import type Parser from 'tree-sitter';
import type { ElementKind, FileOutline } from '../../types';
import { createOutlineBuilder } from '../treesitter';
import { rustStubKind } from './stubs';

// Kind mapping (same convention as Python/TypeScript): struct and union are 'class' (data plus
// methods); enum and trait are 'type' (like TS interface/enum). A function is 'function' at file
// or module level, 'method' inside an impl or trait, named `Type.method` (the shared dotted
// convention). Modules are not elements: their items are listed flat, under their plain name.
const TYPE_KINDS: Record<string, ElementKind> = {
  struct_item: 'class',
  union_item: 'class',
  enum_item: 'type',
  trait_item: 'type',
};

/** Base name of an impl's `type` field: Foo<T> -> Foo, a::b::Foo -> Foo, &Foo -> Foo. */
function typeName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'scoped_type_identifier') return node.childForFieldName('name')?.text ?? null;
  if (node.type === 'generic_type' || node.type === 'reference_type') return typeName(node.childForFieldName('type'));
  return node.text;
}

export function extractRustOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('rust-outline', tree, file, code);

  // Methods of an impl or trait body; `owner` is the type name.
  function members(body: Parser.SyntaxNode | null, owner: string): void {
    for (const child of body?.namedChildren ?? []) {
      if (child.type !== 'function_item' && child.type !== 'function_signature_item') continue;
      const name = child.childForFieldName('name')?.text;
      if (name) out.add(`${owner}.${name}`, 'method', child, rustStubKind(child));
    }
  }

  function walk(parent: Parser.SyntaxNode): void {
    for (const node of parent.namedChildren) {
      const name = node.childForFieldName('name')?.text;
      if (node.type === 'function_item' && name) {
        out.add(name, 'function', node, rustStubKind(node));
      } else if (TYPE_KINDS[node.type] && name) {
        out.add(name, TYPE_KINDS[node.type], node);
        if (node.type === 'trait_item') members(node.childForFieldName('body'), name);
      } else if (node.type === 'impl_item') {
        const owner = typeName(node.childForFieldName('type'));
        if (owner) members(node.childForFieldName('body'), owner);
      } else if (node.type === 'mod_item') {
        const body = node.childForFieldName('body');
        if (body) walk(body);
      }
    }
  }
  walk(tree.rootNode);
  return out.finish();
}
