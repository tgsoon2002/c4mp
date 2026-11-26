import type Parser from 'tree-sitter';
import type { RawImport } from '../../types';
import { collectImports } from '../treesitter';
import type { ImportRule } from '../treesitter';

// import_declaration: optional `modifiers` (attributes such as @testable, @_spi(X), @_exported,
// @preconcurrency; access levels such as internal), the `import` keyword, an optional kind keyword
// (struct, class, func, ...) and an `identifier` with the dotted module path.
const RULES: Record<string, ImportRule> = {
  import_declaration: {
    hits(node) {
      const id = node.namedChildren.find((c) => c.type === 'identifier');
      return id ? [{ spec: id.text.replace(/\s+/g, '') }] : [];
    },
  },
};

/**
 * Imports of one Swift file (kind 'import'): the module path as written, attributes, access level and
 * kind keyword dropped. `import Foo`, `@testable import Foo`, `@_spi(X) import Foo` -> 'Foo';
 * `import Foo.Bar` and `import struct Foo.Bar` -> 'Foo.Bar'. Imports inside `#if` blocks are read too.
 */
export function extractSwiftImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'swift-imports');
}
