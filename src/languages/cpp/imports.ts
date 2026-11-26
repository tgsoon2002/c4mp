import type Parser from 'tree-sitter';
import type { RawImport } from '../../types';
import { collectImports } from '../treesitter';
import type { ImportRule } from '../treesitter';

const RULES: Record<string, ImportRule> = {
  preproc_include: {
    hits(node) {
      const pathNode = node.childForFieldName('path');
      if (pathNode?.type === 'string_literal') return [{ spec: pathNode.text.slice(1, -1) }];
      if (pathNode?.type === 'system_lib_string') return [{ spec: pathNode.text }];
      return [];
    },
  },
};

/**
 * #include directives of one C++ file. The spec is the path as written: `a/b.h` for `#include "a/b.h"`
 * and `<vector>` (angle brackets kept) for `#include <vector>`, so the resolver can tell the two forms apart.
 * Includes inside #if/#ifdef blocks or namespaces are read too (no preprocessing). A macro include
 * (`#include MACRO`) has no literal path and is skipped.
 */
export function extractCppImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'cpp-imports');
}
