import * as path from 'path';
import type { PlanLink } from '../types';
import { log } from '../log';

const TAG = 'links';

/**
 * Parse a link from a .c4 file.
 * - Splits off fragment: L(\d+)-L(\d+) or L(\d+) → lines; otherwise → name
 * - Relative paths (./,../,bare) → resolve against c4File's directory
 * - Absolute URLs (scheme://) → path = raw, name/lines null
 * - Keeps trailing / for folders
 */
export function parseLink(raw: string, c4File: string, title?: string | null): PlanLink {
  log(TAG, 'parseLink', { raw, c4File, title });

  // Check if it's an absolute URL with a scheme (e.g., https://...)
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (schemeMatch) {
    log(TAG, 'URL with scheme', { scheme: schemeMatch[1] });
    return {
      raw,
      path: raw,
      name: null,
      lines: null,
      title: title ?? null,
    };
  }

  // Split fragment
  let targetPath = raw;
  let fragment = '';
  const hashIdx = raw.indexOf('#');
  if (hashIdx !== -1) {
    targetPath = raw.slice(0, hashIdx);
    fragment = raw.slice(hashIdx + 1);
  }

  // Parse fragment: lines or name
  let name: string | null = null;
  let lines: { start: number; end: number } | null = null;

  if (fragment) {
    const lineMatch = fragment.match(/^L(\d+)(?:-L(\d+))?$/);
    if (lineMatch) {
      const start = parseInt(lineMatch[1], 10);
      const end = lineMatch[2] ? parseInt(lineMatch[2], 10) : start;
      lines = { start, end };
      log(TAG, 'fragment is line range', { start, end });
    } else {
      name = fragment;
      log(TAG, 'fragment is name', { name });
    }
  }

  // Resolve relative path
  let resolvedPath: string;
  if (targetPath.startsWith('./') || targetPath.startsWith('../') || (!targetPath.startsWith('/') && !targetPath.includes(':'))) {
    // It's a relative path
    // Determine the directory containing the c4 file
    let c4Dir: string;
    if (c4File.endsWith('/')) {
      // c4File is already a directory path
      c4Dir = c4File;
    } else {
      // c4File is a file path, get its directory
      c4Dir = path.posix.dirname(c4File);
    }
    resolvedPath = path.posix.normalize(path.posix.join(c4Dir, targetPath));
    log(TAG, 'resolved relative path', { c4Dir, targetPath, resolvedPath });
  } else {
    resolvedPath = targetPath;
  }

  // Keep trailing slash for folders (if original had one)
  if (targetPath.endsWith('/') && !resolvedPath.endsWith('/')) {
    resolvedPath += '/';
  }

  return {
    raw,
    path: resolvedPath,
    name,
    lines,
    title: title ?? null,
  };
}

/**
 * Format a link for writing to a .c4 file (the one implementation: `plan generate`, `plan add` and `plan link` all use it).
 * Returns a relative path from fromDir to targetPath, prefixed with './' unless it already starts with '../'
 * (or is exactly '..'), plus an optional #name. A trailing '/' (folder) is kept once. A target equal to fromDir
 * gives './' (PS-5.2 folder form), never './.' or './/'. A first segment that merely starts with '..' (a folder
 * called '..foo') still gets the './' prefix.
 */
export function formatLink(targetPath: string, fromDir: string, name?: string | null, repoRoot?: string): string {
  log(TAG, 'formatLink', { targetPath, fromDir, name, repoRoot });

  const normalized = path.posix.normalize(targetPath);
  const fromNormalized = path.posix.normalize(fromDir);

  // B8: with repoRoot both sides are anchored on the absolute repo root, so the result does not depend on the cwd
  // (path.posix.relative resolves relative inputs against process.cwd(); a plan folder outside the repo,
  // fromDir starting with '../', then gave a different link from the git root than from inside).
  let relative = repoRoot
    ? path.relative(path.resolve(repoRoot, fromNormalized), path.resolve(repoRoot, normalized)).split(path.sep).join('/')
    : path.posix.relative(fromNormalized, normalized);
  if (relative === '' || relative === '.') relative = './';

  if (relative !== '..' && !relative.startsWith('../') && !relative.startsWith('./')) {
    relative = './' + relative;
  }
  if (targetPath.endsWith('/') && !relative.endsWith('/')) {
    relative += '/';
  }

  const result = name ? relative + '#' + name : relative;
  log(TAG, 'formatLink result', { result });
  return result;
}
