import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, initConfig } from '../config';
import { addIgnoreFolder } from '../configIgnore';
import type { AddIgnoreResult } from '../configIgnore';
import { initProject, InitResult } from '../init';
import { log } from '../log';
import { configOptsFor, ensureExportDir, ensureInternalDirFor, requireProject, resolveStoreRoot, tryResolveProject } from '../outputs';
import { otherProjects } from '../paths';
import type { C4pmConfig, ProjectPaths } from '../types';

/** The language ids `--lang` and config `languages` accept (owned by src/languages/registry.ts), for the Command Line. */
export { LANGUAGE_IDS, LANGUAGES } from '../languages/registry';
/** R7: the --repo default of every command; the entry points reach paths.ts through this service (LAY-11). */
export { defaultRepoRoot } from '../paths';

/**
 * Which history store a command needs (the store is config.store after cli > env > file, so --store goes in `cli`):
 * - 'set': only a store the user asked for (--store, env or config file), else null. Never needs an anchor.
 * - 'known': 'set', else the project's default store when an anchor exists, else null. Never throws for a missing anchor.
 * - 'required': 'set', else the project's default store; throws AnchorNotFoundError (init hint) when there is neither.
 */
export type StoreNeed = 'set' | 'known' | 'required';

export interface OpenProjectOptions {
  /** Which history store to resolve; omitted: none (store is null). */
  store?: StoreNeed;
  /** The command writes into the store: make sure .c4pm/.gitignore exists first when the store lies under .c4pm. */
  create?: boolean;
  /** Throw AnchorNotFoundError (init hint) when no .c4pm / .git anchor exists, before the config is read. */
  requireAnchor?: boolean;
  /**
   * A file or folder the command writes into (not the store): make sure .c4pm/.gitignore exists first when it lies
   * under .c4pm (needs an anchor; nothing happens without one or outside .c4pm). Nothing else is created.
   */
  writeTo?: string;
  /**
   * The command writes the exported page (b507, row G6): after the config is read, require the anchor
   * (AnchorNotFoundError, init hint) and make the export folder <anchor>/C4PM/<repoId> with its .gitignore
   * (ensureExportDir: the .gitignore only when absent). project.viewFile is the page.
   */
  exportDir?: boolean;
}

/** An opened project: the merged config, the project folders (null without an anchor) and the history store. */
export interface OpenedProject {
  config: C4pmConfig;
  project: ProjectPaths | null;
  store: string | null;
}

/**
 * The one way to open a project, the steps every command repeats: find the project folders (anchor), load the merged
 * config (cli > env > the anchor's config.json > legacy .c4pmrc.json > defaults), resolve the history store
 * (see StoreNeed) and, with `create`, prepare .c4pm for a write into the store; with `exportDir`, make the export
 * folder. Errors are thrown unchanged: the anchor error (init hint; with exportDir after the config error), the config
 * error, the store error.
 */
export function openProject<O extends OpenProjectOptions = Record<string, never>>(
  repoRoot: string,
  cli: Partial<C4pmConfig> = {},
  opts?: O,
): OpenedFor<O> {
  const o: OpenProjectOptions = opts ?? {};
  const project = o.requireAnchor ? requireProject(repoRoot) : tryResolveProject(repoRoot);
  const config = loadConfig(repoRoot, cli, configOptsFor(repoRoot));
  if (o.exportDir) ensureExportDir(project ?? requireProject(repoRoot));
  const store = storeFor(repoRoot, project, config, o.store);
  if (o.create && project && store) ensureInternalDirFor(project, store);
  if (o.writeTo !== undefined && project) ensureInternalDirFor(project, o.writeTo);
  log('project', 'openProject', { repoRoot, anchor: project?.anchor ?? null, store, opts: o });
  return { config, project, store } as OpenedFor<O>;
}

/** OpenedProject narrowed by the options: project is set with requireAnchor or exportDir, store with store 'required'. */
export type OpenedFor<O extends OpenProjectOptions> = OpenedProject & {
  project: O extends { requireAnchor: true } | { exportDir: true } ? ProjectPaths : ProjectPaths | null;
  store: O extends { store: 'required' } ? string : string | null;
};

