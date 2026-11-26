import type Parser from 'tree-sitter';
import type { RawImport } from '../../types';
import { collectImports } from '../treesitter';
import type { ImportHit, ImportRule } from '../treesitter';

// Rust import specs (read by resolve.ts):
//   `use a::b::{c, d::e, f as g, h::*};` -> 'a::b::c', 'a::b::d::e', 'a::b::f', 'a::b::h' (aliases dropped,
//       a glob names its module, `self` inside braces names the prefix). `crate`, `self`, `super` and a
//       leading `::` stay as written.
//   `extern crate serde;`                -> 'serde'
//   `mod x;` (a module in its own file)  -> 'mod x'; inside inline modules: 'mod outer::x'.
//   Inline `mod m { ... }` makes no import, but `self`/`super` in a `use` inside it are rewritten to be
//   relative to the file's module ('super' in `mod tests { use super::*; }` is the file itself -> no import).

/** Path segments of a use-tree node, one array per imported path (braces expand to several). */
function flatten(node: Parser.SyntaxNode, prefix: string[]): string[][] {
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'metavariable':
      return [[...prefix, node.text]];
    case 'self':
      return prefix.length ? [prefix] : [['self']];
    case 'scoped_identifier': {
      const p = node.childForFieldName('path');
      const name = node.childForFieldName('name');
      if (!name) return [];
      const head = p ? flatten(p, prefix)[0] ?? prefix : node.text.startsWith('::') ? [...prefix, ''] : prefix;
      return name.type === 'self' ? [head] : [[...head, name.text]];
    }
    case 'use_as_clause': {
      const p = node.childForFieldName('path');
      return p ? flatten(p, prefix) : [];
    }
    case 'use_wildcard': {
      const inner = node.namedChild(0);
      return inner ? flatten(inner, prefix) : prefix.length ? [prefix] : [];
    }
    case 'use_list':
      return node.namedChildren.flatMap((c) => flatten(c, prefix));
    case 'scoped_use_list': {
      const p = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const head = p ? flatten(p, prefix)[0] ?? prefix : prefix;
      return list ? flatten(list, head) : [];
    }
    default:
      return [];
  }
}

/** Names of the inline modules (`mod m { }`) around a node, outermost first. */
function inlineModules(node: Parser.SyntaxNode): string[] {
  const chain: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'mod_item' && p.childForFieldName('body')) {
      const name = p.childForFieldName('name');
      if (name) chain.unshift(name.text);
    }
  }
  return chain;
}

/** Rewrite `self`/`super` written inside inline modules so the path starts at the file's module. */
function relativeToFile(segs: string[], chain: string[]): string[] {
  if (!chain.length) return segs;
  if (segs[0] === 'self') return ['self', ...chain, ...segs.slice(1)];
  if (segs[0] !== 'super') return segs;
  const up = [...chain];
  let i = 0;
  while (segs[i] === 'super' && up.length) { up.pop(); i++; }
  const rest = segs.slice(i);
  return rest[0] === 'super' ? rest : ['self', ...up, ...rest];
}

const RULES: Record<string, ImportRule> = {
  use_declaration: {
    hits(node) {
      const arg = node.childForFieldName('argument');
      if (!arg) return [];
      const chain = inlineModules(node);
      const hits: ImportHit[] = [];
      for (const segs of flatten(arg, [])) {
        const rel = relativeToFile(segs, chain);
        if (rel.length === 1 && rel[0] === 'self' && chain.length) continue; // `use super::*` in a test module
        hits.push({ spec: rel.join('::') });
      }
      return hits;
    },
  },
  extern_crate_declaration: {
    hits(node) {
      const name = node.childForFieldName('name');
      return name && name.text !== 'self' ? [{ spec: name.text }] : [];
    },
  },
  // `mod x;` only: an inline `mod m { ... }` is walked for the imports inside it
  mod_item: {
    hits(node) {
      if (node.childForFieldName('body')) return null;
      const name = node.childForFieldName('name');
      return name ? [{ spec: 'mod ' + [...inlineModules(node), name.text].join('::') }] : [];
    },
  },
};

export function extractRustImports(tree: Parser.Tree): RawImport[] {
  return collectImports(tree, RULES, 'rust-imports');
}
