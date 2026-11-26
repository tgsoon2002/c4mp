import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Parser from 'tree-sitter';
import { FileOutline, FileCalls, FileRole, LanguageHandler, RawImport } from './types';
import { fileOnlyOutline } from './languages/files';
import { withFileLock, LockBusyError } from './util/fileLock';
import { writeAtomic } from './util/fsAtomic';
import { TOOL_VERSION, isCurrentTool } from './constants';
import { log } from './log';

/**
 * b217 fix A: per-PROCESS parse cache. `plan link` / `plan set` scan the repo several times in one
 * process while only the plan differs; the parse step (tree-sitter, 75-87 percent of a scan) is the same
 * every time. Values are cloned in and out, because the scan mutates them later (call bindings get their
 * import verdict, markTestFiles marks test cases).
 * QS-2 disk layer: loadParseCacheDisk / saveParseCacheDisk, used by queries only (loadQueryContext passes the folder
 * through scanCore's parseCacheDir). Each CLI query is a new process, so without it every query parsed every file.
 *
 * b620: key = repo-relative path + content hash (sha1 of the code) + handler id ('files' for a file-only
 * listing) + role. The parse depends only on these (and on wantCalls: a hit without calls when calls are
 * wanted is a miss). No absolute path and no stat: `history` scans each commit in a new temp dir and the
 * page build scans the live tree, so unchanged files hit across them.
 * Sweep: each scan is one generation (beginParseGeneration before its file loop, endParseGeneration after
 * it). An entry not hit or stored in the current generation is dropped at its end, so the cache holds at
 * most one scan's files (old versions of changed files and deleted files go).
 */

/** What the parse step produces for one file. rawImports is undefined for a file-only file (listed, never parsed). */
export interface ParsedFile {
  outline: FileOutline;
  rawImports?: RawImport[];
  calls?: FileCalls;
}

interface Entry { gen: number; value: ParsedFile; }

const cache = new Map<string, Entry>();
const stats = { hits: 0, misses: 0 };
let generation = 0;

// 2: b567 outlines list functions assigned to a property; 3: b568 outlines carry content hashes;
// 4: b573 C++ files with export / namespace macros parse again with the macros blanked, b575 C++ nested classes
// 5: b682 call, binding and use positions, ownUses; 6: b592 Python files carry calls; 7: b782 outlines carry nested functions
const DISK_FORMAT = 7;
const DISK_FILE = 'parse-cache.json';
const LOCK_FILE = 'parse-cache.lock';
const loadedDirs = new Set<string>();   // a dir is read once per process
let dirty = false;                       // set by storeParse and by a sweep that drops an entry

/** The disk file: `{ format, tool, entries: { <key>: ParsedFile } }`. */
interface DiskFile { format: number; tool: string; entries: Record<string, ParsedFile>; }

/** Outline of a parsed file; a role-test file also gets its test cases (Phase 26), before calls are taken from it. */
export function outlineFor(handler: LanguageHandler, tree: Parser.Tree, file: string, code: string, role?: FileRole): FileOutline {
  const outline = handler.outline(tree, file, code);
  return role === 'test' && handler.tests ? handler.tests(tree, outline) : outline;
}

/** The ONE definition of the parse step for a file. handler null = file-only listing. */
export function extractParsed(handler: LanguageHandler | null, file: string, code: string, wantCalls: boolean, role?: FileRole): ParsedFile {
  if (!handler) {
    const listed = fileOnlyOutline(file, code);
    addContentHashes(listed, code);
    return { outline: listed };
  }
  const tree = handler.parse(code, file);
  const outline = outlineFor(handler, tree, file, code, role);
  addContentHashes(outline, code);
  const parsed: ParsedFile = { outline, rawImports: handler.imports(tree) };
  if (wantCalls && handler.calls) parsed.calls = handler.calls(tree, outline);
  return parsed;
}

/**
 * b568 + b582: content hashes for `diff`, which before compared line counts only (a body edit that keeps the count,
 * or `const f` -> `export const f`, was no change). Hash = the first 16 hex chars of sha1. The code is read with CRLF
 * as LF (a checkout's line ends are no edit); every other byte counts, whitespace included.
 * File: the whole code. Element: its whole lines startLine..endLine joined with '\n', so a keyword in front of the
 * declaration on its first line (`export`, `async`, `public`) is part of it. Depends on the text only (b563: stable
 * across runs, folders and machines).
 */
export function addContentHashes(outline: FileOutline, code: string): void {
  const text = code.replace(/\r\n/g, '\n');
  const hashOf = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
  outline.hash = hashOf(text);
  if (outline.elements.length === 0) return;
  const lines = text.split('\n');
  for (const e of outline.elements) e.hash = hashOf(lines.slice(e.startLine - 1, e.endLine).join('\n'));
}

