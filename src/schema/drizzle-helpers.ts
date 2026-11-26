import { log } from '../log';
import { callArgs } from './drizzle-ast';
import type { Binding, Node, TableCtx } from './drizzle-ast';
import { loadFile, resolveRelative } from './drizzle-source';

// P23-D3b (b274): a project's own helper functions (idColumn(), timestamptz('x'), oneOf(...)) are read as
// if their body were written in place. The helper is a function declared in the same file or imported
// from a relative path; its body must be one expression (an arrow expression body, or a block that is a
// single `return`). Helpers from packages, helpers with destructured/rest parameters and calls with a
// spread argument are not followed (the caller keeps today's unresolved marking).

/** Helper calls followed, counted from the table file: createdAt() -> timestamptz() -> timestamp() is 2. */
export const MAX_HELPER_DEPTH = 2;

export interface Helper {
  /** The file the helper is declared in (repo-relative). */
  file: string;
  /** The single expression the helper returns. */
  body: Node;
  /** Parameter names with their default value node, if any. */
  params: { name: string; fallback: Node | null }[];
}

/**
 * The helper called `name` as seen from ctx.file, or null (not a function we can read, too deep, or
 * a pg-core builder: those are handled before this is asked).
 */
export function findHelper(ctx: TableCtx, name: string): Helper | null {
  if (ctx.depth >= MAX_HELPER_DEPTH) {
    log('schema', `${ctx.file}: helper '${name}' is deeper than ${MAX_HELPER_DEPTH} helper calls; not followed`);
    return null;
  }
  const here = loadFile(ctx.src, ctx.file);
  let owner = here;
  let fnName = name;
  if (!here.functions.has(name)) {
    const imp = here.rel.get(name);
    const target = imp ? resolveRelative(ctx.src, ctx.file, imp.spec) : null;
    if (!imp || !target) return null;
    owner = loadFile(ctx.src, target);
    fnName = imp.imported;
  }
  const fn = owner.functions.get(fnName);
  if (!fn) return null;
  const body = unparen(returnedExpression(fn));
  const params = parameters(fn);
  if (!body || !params) {
    log('schema', `${owner.file}: '${fnName}' is not a single-expression function with plain parameters; not followed`);
    return null;
  }
  return { file: owner.file, body, params };
}

/**
 * The context to read the helper body in: the helper's file (its own pg-core imports and consts) with
 * the parameters bound to the call's arguments. Null when the call has a spread argument.
 */
export function bindCall(h: Helper, call: Node, caller: TableCtx): TableCtx | null {
  const args = callArgs(call);
  if (args.some((a) => a.type === 'spread_element')) return null;
  const info = loadFile(caller.src, h.file);
  const sub: TableCtx = {
    file: h.file, imports: info.imports, consts: info.consts, param: null, sqlNames: caller.sqlNames,
    src: caller.src, env: new Map<string, Binding>(), depth: caller.depth + 1,
  };
  h.params.forEach((p, i) => {
    if (args[i]) sub.env.set(p.name, { node: args[i], ctx: caller });
    else if (p.fallback) sub.env.set(p.name, { node: p.fallback, ctx: sub });
  });
  return sub;
}

function unparen(n: Node | null): Node | null {
  let x = n;
  while (x && x.type === 'parenthesized_expression') x = x.namedChildren[0] ?? null;
  return x;
}

function returnedExpression(fn: Node): Node | null {
  const body = fn.childForFieldName('body');
  if (!body) return null;
  if (body.type !== 'statement_block') return body;
  const stmts = body.namedChildren.filter((c) => c.type !== 'comment');
  return stmts.length === 1 && stmts[0].type === 'return_statement' ? stmts[0].namedChildren.find((c) => c.type !== 'comment') ?? null : null;
}

function parameters(fn: Node): { name: string; fallback: Node | null }[] | null {
  const p = fn.childForFieldName('parameters');
  const single = fn.childForFieldName('parameter');
  const list = p && p.type === 'formal_parameters' ? p.namedChildren.filter((c) => c.type !== 'comment') : single ? [single] : [];
  const out: { name: string; fallback: Node | null }[] = [];
  for (const x of list) {
    if (x.type === 'identifier') { out.push({ name: x.text, fallback: null }); continue; }
    const pattern = x.childForFieldName('pattern');
    if ((x.type !== 'required_parameter' && x.type !== 'optional_parameter') || !pattern || pattern.type !== 'identifier') return null;
    out.push({ name: pattern.text, fallback: x.childForFieldName('value') });
  }
  return out;
}
