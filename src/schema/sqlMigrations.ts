import * as fs from 'fs';
import * as path from 'path';
import { splitStatements, tokenize } from './sqlTokens';
import type { Statement, Tok } from './sqlTokens';
import { fieldLocation } from './types';
import type { Field, RecordType, SchemaModel, UnsupportedFile } from './types';

// P23 (b212 D3): the SQL migrations reader. Applies the migration files in order and returns the FINAL schema.
// Pure over file contents (applySqlFiles) plus a thin file reader (readSqlSchema). Postgres first; MySQL and
// SQLite spellings are accepted where cheap (backticks, [x], AUTO_INCREMENT, AUTOINCREMENT, KEY name (cols),
// MODIFY / CHANGE). Names: a bare identifier is folded to lower case, a quoted one is kept ("Users" != users);
// a schema qualifier is dropped from every name and kept on RecordType.schema when it is not 'public'.
// Defaults are the SQL text; GENERATED ... / AS (expr) / AUTO_INCREMENT columns put that clause in `default`.
// Statements that only move data or settings (BEGIN, COMMIT, SET, INSERT, UPDATE, DELETE, GRANT, REVOKE, COMMENT,
// SELECT, CREATE EXTENSION / SCHEMA, ALTER ... OWNER TO, ENABLE / DISABLE / FORCE ROW LEVEL SECURITY, ...) are
// skipped silently. Every other statement that is not understood (CREATE FUNCTION / TRIGGER / VIEW / POLICY, DO
// blocks, EXCLUDE, unknown ALTER actions, a table that does not exist, ...) becomes an `unsupported` entry with
// file, line, statement head and reason. Nothing is guessed. Table options after the closing paren (ENGINE=,
// WITHOUT ROWID, ...) are not read.

// ---------------------------------------------------------------- file order and detection

const MIGRATION_DIRS = new Set(['migrations', 'migrate', 'drizzle']);
const UNDO_FILE = /(\.down|\.undo|\.rollback)\.sql$|^U\d[\w.]*__.*\.sql$/i;
const FLYWAY = /^V\d[\w.]*__.+\.sql$|^R__.+\.sql$/i;
const isSql = (f: string): boolean => /\.sql$/i.test(f);
const baseOf = (f: string): string => f.slice(f.lastIndexOf('/') + 1);

/** Cheap filter: .sql files in a migration place, flyway-named, or whose text contains CREATE TABLE. No parsing. */
export function detectSqlFiles(repoRoot: string, repoFiles: string[]): string[] {
  return repoFiles.filter((f) => {
    if (!isSql(f) || UNDO_FILE.test(baseOf(f))) return false;
    const segs = f.split('/');
    if (segs.slice(0, -1).some((s) => MIGRATION_DIRS.has(s.toLowerCase())) || FLYWAY.test(baseOf(f))) return true;
    return /CREATE\s+(?:\w+\s+)*TABLE/i.test(fs.readFileSync(path.join(repoRoot, f), 'utf8'));
  });
}

interface OrderKey { dir: string; cls: number; nums: string[]; name: string }

function orderKey(file: string): OrderKey {
  const parts = file.split('/');
  const base = parts[parts.length - 1];
  // prisma/migrations/<name>/migration.sql : the folder is the migration
  const unit = base.toLowerCase() === 'migration.sql' && parts.length >= 3;
  const dir = parts.slice(0, unit ? -2 : -1).join('/');
  const name = (unit ? parts[parts.length - 2] : base).replace(/\.up\.sql$|\.sql$/i, '');
  const fw = /^V(\d+(?:[._]\d+)*)__/i.exec(name);
  if (fw) return { dir, cls: 0, nums: fw[1].split(/[._]/), name };
  if (/^R__/i.test(name)) return { dir, cls: 1, nums: [], name };
  const lead = /^\d+/.exec(name);
  if (lead) return { dir, cls: 0, nums: [lead[0]], name };
  return { dir, cls: 2, nums: [], name };
}

