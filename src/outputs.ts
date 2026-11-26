import * as fs from 'fs';
import * as path from 'path';
import { toId } from './names';
import { readRepoIdentity } from './history/meta';
import { AnchorNotFoundError, ProjectPaths, resolvePaths } from './paths';
import { log } from './log';
import { ensureInternalDir } from './init';
import { loadConfig } from './config';
import type { C4pmConfig } from './types';

/**
 * Shared helper for every command that writes under `<anchor>/.c4mp`.
 * Everything is pure except `ensureExportDir`, the one function here that writes.
 */

/** The one stable folder id: toId(package.json name, else folder basename). Independent of any plan. */
export function projectIdFor(repoRoot: string): string {
  // readRepoIdentity names the repo (package.json name, else the one project folder at the anchor, else the folder name),
  // so the project id, the snapshot system id and the history store path all agree.
  const id = toId(readRepoIdentity(repoRoot).repoName);
  log('outputs', 'projectIdFor', { repoRoot, id });
  return id;
}

/** Project paths, or null when no anchor (.c4mp / .git) exists at or above repoRoot. */
export function tryResolveProject(repoRoot: string): ProjectPaths | null {
  try {
    const paths = resolvePaths(repoRoot, { repoId: projectIdFor(repoRoot) });
    log('outputs', 'tryResolveProject found', { projectDir: paths.projectDir });
    return paths;
  } catch (err) {
    if (err instanceof AnchorNotFoundError) {
      log('outputs', 'tryResolveProject no anchor', { repoRoot, hint: err.hint });
      return null;
    }
    throw err;
  }
}

/** Like tryResolveProject but throws AnchorNotFoundError (message carries the init hint). */
export function requireProject(repoRoot: string): ProjectPaths {
  const paths = resolvePaths(repoRoot, { repoId: projectIdFor(repoRoot) });
  log('outputs', 'requireProject', { projectDir: paths.projectDir });
  return paths;
}

/** loadConfig option: the anchor's config file when an anchor exists, else nothing. */
export function configOptsFor(repoRoot: string): { configPath?: string } {
  const paths = tryResolveProject(repoRoot);
  const opts = paths ? { configPath: paths.configFile } : {};
  log('outputs', 'configOptsFor', opts);
  return opts;
}

/** The scan options (languages, ignore, fileOnlyExtensions and tests when set) of a merged config. */
export function pickScanConfig(c: C4pmConfig): Partial<C4pmConfig> {
  return {
    languages: c.languages,
    ignore: c.ignore,
    ...(c.fileOnlyExtensions ? { fileOnlyExtensions: c.fileOnlyExtensions } : {}),
    ...(c.tests ? { tests: c.tests } : {}),
  };
}

/** Scan options with the project config file included (precedence CLI > env > file > defaults). */
export function scanConfigFor(repoRoot: string, cli?: Partial<C4pmConfig>): Partial<C4pmConfig> {
  const result = pickScanConfig(loadConfig(repoRoot, cli, configOptsFor(repoRoot)));
  log('outputs', 'scanConfigFor', result);
  return result;
}

/** Default history store root: histories live at <store>/<repoId>/history. */
export function defaultStoreRoot(paths: ProjectPaths): string {
  return path.join(paths.internalDir, 'projects');
}

/**
 * One place for the history-store precedence:
 * explicit --store > config.store (cli > env > file) > defaultStoreRoot(requireProject(repoRoot)).
 * Explicit and config values are resolved against the cwd. Throws AnchorNotFoundError
 * (init hint in the message) only when it has to default and no anchor exists.
 */
export function resolveStoreRoot(
  repoRoot: string,
  explicitStore?: string | null,
  configStore?: string | null,
): string {
  const chosen = explicitStore || configStore || undefined;
  const store = chosen ? path.resolve(chosen) : defaultStoreRoot(requireProject(repoRoot));
  log('outputs', 'resolveStoreRoot', { repoRoot, explicitStore, configStore, store });
  return store;
}

/**
 * Make the export folder usable: mkdir -p `<anchor>/C4MP/<repoId>` and make the export root
 * `<anchor>/C4PM` ignore itself (`.gitignore` containing `*`). The .gitignore is written only
 * when absent, so an edited one (e.g. deleted/changed to share the page) is never overwritten.
 * The anchor's own .gitignore is never touched.
 */
export function ensureExportDir(paths: ProjectPaths): void {
  fs.mkdirSync(paths.exportDir, { recursive: true });
  const ignoreFile = path.join(path.dirname(paths.exportDir), '.gitignore');
  const exists = fs.existsSync(ignoreFile);
  log('outputs', 'ensureExportDir', { exportDir: paths.exportDir, ignoreFile, alreadyThere: exists });
  if (!exists) fs.writeFileSync(ignoreFile, '*\n');
}

/**
 * Call right before an automatic write to `target`: when target lives under the project's
 * `.c4mp` (data dir, history store, plan dir), make sure `.c4mp/.gitignore` exists first.
 * A target outside .c4mp (explicit --out/--store elsewhere) is left alone: nothing is created.
 * Returns true when ensureInternalDir ran.
 */
export function ensureInternalDirFor(paths: ProjectPaths, target: string): boolean {
  const rel = path.relative(paths.internalDir, path.resolve(target));
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  log('outputs', 'ensureInternalDirFor', { target, internalDir: paths.internalDir, inside });
  if (inside) ensureInternalDir(paths);
  return inside;
}
