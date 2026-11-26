import * as fs from 'fs';
import * as path from 'path';
import { parseLink } from '../plan/links';
import type { CodeElement, ElementKind, PlanLink, StubKind } from '../types';
import { findStructureNode, nameStructure, structureCandidates, structureReaderFor } from '../structure';
import type { StructureKind, StructureNode } from '../structure';
import { elementsOf, fileOf, queryBaseOf } from './context';
import type { QueryBase, QueryContext } from './context';
import { scanExtensions } from '../pipeline';
import { QueryError } from './errors';
import { explainOwner, ownerByPathClaims, ownerOf } from './owner';
import type { OwnerExplanation, OwnerRef } from './owner';
import { splitLines } from '../util/text';
import { codeElementTests } from './itemTests';
import type { ShownTestsReport } from './itemTests';

/** Decision 8: default and maximum number of lines `show` returns. */
export const SHOW_MAX_LINES = 400;

/** P15-T3: the source text a target points at. `code` has no line numbers; `code[0]` is line `startLine`. */
export interface ShowResult {
  path: string;
  targetKind: 'element' | 'file' | 'range';
  name?: string;
  /** b683: 'key', 'heading', a plan kind or 'test' for a structure file. */
  elementKind?: ElementKind | StructureKind;
  startLine: number;
  /** Last line returned (after clamping to the end of file and to maxLines). `startLine - 1` when `code` is empty. */
  endLine: number;
  /** Lines in the whole file (a trailing newline does not add an empty last line). */
  totalLines: number;
  owner: OwnerRef;
  /** Only for element targets: explainOwner needs a function name. */
  how?: OwnerExplanation;
  stub?: StubKind;
  code: string[];
  /** True when more lines of the target exist than were returned (maxLines). */
  truncated: boolean;
  /** T26-11: an element's tests (to run, to write, touching); absent for a file, a range or code off the map (a test case). */
  tests?: ShownTestsReport;
}

/**
 * Containment (Decision 7): the repo-relative `rel` must stay inside the repo both lexically and after
 * resolving symlinks. Returns the real absolute path to read. Also the code edit service's check (Phase 32 ED-2),
 * which has no query context: it needs only `repoRoot`.
 */
export function resolveInsideRepo(ctx: Pick<QueryContext, 'repoRoot'>, rel: string, target: string, lexicalOnly = false): string {
  const refuse = (): never => {
    throw new QueryError('out-of-repo', `Target '${target}' is outside the repository`);
  };
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) refuse();
  const root = fs.realpathSync(ctx.repoRoot);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) refuse();
  if (lexicalOnly) return abs;
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    throw new QueryError('scan-failed', `Cannot read '${rel}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!real.startsWith(root + path.sep)) refuse();
  return real;
}

/** b683: a .json, .md or .c4 file read with its structure reader, without the scan. */
export interface StructureFile {
  /** Repo-relative as asked (`../.c4pm/...` for a plan file outside the repo). */
  file: string;
  lines: string[];
  /** nameStructure output: full names `a › b`. */
  nodes: StructureNode[];
  parseError: boolean;
  owner: OwnerRef;
}

/**
 * b683: read `rel` with its structure reader; null when no reader takes its extension. A plan file (`plan.files`) is
 * read even outside the repo; any other path must be inside it (resolveInsideRepo). Missing file or folder: not-found.
 */
export function readStructureFile(base: QueryBase, rel: string, target: string): StructureFile | null {
  const reader = structureReaderFor(rel);
  if (!reader) return null;
  const view = base.planView();
  const planFile = (view.plan?.files ?? []).includes(rel);
  const abs = planFile ? path.resolve(base.repoRoot, rel) : resolveInsideRepo(base, rel, target, true);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new QueryError('not-found', `File '${rel}' does not exist`);
  const real = planFile ? abs : resolveInsideRepo(base, rel, target);
  let text: string;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch (err) {
    throw new QueryError('scan-failed', `Cannot read '${rel}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const read = reader(text, rel);
  return { file: rel, lines: splitLines(text, { keepEol: false }), nodes: nameStructure(read.nodes), parseError: read.parseError, owner: ownerByPathClaims(view, rel) };
}

/** A `#L<a>-L<b>` range, checked: invalid when it starts at 0 or after its end. */
function checkedRange(lines: { start: number; end: number }): { start: number; end: number } {
  if (lines.start < 1) throw new QueryError('invalid', `Line numbers start at 1, got L${lines.start}`);
  if (lines.start > lines.end) throw new QueryError('invalid', `Range starts after it ends: L${lines.start}-L${lines.end}`);
  return lines;
}

/** Lines start..end of a file (end clamped to the file and to `limit` lines); a range that starts past the end is invalid. */
function cutLines(lines: string[], file: string, isRange: boolean, start: number, end: number, limit: number): { code: string[]; truncated: boolean } {
  if (isRange && start > lines.length) throw new QueryError('invalid', `Range starts at line ${start} but '${file}' has ${lines.length} lines`);
  const lastWanted = Math.min(end, lines.length);
  const lastReturned = Math.min(lastWanted, start + limit - 1);
  return { code: lines.length === 0 ? [] : lines.slice(start - 1, lastReturned), truncated: lastReturned < lastWanted };
}

