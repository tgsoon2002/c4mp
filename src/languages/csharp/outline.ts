import type Parser from 'tree-sitter';
import type { ElementKind, FileOutline } from '../../types';
import { createOutlineBuilder } from '../treesitter';
import { csharpStubKind } from './stubs';

// Kind mapping (same convention as Python/TypeScript): class, struct and record are 'class'
// (data plus methods); interface and enum are 'type' (like TS interface/enum). Methods and
// constructors are 'method', named `Type.method` (constructor: `Type.Type`). A nested type is
// listed under its plain name with its own methods. Namespaces (block and file-scoped) are not
// elements: their types are listed flat. Properties and fields are not listed.
const TYPE_KINDS: Record<string, ElementKind> = {
  class_declaration: 'class',
  struct_declaration: 'class',
  record_declaration: 'class',
  record_struct_declaration: 'class',
  interface_declaration: 'type',
  enum_declaration: 'type',
};
const METHOD_TYPES = ['method_declaration', 'constructor_declaration'];
// #if / #elif / #else blocks (same rule as the C++ outline): they only hold more declarations or members,
// so they are walked like the block around them and every branch is listed (a repeat gets `#2`).
const PREPROC_BLOCKS = new Set(['preproc_if', 'preproc_elif', 'preproc_else']);

// C# 12 lets a class, struct or interface end in `;` instead of a body (`class Empty;`,
// `sealed class P : Base;`). tree-sitter-c-sharp 0.23.1 does not know that form and leaves its tokens
// in an ERROR node; it is listed when the ERROR holds exactly
// [modifiers] keyword name [<T>] [(params)] [: bases] [where ...] followed by `;`. Grammar limit: inside
// a `{ }` block, a body-less type followed by another type is sometimes read as one type that takes the
// next body (`class Empty; class Full { M }` -> Empty with Empty.M); that tree has no ERROR to recover.
const BODYLESS_KINDS: Record<string, ElementKind> = { class: 'class', struct: 'class', interface: 'type' };
const BODYLESS_HEAD = new Set(['modifier', 'attribute_list']);
const BODYLESS_TAIL = new Set(['type_parameter_list', 'parameter_list', 'base_list', 'type_parameter_constraints_clause']);

export function extractCSharpOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('csharp-outline', tree, file, code);

  // Body-less types inside one ERROR node. The closing `;` is the next token in the ERROR, or, when the
  // ERROR stops at the name, the start of the next sibling (the grammar then reads `;` as an empty statement).
  function addBodylessTypes(error: Parser.SyntaxNode): void {
    const kids = error.children;
    for (let i = 0; i + 1 < kids.length; i++) {
      const kind = BODYLESS_KINDS[kids[i].type];
      if (!kind || kids[i].isNamed || kids[i + 1].type !== 'identifier') continue;
      let start = i;
      while (start > 0 && BODYLESS_HEAD.has(kids[start - 1].type)) start--;
      let j = i + 2;
      while (j < kids.length && BODYLESS_TAIL.has(kids[j].type)) j++;
      const semi = j < kids.length ? kids[j] : error.nextSibling;
      if (semi?.type !== ';' && !(j === kids.length && semi?.text.startsWith(';'))) continue;
      out.addLines(kids[i + 1].text, kind, kids[start].startPosition.row + 1, semi.startPosition.row + 1);
      i = j;
    }
  }

  // The methods and constructors of a type body, also inside its #if blocks.
  function addMethods(typeName: string, body: Parser.SyntaxNode): void {
    for (const member of body.namedChildren) {
      const memberName = member.childForFieldName('name')?.text;
      if (METHOD_TYPES.includes(member.type) && memberName) out.add(`${typeName}.${memberName}`, 'method', member, csharpStubKind(member));
      else if (PREPROC_BLOCKS.has(member.type)) addMethods(typeName, member);
    }
  }

  // Namespace bodies, file-scoped namespaces, #if blocks and the compilation unit all hold declarations.
  function walk(parent: Parser.SyntaxNode): void {
    for (const node of parent.namedChildren) {
      if (TYPE_KINDS[node.type]) {
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        out.add(name, TYPE_KINDS[node.type], node);
        const body = node.childForFieldName('body');
        if (body) addMethods(name, body);
        if (body) walk(body);  // nested types
      } else if (node.type === 'namespace_declaration') {
        const body = node.childForFieldName('body');
        if (body) walk(body);
      } else if (node.type === 'file_scoped_namespace_declaration' || PREPROC_BLOCKS.has(node.type)) {
        walk(node);
      } else if (node.type === 'ERROR') {
        addBodylessTypes(node);
      }
    }
  }
  walk(tree.rootNode);
  return out.finish();
}
