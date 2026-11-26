import * as fs from 'fs';
import * as path from 'path';
import { IGNORE_DIRS } from './constants';
import { isAnchorExportDir } from './paths';
import { log } from './log';
import { createIgnoreMatcher } from './ignoreMatch';
import type { IgnoreMatcher } from './ignoreMatch';
import { withLanguageIgnores } from './languages/registry';

/**
 * b679 (SV3): an input root and its file filter, shared by the watcher (watchRoots) and the fingerprint
 * (src/scan/fingerprint.ts). Which roots a project has: projectInputRoots (src/scan/inputs.ts).
 */

/** One folder a page build reads. */
export interface InputRoot {
  /** Absolute folder (it may not exist yet: then it holds nothing). */
  dir: string;
  /** File extensions with the dot ('.ts', '.c4', ...): other files are never reported. */
  extensions: string[];
  /** false: only the files directly in `dir`. */
  recursive: boolean;
  /** When set, only these file names directly in `dir` (a dot name such as `.c4pmrc.json` is allowed). */
  files?: string[];
}

/** What inputDropReason needs besides the root: the repo (ignore patterns are repo-relative) and the matcher. */
export interface InputFilter {
  repoRoot: string;
  /** config.ignore plus the languages' default ignores (inputFilter builds it). */
  ignore: IgnoreMatcher;
}

/** The filter of one repo: config.ignore plus the languages' default ignores (as the source walk uses them). */
export function inputFilter(repoRoot: string, config: { ignore?: string[]; languages?: string[] }): InputFilter {
  return { repoRoot: path.resolve(repoRoot), ignore: createIgnoreMatcher(withLanguageIgnores(config.ignore, config.languages)) };
}

/**
 * Why `absFile` is not an input of `root`, or null when it is. Below the root: a dot folder or dot file, an
 * IGNORE_DIRS folder (`out/` among them) or the anchor's `C4PM/` export folder drop it (so a root may sit inside
 * `.c4pm/`); inside the repo the ignore and language patterns apply to the repo-relative path (as the source walk and
 * .c4 discovery do); last the root's names and extensions.
 */
export function inputDropReason(root: InputRoot, absFile: string, filter: InputFilter): string | null {
  const rel = path.relative(root.dir, absFile).split(path.sep).join('/');
  if (!rel) return 'empty path';
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return 'outside root';
  const segments = rel.split('/');
  if (!root.recursive && segments.length > 1) return 'not directly in root';
  if (root.files) {
    if (!root.files.includes(rel)) return 'name not listed';
  } else if (segments.some(s => s.startsWith('.'))) {
    return 'dot-dir';
  }
  const ignoredDir = segments.find(s => IGNORE_DIRS.includes(s));
  if (ignoredDir) return `ignore-dir ${ignoredDir}`;
  for (let i = 0; i < segments.length - 1; i++) {
    if (isAnchorExportDir(path.join(root.dir, ...segments.slice(0, i + 1)))) return 'anchor-export-dir';
  }
  const repoRel = path.relative(filter.repoRoot, absFile).split(path.sep).join('/');
  if (!repoRel.startsWith('../') && !path.isAbsolute(repoRel) && filter.ignore.matches(repoRel)) return 'ignore-pattern';
  if (!root.extensions.includes(path.extname(rel))) return 'extension-not-matched';
  return null;
}

/** The files of `root` that inputDropReason accepts: absolute, sorted; a missing folder gives none. */
export function inputRootFiles(root: InputRoot, filter: InputFilter): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw err;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (root.recursive) walk(abs);
      } else if (e.isFile() && inputDropReason(root, abs, filter) === null) {
        out.push(abs);
      }
    }
  };
  walk(root.dir);
  return out.sort();
}

/**
 * Watch the source files of one repo (`.c4` plus `extensions`): the repo folder as one root of watchRoots, so dot
 * folders, IGNORE_DIRS, the anchor's `C4PM/` export folder and the ignore patterns are dropped. Returns the stop function.
 */
export function watchRepo(
  repoRoot: string,
  opts: { debounceMs: number; ignore: string[]; languages?: string[]; extensions: string[]; onChange: (files: string[]) => void }
): () => void {
  const { extensions, ...rest } = opts;
  // b679: the one-root case of watchRoots (`.c4` always counts, as before)
  return watchRoots([{ dir: path.resolve(repoRoot), extensions: ['.c4', ...extensions], recursive: true }], { repoRoot, ...rest });
}

/**
 * b679 (SV3): watchRepo generalised. One `fs.watch` per root folder not inside a recursive one (a root inside a dot
 * folder, such as `.c4pm/projects/x/board`, is seen through the repo's watcher or its own). An event counts when a
 * root accepts it (inputDropReason: the dot, IGNORE_DIRS and export rules apply below that root only). A root folder
 * that does not exist yet is waited for: its nearest existing parent is watched (not recursive) until it appears, then
 * the folder gets its watcher and the files already in it are reported. Files are reported repo-relative inside the
 * repo, else absolute; debounced, sorted. Returns the stop function.
 */
