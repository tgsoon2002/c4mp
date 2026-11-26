import * as fs from 'fs';
import * as path from 'path';
import { toId } from './names';
import { log } from './log';
import { CMD_NAME, DATA_DIR, LEGACY_DATA_DIR } from './constants';
import { noteOnce } from './env';
import type { ProjectPaths } from './types';

/** b513 (row N8): the type lives in Foundation (src/types.ts); re-exported for the Workspace files that import it here. */
export type { ProjectPaths } from './types';

/** Phase 35 A: alias of DATA_DIR (src/constants.ts), the name a NEW data folder gets; which folder a repo uses is dataDirAt. */
export const INTERNAL_DIR = DATA_DIR;
export const EXPORT_DIR = 'C4MP';
/** Phase 35 C (b945): the export folder of earlier versions (C4PM/<repoId>/c4pmView.html); left alone in a user's repo, only recognised as an export folder. */
export const LEGACY_EXPORT_DIR = 'C4PM';
export const VIEW_FILE = 'c4mpView.html';

export class AnchorNotFoundError extends Error {
  hint: string;
  constructor(target: string) {
    const hint = `run: ${CMD_NAME} init --repo ${target}`;
    super(`No ${INTERNAL_DIR} or .git found at or above ${target}. To create the project folder, ${hint}`);
    this.name = 'AnchorNotFoundError';
    this.hint = hint;
  }
}

/**
 * Nearest ancestor (including target itself) holding a `.c4pm` or `.git` entry.
 * `.git` may be a directory or a file (worktrees/submodules).
 */
export function findAnchor(target: string): string {
  const start = path.resolve(target);
  log('paths', 'findAnchor start', { target, start });
  const found = nearestAnchor(start);
  if (found) {
    log('paths', 'findAnchor marker found', { dir: found });
    return found;
  }
  log('paths', 'findAnchor reached filesystem root, none found', { start });
  throw new AnchorNotFoundError(start);
}

/** The folder findAnchor returns, or null when none: a plain walk with no logging, for callers that run before debug output is routed. */
export function nearestAnchor(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if ([DATA_DIR, LEGACY_DATA_DIR, '.git'].some((marker) => fs.existsSync(path.join(dir, marker)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
/**
 * Phase 35 A: the data folder at an anchor. `.c4mp` when it exists; else `.c4pm` when it exists (an old repo keeps
 * working in place until `migrate`: one repo's data is never split over two folders); else `.c4mp` (a new repo).
 * Both present: `.c4mp` wins and one stderr warning per process names both. An old repo: one stderr note per process.
 */
export function dataDirAt(anchor: string): string {
  const next = path.join(anchor, DATA_DIR);
  const old = path.join(anchor, LEGACY_DATA_DIR);
  if (fs.existsSync(next)) {
    if (fs.existsSync(old)) {
      noteOnce('data-dir-both', `warning: ${anchor} holds both ${DATA_DIR} and ${LEGACY_DATA_DIR}; using ${DATA_DIR} and ignoring ${LEGACY_DATA_DIR}`);
    }
    return next;
  }
  if (fs.existsSync(old)) {
    noteOnce('data-dir-legacy', `note: this repo still uses ${LEGACY_DATA_DIR}; run \`${CMD_NAME} migrate\` to move it`);
    return old;
  }
  return next;
}

/** The only project folder under `<anchorDir>/.c4pm/projects`, else null (none, several, or no folder). */
export function soleProjectId(anchorDir: string): string | null {
  const root = path.join(dataDirAt(anchorDir), 'projects');
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  log('paths', 'soleProjectId', { root, names });
  return names.length === 1 ? names[0] : null;
}

/**
 * R7: the folder a command uses when --repo is missing: the nearest folder at or above `from` (default: the working
 * folder) that holds `.c4pm` or `.git` (findAnchor), else `from` itself.
 */
export function defaultRepoRoot(from: string = process.cwd()): string {
  return nearestAnchor(from) ?? path.resolve(from);
}

/** Pure: computes locations only, never creates or writes anything. */
export function resolvePaths(target: string, opts?: { repoId?: string; anchor?: string }): ProjectPaths {
  const abs = path.resolve(target);
  const repoId = opts?.repoId ?? toId(path.basename(abs));
  log('paths', opts?.repoId ? 'resolvePaths explicit repoId' : 'resolvePaths derived repoId', { repoId });
  const anchor = opts?.anchor ? path.resolve(opts.anchor) : findAnchor(abs);
  log('paths', opts?.anchor ? 'resolvePaths explicit anchor' : 'resolvePaths derived anchor', { anchor });
  const internalDir = dataDirAt(anchor);
  const projectDir = path.join(internalDir, 'projects', repoId);
  const exportDir = path.join(anchor, EXPORT_DIR, repoId);
  const result: ProjectPaths = {
    anchor,
    internalDir,
    projectDir,
    dataDir: path.join(projectDir, 'data'),
    historyDir: path.join(projectDir, 'history'),
    planDir: path.join(projectDir, 'plan'),
    exportDir,
    viewFile: path.join(exportDir, VIEW_FILE),
    configFile: path.join(internalDir, 'config.json'),
    repoId,
  };
  log('paths', 'resolvePaths result', result);
  return result;
}

/**
 * b564: the other projects at the anchor when `paths.projectDir` does not exist yet: the folder names under
 * `<internalDir>/projects/`, sorted; else (or when there is no projects folder) []. Reads only, never writes.
 * A wrong --repo (`.` instead of `Project`) resolves to a new, empty project id: this is what tells it apart.
 */
export function otherProjects(paths: ProjectPaths): string[] {
  if (fs.existsSync(paths.projectDir)) return [];
  const root = path.join(paths.internalDir, 'projects');
  if (!fs.existsSync(root)) return [];
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  log('paths', 'otherProjects', { projectDir: paths.projectDir, names });
  return names;
}

/** True when absPath is anchor/C4PM or below it (exact folder at the anchor only). */
export function isInsideExportDir(anchor: string, absPath: string): boolean {
  // Phase 35 C (b945): the old export folder `C4PM/` of an earlier version counts too (it is left alone, never scanned or deleted).
  const inside = [EXPORT_DIR, LEGACY_EXPORT_DIR].some((name) => {
    const rel = path.relative(path.join(path.resolve(anchor), name), path.resolve(absPath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  log('paths', 'isInsideExportDir', { anchor, absPath, inside });
  return inside;
}

/**
 * True when absDir is the export folder sitting at an anchor: named `C4PM` and its parent
 * holds a `.c4pm` or `.git` entry. A user's deeper folder named C4PM is not matched.
 */
export function isAnchorExportDir(absDir: string): boolean {
  const dir = path.resolve(absDir);
  // Phase 35 C (b945): the old name `C4PM` of an earlier version is an export folder too (left alone, never scanned).
  if (path.basename(dir) !== EXPORT_DIR && path.basename(dir) !== LEGACY_EXPORT_DIR) {
    log('paths', 'isAnchorExportDir no (name)', { dir });
    return false;
  }
  const parent = path.dirname(dir);
  const result = [DATA_DIR, LEGACY_DATA_DIR, '.git'].some(m => fs.existsSync(path.join(parent, m)));
  log('paths', 'isAnchorExportDir', { dir, parent, result });
  return result;
}
