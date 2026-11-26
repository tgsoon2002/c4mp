import type Parser from 'tree-sitter';
import type { FileOutline } from '../../types';
import { createOutlineBuilder } from '../treesitter';

// Kind mapping, same as TypeScript/Python: class and struct are 'class'; enum is 'type' (like a TS enum).
// A function defined inside a class body, or written `Foo::bar` outside it, is a 'method' named
// `Foo.bar` (`::` becomes `.`). Any other function is a 'function'. Namespaces add no element and
// no name prefix. A nested class or struct (member template classes too) is listed under its plain name
// with its own methods, as in C# and Swift. Only definitions with a body are listed (declarations and
// forward declarations are not).
const CLASS_NODES = new Set(['class_specifier', 'struct_specifier']);
// Nodes that only hold more declarations: namespace bodies, templates, extern "C", #ifdef guards.
const CONTAINERS = new Set([
  'translation_unit', 'declaration_list', 'namespace_definition', 'template_declaration',
  'linkage_specification', 'preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif',
]);
const WRAPPING_DECLARATORS = new Set(['pointer_declarator', 'reference_declarator']);
// gtest bodies `TEST(suite, name) { ... }` parse as a function without return type named TEST. Such a body
// is named by its macro call, `TEST(suite, name)`, so each test keeps its own name instead of TEST#N.
export const TEST_MACROS = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P']);

/** Name of a function_definition: function_declarator -> declarator (identifier, field_identifier, qualified_identifier, ...). */
function functionName(fn: Parser.SyntaxNode): string | null {
  let d = fn.childForFieldName('declarator');
  while (d && WRAPPING_DECLARATORS.has(d.type)) d = d.childForFieldName('declarator');   // `T* f()`, `T& f()`
  if (!d || d.type !== 'function_declarator') return null;
  const name = d.childForFieldName('declarator')?.text;
  if (name && TEST_MACROS.has(name) && !fn.childForFieldName('type')) {
    const args = d.childForFieldName('parameters')?.namedChildren.map((p) => p.text) ?? [];   // whitespace: outline builder
    return `${name}(${args.join(', ')})`;
  }
  return name ? name.replace(/\s*::\s*/g, '.') : null;
}

export function extractCppOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('cpp-outline', tree, file, code);

  function addFunction(node: Parser.SyntaxNode, className?: string): void {
    const name = functionName(node);
    if (!name) return;
    if (className) out.add(`${className}.${name}`, 'method', node);
    else out.add(name, name.includes('.') ? 'method' : 'function', node);
  }

  /** A class or struct with a name and a body, then its members; a nested one too, under its plain name (b575). */
  function addClass(node: Parser.SyntaxNode): void {
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    if (!name || !body) return;
    out.add(name, 'class', node);
    visitClassBody(body, name);
  }

  function visitClassBody(body: Parser.SyntaxNode, className: string): void {
    for (const member of body.namedChildren) {
      if (member.type === 'function_definition') addFunction(member, className);
      else if (member.type === 'template_declaration') visitClassBody(member, className);   // member templates
      else if (CLASS_NODES.has(member.type)) addClass(member);   // `template <...> struct T {}` (through the line above)
      else if (member.type === 'field_declaration') {   // `struct Inner {};` is a field declaration of type Inner
        const type = member.childForFieldName('type');
        if (type && CLASS_NODES.has(type.type)) addClass(type);
      }
    }
  }

  function visit(node: Parser.SyntaxNode): void {
    for (const child of node.namedChildren) {
      if (child.type === 'function_definition') {
        addFunction(child);
      } else if (CLASS_NODES.has(child.type)) {
        addClass(child);
      } else if (child.type === 'enum_specifier') {
        const name = child.childForFieldName('name')?.text;
        if (name && child.childForFieldName('body')) out.add(name, 'type', child);
      } else if (CONTAINERS.has(child.type)) {
        visit(child.type === 'namespace_definition' ? (child.childForFieldName('body') ?? child) : child);
      }
    }
  }

  visit(tree.rootNode);
  return out.finish();
}
