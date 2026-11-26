import Parser from 'tree-sitter';
import { RawImport, ImportKind } from '../../types';
import { log } from '../../log';
import { collectImports } from '../treesitter';
import type { ImportHit, ImportRule } from '../treesitter';

function extractStringSpec(strNode: Parser.SyntaxNode): string {
  // Remove quotes from string literal
  return strNode.text.slice(1, -1);
}

/** `import ... from 'spec'` / `export ... from 'spec'`: the `source` string, as `kind`. */
function sourceRule(kind: ImportKind): ImportRule {
  return {
    descend: true,
    hits(node) {
      const source = node.childForFieldName('source');
      return source && source.type === 'string' ? [{ spec: extractStringSpec(source), kind }] : [];
    },
  };
}

// Every rule lets the walk go on inside the node: a require() or import() can sit anywhere below.
const RULES: Record<string, ImportRule> = {
  import_statement: sourceRule('import'),
  export_statement: sourceRule('export-from'),

  // require('spec') or dynamic import('spec')
  call_expression: {
    descend: true,
    hits(node): ImportHit[] {
      const func = node.childForFieldName('function');
      let kind: ImportKind;
      if (func?.type === 'identifier' && func.text === 'require') kind = 'require';
      else if (func?.type === 'import') kind = 'dynamic';
      else return [];
      const args = node.childForFieldName('arguments');
      if (!args || args.type !== 'arguments') return [];
      // Get the first named child (actual argument, not parentheses)
      const first = args.namedChild(0);
      if (!first) return [];
      if (first.type !== 'string') {
        // Non-literal argument
        log('specifiers', 'skip', { line: node.startPosition.row + 1, reason: 'non-literal' });
        return [];
      }
      return [{ spec: extractStringSpec(first), kind }];
    },
  },
};

export function extractImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'specifiers');
}
