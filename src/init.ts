import * as fs from 'fs';
import * as path from 'path';
import { AnchorNotFoundError, findAnchor, ProjectPaths, resolvePaths } from './paths';
import { DEFAULT_CONFIG } from './config';
import { log } from './log';

export interface InitResult {
  anchor: string;
  created: string[];
  existing: string[];
}

export const INTERNAL_GITIGNORE =
  '# c4mp regenerable data (rebuilt from the code and from git). Plan, config and layout stay committed.\n' +
  'projects/*/data/\n' +
  'projects/*/history/\n';

/**
 * Make `<anchor>/.c4pm` safe to write into: mkdir -p it and write `.c4pm/.gitignore`
 * (INTERNAL_GITIGNORE) only when absent. Never overwrites, never touches config.json or the
 * anchor's own .gitignore. Call it right before any automatic write under .c4pm, so a repo
 * that never ran `c4pm init` still ignores projects/*\/data and projects/*\/history.
 */
export function ensureInternalDir(paths: ProjectPaths): void {
  fs.mkdirSync(paths.internalDir, { recursive: true });
  const ignoreFile = path.join(paths.internalDir, '.gitignore');
  const exists = fs.existsSync(ignoreFile);
  log('init', 'ensureInternalDir', { internalDir: paths.internalDir, ignoreFile, alreadyThere: exists });
  if (!exists) fs.writeFileSync(ignoreFile, INTERNAL_GITIGNORE, 'utf8');
}

/**
 * Creates the .c4pm project folders. Idempotent, never overwrites a file,
 * works without git (target itself becomes the anchor), writes only under <anchor>/.c4pm.
 */
export function initProject(target: string): InitResult {
  let anchor: string;
  try {
    anchor = findAnchor(target);
  } catch (err) {
    if (!(err instanceof AnchorNotFoundError)) throw err;
    anchor = path.resolve(target);
    log('init', 'no anchor found, using target as anchor', { anchor });
  }
  const p = resolvePaths(target, { anchor });
  const created: string[] = [];
  const existing: string[] = [];
  const record = (abs: string, wasThere: boolean) => {
    (wasThere ? existing : created).push(abs);
    log('init', wasThere ? 'already present' : 'created', { path: abs });
  };

  for (const dir of [p.internalDir, p.projectDir, p.dataDir, p.historyDir, p.planDir]) {
    const wasThere = fs.existsSync(dir);
    if (!wasThere) fs.mkdirSync(dir, { recursive: true });
    record(dir, wasThere);
  }

  const configWasThere = fs.existsSync(p.configFile);
  if (!configWasThere) fs.writeFileSync(p.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  record(p.configFile, configWasThere);

  const ignoreFile = path.join(p.internalDir, '.gitignore');
  const ignoreWasThere = fs.existsSync(ignoreFile);
  ensureInternalDir(p);
  record(ignoreFile, ignoreWasThere);

  log('init', 'done', { anchor, created: created.length, existing: existing.length });
  return { anchor, created, existing };
}
