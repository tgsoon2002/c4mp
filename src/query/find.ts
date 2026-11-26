import * as fs from 'fs';
import * as path from 'path';
import type { CodeElement, ElementKind, StubKind } from '../types';
import { fieldLocation } from '../schema/types';
import type { RecordType } from '../schema/types';
import { splitLines } from '../util/text';
import { QueryError } from './errors';
import { fileOf, queryBaseOf } from './context';
import type { QueryBase, QueryContext } from './context';
import { readStructureFile } from './show';
import type { StructureFile } from './show';
import type { StructureKind, StructureNode } from '../structure';
import { ownerOf, ownerOfPath } from './owner';
import type { OwnerRef } from './owner';
import { recordsOf } from './storage';

/**
 * Every code element kind ('type': interface, type alias, enum, trait, protocol; 'test': a test case), a file whose
 * path matched, and 'record' (STOR-4): a record (table) a storage reader finds behind a plan store.
 */
export type RowKind = ElementKind | 'file' | 'record';

/** The kinds `find --kind` takes, in this order: the CLI option text and the MCP `find` enum are built from it (b681). */
export const ROW_KINDS: readonly RowKind[] = ['function', 'class', 'method', 'type', 'test', 'file', 'record'];
export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 100;

/** One find hit: a code element, or (kind 'file') a file whose path matched. */
export interface Row {
  path: string;
  name: string;
  kind: RowKind;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  stub?: StubKind;
  fileOnly?: true;
  owner: OwnerRef;
}

export interface FindResult {
  results: Row[];
  total: number;
  truncated: boolean;
}

export interface OutlineElement {
  name: string;
  /** 'record' / 'field' (STOR-4): a record and its fields in a file the scan does not walk (a .sql migration). */
  /** b683: 'key', 'heading', a plan kind or 'test' in a .json, .md or .c4 file. */
  kind: ElementKind | 'record' | 'field' | StructureKind;
  startLine: number;
  endLine: number;
  lineCount: number;
  stub?: StubKind;
  owner: OwnerRef;
  children?: OutlineElement[];
}

export interface FileOutlineResult {
  path: string;
  lineCount: number;
  parseError: boolean;
  fileOnly?: true;
  elements: OutlineElement[];
}

/** 0 exact, 1 exact last segment, 2 prefix, 3 substring; -1 no match. `q` is already lower-case. */
function rankOf(text: string, q: string, sep: string): number {
  const t = text.toLowerCase();
  if (!t.includes(q)) return -1;
  if (t === q) return 0;
  if (t.slice(t.lastIndexOf(sep) + 1) === q) return 1;
  if (t.startsWith(q)) return 2;
  return 3;
}

interface Candidate {
  rank: number;
  file: string;
  startLine: number;
  element?: CodeElement;
  record?: RecordType;
  fileOnly: boolean;
  /** b580: a test file (role 'test', config `tests.globs`) or a test case; sorts after source within one rank. */
  test: boolean;
}

/**
 * Case-insensitive substring search over element names (already `Class.method`) and file paths.
 * A path match is a `kind:'file'` row. Code types (kind 'type') and test cases (kind 'test') are elements like the others.
 * STOR-4: also the records of the plan stores (recordsOf), as `kind:'record'` rows, ranked by name like elements.
 * Order: exact name > exact last `.` segment > prefix > substring, then source before test files (b580: role 'test' from
 * config `tests.globs`, or a test case), then path, then startLine.
 */