function storeFor(repoRoot: string, project: ProjectPaths | null, config: C4pmConfig, need?: StoreNeed): string | null {
  if (!need) return null;
  if (need === 'set' && !config.store) return null;
  if (need === 'known' && !config.store && !project) return null;
  return resolveStoreRoot(repoRoot, undefined, config.store);
}

/** Where the exported page is and whether/when it was written (the MCP `view_path` tool's answer). */
export interface ViewPageInfo {
  path: string | null;
  exists: boolean;
  modified?: string;
}

/**
 * The repo's exported view page, read-only (b507, row G7; moved from src/page/viewExport.ts): tryResolveProject never
 * creates `.c4pm/`, the config is not read and the page is only stat'ed. `path` is null when there is no
 * `.c4pm`/`.git` anchor; `exists` and `modified` (ISO mtime) only when the file can be stat'ed (a failed stat means
 * "not exported yet").
 */
export function viewPageInfo(repoRoot: string): ViewPageInfo {
  const viewFile = tryResolveProject(repoRoot)?.viewFile ?? null;
  const info: ViewPageInfo = { path: viewFile, exists: false };
  if (viewFile) {
    try {
      info.modified = fs.statSync(viewFile).mtime.toISOString();
      info.exists = true;
    } catch {
      // not exported yet
    }
  }
  return info;
}

/** b564: a --repo that would start a new, empty project while the anchor already holds other projects. */
export interface NewProjectBesideOthers {
  repoId: string;
  anchor: string;
  /** The project ids already at the anchor, sorted. */
  others: string[];
}

/**
 * b564: when `repoRoot` resolves to a project id that has no folder yet while its anchor holds other projects (the
 * usual sign of a wrong --repo: `.` at the git root instead of `Project`), those facts; else null (no anchor, the
 * project exists, or it would be the only one). Reads only, never creates anything.
 */
export function newProjectBesideOthers(repoRoot: string): NewProjectBesideOthers | null {
  const paths = tryResolveProject(repoRoot);
  if (paths === null) return null;
  const others = otherProjects(paths);
  return others.length === 0 ? null : { repoId: paths.repoId, anchor: paths.anchor, others };
}

/** `c4pm init`: create the .c4pm project folders, config.json and .gitignore (idempotent, never overwrites). */
export function setupProject(repoRoot: string): InitResult {
  return initProject(repoRoot);
}

/** `c4pm config init`: write the default .c4pmrc.json into repoRoot; throws when it already exists. Returns its path. */
export function createConfig(repoRoot: string): string {
  return initConfig(repoRoot);
}

/** ignoreFolder's answer: addIgnoreFolder's result (status, reason, before, after) plus the folder, the config file and the write. */
export type IgnoreFolderEdit = AddIgnoreResult & {
  /** The folder as asked (repo-relative). */
  folder: string;
  /** The project's config file (.c4pm/config.json) the folder goes into. */
  configFile: string;
  /**
   * Write `after` into the config file (call it only for status 'added'), then load the config again; when it no
   * longer loads, the old text is put back (the file is removed when it did not exist). Null = written, else the
   * load error message (rolled back).
   */
  write: () => string | null;
};

/**
 * b472 (row P7, `plan remove` of a scanned box): add one folder to the project's ignore list. Reads the config file
 * (AnchorNotFoundError, init hint, without an anchor) and plans the edit; nothing is written until `write()`.
 */
export function ignoreFolder(repoRoot: string, folder: string): IgnoreFolderEdit {
  const configFile = requireProject(repoRoot).configFile;
  const res = addIgnoreFolder(configFile, folder);
  const write = (): string | null => {
    const project = tryResolveProject(repoRoot);
    if (project) ensureInternalDirFor(project, configFile);
    else fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, res.after);
    try {
      loadConfig(repoRoot, {}, configOptsFor(repoRoot));
    } catch (err) {
      if (res.before === '') fs.rmSync(configFile, { force: true });
      else fs.writeFileSync(configFile, res.before);
      return err instanceof Error ? err.message : String(err);
    }
    log('remove', 'ignore added', { folder, configFile });
    return null;
  };
  return { ...res, folder, configFile, write };
}
