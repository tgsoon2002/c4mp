import type Parser from 'tree-sitter';
import { log } from '../log';

// P23-D3a (b267): small tree-sitter helpers for the Drizzle reader. All work on the syntax tree; no
// regex over source text. Shapes verified against tree-sitter-typescript (a tagged template sql`..` is a
// call_expression whose second child is a template_string; a method chain is call(member(call(...))).

export type Node = Parser.SyntaxNode;

/** A named import from a relative path: local name -> the specifier as written and the exported name. */
export interface RelImport { spec: string; imported: string }

export interface FileInfo {
  /** Repo-relative file, '/' separators. */
  file: string;
  tree: Parser.Tree;
  root: Node;
  /** True when the file imports drizzle-orm/pg-core. */
  pg: boolean;
  /** Other dialect cores imported (mysql, sqlite, ...). */
  otherDialects: string[];
  /** Local -> imported names from drizzle-orm/pg-core. */
  imports: Map<string, string>;
  /** Named imports from relative paths ('./x', '../y.ts'). */
  rel: Map<string, RelImport>;
  /** Top-level `const X = [...] as const` (or plain array) of string literals. */
  consts: Map<string, string[]>;
  /** Top-level function-like declarations: `const f = (..) => ..`, `const f = function ..`, `function f(..) {..}`. */
  functions: Map<string, Node>;
}

export interface SourceIndex {
  repoRoot: string;
  cache: Map<string, FileInfo>;
}

/** What the reader knows about the table being read; lets a `t.key` become its SQL column name. */
export interface TableCtx {
  file: string;
  /** Local names imported from drizzle-orm/pg-core: local -> imported name. */
  imports: Map<string, string>;
  /** Same-file `const X = [...] as const` string arrays. */
  consts: Map<string, string[]>;
  /** The parameter name of the (t) => ... extras callback; null while reading columns. */
  param: string | null;
  /** key -> SQL name for the columns of this table (filled once the columns are read). */
  sqlNames: Map<string, string>;
  /** The files read so far (cache) and the repo root; lets a helper or a const be found in another file. */
  src: SourceIndex;
  /** Helper parameters in scope while a helper body is read: name -> what the caller passed. Empty outside. */
  env: Map<string, Binding>;
  /** How many helper calls deep this context is (0 = the table file itself). */
  depth: number;
}

/** What a name stands for: the caller's argument node with the context it is written in, or a known string (a .map() item). */
export type Binding = { node: Node; ctx: TableCtx } | { value: string };

/** The text of a plain string literal node, else null. */
export function stringValue(n: Node | undefined): string | null {
  if (!n || n.type !== 'string') return null;
  return n.text.slice(1, -1);
}

/** Argument nodes of a call_expression (named children of its `arguments`), [] when none. */
export function callArgs(call: Node): Node[] {
  const args = call.childForFieldName('arguments');
  return args && args.type === 'arguments' ? args.namedChildren.filter((c) => c.type !== 'comment') : [];
}

/** Object literal -> key -> value node (pair entries only). Other entries (spread, method) go to `other`. */
export function objectPairs(obj: Node): { pairs: Map<string, Node>; other: Node[] } {
  const pairs = new Map<string, Node>();
  const other: Node[] = [];
  for (const c of obj.namedChildren) {
    if (c.type === 'comment') continue;
    const k = c.type === 'pair' ? propertyKey(c.childForFieldName('key')) : null;
    const v = c.type === 'pair' ? c.childForFieldName('value') : null;
    if (k !== null && v) pairs.set(k, v); else other.push(c);
  }
  return { pairs, other };
}

/** Property key text: identifier or quoted string; null for a computed key. */
export function propertyKey(n: Node | null): string | null {
  if (!n) return null;
  if (n.type === 'property_identifier') return n.text;
  if (n.type === 'string') return stringValue(n);
  return null;
}

export interface ChainMethod { name: string; args: Node[] }

/**
 * Split `base.m1(a).m2(b)` into the base expression and the ordered method calls.
 * base is the innermost non-method expression: `uuid('x')` (a call whose callee is a plain name),
 * or `t.key` (a member access) when the chain started there.
 */
export function unwrapChain(node: Node): { base: Node; methods: ChainMethod[] } {
  const methods: ChainMethod[] = [];
  let cur = node;
  for (;;) {
    if (cur.type !== 'call_expression') break;
    const fn = cur.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') break;
    const prop = fn.childForFieldName('property');
    const obj = fn.childForFieldName('object');
    if (!prop || !obj) break;
    methods.unshift({ name: prop.text, args: callArgs(cur) });
    cur = obj;
  }
  return { base: cur, methods };
}

/** The plain callee name of `name(...)` (also `name<T>(...)`), else null. */
export function calleeName(call: Node): string | null {
  if (call.type !== 'call_expression') return null;
  const fn = call.childForFieldName('function');
  return fn && fn.type === 'identifier' ? fn.text : null;
}

/** `t.key` where t is the extras parameter -> key; else null. */
export function paramKey(n: Node, param: string | null): string | null {
  if (n.type !== 'member_expression' || param === null) return null;
  const obj = n.childForFieldName('object');
  const prop = n.childForFieldName('property');
  return obj && prop && obj.type === 'identifier' && obj.text === param ? prop.text : null;
}

/** SQL name of a column key in this table; the key itself when the column is not known. */
export function sqlNameOf(key: string, ctx: TableCtx): string {
  const name = ctx.sqlNames.get(key);
  if (name === undefined) log('schema', `column key '${key}' is not a column of its table, kept as written (${ctx.file})`);
  return name ?? key;
}
