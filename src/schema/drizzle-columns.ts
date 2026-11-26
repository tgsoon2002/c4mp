import { log } from '../log';
import type { Field } from './types';
import { calleeName, callArgs, objectPairs, stringValue, unwrapChain } from './drizzle-ast';
import { deref, evalStr } from './drizzle-eval';
import { bindCall, findHelper } from './drizzle-helpers';
import type { Node, TableCtx } from './drizzle-ast';

// P23-D3a (b267): the columns object of a pgTable(...) call -> Field[].
// Only drizzle's own builders are understood. A call that is not one of them (a project helper such as
// idColumn(), or a pg-core builder not listed) still gives a field: type '?', unresolved = its name.

/** A foreign key found in a column chain; target names are the TS names, resolved after all files are read. */
export interface PendingRef {
  field: Field;
  targetTable: string;
  targetKey: string;
  onDelete: string | null;
}

const PLAIN_TYPES = new Set(['text', 'uuid', 'integer', 'bigint', 'boolean', 'date', 'jsonb']);

/** Read every column of the columns object. ctx.sqlNames is filled with key -> SQL name. */
export function readColumns(obj: Node, ctx: TableCtx, table: string): { fields: Field[]; refs: PendingRef[] } {
  const fields: Field[] = [];
  const refs: PendingRef[] = [];
  const { pairs, other } = objectPairs(obj);
  for (const o of other) log('schema', `${ctx.file}:${o.startPosition.row + 1} ${table}: '${o.type}' entry in the columns object is not read (columns it adds are missing)`);
  for (const [key, value] of pairs) {
    const f = readField(key, value, ctx, refs);
    fields.push(f);
    ctx.sqlNames.set(key, f.name);
  }
  log('schema', `${ctx.file} ${table}: ${fields.length} columns`);
  return { fields, refs };
}

function readField(key: string, value: Node, ctx: TableCtx, refs: PendingRef[]): Field {
  const field: Field = {
    name: key, key, type: '?', nullable: true, pk: false, unique: false,
    default: null, values: null, fk: null, line: value.startPosition.row + 1,
  };
  const { base, methods } = unwrapChain(value);
  const failed = readBuilder(field, base, ctx, refs, key);
  if (failed !== null) {
    field.unresolved = failed;
    const n = base.type === 'call_expression' ? evalStr(callArgs(base)[0], ctx) : null;
    if (n !== null) field.name = n;
  }
  for (const m of methods) applyMethod(field, m.name, m.args, ctx, refs);
  return field;
}

/**
 * Set type / name / values of `field` from the base of a column chain (the part before .notNull() etc.):
 * a pg-core builder, a customType({ dataType })(name), or a project helper whose body is read in place
 * (P23-D3b). Returns null when read, else the name to show as unresolved (the helper or call as written).
 * A helper body is read on a copy, so a failure part-way leaves `field` untouched.
 */
function readBuilder(field: Field, base: Node, ctx: TableCtx, refs: PendingRef[], key: string): string | null {
  const local = calleeName(base);
  const imported = local === null ? undefined : ctx.imports.get(local);
  const args = base.type === 'call_expression' ? callArgs(base) : [];
  const name = evalStr(args[0], ctx);
  const config = args.find((a) => a.type === 'object');

  if (imported !== undefined && PLAIN_TYPES.has(imported)) {
    field.type = imported;
    if (name !== null) field.name = name;
    if (imported === 'text' && config) field.values = readEnum(config, ctx, key);
    return null;
  }
  if (imported === 'numeric') {
    field.type = numericType(config);
    if (name !== null) field.name = name;
    return null;
  }
  if (imported === 'timestamp') {
    field.type = timestampType(config);
    if (name !== null) field.name = name;
    return null;
  }
  const custom = customType(base, ctx);
  if (custom !== null) {
    field.type = custom;
    if (name !== null) field.name = name;
    return null;
  }
  if (local !== null && imported === undefined) {
    const h = findHelper(ctx, local);
    const sub = h ? bindCall(h, base, ctx) : null;
    if (h && sub) {
      const inner: Field = { ...field };
      const innerRefs: PendingRef[] = [];
      const chain = unwrapChain(h.body);
      const failed = readBuilder(inner, chain.base, sub, innerRefs, key);
      if (failed === null) {
        for (const m of chain.methods) applyMethod(inner, m.name, m.args, sub, innerRefs);
        Object.assign(field, inner);
        refs.push(...innerRefs.map((r) => ({ ...r, field })));
        return null;
      }
      log('schema', `${ctx.file}:${field.line} column '${key}': helper '${local}' does not end in a drizzle builder ('${failed}'); type '?'`);
      return local;
    }
  }
  const shown = local ?? base.text;
  log('schema', `${ctx.file}:${field.line} column '${key}': '${shown}' is ${imported !== undefined ? 'a pg-core builder not read yet' : 'not a drizzle builder (helper)'}; type '?'`);
  return shown;
}