export function watchRoots(
  roots: InputRoot[],
  opts: { repoRoot: string; debounceMs: number; ignore: string[]; languages?: string[]; onChange: (files: string[]) => void }
): () => void {
  const { debounceMs, onChange } = opts;
  const filter = inputFilter(opts.repoRoot, opts);
  const repoRoot = filter.repoRoot;
  const changedPaths = new Set<string>();
  let debounceTimer: NodeJS.Timeout | null = null;
  const watchers = new Map<string, fs.FSWatcher>();   // key `${recursive}:${dir}`
  let waiting: InputRoot[] = [];
  let stopped = false;
  let armed = false;   // true after the first arm(): a later watch failure is logged, not thrown

  const flush = () => {
    if (changedPaths.size > 0) {
      const sorted = Array.from(changedPaths).sort();
      log('watch', 'flush', sorted);
      onChange(sorted);
      changedPaths.clear();
    }
  };
  const reschedule = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, debounceMs);
  };
  const report = (abs: string): void => {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    changedPaths.add(rel.startsWith('../') || path.isAbsolute(rel) ? abs : rel);
    reschedule();
  };
  const accept = (abs: string, eventType: string): void => {
    const reasons = roots.map(r => inputDropReason(r, abs, filter));
    if (reasons.includes(null)) {
      log('watch', 'accept', { event: eventType, path: abs });
      report(abs);
    } else {
      log('watch', 'drop', { path: abs, reasons: [...new Set(reasons)] });
    }
  };
  const onEvent = (watchDir: string, eventType: string, filename: string | null): void => {
    if (stopped) return;
    if (!filename) {
      log('watch', 'drop', { reason: 'null-filename' });
      return;
    }
    const abs = path.join(watchDir, filename);
    accept(abs, eventType);
    // a waited-for folder (or a parent of it) may have appeared: arm again
    if (waiting.some(r => r.dir === abs || r.dir.startsWith(abs + path.sep) || abs.startsWith(r.dir + path.sep))) arm();
  };
  const nearestExisting = (dir: string): string => {
    let d = dir;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    return d;
  };

  // The watch set: each root's folder (or, while it is missing, its nearest existing parent, not recursive), without
  // the folders a recursive entry already covers. New entries get a watcher; a root that just appeared reports its files.
  function arm(): void {
    const wanted = new Map<string, { dir: string; recursive: boolean }>();
    const nowWaiting: InputRoot[] = [];
    for (const r of roots) {
      const exists = fs.existsSync(r.dir);
      if (!exists) nowWaiting.push(r);
      const entry = exists ? { dir: r.dir, recursive: r.recursive } : { dir: nearestExisting(r.dir), recursive: false };
      wanted.set(`${entry.recursive}:${entry.dir}`, entry);
    }
    const all = [...wanted.values()];
    const covered = (e: { dir: string; recursive: boolean }): boolean => all.some(o => o !== e && o.recursive &&
      (e.dir.startsWith(o.dir + path.sep) || (o.dir === e.dir && !e.recursive)));
    const keep = all.filter(e => !covered(e));
    const appeared = waiting.filter(r => !nowWaiting.includes(r));
    waiting = nowWaiting;
    for (const [key, w] of watchers) {
      if (!keep.some(e => `${e.recursive}:${e.dir}` === key)) { w.close(); watchers.delete(key); }
    }
    for (const e of keep) {
      const key = `${e.recursive}:${e.dir}`;
      if (watchers.has(key)) continue;
      log('watch', 'watch', e);
      let w: fs.FSWatcher;
      try {
        w = fs.watch(e.dir, { recursive: e.recursive }, (eventType, filename) => onEvent(e.dir, eventType, filename));
      } catch (err) {
        if (!armed) throw err;   // at the start the caller hears it; later (inside an event) only the log does
        log('watch', 'watch failed', { dir: e.dir, err: String(err) });
        continue;
      }
      // a watched folder removed (or another watch error): drop that watcher and arm again (the root then waits)
      w.on('error', (err) => {
        log('watch', 'error', { dir: e.dir, err: String(err) });
        w.close();
        watchers.delete(key);
        if (!stopped) arm();
      });
      watchers.set(key, w);
    }
    for (const r of appeared) for (const f of inputRootFiles(r, filter)) report(f);
  }
  try {
    arm();
  } catch (err) {
    for (const w of watchers.values()) w.close();
    throw err;
  }
  armed = true;

  return () => {
    log('watch', 'stop');
    stopped = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
    waiting = [];
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}
