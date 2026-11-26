import { log } from '../log';
import type { RecordType } from './types';
import { calleeName, callArgs, objectPairs, paramKey, sqlNameOf, unwrapChain } from './drizzle-ast';
import { deref, evalStr, sqlText } from './drizzle-eval';
import { bindCall, findHelper } from './drizzle-helpers';
import type { Node, TableCtx } from './drizzle-ast';

// P23-D3a (b267): the third argument of pgTable, `(t) => [ ... ]` or `(t) => ({ ... })`, -> indexes,
// checks and the composite primary key of a RecordType. Only drizzle's own index, uniqueIndex,
// primaryKey and check are read; any other call (a project helper) is skipped with a log line.

/** Fill rec.indexes / rec.checks / rec.primaryKey from the extras callback. ctx.sqlNames must be filled. */
export function readExtras(fn: Node, ctx: TableCtx, rec: RecordType): void {
  if (fn.type !== 'arrow_function') {
    log('schema', `${ctx.file} ${rec.name}: third argument is a '${fn.type}', not an arrow function; indexes and checks not read`);
    return;
  }
  const p = fn.childForFieldName('parameters');
  const first = p && p.type === 'formal_parameters' ? p.namedChildren[0] : fn.childForFieldName('parameter');
  const param = first ? (first.childForFieldName('pattern') ?? first).text : null;
  const local: TableCtx = { ...ctx, param };
  for (const entry of entries(fn.childForFieldName('body'), ctx, rec.name)) readEntry(entry, local, rec);
  log('schema', `${ctx.file} ${rec.name}: ${rec.indexes.length} indexes, ${rec.checks.length} checks, primary key [${rec.primaryKey.join(', ')}]`);
}

/** The entry expressions: array elements, or the values of an object literal (parentheses removed). */
function entries(body: Node | null, ctx: TableCtx, table: string): Node[] {
  let b = body;
  while (b && b.type === 'parenthesized_expression') b = b.namedChildren[0] ?? null;
  if (!b) return [];
  if (b.type === 'array') return b.namedChildren.filter((c) => c.type !== 'comment');
  if (b.type === 'object') return [...objectPairs(b).pairs.values()];
  log('schema', `${ctx.file} ${table}: extras body is a '${b.type}'; indexes and checks not read`);
  return [];
}

/** One extras entry into rec. Returns false when it is a call we do not read (a helper that cannot be followed). */
function readEntry(entry: Node, ctx: TableCtx, rec: RecordType): boolean {
  const { base, methods } = unwrapChain(entry);
  const local = calleeName(base);
  const imported = local === null ? undefined : ctx.imports.get(local);
  const at = `${ctx.file}:${entry.startPosition.row + 1} ${rec.name}`;
  const args = base.type === 'call_expression' ? callArgs(base) : [];
  const keep = (e: string) => log('schema', `${at}: sql substitution ${e} kept as written`);
  switch (imported) {
    case 'index': case 'uniqueIndex': {
      const on = methods.find((m) => m.name === 'on');
      const where = methods.find((m) => m.name === 'where');
      for (const m of methods) if (m.name !== 'on' && m.name !== 'where') log('schema', `${at}: index method .${m.name}() not read`);
      if (!on) log('schema', `${at}: index without .on(); no columns`);
      rec.indexes.push({
        name: evalStr(args[0], ctx) ?? '',
        unique: imported === 'uniqueIndex',
        columns: (on?.args ?? []).map((a) => indexColumn(a, ctx, at, keep)),
        where: where?.args[0] ? sqlText(where.args[0], ctx, keep) : null,
      });
      break;
    }
    case 'primaryKey': {
      const cfg = args[0] && args[0].type === 'object' ? objectPairs(args[0]).pairs : new Map<string, Node>();
      const cols = cfg.get('columns');
      const names = cols && cols.type === 'array' ? cols.namedChildren.map((c) => indexColumn(c, ctx, at, keep)) : [];
      if (names.length === 0) log('schema', `${at}: primaryKey without a readable columns list`);
      rec.primaryKey = names;
      for (const f of rec.fields) if (names.includes(f.name)) { f.pk = true; f.nullable = false; }
      break;
    }
    case 'check': {
      const expr = args[1] ? sqlText(args[1], ctx, keep) : null;
      if (expr === null) log('schema', `${at}: check expression is not an sql template; expr null`);
      rec.checks.push({ name: evalStr(args[0], ctx) ?? '', expr });
      break;
    }
    default: {
      const h = local !== null && imported === undefined ? findHelper(ctx, local) : null;
      const sub = h ? bindCall(h, base, ctx) : null;
      if (h && sub && readEntry(h.body, sub, rec)) return true;
      log('schema', `${at}: '${local ?? base.text}' is not a drizzle index/check/primaryKey (helper); skipped`);
      return false;
    }
  }
  return true;
}

/** One column argument: t.key (ordering modifiers stripped) -> SQL name; an sql`..` -> its text; else as written. */
function indexColumn(arg: Node, callerCtx: TableCtx, at: string, keep: (e: string) => void): string {
  const bound = deref(arg, callerCtx);
  if ('value' in bound) return bound.value;
  const a = bound.node;
  const ctx = bound.ctx;
  const t = sqlText(a, ctx, keep);
  if (t !== null) return t;
  const { base, methods } = unwrapChain(a);
  const key = paramKey(base, ctx.param);
  if (key === null) {
    log('schema', `${at}: index column '${a.text}' is not t.column or sql; kept as written`);
    return a.text;
  }
  for (const m of methods) if (!['desc', 'asc', 'nullsFirst', 'nullsLast'].includes(m.name)) log('schema', `${at}: column modifier .${m.name}() not read`);
  return sqlNameOf(key, ctx);
}