/** customType<..>({ dataType: () => 'jsonb', ... })(name): the dataType string, else null. */
function customType(base: Node, ctx: TableCtx): string | null {
  if (base.type !== 'call_expression') return null;
  const inner = base.childForFieldName('function');
  if (!inner || inner.type !== 'call_expression' || ctx.imports.get(calleeName(inner) ?? '') !== 'customType') return null;
  const config = callArgs(inner).find((a) => a.type === 'object');
  const dt = config ? objectPairs(config).pairs.get('dataType') : undefined;
  const body = dt && dt.type === 'arrow_function' ? dt.childForFieldName('body') : null;
  return body ? evalStr(body, ctx) : null;
}

function applyMethod(field: Field, method: string, args: Node[], ctx: TableCtx, refs: PendingRef[]): void {
  switch (method) {
    case 'notNull': field.nullable = false; break;
    case 'primaryKey': field.pk = true; field.nullable = false; break;
    case 'unique': field.unique = true; break;
    case 'default': field.default = args[0] ? defaultText(args[0], ctx) : null; break;
    case 'defaultNow': field.default = 'now()'; break;
    case '$defaultFn': case '$default': case '$onUpdate': case '$onUpdateFn': case '$type': break;   // app side, no SQL default
    case 'references': refs.push(readReference(field, args, ctx)); break;
    default: log('schema', `${ctx.file}:${field.line} column '${field.key}': chain method .${method}() not read`);
  }
}

/** The default as written; a helper parameter shows what the caller passed. */
function defaultText(n: Node, ctx: TableCtx): string {
  const d = deref(n, ctx);
  return 'value' in d ? d.value : d.node.text;
}

/** .references(() => t.col, { onDelete }) and the (): AnyPgColumn => t.col form. */
function readReference(field: Field, args: Node[], ctx: TableCtx): PendingRef {
  const fn = args[0];
  const body = fn && fn.type === 'arrow_function' ? fn.childForFieldName('body') : null;
  const obj = body && body.type === 'member_expression' ? body.childForFieldName('object') : null;
  const prop = body && body.type === 'member_expression' ? body.childForFieldName('property') : null;
  if (!obj || !prop || obj.type !== 'identifier') {
    throw new Error(`schema: ${ctx.file}:${field.line} column '${field.key}': .references() is not "() => table.column"; cannot read this foreign key`);
  }
  const opts = args[1] && args[1].type === 'object' ? objectPairs(args[1]).pairs : new Map<string, Node>();
  const onDelete = stringValue(opts.get('onDelete')) ?? null;
  if (opts.get('onDelete') && onDelete === null) log('schema', `${ctx.file}:${field.line} column '${field.key}': onDelete is not a string literal, kept null`);
  if (opts.has('onUpdate')) log('schema', `${ctx.file}:${field.line} column '${field.key}': onUpdate is not part of the model, ignored`);
  return { field, targetTable: obj.text, targetKey: prop.text, onDelete };
}

/** { enum: X } on text(): X is a same-file const array or an inline array of strings; else null (logged). */
function readEnum(config: Node, ctx: TableCtx, key: string): string[] | null {
  const e = objectPairs(config).pairs.get('enum');
  if (!e) return null;
  if (e.type === 'identifier') {
    const v = ctx.consts.get(e.text);
    if (!v) log('schema', `${ctx.file}: column '${key}': enum '${e.text}' is not a same-file const array, values not read`);
    return v ?? null;
  }
  if (e.type === 'array') {
    const items = e.namedChildren.map((c) => stringValue(c));
    if (items.every((s): s is string => s !== null)) return items;
  }
  log('schema', `${ctx.file}: column '${key}': enum value is not a list of strings, values not read`);
  return null;
}

function numericType(config: Node | undefined): string {
  const p = config ? objectPairs(config).pairs : new Map<string, Node>();
  const precision = p.get('precision')?.text;
  const scale = p.get('scale')?.text;
  if (precision === undefined) return 'numeric';
  return scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
}

function timestampType(config: Node | undefined): string {
  const tz = config ? objectPairs(config).pairs.get('withTimezone') : undefined;
  return tz && tz.text === 'true' ? 'timestamptz' : 'timestamp';
}