const cmpNum = (a: string, b: string): number => {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The order the migration tools apply files in. Per folder (a prisma migration folder counts as its parent):
 * versioned first - flyway V<n>[.<n>]__ versions and any name starting with digits (0001_x, 001-x, a 14-digit
 * timestamp) - compared number by number (so 2 < 10 and 0009 < 0010), then equal numbers by name; then flyway
 * repeatable R__ files by name; then names without a number by name. Folders are ordered by path.
 */
export function sortMigrationFiles(files: string[]): string[] {
  const keyed = files.map((f) => ({ f, k: orderKey(f) }));
  keyed.sort((a, b) => {
    if (a.k.dir !== b.k.dir) return a.k.dir < b.k.dir ? -1 : 1;
    if (a.k.cls !== b.k.cls) return a.k.cls - b.k.cls;
    for (let i = 0; i < Math.max(a.k.nums.length, b.k.nums.length); i++) {
      const x = a.k.nums[i];
      const y = b.k.nums[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const c = cmpNum(x, y);
      if (c !== 0) return c;
    }
    if (a.k.name !== b.k.name) return a.k.name < b.k.name ? -1 : 1;
    return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
  });
  return keyed.map((x) => x.f);
}

// ---------------------------------------------------------------- state

interface Con { name: string; kind: 'pk' | 'unique' | 'fk' | 'check'; cols: string[] }
interface Tbl { rec: RecordType; schema: string; cons: Con[] }
interface Ctx { file: string; text: string; state: State }
interface State { tables: Map<string, Tbl>; enums: Map<string, string[]>; unsupported: UnsupportedFile[] }

const tKey = (schema: string | undefined, name: string): string => `${schema ?? 'public'}.${name}`;
const isW = (t: Tok | undefined, ...words: string[]): boolean => t !== undefined && t.k === 'w' && words.includes(t.up);
const isP = (t: Tok | undefined, c: string): boolean => t !== undefined && t.k === 'p' && t.v === c;
const ident = (t: Tok): string => (t.k === 'q' ? t.v : t.v.toLowerCase());
const isIdent = (t: Tok | undefined): t is Tok => t !== undefined && (t.k === 'w' || t.k === 'q');
const src = (c: Ctx, toks: Tok[]): string => (toks.length === 0 ? '' : c.text.slice(toks[0].start, toks[toks.length - 1].end).replace(/\s+/g, ' ').trim());

/** Index of the ')' that closes the '(' at toks[open]; toks.length when none. */
function closeParen(toks: Tok[], open: number): number {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    if (isP(toks[i], '(')) d++;
    else if (isP(toks[i], ')') && --d === 0) return i;
  }
  return toks.length;
}

/** Split at depth-0 commas. */
function splitTop(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let d = 0;
  for (const t of toks) {
    if (isP(t, '(')) d++;
    else if (isP(t, ')')) d--;
    if (d === 0 && isP(t, ',')) { out.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** [schema.]name at toks[i]; next = index after it. */
function qname(toks: Tok[], i: number): { schema?: string; name: string; next: number } | null {
  if (!isIdent(toks[i])) return null;
  let schema: string | undefined;
  let name = ident(toks[i]);
  let j = i + 1;
  while (isP(toks[j], '.') && isIdent(toks[j + 1])) { schema = name; name = ident(toks[j + 1]); j += 2; }
  return { schema, name, next: j };
}

const unsup = (c: Ctx, line: number, statement: string, reason?: string): void => {
  c.state.unsupported.push({ file: c.file, dialect: 'sql', line, statement, ...(reason !== undefined ? { reason } : {}) });
};
const head = (toks: Tok[]): string => {
  const w: string[] = [];
  for (const t of toks) { if (t.k !== 'w' || w.length >= 4) break; w.push(t.up); }
  return (w[1] === 'OR' ? w : w.slice(0, 2)).join(' ');
};

const findTable = (c: Ctx, schema: string | undefined, name: string): Tbl | undefined => c.state.tables.get(tKey(schema, name));

// ---------------------------------------------------------------- constraints on a table

const fieldOf = (t: Tbl, col: string): Field | undefined => t.rec.fields.find((f) => f.name === col);
const addCon = (t: Tbl, con: Con): void => { t.cons = t.cons.filter((x) => x.name !== con.name); t.cons.push(con); };

function setPk(t: Tbl, cols: string[], name: string): void {
  for (const f of t.rec.fields) if (t.rec.primaryKey.includes(f.name)) f.pk = false;
  t.rec.primaryKey = cols;
  for (const col of cols) { const f = fieldOf(t, col); if (f) { f.pk = true; f.nullable = false; } }
  t.cons = t.cons.filter((x) => x.kind !== 'pk');
  addCon(t, { name, kind: 'pk', cols });
}

function addUnique(t: Tbl, cols: string[], name: string): void {
  const f = cols.length === 1 ? fieldOf(t, cols[0]) : undefined;
  if (f) f.unique = true;
  else t.rec.indexes.push({ name, unique: true, columns: cols, where: null });
  addCon(t, { name, kind: 'unique', cols });
}

interface Ref { table: string; cols: string[]; onDelete: string | null }

function addFk(t: Tbl, cols: string[], ref: Ref, name: string): void {
  cols.forEach((col, i) => {
    const f = fieldOf(t, col);
    // pairwise for a composite key; a missing target column list is resolved at the end (resolveRefs)
    if (f) f.fk = { table: ref.table, column: ref.cols[i] ?? '', onDelete: ref.onDelete };
  });
  addCon(t, { name, kind: 'fk', cols });
}

function addCheck(t: Tbl, name: string, expr: string, exprToks: Tok[]): void {
  const cols = t.rec.fields.map((f) => f.name).filter((n) => exprToks.some((x) => (x.k === 'w' || x.k === 'q') && ident(x) === n));
  t.rec.checks.push({ name, expr });
  addCon(t, { name, kind: 'check', cols });
}

function dropCon(t: Tbl, name: string): boolean {
  const con = t.cons.find((x) => x.name === name);
  if (!con) return false;
  t.cons = t.cons.filter((x) => x !== con);
  if (con.kind === 'pk') { for (const col of con.cols) { const f = fieldOf(t, col); if (f) f.pk = false; } t.rec.primaryKey = []; }
  else if (con.kind === 'unique') {
    const f = con.cols.length === 1 ? fieldOf(t, con.cols[0]) : undefined;
    if (f) f.unique = false;
    t.rec.indexes = t.rec.indexes.filter((x) => !(x.unique && x.name === name));
  } else if (con.kind === 'fk') { for (const col of con.cols) { const f = fieldOf(t, col); if (f) f.fk = null; } }
  else t.rec.checks = t.rec.checks.filter((x) => x.name !== name);
  return true;
}

// ---------------------------------------------------------------- column definitions

const TYPE_STOP = ['NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'GENERATED', 'COLLATE', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'ON', 'AS'];
const EXPR_STOP = TYPE_STOP.filter((w) => w !== 'AS');

/** Index after one expression starting at i: stops at a depth-0 attribute keyword (or end). */
function exprEnd(toks: Tok[], i: number, stop: string[]): number {
  let j = i;
  while (j < toks.length) {
    if (isP(toks[j], '(')) { j = closeParen(toks, j) + 1; continue; }
    if (j > i && isW(toks[j], ...stop)) break;
    j++;
  }
  return j;
}

/** REFERENCES t [(cols)] [ON DELETE x] [ON UPDATE y] [MATCH m] [[NOT] DEFERRABLE] [INITIALLY z] at toks[i] (after the REFERENCES word). */
function parseRef(toks: Tok[], i: number): { ref: Ref; next: number } | null {
  const q = qname(toks, i);
  if (!q) return null;
  let j = q.next;
  const cols: string[] = [];
  if (isP(toks[j], '(')) {
    const e = closeParen(toks, j);
    for (const item of splitTop(toks.slice(j + 1, e))) if (isIdent(item[0])) cols.push(ident(item[0]));
    j = e + 1;
  }
  let onDelete: string | null = null;
  const action = (): string => {
    if (isW(toks[j], 'NO') && isW(toks[j + 1], 'ACTION')) { j += 2; return 'no action'; }
    if (isW(toks[j], 'SET') && isW(toks[j + 1], 'NULL', 'DEFAULT')) { const a = `set ${toks[j + 1].v.toLowerCase()}`; j += 2; return a; }
    const a = toks[j] ? toks[j].v.toLowerCase() : ''; j++; return a;
  };
  for (;;) {
    if (isW(toks[j], 'ON') && isW(toks[j + 1], 'DELETE')) { j += 2; onDelete = action(); }
    else if (isW(toks[j], 'ON') && isW(toks[j + 1], 'UPDATE')) { j += 2; action(); }
    else if (isW(toks[j], 'MATCH')) j += 2;
    else if (isW(toks[j], 'NOT') && isW(toks[j + 1], 'DEFERRABLE')) j += 2;
    else if (isW(toks[j], 'DEFERRABLE')) j++;
    else if (isW(toks[j], 'INITIALLY')) j += 2;
    else break;
  }
  return { ref: { table: q.name, cols, onDelete }, next: j };
}

/** One column definition (toks[0] is the column name); registers its inline constraints on t. */
function parseColumn(c: Ctx, t: Tbl, toks: Tok[]): Field | null {
  if (!isIdent(toks[0])) return null;
  const name = ident(toks[0]);
  let i = 1;
  const typeStart = i;
  while (i < toks.length && !isW(toks[i], ...TYPE_STOP)) i = isP(toks[i], '(') ? closeParen(toks, i) + 1 : i + 1;
  const typeToks = toks.slice(typeStart, i);
  // b613: a column added or redefined by a later file than the record's CREATE TABLE keeps that file (Field.file).
  const field: Field = { name, key: name, type: src(c, typeToks), nullable: true, pk: false, unique: false, default: null, values: null, fk: null, line: toks[0].line, ...(c.file !== t.rec.file ? { file: c.file } : {}) };
  if (isW(typeToks[0], 'ENUM') && isP(typeToks[1], '(')) field.values = typeToks.slice(2).filter((x) => x.k === 's').map((x) => x.v);
  putField(t, field);   // first: the constraints below set pk / unique / fk on the field in the table
  let conName: string | null = null;
  const take = (): string | null => { const n = conName; conName = null; return n; };
  while (i < toks.length) {
    const tk = toks[i];
    if (isW(tk, 'CONSTRAINT') && isIdent(toks[i + 1])) { conName = ident(toks[i + 1]); i += 2; }
    else if (isW(tk, 'NOT') && isW(toks[i + 1], 'NULL')) { field.nullable = false; i += 2; }
    else if (isW(tk, 'NULL')) i++;
    else if (isW(tk, 'DEFAULT')) {
      const e = isW(toks[i + 1], 'NULL') ? i + 2 : exprEnd(toks, i + 1, EXPR_STOP);
      field.default = src(c, toks.slice(i + 1, e));
      i = Math.max(e, i + 1);
    } else if (isW(tk, 'PRIMARY') && isW(toks[i + 1], 'KEY')) { setPk(t, [name], take() ?? `${t.rec.name}_pkey`); i += 2; }
    else if (isW(tk, 'UNIQUE')) { addUnique(t, [name], take() ?? `${t.rec.name}_${name}_key`); i += isW(toks[i + 1], 'KEY') ? 2 : 1; }
    else if (isW(tk, 'REFERENCES')) {
      const r = parseRef(toks, i + 1);
      if (!r) { unsup(c, tk.line, `column ${name}`, 'REFERENCES not read'); i++; continue; }
      field.fk = { table: r.ref.table, column: r.ref.cols[0] ?? '', onDelete: r.ref.onDelete };
      addCon(t, { name: take() ?? `${t.rec.name}_${name}_fkey`, kind: 'fk', cols: [name] });
      i = r.next;
    } else if (isW(tk, 'CHECK') && isP(toks[i + 1], '(')) {
      const e = closeParen(toks, i + 1);
      addCheck(t, take() ?? `${t.rec.name}_${name}_check`, src(c, toks.slice(i + 2, e)), toks.slice(i + 2, e));
      i = e + 1;
    } else if (isW(tk, 'GENERATED') || isW(tk, 'AS')) {
      const e = exprEnd(toks, i + 1, EXPR_STOP);
      field.default = src(c, toks.slice(i, e));
      i = e;
    } else if (isW(tk, 'AUTO_INCREMENT', 'AUTOINCREMENT')) { field.default = tk.up; i++; }
    else if (isW(tk, 'COLLATE', 'COMMENT')) i += 2;
    else if (isW(tk, 'ON') && isW(toks[i + 1], 'UPDATE')) i = exprEnd(toks, i + 2, EXPR_STOP);
    else i++;
  }
  return field;
}

/** Put a parsed column into t: replace one of the same name, or append. */
function putField(t: Tbl, f: Field): void {
  const at = t.rec.fields.findIndex((x) => x.name === f.name);
  if (at >= 0) t.rec.fields[at] = f; else t.rec.fields.push(f);
}

// ---------------------------------------------------------------- table-level constraints

/** Column names of a "(a, b DESC, c(10))" list at toks[open]; an item that is not a plain column is skipped. */
function colList(toks: Tok[], open: number): { cols: string[]; next: number } {
  const e = closeParen(toks, open);
  const cols: string[] = [];
  for (const item of splitTop(toks.slice(open + 1, e))) if (isIdent(item[0])) cols.push(ident(item[0]));
  return { cols, next: e + 1 };
}

/** [CONSTRAINT n] PRIMARY KEY | UNIQUE | FOREIGN KEY | CHECK, or a MySQL [UNIQUE] KEY|INDEX n (cols). Returns false when not understood. */
function tableConstraint(c: Ctx, t: Tbl, toks: Tok[]): boolean {
  let i = 0;
  let name: string | null = null;
  if (isW(toks[0], 'CONSTRAINT') && isIdent(toks[1])) { name = ident(toks[1]); i = 2; }
  const w = toks[i];
  if (isW(w, 'PRIMARY') && isW(toks[i + 1], 'KEY') && isP(toks[i + 2], '(')) { setPk(t, colList(toks, i + 2).cols, name ?? `${t.rec.name}_pkey`); return true; }
  if (isW(w, 'UNIQUE') || (isW(w, 'KEY', 'INDEX') && name === null)) {
    const unique = isW(w, 'UNIQUE');
    let j = i + 1;
    if (unique && isW(toks[j], 'KEY', 'INDEX')) j++;
    let idx: string | null = null;
    if (unique && isW(toks[j], 'NULLS') && isW(toks[j + 1], 'NOT')) j += 3;   // NULLS NOT DISTINCT
    if (isIdent(toks[j])) { idx = ident(toks[j]); j++; }
    if (!isP(toks[j], '(')) return false;
    const { cols } = colList(toks, j);
    if (unique) addUnique(t, cols, name ?? idx ?? `${t.rec.name}_${cols.join('_')}_key`);
    else t.rec.indexes.push({ name: idx ?? `${t.rec.name}_${cols.join('_')}_idx`, unique: false, columns: cols, where: null });
    return true;
  }
  if (isW(w, 'FOREIGN') && isW(toks[i + 1], 'KEY')) {
    let j = i + 2;
    if (isIdent(toks[j])) j++;   // MySQL: FOREIGN KEY name (cols)
    if (!isP(toks[j], '(')) return false;
    const { cols, next } = colList(toks, j);
    if (!isW(toks[next], 'REFERENCES')) return false;
    const r = parseRef(toks, next + 1);
    if (!r) return false;
    addFk(t, cols, r.ref, name ?? `${t.rec.name}_${cols.join('_')}_fkey`);
    return true;
  }
  if (isW(w, 'CHECK') && isP(toks[i + 1], '(')) {
    const e = closeParen(toks, i + 1);
    const n = name ?? (t.rec.checks.some((x) => x.name === `${t.rec.name}_check`) ? `${t.rec.name}_check${t.rec.checks.length}` : `${t.rec.name}_check`);
    addCheck(t, n, src(c, toks.slice(i + 2, e)), toks.slice(i + 2, e));
    return true;
  }
  return false;
}

/** True when a CREATE TABLE element (or ALTER ... ADD action) is a table constraint or MySQL index, not a column. */
function isTableConstraint(el: Tok[]): boolean {
  const [a, b, c] = el;
  if (isW(a, 'CONSTRAINT', 'FULLTEXT', 'SPATIAL')) return true;
  if (isW(a, 'PRIMARY', 'FOREIGN')) return isW(b, 'KEY');
  if (isW(a, 'CHECK')) return isP(b, '(');
  if (isW(a, 'EXCLUDE')) return isW(b, 'USING') || isP(b, '(');
  if (isW(a, 'UNIQUE', 'KEY', 'INDEX')) return isP(b, '(') || isW(b, 'KEY', 'INDEX', 'NULLS') || (isIdent(b) && isP(c, '('));
  return false;
}

// ---------------------------------------------------------------- statements

function createTable(c: Ctx, st: Statement, i0: number): void {
  const toks = st.toks;
  let i = i0;
  if (isW(toks[i], 'IF') && isW(toks[i + 1], 'NOT') && isW(toks[i + 2], 'EXISTS')) i += 3;
  const ifNotExists = i > i0;
  const q = qname(toks, i);
  if (q && ifNotExists && findTable(c, q.schema, q.name)) return;
  if (!q || !isP(toks[q.next], '(')) { unsup(c, st.line, 'CREATE TABLE', 'not a column list (AS SELECT, PARTITION OF, ...)'); return; }
  if (isW(toks[q.next + 1], 'LIKE')) { unsup(c, st.line, 'CREATE TABLE', 'LIKE not read'); return; }
  const rec: RecordType = { name: q.name, key: q.name, file: c.file, line: st.line, endLine: st.endLine, fields: [], primaryKey: [], indexes: [], checks: [] };
  if (q.schema !== undefined && q.schema !== 'public') rec.schema = q.schema;
  const t: Tbl = { rec, schema: q.schema ?? 'public', cons: [] };
  const open = q.next;
  const close = closeParen(st.toks, open);
  for (const el of splitTop(toks.slice(open + 1, close))) {
    if (isTableConstraint(el)) {
      if (!tableConstraint(c, t, el)) unsup(c, el[0].line, `CREATE TABLE ${q.name}`, `table element not read: ${src(c, el).slice(0, 60)}`);
    } else {
      const f = parseColumn(c, t, el);
      if (!f) unsup(c, el[0].line, `CREATE TABLE ${q.name}`, 'column not read');
    }
  }
  // inline PRIMARY KEY on several columns would be invalid SQL; a table-level pk already set primaryKey.
  c.state.tables.set(tKey(q.schema, q.name), t);
}

function indexItems(c: Ctx, toks: Tok[]): string[] {
  return splitTop(toks).map((item) => {
    const plain = item.length === 1 || isW(item[1], 'ASC', 'DESC', 'NULLS', 'COLLATE') || (item.length === 2 && item[1].k === 'w') || (isP(item[1], '(') && item.length === 4 && item[2].k === 'n');
    if (plain && isIdent(item[0])) return ident(item[0]);
    // expression: one wrapping pair of parens goes, lower(email) stays as written
    const inner = isP(item[0], '(') && closeParen(item, 0) === item.length - 1 ? item.slice(1, -1) : item;
    return src(c, inner);
  });
}

function createIndex(c: Ctx, st: Statement, i0: number, unique: boolean): void {
  const toks = st.toks;
  let i = i0;
  if (isW(toks[i], 'CONCURRENTLY')) i++;
  if (isW(toks[i], 'IF') && isW(toks[i + 1], 'NOT') && isW(toks[i + 2], 'EXISTS')) i += 3;
  let name: string | null = null;
  if (!isW(toks[i], 'ON')) { const q = qname(toks, i); if (!q) { unsup(c, st.line, 'CREATE INDEX', 'name not read'); return; } name = q.name; i = q.next; }
  if (!isW(toks[i], 'ON')) { unsup(c, st.line, 'CREATE INDEX', 'ON not found'); return; }
  i++;
  if (isW(toks[i], 'ONLY')) i++;
  const q = qname(toks, i);
  if (!q) { unsup(c, st.line, 'CREATE INDEX', 'table not read'); return; }
  const t = findTable(c, q.schema, q.name);
  if (!t) { unsup(c, st.line, `CREATE INDEX ${name ?? ''}`.trim(), `table ${q.name} not found`); return; }
  i = q.next;
  if (isW(toks[i], 'USING')) i += 2;
  if (!isP(toks[i], '(')) { unsup(c, st.line, `CREATE INDEX ${name ?? ''}`.trim(), 'column list not found'); return; }
  const e = closeParen(toks, i);
  const columns = indexItems(c, toks.slice(i + 1, e));
  let where: string | null = null;
  const w = toks.findIndex((x, k) => k > e && isW(x, 'WHERE'));
  if (w >= 0) where = src(c, toks.slice(w + 1));
  t.rec.indexes.push({ name: name ?? `${q.name}_${columns.join('_')}_idx`, unique, columns, where });
}

function dropIndex(c: Ctx, st: Statement, i0: number): void {
  const toks = st.toks;
  let i = i0;
  if (isW(toks[i], 'CONCURRENTLY')) i++;
  const ifExists = isW(toks[i], 'IF') && isW(toks[i + 1], 'EXISTS');
  if (ifExists) i += 2;
  const onIdx = toks.findIndex((x, k) => k >= i && isW(x, 'ON'));   // MySQL: DROP INDEX name ON table
  const names = splitTop(toks.slice(i, onIdx >= 0 ? onIdx : undefined)).map((x) => qname(x, 0)).filter((x): x is NonNullable<typeof x> => x !== null);
  for (const n of names) {
    let found = false;
    for (const t of c.state.tables.values()) {
      const before = t.rec.indexes.length;
      t.rec.indexes = t.rec.indexes.filter((x) => x.name !== n.name);
      if (t.rec.indexes.length !== before) found = true;
    }
    if (!found && !ifExists) unsup(c, st.line, 'DROP INDEX', `index ${n.name} not found`);
  }
}

function dropTable(c: Ctx, st: Statement, i0: number): void {
  let i = i0;
  const toks = st.toks;
  if (isW(toks[i], 'IF') && isW(toks[i + 1], 'EXISTS')) i += 2;
  const ifExists = i > i0;
  for (const item of splitTop(toks.slice(i))) {
    const q = qname(item, 0);
    if (!q) continue;
    if (!c.state.tables.delete(tKey(q.schema, q.name))) { if (!ifExists) unsup(c, st.line, 'DROP TABLE', `table ${q.name} not found`); continue; }
    for (const t of c.state.tables.values()) {
      for (const f of t.rec.fields) if (f.fk?.table === q.name) f.fk = null;
      t.cons = t.cons.filter((x) => !(x.kind === 'fk' && x.cols.every((col) => fieldOf(t, col)?.fk === null)));
    }
  }
}

/** Rename a column everywhere it is mentioned. */
function renameColumn(c: Ctx, t: Tbl, from: string, to: string): void {
  const f = fieldOf(t, from);
  if (!f) return;
  f.name = to; f.key = to;
  const swap = (a: string[]): string[] => a.map((x) => (x === from ? to : x));
  t.rec.primaryKey = swap(t.rec.primaryKey);
  for (const ix of t.rec.indexes) ix.columns = swap(ix.columns);
  for (const con of t.cons) con.cols = swap(con.cols);
  for (const o of c.state.tables.values()) for (const g of o.rec.fields) if (g.fk && g.fk.table === t.rec.name && g.fk.column === from) g.fk = { ...g.fk, column: to };
}

function dropColumn(t: Tbl, col: string): boolean {
  if (!fieldOf(t, col)) return false;
  t.rec.fields = t.rec.fields.filter((f) => f.name !== col);
  t.rec.primaryKey = t.rec.primaryKey.includes(col) ? [] : t.rec.primaryKey;
  t.rec.indexes = t.rec.indexes.filter((x) => !x.columns.includes(col));
  const gone = t.cons.filter((x) => x.cols.includes(col));
  t.cons = t.cons.filter((x) => !x.cols.includes(col));
  for (const g of gone) if (g.kind === 'check') t.rec.checks = t.rec.checks.filter((x) => x.name !== g.name);
  return true;
}

const NOOP_ALTER = [['OWNER', 'TO'], ['ENABLE'], ['DISABLE'], ['FORCE'], ['NO', 'FORCE'], ['SET', 'TABLESPACE'], ['CLUSTER'], ['REPLICA'], ['SET', 'LOGGED'], ['SET', 'UNLOGGED']];

function alterTable(c: Ctx, st: Statement): void {
  const toks = st.toks;
  let i = 2;
  if (isW(toks[i], 'IF') && isW(toks[i + 1], 'EXISTS')) i += 2;
  if (isW(toks[i], 'ONLY')) i++;
  const q = qname(toks, i);
  if (!q) { unsup(c, st.line, 'ALTER TABLE', 'table name not read'); return; }
  const label = `ALTER TABLE ${q.name}`;
  const t = findTable(c, q.schema, q.name);
  const actions = splitTop(toks.slice(q.next));
  if (!t) {
    if (!actions.every((a) => NOOP_ALTER.some((n) => n.every((w, k) => isW(a[k], w))))) unsup(c, st.line, label, `table ${q.name} not found`);
    return;
  }
  const bad = (a: Tok[], why = 'action not read'): void => unsup(c, a[0].line, label, `${why}: ${src(c, a).slice(0, 60)}`);
  for (const a of actions) {
    const w = a[0];
    if (NOOP_ALTER.some((n) => n.every((x, k) => isW(a[k], x)))) continue;
    if (isW(w, 'ADD')) {
      let j = 1;
      const explicitCol = isW(a[j], 'COLUMN');
      if (explicitCol) j++;
      if (isW(a[j], 'IF') && isW(a[j + 1], 'NOT') && isW(a[j + 2], 'EXISTS')) j += 3;
      const rest = a.slice(j);
      if (!explicitCol && isTableConstraint(rest)) {
        if (!tableConstraint(c, t, rest)) bad(a);
      } else {
        const f = parseColumn(c, t, rest);
        if (!f) bad(a);
      }
    } else if (isW(w, 'DROP')) {
      let j = 1;
      const kind = isW(a[j], 'COLUMN', 'CONSTRAINT', 'INDEX', 'KEY') ? a[j].up : 'COLUMN';
      if (isW(a[j], 'COLUMN', 'CONSTRAINT', 'INDEX', 'KEY')) j++;
      if (isW(a[j], 'IF') && isW(a[j + 1], 'EXISTS')) j += 2;
      if (isW(a[j], 'PRIMARY') && isW(a[j + 1], 'KEY')) { const pk = t.cons.find((x) => x.kind === 'pk'); if (pk) dropCon(t, pk.name); continue; }
      if (!isIdent(a[j])) { bad(a); continue; }
      const n = ident(a[j]);
      if (kind === 'COLUMN') { if (!dropColumn(t, n)) bad(a, `column ${n} not found`); }
      else if (kind === 'CONSTRAINT') { if (!dropCon(t, n)) bad(a, `constraint ${n} not found`); }
      else { const b = t.rec.indexes.length; t.rec.indexes = t.rec.indexes.filter((x) => x.name !== n); if (b === t.rec.indexes.length) bad(a, `index ${n} not found`); }
    } else if (isW(w, 'RENAME')) {
      let j = 1;
      if (isW(a[j], 'TO', 'AS')) {
        if (!isIdent(a[j + 1])) { bad(a); continue; }
        const to = ident(a[j + 1]);
        const oldName = t.rec.name;
        c.state.tables.delete(tKey(q.schema, oldName));
        t.rec.name = to; t.rec.key = to;
        c.state.tables.set(tKey(q.schema, to), t);
        for (const o of c.state.tables.values()) for (const g of o.rec.fields) if (g.fk?.table === oldName) g.fk = { ...g.fk, table: to };
        continue;
      }
      const isCon = isW(a[j], 'CONSTRAINT');
      if (isW(a[j], 'COLUMN', 'CONSTRAINT')) j++;
      if (!(isIdent(a[j]) && isW(a[j + 1], 'TO') && isIdent(a[j + 2]))) { bad(a); continue; }
      const from = ident(a[j]);
      const to = ident(a[j + 2]);
      if (isCon) { const con = t.cons.find((x) => x.name === from); if (con) con.name = to; else bad(a, `constraint ${from} not found`); } else if (!fieldOf(t, from)) bad(a, `column ${from} not found`);
      else renameColumn(c, t, from, to);
    } else if (isW(w, 'ALTER')) {
      let j = 1;
      if (isW(a[j], 'COLUMN')) j++;
      const f = isIdent(a[j]) ? fieldOf(t, ident(a[j])) : undefined;
      if (!f) { bad(a, 'column not found'); continue; }
      j++;
      if (isW(a[j], 'SET') && isW(a[j + 1], 'NOT') && isW(a[j + 2], 'NULL')) f.nullable = false;
      else if (isW(a[j], 'DROP') && isW(a[j + 1], 'NOT') && isW(a[j + 2], 'NULL')) f.nullable = !f.pk;
      else if (isW(a[j], 'SET') && isW(a[j + 1], 'DEFAULT')) f.default = src(c, a.slice(j + 2));
      else if (isW(a[j], 'DROP') && isW(a[j + 1], 'DEFAULT')) f.default = null;
      else if (isW(a[j], 'TYPE') || (isW(a[j], 'SET') && isW(a[j + 1], 'DATA') && isW(a[j + 2], 'TYPE'))) {
        const s = j + (isW(a[j], 'TYPE') ? 1 : 3);
        const e = a.findIndex((x, k) => k >= s && isW(x, 'USING', 'COLLATE'));
        f.type = src(c, a.slice(s, e < 0 ? undefined : e));
        f.values = null;
      } else bad(a);
    } else if (isW(w, 'MODIFY') || isW(w, 'CHANGE')) {
      let j = 1;
      if (isW(a[j], 'COLUMN')) j++;
      const change = isW(w, 'CHANGE');
      if (change && !isIdent(a[j])) { bad(a); continue; }
      const oldName = change ? ident(a[j]) : null;
      const rest = a.slice(change ? j + 1 : j);
      const f0 = fieldOf(t, oldName ?? (isIdent(rest[0]) ? ident(rest[0]) : ''));
      if (!f0) { bad(a, 'column not found'); continue; }
      const old = { ...f0 };
      if (oldName !== null && isIdent(rest[0]) && oldName !== ident(rest[0])) renameColumn(c, t, oldName, ident(rest[0]));
      const f = parseColumn(c, t, rest);   // replaces the field of that name
      if (!f) { bad(a); continue; }
      f.pk = old.pk || f.pk; f.unique = old.unique || f.unique; f.fk = f.fk ?? old.fk;
      if (f.pk) f.nullable = false;
    } else bad(a);
  }
}

function createType(c: Ctx, st: Statement, i0: number): void {
  const q = qname(st.toks, i0);
  if (q && isW(st.toks[q.next], 'AS') && isW(st.toks[q.next + 1], 'ENUM')) {
    c.state.enums.set(q.name, st.toks.slice(q.next + 2).filter((x) => x.k === 's').map((x) => x.v));
  } else unsup(c, st.line, 'CREATE TYPE', 'only AS ENUM is read');
}

function alterType(c: Ctx, st: Statement): void {
  const q = qname(st.toks, 2);
  const vals = q ? c.state.enums.get(q.name) : undefined;
  if (!q || !vals) { unsup(c, st.line, 'ALTER TYPE', `type ${q?.name ?? ''} not found`); return; }
  const a = st.toks.slice(q.next);
  if (isW(a[0], 'ADD') && isW(a[1], 'VALUE')) {
    let j = 2;
    if (isW(a[j], 'IF') && isW(a[j + 1], 'NOT') && isW(a[j + 2], 'EXISTS')) j += 3;
    const v = a[j];
    if (!v || v.k !== 's') { unsup(c, st.line, 'ALTER TYPE', 'ADD VALUE not read'); return; }
    if (vals.includes(v.v)) return;
    const rel = a[j + 2];
    const at = isW(a[j + 1], 'BEFORE', 'AFTER') && rel ? vals.indexOf(rel.v) : -1;
    if (at < 0) vals.push(v.v); else vals.splice(isW(a[j + 1], 'BEFORE') ? at : at + 1, 0, v.v);
  } else if (isW(a[0], 'RENAME') && isW(a[1], 'TO') && isIdent(a[2])) {
    c.state.enums.delete(q.name);
    c.state.enums.set(ident(a[2]), vals);
  } else unsup(c, st.line, 'ALTER TYPE', `action not read: ${src(c, a).slice(0, 60)}`);
}

const IGNORED_HEADS = ['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SET', 'RESET', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'GRANT', 'REVOKE', 'COMMENT', 'USE', 'PRAGMA', 'ANALYZE', 'VACUUM', 'LOCK', 'TRUNCATE', 'WITH', 'COPY', 'REINDEX', 'REFRESH', 'NOTIFY', 'SAVEPOINT', 'RELEASE', 'DELIMITER'];
const IGNORED_OBJECTS = ['EXTENSION', 'SCHEMA'];

function apply(c: Ctx, st: Statement): void {
  const toks = st.toks;
  const w0 = toks[0];
  if (w0.k !== 'w') { unsup(c, st.line, head(toks) || 'statement', 'not a SQL statement'); return; }
  if (IGNORED_HEADS.includes(w0.up)) return;
  if (w0.up === 'CREATE') {
    let i = 1;
    if (isW(toks[i], 'OR') && isW(toks[i + 1], 'REPLACE')) i += 2;
    while (isW(toks[i], 'TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL')) i++;
    const unique = isW(toks[i], 'UNIQUE');
    if (unique) i++;
    const obj = toks[i];
    if (isW(obj, 'TABLE') && !unique) return createTable(c, st, i + 1);
    if (isW(obj, 'INDEX')) return createIndex(c, st, i + 1, unique);
    if (isW(obj, 'TYPE') && !unique) return createType(c, st, i + 1);
    if (isW(obj, ...IGNORED_OBJECTS)) return;
    return unsup(c, st.line, head(toks), 'not read');
  }
  if (w0.up === 'ALTER') {
    if (isW(toks[1], 'TABLE')) return alterTable(c, st);
    if (isW(toks[1], 'TYPE')) return alterType(c, st);
    if (isW(toks[1], ...IGNORED_OBJECTS) || (isW(toks[1], 'DEFAULT') && isW(toks[2], 'PRIVILEGES'))) return;
    if (toks.some((x, k) => isW(x, 'OWNER') && isW(toks[k + 1], 'TO'))) return;
    return unsup(c, st.line, head(toks), 'not read');
  }
  if (w0.up === 'DROP') {
    let i = 1;
    if (isW(toks[i], 'TEMP', 'TEMPORARY')) i++;
    if (isW(toks[i], 'TABLE')) return dropTable(c, st, i + 1);
    if (isW(toks[i], 'INDEX')) return dropIndex(c, st, i + 1);
    if (isW(toks[i], 'TYPE')) {
      let j = i + 1;
      if (isW(toks[j], 'IF') && isW(toks[j + 1], 'EXISTS')) j += 2;
      for (const item of splitTop(toks.slice(j))) { const q = qname(item, 0); if (q) c.state.enums.delete(q.name); }
      return;
    }
    if (isW(toks[i], ...IGNORED_OBJECTS)) return;
    return unsup(c, st.line, head(toks), 'not read');
  }
  unsup(c, st.line, head(toks), 'not read');
}

// ---------------------------------------------------------------- finish

/** Fill enum values and the target column of REFERENCES t without a column list. */
function finish(state: State): void {
  for (const t of state.tables.values()) {
    for (const f of t.rec.fields) {
      const base = f.type.replace(/\[\d*\]/g, '').replace(/"/g, '').split('.').pop()!.trim();
      const vals = state.enums.get(base) ?? state.enums.get(base.toLowerCase());
      if (vals && f.values === null) f.values = [...vals];
      if (f.fk && f.fk.column === '') {
        const target = [...state.tables.values()].find((o) => o.rec.name === f.fk!.table);
        if (target && target.rec.primaryKey.length === 1) f.fk = { ...f.fk, column: target.rec.primaryKey[0] };
        else {
          const at = fieldLocation(t.rec, f);
          state.unsupported.push({ file: at.file, dialect: 'sql', line: at.line, statement: `${t.rec.name}.${f.name}`, reason: `REFERENCES ${f.fk.table} without a column list and no single-column primary key to use` });
        }
      }
    }
  }
}

/** Pure core: files (repo-relative names with their text) in the order given -> final schema. */
export function applySqlFiles(files: { file: string; text: string }[]): SchemaModel {
  const state: State = { tables: new Map(), enums: new Map(), unsupported: [] };
  for (const { file, text } of files) {
    const c: Ctx = { file, text, state };
    for (const st of splitStatements(tokenize(text))) {
      try {
        apply(c, st);
      } catch (err) {
        // a bug in this parser must not hide the rest of the history; the statement is reported, not dropped
        unsup(c, st.line, head(st.toks) || 'statement', `parser error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  finish(state);
  return { records: [...state.tables.values()].map((t) => t.rec), unsupported: state.unsupported };
}

/** Read the files (repo-relative), order them (sortMigrationFiles), apply them. Throws when a file cannot be read. */
export function readSqlSchema(repoRoot: string, files: string[]): SchemaModel {
  return applySqlFiles(sortMigrationFiles(files).map((file) => ({ file, text: fs.readFileSync(path.join(repoRoot, file), 'utf8') })));
}
