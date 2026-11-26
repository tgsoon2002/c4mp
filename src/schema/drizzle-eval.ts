import { calleeName, callArgs, paramKey, sqlNameOf, stringValue } from './drizzle-ast';
import type { Node, TableCtx } from './drizzle-ast';
import { loadFile, resolveRelative } from './drizzle-source';

// P23-D3b (b274): the small constant evaluator of the Drizzle reader. It turns an argument node into text
// when that is certain: a string or number literal, a template of those, String(x), x.replaceAll('a','b'),
// a helper parameter bound to such a value, or a const array. Everything else gives null (never a guess).
// Also home of sqlText (sql`...` -> SQL text), which uses the evaluator for ${...} parts.

/** Follow helper parameters to what the caller wrote. Stops at the first node that is not a bound name. */
export function deref(node: Node, ctx: TableCtx): { node: Node; ctx: TableCtx } | { value: string } {
  let n = node;
  let c = ctx;
  for (let i = 0; i < 32; i++) {
    while (n.type === 'parenthesized_expression' && n.namedChildren[0]) n = n.namedChildren[0];
    const b = n.type === 'identifier' ? c.env.get(n.text) : undefined;
    if (!b) break;
    if ('value' in b) return b;
    n = b.node;
    c = b.ctx;
  }
  return { node: n, ctx: c };
}

/** Text of a literal-like expression, else null. */
export function evalStr(node: Node | undefined, ctx: TableCtx): string | null {
  if (!node) return null;
  const d = deref(node, ctx);
  if ('value' in d) return d.value;
  const n = d.node;
  const c = d.ctx;
  switch (n.type) {
    case 'string': return stringValue(n);
    case 'number': return n.text;
    case 'unary_expression': return /^-\s*\d+(\.\d+)?$/.test(n.text) ? n.text.replace(/\s+/g, '') : null;
    case 'template_string': {
      let out = '';
      for (const p of n.children) {
        if (p.type === '`') continue;
        if (p.type === 'string_fragment') { out += p.text; continue; }
        if (p.type !== 'template_substitution') return null;
        const v = evalStr(p.namedChildren[0], c);
        if (v === null) return null;
        out += v;
      }
      return out;
    }
    case 'call_expression': {
      const args = callArgs(n);
      if (calleeName(n) === 'String') return args.length === 1 ? evalStr(args[0], c) : null;
      const fn = n.childForFieldName('function');
      const method = fn && fn.type === 'member_expression' ? fn.childForFieldName('property')?.text : undefined;
      if ((method === 'replaceAll' || method === 'replace') && fn && args.length === 2) {
        const subject = evalStr(fn.childForFieldName('object') ?? undefined, c);
        const from = evalStr(args[0], c);
        const to = evalStr(args[1], c);
        if (subject === null || from === null || to === null || from === '') return null;
        return method === 'replaceAll' ? subject.split(from).join(to) : subject.replace(from, () => to);
      }
      return null;
    }
    default: return null;
  }
}

/** A list of strings: an inline array, a same-file const array, or one imported from a relative file. */
export function evalList(node: Node | undefined, ctx: TableCtx): string[] | null {
  if (!node) return null;
  const d = deref(node, ctx);
  if ('value' in d) return null;
  let n = d.node;
  const c = d.ctx;
  if (n.type === 'as_expression' && n.namedChildren[0]) n = n.namedChildren[0];
  if (n.type === 'array') {
    const items = n.namedChildren.filter((x) => x.type !== 'comment').map((x) => evalStr(x, c));
    return items.every((s): s is string => s !== null) ? items : null;
  }
  if (n.type !== 'identifier') return null;
  const same = c.consts.get(n.text);
  if (same) return same;
  const info = loadFile(c.src, c.file);
  const imp = info.rel.get(n.text);
  const target = imp ? resolveRelative(c.src, c.file, imp.spec) : null;
  return imp && target ? loadFile(c.src, target).consts.get(imp.imported) ?? null : null;
}

/**
 * SQL text of an sql`...` template: ${t.key} (or a helper parameter bound to it) becomes the SQL column
 * name; ${sql.raw(..)}, ${sql.join(list.map(..), sep)} and plain literals are evaluated when they can be;
 * any other ${...} stays as written (onKeep is told). Returns null when n is not a tagged sql template.
 */
export function sqlText(n: Node, ctx: TableCtx, onKeep: (expr: string) => void): string | null {
  return sqlTemplate(n, ctx, onKeep)?.trim() ?? null;
}

/** sqlText without the final trim (a nested template such as the separator sql`, ` keeps its space). */
function sqlTemplate(n: Node, ctx: TableCtx, onKeep: (expr: string) => void): string | null {
  if (n.type !== 'call_expression' || calleeName(n) !== 'sql') return null;
  const tpl = n.namedChildren.find((c) => c.type === 'template_string');
  if (!tpl) return null;
  let out = '';
  for (const c of tpl.children) {
    if (c.type === '`') continue;
    if (c.type !== 'template_substitution') { out += c.text; continue; }
    const piece = sqlPiece(c.namedChildren[0], ctx, onKeep);
    if (piece !== null) { out += piece; continue; }
    onKeep(c.text);
    out += c.text;
  }
  return out;
}

/** One ${...} part of an sql template as SQL text, or null when it cannot be read. */
function sqlPiece(expr: Node | undefined, ctx: TableCtx, onKeep: (e: string) => void): string | null {
  if (!expr) return null;
  const d = deref(expr, ctx);
  if ('value' in d) return d.value;
  const n = d.node;
  const c = d.ctx;
  const key = paramKey(n, c.param);
  if (key !== null) return sqlNameOf(key, c);
  if (n.type === 'call_expression') {
    const nested = sqlTemplate(n, c, onKeep);
    if (nested !== null) return nested;
    const fn = n.childForFieldName('function');
    const args = callArgs(n);
    if (fn && fn.type === 'member_expression' && fn.childForFieldName('object')?.text === 'sql') {
      const m = fn.childForFieldName('property')?.text;
      if (m === 'raw') return evalStr(args[0], c);
      if (m === 'join') return sqlJoin(args[0], args[1], c, onKeep);
    }
    return null;
  }
  return evalStr(n, c);
}

/** sql.join(list.map((v) => piece), sep) with a readable list and separator, else null. */
function sqlJoin(listExpr: Node | undefined, sepExpr: Node | undefined, ctx: TableCtx, onKeep: (e: string) => void): string | null {
  if (!listExpr || !sepExpr) return null;
  const sep = sqlPiece(sepExpr, ctx, onKeep);
  const l = deref(listExpr, ctx);
  if (sep === null || 'value' in l || l.node.type !== 'call_expression') return null;
  const fn = l.node.childForFieldName('function');
  const arrow = callArgs(l.node)[0];
  if (!fn || fn.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'map') return null;
  if (!arrow || arrow.type !== 'arrow_function') return null;
  const items = evalList(fn.childForFieldName('object') ?? undefined, l.ctx);
  const p = arrow.childForFieldName('parameters');
  const param = p && p.type === 'formal_parameters' ? p.namedChildren[0] : arrow.childForFieldName('parameter');
  const name = param ? (param.childForFieldName('pattern') ?? param) : null;
  const body = arrow.childForFieldName('body');
  if (!items || !name || name.type !== 'identifier' || !body) return null;
  const parts: string[] = [];
  for (const item of items) {
    const env = new Map(l.ctx.env);
    env.set(name.text, { value: item });
    const piece = sqlPiece(body, { ...l.ctx, env }, onKeep);
    if (piece === null) return null;
    parts.push(piece);
  }
  return parts.join(sep);
}