/** b683: showTarget for a structure file: the whole file, a #L range or the node named `link.name`. */
function showStructure(sf: StructureFile, link: PlanLink, limit: number): ShowResult {
  let targetKind: ShowResult['targetKind'] = 'file';
  let node: StructureNode | undefined;
  let start = 1;
  let end = Number.MAX_SAFE_INTEGER;
  if (link.lines) {
    targetKind = 'range';
    ({ start, end } = checkedRange(link.lines));
  } else if (link.name !== null) {
    node = findStructureNode(sf.nodes, link.name);
    if (!node) {
      throw new QueryError('not-found', `No key, heading or plan element '${link.name}' in '${sf.file}'`, structureCandidates(sf.nodes, link.name));
    }
    targetKind = 'element';
    start = node.startLine;
    end = node.endLine;
  }
  const { code, truncated } = cutLines(sf.lines, sf.file, targetKind === 'range', start, end, limit);
  return {
    path: sf.file, targetKind, ...(node ? { name: node.name, elementKind: node.kind } : {}),
    startLine: start, endLine: start + code.length - 1, totalLines: sf.lines.length, owner: sf.owner, code, truncated,
  };
}

/**
 * Show the source of `target`: `path`, `path#name`, `path#Class.method`, `path#L10`, `path#L10-L20`
 * (grammar of `parseLink`). A class range includes its methods. Only files of the scan are readable; b680: a file
 * whose extension the scan never walks is refused without running the scan (`full()`).
 * b683: a .json, .md or .c4 file shows its keys, headings or plan elements (`path#a › b`), also a plan file outside
 * the repo, without the scan.
 * Errors: invalid (bad target / maxLines / range), out-of-repo, not-found, ambiguous (candidates
 * `"<start>-<end>"`), scan-failed (unreadable file or file shorter than a recorded element: stale scan).
 */
export function showTarget(on: QueryBase | QueryContext, target: string, opts: { maxLines?: number } = {}): ShowResult {
  const base = queryBaseOf(on);
  const maxLines = opts.maxLines ?? SHOW_MAX_LINES;
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new QueryError('invalid', `maxLines must be a positive integer, got '${String(opts.maxLines)}'`);
  }
  const limit = Math.min(maxLines, SHOW_MAX_LINES);

  if (typeof target !== 'string' || target.trim() === '') throw new QueryError('invalid', 'Target is empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new QueryError('out-of-repo', `Target '${target}' is not a repository path`);
  }
  const hashIdx = target.indexOf('#');
  if ((hashIdx === -1 ? target : target.slice(0, hashIdx)).trim() === '') {
    throw new QueryError('invalid', `Target '${target}' has no file path (use find to locate a name)`);
  }

  const link = parseLink(target, '_.c4');
  // b683: a .json, .md or .c4 file answers from its structure reader, without the scan.
  const structured = readStructureFile(base, link.path, target);
  if (structured) return showStructure(structured, link, limit);
  const notInScan = (): never => {
    // Not in the scan: refuse anything that leaves the repo first, so those errors do not depend on the scan.
    resolveInsideRepo(base, link.path, target, true);
    throw new QueryError('not-found', `File '${link.path}' is not in the scan (ignored folder, unscanned extension or language, or not a source file)`);
  };
  // b680: the scan walks only scanExtensions, so a file with another extension is refused without the scan.
  if (!scanExtensions(base.config).includes(path.extname(link.path))) notInScan();
  const ctx = base.full();
  const file = fileOf(ctx, link.path) ?? notInScan();

  // What to show: [start, end] (1-based, inclusive; end may be beyond EOF until clamped).
  let targetKind: ShowResult['targetKind'] = 'file';
  let element: CodeElement | undefined;
  let start = 1;
  let end = Number.MAX_SAFE_INTEGER;
  if (link.lines) {
    targetKind = 'range';
    ({ start, end } = checkedRange(link.lines));
  } else if (link.name !== null) {
    const matches = elementsOf(ctx, file, link.name);
    if (matches.length === 0) throw new QueryError('not-found', `No function, class or method '${link.name}' in '${file.file}'`);
    if (matches.length > 1) {
      throw new QueryError(
        'ambiguous',
        `'${link.name}' appears ${matches.length} times in '${file.file}'; use #L<start>-L<end>`,
        matches.map((m) => `${m.startLine}-${m.endLine}`),
      );
    }
    element = matches[0];
    targetKind = 'element';
    start = element.startLine;
    end = element.endLine;
  }

  const real = resolveInsideRepo(ctx, file.file, target);
  let text: string;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch (err) {
    throw new QueryError('scan-failed', `Cannot read '${file.file}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = splitLines(text, { keepEol: false });
  const totalLines = lines.length;
  if (element && element.endLine > totalLines) {
    throw new QueryError('scan-failed', `'${file.file}' has ${totalLines} lines but '${element.name}' ends at line ${element.endLine} (file changed since the scan)`);
  }
  const { code, truncated } = cutLines(lines, file.file, targetKind === 'range', start, end, limit);

  const owner = ownerOf(ctx, file.file, element?.name);
  const tests = element ? codeElementTests(ctx, file.file, element.name) : null;
  return {
    path: file.file,
    targetKind,
    ...(element ? { name: element.name, elementKind: element.kind } : {}),
    startLine: start,
    endLine: start + code.length - 1,
    totalLines,
    owner,
    ...(element ? { how: explainOwner(ctx, file.file, element.name) } : {}),
    ...(element?.stub ? { stub: element.stub } : {}),
    code,
    truncated,
    ...(tests ? { tests } : {}),
  };
}
