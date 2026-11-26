import Parser from 'tree-sitter';
import { RawImport } from '../../types';
import { collectImports } from '../treesitter';
import type { ImportHit, ImportRule } from '../treesitter';

/** `a.b.c` of a dotted_name node; also the specs of the calls reader's import bindings (calls.ts, b592). */
export function getDottedNameSpec(node: Parser.SyntaxNode): string {
  // Extract the full dotted name like 'a.b.c' from a dotted_name node
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') {
      parts.push(child.text);
    }
  }
  return parts.join('.');
}

/** `.m`, `..x`, `.` of a relative_import node; also the specs of the calls reader's import bindings (calls.ts, b592). */
export function getRelativeImportSpec(node: Parser.SyntaxNode): string {
  // Extract the full spec from a relative_import node like '.m' or '..x'
  // relative_import contains import_prefix (with dots) and optionally dotted_name
  let dots = '';
  let name = '';

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'import_prefix') {
      // Count the dots
      for (let j = 0; j < child.childCount; j++) {
        const dotChild = child.child(j);
        if (dotChild && dotChild.text === '.') {
          dots += '.';
        }
      }
    } else if (child && child.type === 'dotted_name') {
      name = getDottedNameSpec(child);
    }
  }

  return dots + name;
}

// Both rules let the walk go on inside the statement, as it always did.
const RULES: Record<string, ImportRule> = {
  // import a / import a.b as c / import a, b
  import_statement: {
    descend: true,
    hits(node) {
      const hits: ImportHit[] = [];
      // import_statement has multiple 'name' children, each is dotted_name or aliased_import
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;

        if (child.type === 'dotted_name') {
          hits.push({ spec: getDottedNameSpec(child) });
        } else if (child.type === 'aliased_import') {
          // aliased_import has 'name' field (dotted_name) and 'alias' field (identifier)
          // We only extract the name part, not the alias
          const nameChild = child.childForFieldName('name');
          if (nameChild && nameChild.type === 'dotted_name') {
            hits.push({ spec: getDottedNameSpec(nameChild) });
          }
        }
      }
      return hits;
    },
  },

  // from a.b import c / from . import x / from ..x import y
  import_from_statement: {
    descend: true,
    hits(node) {
      const moduleNameChild = node.childForFieldName('module_name');

      let moduleSpec = '';

      if (moduleNameChild) {
        if (moduleNameChild.type === 'dotted_name') {
          moduleSpec = getDottedNameSpec(moduleNameChild);
        } else if (moduleNameChild.type === 'relative_import') {
          moduleSpec = getRelativeImportSpec(moduleNameChild);
        }
      }

      // If module_name is just a relative import with no name (like 'from . import x'),
      // we create specs for each imported name: '.x', '.y'
      // If module_name has a name (like 'from ..x import y'), the spec is '..x'

      if (moduleSpec && moduleSpec.match(/^\.+$/) && moduleSpec !== '') {
        // Bare relative import: 'from . import a, b' or 'from .. import a'
        // Extract each imported name and prepend the dots
        const dotPrefix = moduleSpec;
        const hits: ImportHit[] = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;

          if (child.type === 'dotted_name') {
            hits.push({ spec: dotPrefix + getDottedNameSpec(child) });
          }
        }
        return hits;
      }
      // Absolute or relative import with a module name
      return [{ spec: moduleSpec }];
    },
  },
};

export function extractPythonImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'python-imports');
}
