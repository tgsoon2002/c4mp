import { log } from '../log';
import type { RecordType, SchemaModel } from './types';
import { callArgs, stringValue } from './drizzle-ast';
import type { Node, TableCtx } from './drizzle-ast';
import { readColumns } from './drizzle-columns';
import type { PendingRef } from './drizzle-columns';
import { readExtras } from './drizzle-extras';
import { loadFile, newSourceIndex, topDeclarators } from './drizzle-source';

// P23-D3a (b267): Drizzle (pg-core) schema reader. Pure and read-only: files in, SchemaModel out.
// Parsing goes through the shared tree-sitter TypeScript parser (languages/typescript/language.ts parseSource).
// parseCache is not used: it stores outlines, not syntax trees, and this reader needs the trees.

/**
 * Read the tables of the given Drizzle schema files.
 * repoRoot: directory the files are relative to. files: repo-relative paths (a file that imports nothing
 * from drizzle-orm/pg-core, e.g. an index.ts that re-exports, simply gives no tables).
 * A file whose syntax tree has errors throws. A file importing another dialect's core (mysql-core,
 * sqlite-core, ...) goes to `unsupported`. Foreign-key targets are resolved by TS constant name across
 * all given files, so file order does not matter.
 */
export function readDrizzleSchema(repoRoot: string, files: string[]): SchemaModel {
  const model: SchemaModel = { records: [], unsupported: [] };
  const refs: PendingRef[] = [];
  const owner = new Map<PendingRef['field'], RecordType>();
  const src = newSourceIndex(repoRoot);
  for (const file of files) {
    const info = loadFile(src, file);
    for (const d of info.otherDialects) {
      model.unsupported.push({ file, dialect: d });
      log('schema', `${file}: dialect '${d}' is not supported yet`);
    }
    if (!info.pg) { log('schema', `${file}: no drizzle-orm/pg-core import, no tables`); continue; }
    for (const t of tableDeclarations(info.root, info.imports)) {
      const before = refs.length;
      const rec = readTable(t, file, { file, imports: info.imports, consts: info.consts, param: null, sqlNames: new Map(), src, env: new Map(), depth: 0 }, refs);
      model.records.push(rec);
      for (const r of refs.slice(before)) owner.set(r.field, rec);
    }
  }
  resolveRefs(model, refs, owner);
  log('schema', `read ${model.records.length} tables from ${files.length} files, ${refs.length} foreign keys, ${model.unsupported.length} unsupported files`);
  return model;
}

/** `const key = pgTable(...)` at top level: the declarator, whose value is a call of the imported pgTable. */
function tableDeclarations(root: Node, imports: Map<string, string>): Node[] {
  return topDeclarators(root).filter((d) => {
    const v = d.childForFieldName('value');
    const fn = v && v.type === 'call_expression' ? v.childForFieldName('function') : null;
    return !!fn && fn.type === 'identifier' && imports.get(fn.text) === 'pgTable';
  });
}

function readTable(decl: Node, file: string, ctx: TableCtx, refs: PendingRef[]): RecordType {
  const key = (decl.childForFieldName('name') as Node).text;
  const call = decl.childForFieldName('value') as Node;
  const args = callArgs(call);
  const name = stringValue(args[0]);
  if (name === null) throw new Error(`schema: ${file}:${decl.startPosition.row + 1} table '${key}': the first pgTable argument is not a string literal`);
  if (!args[1] || args[1].type !== 'object') throw new Error(`schema: ${file}:${decl.startPosition.row + 1} table '${key}': the second pgTable argument is not an object literal`);
  const stmt = decl.parent?.parent?.type === 'export_statement' ? decl.parent.parent : decl.parent ?? decl;
  const { fields, refs: tableRefs } = readColumns(args[1], ctx, name);
  refs.push(...tableRefs);
  const rec: RecordType = {
    name, key, file, line: stmt.startPosition.row + 1, endLine: stmt.endPosition.row + 1,
    fields, primaryKey: [], indexes: [], checks: [],
  };
  if (args[2]) readExtras(args[2], ctx, rec);
  return rec;
}

/** Turn TS names (users.id) into SQL names (users, id) for every foreign key; order independent. */
function resolveRefs(model: SchemaModel, refs: PendingRef[], owner: Map<PendingRef['field'], RecordType>): void {
  const byKey = new Map<string, RecordType>();
  for (const r of model.records) {
    if (byKey.has(r.key)) log('schema', `table constant '${r.key}' is declared in ${byKey.get(r.key)?.file} and ${r.file}; references use the first`);
    else byKey.set(r.key, r);
  }
  for (const ref of refs) {
    const target = byKey.get(ref.targetTable);
    const col = target?.fields.find((f) => f.key === ref.targetKey);
    const from = owner.get(ref.field);
    if (!target || !col) {
      log('schema', `${from?.file ?? '?'} ${from?.name ?? '?'}.${ref.field.name}: reference ${ref.targetTable}.${ref.targetKey} not found in the given files; kept as written`);
    }
    ref.field.fk = { table: target ? target.name : ref.targetTable, column: col ? col.name : ref.targetKey, onDelete: ref.onDelete };
  }
}