function keyOf(file: string, code: string, handler: LanguageHandler | null, role?: FileRole): string {
  const hash = crypto.createHash('sha1').update(code).digest('hex');
  return `${file}\0${hash}\0${handler ? handler.id : 'files'}\0${role ?? ''}`;
}

/** Cached value (a private copy) for this file content; undefined = miss. A hit counts as used in this generation. */
export function getCachedParse(file: string, code: string, handler: LanguageHandler | null, wantCalls: boolean, role?: FileRole): ParsedFile | undefined {
  const entry = cache.get(keyOf(file, code, handler, role));
  const needsCalls = !!entry && wantCalls && !!handler?.calls && !entry.value.calls;
  if (entry && !needsCalls) {
    entry.gen = generation;
    stats.hits++;
    return structuredClone(entry.value);
  }
  stats.misses++;
  return undefined;
}

/** Store the value of a file just parsed from `code` (a private copy); it counts as used in this generation. */
export function storeParse(file: string, code: string, handler: LanguageHandler | null, value: ParsedFile, role?: FileRole): void {
  cache.set(keyOf(file, code, handler, role), { gen: generation, value: structuredClone(value) });
  dirty = true;
}

/** Start of a scan's file loop: a new generation, stats reset. */
export function beginParseGeneration(): void {
  generation++;
  stats.hits = 0;
  stats.misses = 0;
}

/** End of a scan's file loop (normal completion only): drop every entry not hit or stored in this generation. */
export function endParseGeneration(): void {
  for (const [key, entry] of cache) {
    if (entry.gen !== generation) { cache.delete(key); dirty = true; }
  }
}

/** Why a parsed disk file can't be used, or null when it can. */
function diskProblem(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'not an object';
  const d = data as Partial<DiskFile>;
  if (d.format !== DISK_FORMAT) return `format ${String(d.format)}`;
  if (typeof d.tool !== 'string' || !isCurrentTool(d.tool)) return `tool ${String(d.tool)}`;
  if (!d.entries || typeof d.entries !== 'object') return 'no entries';
  return null;
}

/**
 * Merge the disk cache of `dir` into memory, once per process per dir. Missing, unreadable, broken, other format or
 * other TOOL_VERSION: ignored (log 'parse-cache', 'disk ignored', {dir, reason}). Loaded entries get gen = generation - 1,
 * so the end-of-scan sweep drops the ones this scan does not hit. An entry already in memory is kept. Never throws.
 */
export function loadParseCacheDisk(dir: string): void {
  if (loadedDirs.has(dir)) return;
  loadedDirs.add(dir);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(dir, DISK_FILE), 'utf8'));
    const problem = diskProblem(data);
    if (problem) {
      log('parse-cache', 'disk ignored', { dir, reason: problem });
      return;
    }
    let loaded = 0;
    for (const [key, value] of Object.entries((data as DiskFile).entries)) {
      if (cache.has(key) || !value || typeof value !== 'object' || !value.outline) continue;
      cache.set(key, { gen: generation - 1, value });
      loaded++;
    }
    log('parse-cache', 'disk loaded', { dir, entries: loaded });
  } catch (err) {
    // missing (ENOENT), unreadable or broken JSON: start empty, the save rewrites it
    log('parse-cache', 'disk ignored', { dir, reason: (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err)) });
  }
}

/**
 * Write this generation's entries to <dir>/parse-cache.json when dirty, under withFileLock(<dir>/parse-cache.lock,
 * ..., {waitMs: 2000}) and writeAtomic. Creates dir (recursive). LockBusyError or any write error: log and skip.
 * Never throws. Clears dirty after a successful write.
 */
export function saveParseCacheDisk(dir: string): void {
  if (!dirty) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const entries: Record<string, ParsedFile> = {};
    for (const [key, entry] of cache) {
      if (entry.gen === generation) entries[key] = entry.value;
    }
    const file: DiskFile = { format: DISK_FORMAT, tool: TOOL_VERSION, entries };
    withFileLock(path.join(dir, LOCK_FILE), () => writeAtomic(path.join(dir, DISK_FILE), JSON.stringify(file)), { waitMs: 2000 });
    dirty = false;
  } catch (err) {
    log('parse-cache', 'disk save skipped', {
      dir,
      reason: err instanceof LockBusyError ? err.message : err instanceof Error ? err.message : String(err),
    });
  }
}

export function clearParseCache(): void {
  cache.clear();
  loadedDirs.clear();
  dirty = false;
  stats.hits = 0;
  stats.misses = 0;
}

/** Hits and misses since the last clear or beginParseGeneration (a scan begins one before its parse loop). */
export function parseCacheStats(): { hits: number; misses: number } {
  return { ...stats };
}

/** Number of cached entries (tests: after a scan the sweep leaves at most that scan's files). */
export function parseCacheSize(): number {
  return cache.size;
}
