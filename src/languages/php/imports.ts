import type Parser from 'tree-sitter';
import type { RawImport } from '../../types';
import { log } from '../../log';
import { collectImports } from '../treesitter';
import type { ImportHit, ImportRule } from '../treesitter';

const REQUIRE_TYPES = new Set(['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression']);

/** `Foo\Bar` from the text of a name (a leading backslash is dropped). */
function cleanName(text: string): string {
  return text.replace(/\s+/g, '').replace(/^\\/, '');
}

/** The imported name of one `namespace_use_clause`: its first named child (the alias is a later field). */
function clauseName(clause: Parser.SyntaxNode): string {
  const first = clause.namedChild(0);
  return first ? cleanName(first.text) : '';
}

/**
 * Directory of the including file as a relative path: `__DIR__` and `dirname(__FILE__)` are '.',
 * `dirname(X)` is X plus '/..'. Null for anything else.
 */
function dirExpr(node: Parser.SyntaxNode): string | null {
  if (node.type === 'parenthesized_expression' && node.namedChild(0)) return dirExpr(node.namedChild(0)!);
  if (node.type === 'name' && node.text === '__DIR__') return '.';
  if (node.type === 'function_call_expression' && node.childForFieldName('function')?.text === 'dirname') {
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length !== 1) return null;
    const arg = args[0].namedChild(0);
    if (!arg) return null;
    if (arg.type === 'name' && arg.text === '__FILE__') return '.';
    const inner = dirExpr(arg);
    return inner === null ? null : inner + '/..';
  }
  return null;
}

/** The path a require/include argument builds when it is only literals and the including file's folder; else null. */
function literalPath(node: Parser.SyntaxNode): string | null {
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner ? literalPath(inner) : null;
  }
  if (node.type === 'string' || node.type === 'encapsed_string') {
    // encapsed_string with a variable or expression inside has named children other than string_content
    if (node.namedChildren.some((c) => c.type !== 'string_content' && c.type !== 'escape_sequence')) return null;
    return node.text.slice(1, -1);
  }
  const dir = dirExpr(node);
  if (dir !== null) return dir;
  if (node.type === 'binary_expression') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right || node.child(1)?.type !== '.') return null;
    const l = literalPath(left);
    const r = literalPath(right);
    return l === null || r === null ? null : l + r;
  }
  return null;
}

const useRule: ImportRule = {
  hits(node) {
    const group = node.childForFieldName('body');
    const prefix = group ? node.namedChildren.find((c) => c.type === 'namespace_name') : undefined;
    const clauses = group ? group.namedChildren : node.namedChildren;
    const hits: ImportHit[] = [];
    for (const clause of clauses) {
      if (clause.type !== 'namespace_use_clause') continue;
      const name = clauseName(clause);
      hits.push({ spec: prefix ? `${cleanName(prefix.text)}\\${name}` : name, line: clause.startPosition.row + 1 });
    }
    return hits;
  },
};

// The argument of a require/include may hold another one, so the walk goes on inside it.
const requireRule: ImportRule = {
  descend: true,
  hits(node) {
    const arg = node.namedChild(0);
    if (!arg) return [];
    let spec = literalPath(arg);
    if (spec !== null) {
      // './x' stays './x' (the folder of the including file); 'x' stays 'x'
      const anchored = spec === '.' || spec.startsWith('./') || spec.startsWith('../');
      spec = anchored && !spec.startsWith('../') ? './' + spec.replace(/^\.\/?/, '') : spec;
    } else {
      spec = arg.text.replace(/\s+/g, ' ');
      log('php-imports', 'dynamic', { line: node.startPosition.row + 1, spec });
    }
    return [{ spec, kind: 'require' }];
  },
};

const RULES: Record<string, ImportRule> = {
  namespace_use_declaration: useRule,
  ...Object.fromEntries([...REQUIRE_TYPES].map((type) => [type, requireRule])),
};

/**
 * Imports of one PHP file, as written:
 *  - `use A\B;`, `use A\B as C;`, `use function A\f;`, `use A\{B, C\D};` give the full name 'A\B' (no leading backslash).
 *  - `require`/`include` (and `_once`) with a literal path give the path ('a.php', './b.php' for `__DIR__ . '/b.php'`,
 *    '../c.php' for `dirname(__DIR__) . '/c.php'`); kind 'require'.
 *  - any other argument ($x, a call, a string with a variable) is given as its source text, so the
 *    resolver counts it as unresolved.
 */
export function extractPhpImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'php-imports');
}
