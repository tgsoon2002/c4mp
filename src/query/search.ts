import * as fs from 'fs';
import * as path from 'path';
import { ALL_LANGUAGE_EXTENSIONS, sourceFiles } from '../scan/sourceFiles';
import { QueryError } from './errors';
import { queryBaseOf } from './context';
import type { QueryBase, QueryContext } from './context';
import { ownerOf } from './owner';
import type { SnapshotFile } from '../types';

/**
 * Text files `search` reads when `--ext` is not given: every handler language (ALL_LANGUAGE_EXTENSIONS, whatever --lang says)
 * plus the usual markup, style, data and template files. The ONE place this list lives.
 */
const SEARCH_TEXT_EXTRAS = ['.html', '.htm', '.css', '.scss', '.md', '.json', '.yaml', '.yml', '.txt', '.vue', '.svelte', '.phtml', '.tpl', '.twig', '.ejs', '.hbs'];
export const SEARCH_EXTENSIONS: string[] = [
  ...new Set([...ALL_LANGUAGE_EXTENSIONS, ...SEARCH_TEXT_EXTRAS]),
];

export const SEARCH_DEFAULT_MAX = 50;
export const SEARCH_MAX_MAX = 1000;
export const SEARCH_MAX_CONTEXT = 10;
/** Files above this size are skipped and counted. */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
export const SEARCH_TEXT_MAX = 200;

export interface SearchHit {
  file: string;
  line: number;
  /** The line, trimmed, cut to SEARCH_TEXT_MAX chars. */
  text: string;
  /** Innermost scanned function, method or class around the line (`Class.method`); null when none or the file is not parsed. */
  function: string | null;
  /** Id of the owning plan component or scanned component; null when the file is not in the scan. */
  owner: string | null;
  /** Only with context > 0: the lines around the hit (trimmed, cut like `text`). */
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  query: string;
  results: SearchHit[];
  /** All hits found, also those cut by max. */
  total: number;
  filesSearched: number;
  filesSkipped: { binary: number; tooBig: number };
  truncated: boolean;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  ext?: string[];
  max?: number;
  context?: number;
}

function cut(line: string): string {
  const t = line.trim();
  return t.length > SEARCH_TEXT_MAX ? t.slice(0, SEARCH_TEXT_MAX) : t;
}

function intIn(value: number | undefined, def: number, min: number, max: number, label: string): number {
  const v = value ?? def;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new QueryError('invalid', `${label} must be an integer from ${min} to ${max} (got ${String(value)})`);
  }
  return v;
}

/** Innermost element of the file that holds `line`: the smallest range, the later start on a tie. */
function enclosing(file: SnapshotFile | undefined, line: number): string | null {
  let best: { name: string; size: number; start: number } | null = null;
  for (const e of file?.elements ?? []) {
    if (line < e.startLine || line > e.endLine) continue;
    const size = e.endLine - e.startLine;
    if (!best || size < best.size || (size === best.size && e.startLine > best.start)) best = { name: e.name, size, start: e.startLine };
  }
  return best ? best.name : null;
}

/**
 * Content search over the text files of the repo. Same walk and ignore rules as the scan (scan/sourceFiles.ts:
 * config ignore, --ignore, dot folders, node_modules, dist, build, ...), so no second matcher; symlinks are not followed,
 * so nothing outside the repo is read. Skips (and counts) binary files (a NUL byte) and files over SEARCH_MAX_FILE_BYTES.
 * Literal text, case-insensitive, unless `regex` / `caseSensitive`. Hits are sorted by file, then line.
 * The enclosing function comes from the scan's outline of the file (files without a handler give null). b680: the scan
 * (`full()`) runs only when there is a hit, so a search with no hit never parses the repo.
 * Errors: invalid (empty query, bad regex, max, context).
 */
export function searchContent(on: QueryBase | QueryContext, opts: SearchOptions): SearchResult {
  const base = queryBaseOf(on);
  const query = opts.query ?? '';
  if (typeof query !== 'string' || query.trim() === '') throw new QueryError('invalid', 'query must not be empty');
  const max = intIn(opts.max, SEARCH_DEFAULT_MAX, 1, SEARCH_MAX_MAX, 'max');
  const context = intIn(opts.context, 0, 0, SEARCH_MAX_CONTEXT, 'context');

  let matches: (line: string) => boolean;
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, opts.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new QueryError('invalid', `regex is not valid: ${err instanceof Error ? err.message : String(err)}`);
    }
    matches = (line) => re.test(line);
  } else if (opts.caseSensitive) {
    matches = (line) => line.includes(query);
  } else {
    const q = query.toLowerCase();
    matches = (line) => line.toLowerCase().includes(q);
  }

  const extensions = opts.ext
    ? opts.ext.map((e) => e.trim()).filter((e) => e !== '').map((e) => (e.startsWith('.') ? e : `.${e}`))
    : SEARCH_EXTENSIONS;
  const files = sourceFiles(base.repoRoot, base.config, extensions);
  // b680: the scan is needed only for a hit's function and owner, so it runs at the first hit (none: no scan).
  let scan: { ctx: QueryContext; byFile: Map<string, SnapshotFile> } | undefined;
  const scanOf = (): { ctx: QueryContext; byFile: Map<string, SnapshotFile> } => {
    if (!scan) {
      const ctx = base.full();
      scan = { ctx, byFile: new Map(ctx.snapshot.files.map((f) => [f.file, f])) };
    }
    return scan;
  };

  const results: SearchHit[] = [];
  const skipped = { binary: 0, tooBig: 0 };
  let total = 0;
  let filesSearched = 0;
  for (const rel of files) {
    const abs = path.join(base.repoRoot, rel);
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > SEARCH_MAX_FILE_BYTES) {
        skipped.tooBig++;
        continue;
      }
      buf = fs.readFileSync(abs);
    } catch {
      continue; // vanished or unreadable since the walk
    }
    if (buf.includes(0)) {
      skipped.binary++;
      continue;
    }
    filesSearched++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!matches(lines[i])) continue;
      total++;
      if (results.length >= max) continue;
      const { ctx, byFile } = scanOf();
      const file = byFile.get(rel);
      const fn = enclosing(file, i + 1);
      let owner: string | null = null;
      if (file) {
        try {
          owner = ownerOf(ctx, rel, fn ?? undefined).id;
        } catch {
          owner = ownerOf(ctx, rel).id;
        }
      }
      const hit: SearchHit = { file: rel, line: i + 1, text: cut(lines[i]), function: fn, owner };
      if (context > 0) {
        hit.before = lines.slice(Math.max(0, i - context), i).map(cut);
        hit.after = lines.slice(i + 1, i + 1 + context).map(cut);
      }
      results.push(hit);
    }
  }
  return { query, results, total, filesSearched, filesSkipped: skipped, truncated: total > results.length };
}
