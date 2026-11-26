import * as fs from 'fs';
import * as path from 'path';
import { IGNORE_DIRS } from '../constants';
import { isAnchorExportDir } from '../paths';
import { log } from '../log';
import { createIgnoreMatcher } from '../ignoreMatch';

export interface ListSourceFilesOptions {
  /** File extensions to list ('.ts', ...); every other file is skipped. */
  extensions: string[];
  /** The user's ignore patterns (config `ignore`). */
  ignore?: string[];
  /**
   * Default ignore patterns of the selected languages (rust target, csharp bin/obj, ...; languageIgnorePatterns in
   * languages/registry.ts), added after `ignore`. Never reported as unmatched.
   */
  languageIgnores?: string[];
  /** Called once after the walk with the ignore patterns that matched nothing. */
  onUnmatchedIgnore?: (patterns: string[]) => void;
}

export function listSourceFiles(repoRoot: string, opts: ListSourceFilesOptions): string[] {
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

  const { extensions } = opts;
  const languageIgnores = opts.languageIgnores ?? [];
  const ignoreMatcher = createIgnoreMatcher([...(opts.ignore ?? []), ...languageIgnores]);

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
          log('walk', 'skip dir', { path: repoRelPath });
          continue;
        }
        // Skip dot-directories
        if (entry.name.startsWith('.')) {
          log('walk', 'skip dir', { path: repoRelPath });
          continue;
        }
        // Skip if directory matches an ignore pattern (prefix, path or glob)
        if (ignoreMatcher.matches(repoRelPath)) {
          log('walk', 'skip dir', { path: repoRelPath, reason: 'ignore pattern' });
          continue;
        }
        // Recurse
        walk(fullPath);
      } else if (entry.isFile()) {
        // Check extension
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) {
          log('walk', 'skip file', { path: repoRelPath, reason: 'extension' });
          continue;
        }
        // Skip .d.ts files
        if (entry.name.endsWith('.d.ts')) {
          log('walk', 'skip file', { path: repoRelPath, reason: 'd.ts' });
          continue;
        }
        // Skip if the file matches an ignore pattern (exact path or glob)
        if (ignoreMatcher.matches(repoRelPath)) {
          log('walk', 'skip file', { path: repoRelPath, reason: 'ignore pattern' });
          continue;
        }
        // Add file
        log('walk', 'file', { path: repoRelPath });
        files.push(repoRelPath);
      }
    }
  }

  walk(repoRoot);
  const unmatched = ignoreMatcher.unmatched().filter((p) => !languageIgnores.includes(p));
  if (unmatched.length > 0) opts.onUnmatchedIgnore?.(unmatched);
  files.sort();
  log('walk', 'total', { count: files.length });
  return files;
}