export function findElements(
  ctx: QueryContext,
  opts: { query: string; kind?: RowKind; limit?: number },
): FindResult {
  const query = (opts.query ?? '').trim();
  if (query === '') throw new QueryError('invalid', 'query must not be empty');
  if (opts.kind !== undefined && !ROW_KINDS.includes(opts.kind)) {
    throw new QueryError('invalid', `kind must be one of ${ROW_KINDS.join(', ')} (got '${String(opts.kind)}')`);
  }
  const limit = opts.limit ?? FIND_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > FIND_MAX_LIMIT) {
    throw new QueryError('invalid', `limit must be an integer from 1 to ${FIND_MAX_LIMIT} (got ${String(opts.limit)})`);
  }

  const q = query.toLowerCase();
  const found: Candidate[] = [];
  for (const f of ctx.snapshot.files) {
    const testFile = f.role === 'test';
    if (opts.kind === undefined || opts.kind === 'file') {
      const rank = rankOf(f.file, q, '/');
      if (rank >= 0) found.push({ rank, file: f.file, startLine: 0, fileOnly: f.fileOnly === true, test: testFile });
    }
    if (opts.kind === 'file') continue;
    for (const e of [...f.elements, ...(f.nested ?? [])]) {
      if (opts.kind !== undefined && e.kind !== opts.kind) continue;
      const rank = rankOf(e.name, q, '.');
      if (rank >= 0) {
        found.push({ rank, file: f.file, startLine: e.startLine, element: e, fileOnly: false, test: testFile || e.kind === 'test' });
      }
    }
  }
  if (opts.kind === undefined || opts.kind === 'record') {
    for (const rec of recordsOf(ctx)) {
      const rank = rankOf(rec.name, q, '.');
      if (rank >= 0) found.push({ rank, file: rec.file, startLine: rec.line, record: rec, fileOnly: false, test: false });
    }
  }

  found.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(a.test) - Number(b.test) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.startLine - b.startLine,
  );

  const results = found.slice(0, limit).map((c): Row => {
    const rec = c.record;
    if (rec) {
      return {
        path: rec.file,
        name: rec.name,
        kind: 'record',
        startLine: rec.line,
        endLine: rec.endLine,
        lineCount: rec.endLine - rec.line + 1,
        owner: ownerOfPath(ctx, rec.file),
      };
    }
    const e = c.element;
    if (!e) {
      return {
        path: c.file,
        name: c.file,
        kind: 'file',
        ...(c.fileOnly ? { fileOnly: true as const } : {}),
        owner: ownerOf(ctx, c.file),
      };
    }
    return {
      path: c.file,
      name: e.name,
      kind: e.kind as RowKind,
      startLine: e.startLine,
      endLine: e.endLine,
      lineCount: e.lineCount,
      ...(e.stub !== undefined ? { stub: e.stub } : {}),
      owner: ownerOf(ctx, c.file, e.name),
    };
  });

  return { results, total: found.length, truncated: found.length > results.length };
}

/**
 * Elements of one scanned file. Nesting: an element named `A.b` goes under the class element `A` of the
 * same file (first one if the name repeats); otherwise (`obj.m`, no class `obj`) it stays top-level.
 * Duplicates (Python property pair) are listed individually. STOR-4: a file the scan does not walk that holds records of
 * the plan stores (a .sql migration) lists its records, each with its fields; b613: only the fields written in that file
 * (fieldLocation), and a field a later migration adds to a record of another file is a top-level `record.field` row there.
 * Unknown or unscanned file without such records or fields: 'not-found'.
 * b683: a .json, .md or .c4 file lists its keys, headings or plan elements (names `a › b`), without the scan.
 */
