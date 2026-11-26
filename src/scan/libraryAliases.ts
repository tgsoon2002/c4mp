/**
 * b475 (ARR-CL-A1, row A1 of Document/Roadmap/ARROWS_COMMAND_LINE.md): the old library names (src/index.ts) whose
 * job Project & scan does now, kept as deprecated aliases so a library user's code keeps working. Each alias is the
 * very same function or object as before (same signature, same result); its JSDoc names the Project & scan function
 * to call instead. src/index.ts re-exports them from here, so it imports no Engine or Reader.
 */
import * as compare from '../compare/index';
import * as config from '../config';
import * as init from '../init';
import * as pipeline from '../pipeline';
import * as watch from '../watch';
import type { C4pmConfig } from '../types';

/** What setupProject (and the old initProject) returns: the anchor and the paths created or already there. */
export type { InitResult } from '../init';

/** @deprecated Use takeSnapshot (src/scan/snapshots.ts): opens the project and writes or saves the snapshot. */
export const runSnapshot: typeof pipeline.runSnapshot = pipeline.runSnapshot;

/** @deprecated Use diffSnapshots (src/scan/snapshots.ts): compares two snapshot files or two stored snapshots. */
export const compareSnapshots: typeof compare.compareSnapshots = compare.compareSnapshots;

/** @deprecated Use openProject(repoRoot, cli).config (src/scan/project.ts): the merged config. */
export const loadConfig: typeof config.loadConfig = config.loadConfig;

/** @deprecated Use createConfig (src/scan/project.ts). */
export const initConfig: typeof config.initConfig = config.initConfig;

/** @deprecated Use openProject(repoRoot, cli).config (src/scan/project.ts): the defaults merged with the project's config. */
export const DEFAULT_CONFIG: C4pmConfig = config.DEFAULT_CONFIG;

/** @deprecated Use setupProject (src/scan/project.ts). */
export const initProject: typeof init.initProject = init.initProject;

/** @deprecated Use startWatch (src/scan/watchSession.ts): loads the config, scans and hands each diff back. */
export const watchRepo: typeof watch.watchRepo = watch.watchRepo;
