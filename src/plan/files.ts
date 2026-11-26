import * as fs from 'fs';
import * as path from 'path';
import { IGNORE_DIRS, C4_EXTENSION } from '../constants';
import { isAnchorExportDir } from '../paths';
import { log } from '../log';
import { createIgnoreMatcher } from '../ignoreMatch';
import { tryResolveProject } from '../outputs';

export interface ListC4FilesOptions {
  ignore?: string[];
}

export function listC4Files(repoRoot: string, opts?: ListC4FilesOptions): string[] {
  // Check if repoRoot is a directory
  let stat;
  try {
    stat = fs.statSync(repoRoot);
  } catch (err) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }

  const ignoreMatcher = createIgnoreMatcher(opts?.ignore);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath);
      const repoRelPath = relPath.split(path.sep).join('/');

      // Skip symlinks
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (IGNORE_DIRS.includes(entry.name) || isAnchorExportDir(fullPath)) {
          log('c4files', 'skip dir', { path: repoRelPath });
          continue;
        }
        // Skip dot-directories
        if (entry.name.startsWith('.')) {
          log('c4files', 'skip dir', { path: repoRelPath });
          continue;
        }
        // Skip if directory matches an ignore pattern (prefix, path or glob)
        if (ignoreMatcher.matches(repoRelPath)) {
          log('c4files', 'skip dir', { path: repoRelPath, reason: 'ignore pattern' });
          continue;
        }
        // Recurse
        walk(fullPath);
      } else if (entry.isFile()) {
        // Check extension
        const ext = path.extname(entry.name);
        if (ext !== C4_EXTENSION) {
          log('c4files', 'skip file', { path: repoRelPath, reason: 'extension' });
          continue;
        }
        // Skip if the file matches an ignore pattern (exact path or glob)
        if (ignoreMatcher.matches(repoRelPath)) {
          log('c4files', 'skip file', { path: repoRelPath, reason: 'ignore pattern' });
          continue;
        }
        // Add file
        log('c4files', 'file', { path: repoRelPath });
        files.push(repoRelPath);
      }
    }
  }

  walk(repoRoot);
  files.sort();
  log('c4files', 'total', { count: files.length });
  return files;
}

/**
 * Candidate plan folders (absolute), in precedence order:
 * config.architectureDir (repo-relative, if set) > planDir (only when an anchor exists) > legacy <repo>/c4.
 * Existence is NOT checked here; nothing is created or written.
 */
export function planDirsFor(repoRoot: string, config?: { architectureDir?: string | null } | null): string[] {
  const dirs: string[] = [];
  if (config?.architectureDir) dirs.push(path.resolve(repoRoot, config.architectureDir));
  const project = tryResolveProject(repoRoot);
  if (project) dirs.push(project.planDir);
  dirs.push(path.join(repoRoot, 'c4'));
  const unique = dirs.filter((d, i) => dirs.indexOf(d) === i);
  log('outputs', 'planDirsFor', { repoRoot, unique });
  return unique;
}

/**
 * The one plan-loading decision: first candidate from planDirsFor that holds >=1 .c4 file wins (no merging).
 * If none does, fall back to the old behaviour (walk the whole repo for .c4 files) so existing layouts keep working.
 * `files` are paths relative to repoRoot (posix; may start with `../` when the plan lives outside repoRoot),
 * ready for parsePlan(repoRoot, files). `dir` is the winning folder, or null for the repo-wide fallback.
 */
export function findPlanFiles(
  repoRoot: string,
  config?: { architectureDir?: string | null; ignore?: string[] } | null,
): { dir: string | null; files: string[] } {
  // B18: the scan's ignore patterns also apply to .c4 discovery (repo-relative paths)
  const ignoreMatcher = createIgnoreMatcher(config?.ignore);
  for (const dir of planDirsFor(repoRoot, config)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const inDir = listC4Files(dir);
    const files = inDir
      .map(f => path.relative(repoRoot, path.join(dir, f)).split(path.sep).join('/'))
      .filter(f => f.startsWith('../') || !ignoreMatcher.matches(f));
    if (files.length === 0) continue;
    log('outputs', 'findPlanFiles winner', { dir, count: files.length });
    return { dir, files };
  }
  const files = listC4Files(repoRoot, { ignore: config?.ignore });
  log('outputs', 'findPlanFiles repo-wide fallback', { count: files.length });
  return { dir: null, files };
}