export function outlineFile(on: QueryBase | QueryContext, filePath: string): FileOutlineResult {
  const base = queryBaseOf(on);
  // b683: a .json, .md or .c4 file lists its keys, headings or plan elements, without the scan.
  const structured = readStructureFile(base, path.posix.normalize(filePath), filePath);
  if (structured) return structureOutline(structured);
  const ctx = base.full();
  const f = fileOf(ctx, filePath);
  const records = f ? [] : recordsOf(ctx).filter((r) => r.file === filePath || r.fields.some((fl) => fieldLocation(r, fl).file === filePath));
  if (records.length > 0) return recordOutline(ctx, filePath, records);
  if (!f) {
    throw new QueryError(
      'not-found',
      `File '${filePath}' is not in the scan. Check the repo-relative path, that its folder is not ignored, ` +
        `that its extension belongs to a scanned language (or use --lang files), and that it is not a .d.ts file`,
    );
  }

  const toNode = (e: CodeElement): OutlineElement => ({
    name: e.name,
    kind: e.kind,
    startLine: e.startLine,
    endLine: e.endLine,
    lineCount: e.lineCount,
    ...(e.stub !== undefined ? { stub: e.stub } : {}),
    owner: ownerOf(ctx, f.file, e.name),
  });

  const nodes = f.elements.map((e) => ({ e, node: toNode(e) }));
  const classes = new Map<string, OutlineElement>();
  for (const { e, node } of nodes) {
    if (e.kind === 'class' && !classes.has(e.name)) classes.set(e.name, node);
  }

  const top: OutlineElement[] = [];
  for (const { e, node } of nodes) {
    const dot = e.name.indexOf('.');
    const parent = dot > 0 ? classes.get(e.name.slice(0, dot)) : undefined;
    if (parent && parent !== node) (parent.children ??= []).push(node);
    else top.push(node);
  }

  // b782: a nested function goes under the element or nested function it sits in (`parent`; parents sort first).
  const byName = new Map<string, OutlineElement>();
  for (const { node } of nodes) if (!byName.has(node.name)) byName.set(node.name, node);
  for (const n of f.nested ?? []) {
    const node = toNode(n);
    if (!byName.has(n.name)) byName.set(n.name, node);
    const parent = byName.get(n.parent);
    if (parent) (parent.children ??= []).push(node);
    else top.push(node);
  }

  return {
    path: f.file,
    lineCount: f.lineCount,
    parseError: f.parseError,
    ...(f.fileOnly ? { fileOnly: true as const } : {}),
    elements: top,
  };
}

/**
 * STOR-4 (b336): the outline of a file that only a storage reader reads: its records, each with the fields written in
 * this file as children; then (b613) the fields this file adds to records of other files, as `record.field` rows by line.
 */
function recordOutline(ctx: QueryContext, file: string, records: RecordType[]): FileOutlineResult {
  const owner = ownerOfPath(ctx, file);
  const lineCount = splitLines(fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8'), { keepEol: false }).length;
  const fieldRow = (name: string, line: number): OutlineElement => ({ name, kind: 'field', startLine: line, endLine: line, lineCount: 1, owner });
  const here = (rec: RecordType) => rec.fields.map((fl) => ({ fl, at: fieldLocation(rec, fl) })).filter((x) => x.at.file === file);
  const own = records.filter((rec) => rec.file === file).map((rec): OutlineElement => {
    const fields = here(rec);
    return {
      name: rec.name,
      kind: 'record',
      startLine: rec.line,
      endLine: rec.endLine,
      lineCount: rec.endLine - rec.line + 1,
      owner,
      ...(fields.length > 0 ? { children: fields.map((x) => fieldRow(x.fl.name, x.at.line)) } : {}),
    };
  });
  const added = records.filter((rec) => rec.file !== file)
    .flatMap((rec) => here(rec).map((x) => fieldRow(`${rec.name}.${x.fl.name}`, x.at.line)))
    .sort((a, b) => a.startLine - b.startLine);
  return { path: file, lineCount, parseError: false, elements: [...own, ...added] };
}

/** b683: outline rows of a structure file: every node with its full name, the file's owner on each row. */
function structureOutline(sf: StructureFile): FileOutlineResult {
  const toRow = (n: StructureNode): OutlineElement => ({
    name: n.name, kind: n.kind, startLine: n.startLine, endLine: n.endLine, lineCount: n.endLine - n.startLine + 1,
    owner: sf.owner, ...(n.children ? { children: n.children.map(toRow) } : {}),
  });
  return { path: sf.file, lineCount: sf.lines.length, parseError: sf.parseError, elements: sf.nodes.map(toRow) };
}

/** Alias of outlineFile (the task text calls it outlineOf; the plan row calls it outlineFile). */
export const outlineOf = outlineFile;
