import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CMD_NAME, DATA_DIR, LEGACY_DATA_DIR } from '../constants';
import { gitBin } from '../util/gitBin';
import { log } from '../log';
import { nearestAnchor } from '../paths';

export interface MigrateResult {
  anchor: string;
  from: string;
  to: string;
  /** nothing: no old folder; refused: both folders exist; would-move: dry run; moved: done. */
  status: 'nothing' | 'refused' | 'would-move' | 'moved';
  /** How the folder moves (or moved): `git mv` when tracked in a git repo, else a plain rename. */
  method?: 'git mv' | 'rename';
  /** The `.gitignore` comment line inside the folder was (or would be) changed from the old name to the new one. */
  gitignoreFixed: boolean;
  message: string;
}

const OLD_COMMENT = `# ${LEGACY_DATA_DIR.slice(1)} regenerable data`;
const NEW_COMMENT = `# ${DATA_DIR.slice(1)} regenerable data`;

/** True when git tracks something under `dir` of the repo at `anchor`; false in a non-git folder or on any git failure. */
function isTracked(anchor: string, dir: string): boolean {
  try {
    const out = execFileSync(gitBin(), ['-C', anchor, 'ls-files', '--', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Phase 35 A: move the data folder `.c4pm` to `.c4mp` at `anchor` (`git mv` when git tracks it, else a rename) and change the
 * comment line of its `.gitignore`. Dry run unless `opts.yes`. Refuses when both folders exist; "nothing" when no old folder.
 * Touches neither the per-user folder nor git hooks. Reads the folders directly: it never goes through dataDirAt (no notes).
 */
export function migrateDataDir(target: string, opts: { yes: boolean; findAnchor?: boolean }): MigrateResult {
  const anchor = opts.findAnchor ? (nearestAnchor(target) ?? target) : target;   // findAnchor: `target` may be a folder below the anchor
  const from = path.join(anchor, LEGACY_DATA_DIR);
  const to = path.join(anchor, DATA_DIR);
  const base = { anchor, from, to, gitignoreFixed: false };
  const hasOld = fs.existsSync(from);
  const hasNew = fs.existsSync(to);
  log('migrate', 'migrateDataDir', { anchor, hasOld, hasNew, yes: opts.yes });
  if (hasOld && hasNew) {
    return { ...base, status: 'refused', message: `both ${LEGACY_DATA_DIR} and ${DATA_DIR} exist at ${anchor}; keep one and remove or merge the other by hand, then run ${CMD_NAME} migrate again` };
  }
  if (!hasOld) {
    return { ...base, status: 'nothing', message: 'nothing to migrate' };
  }
  const method: 'git mv' | 'rename' = isTracked(anchor, LEGACY_DATA_DIR) ? 'git mv' : 'rename';
  const ignoreOld = path.join(from, '.gitignore');
  const fixIgnore = fs.existsSync(ignoreOld) && fs.readFileSync(ignoreOld, 'utf8').includes(OLD_COMMENT);
  if (!opts.yes) {
    return { ...base, status: 'would-move', method, gitignoreFixed: fixIgnore, message: `would move ${LEGACY_DATA_DIR} to ${DATA_DIR} (${method})${fixIgnore ? ' and fix the comment in its .gitignore' : ''}; run again with --yes to do it` };
  }
  if (method === 'git mv') {
    execFileSync(gitBin(), ['-C', anchor, 'mv', LEGACY_DATA_DIR, DATA_DIR], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    fs.renameSync(from, to);
  }
  if (fixIgnore) {
    const ignoreNew = path.join(to, '.gitignore');
    fs.writeFileSync(ignoreNew, fs.readFileSync(ignoreNew, 'utf8').replace(OLD_COMMENT, NEW_COMMENT), 'utf8');
  }
  return { ...base, status: 'moved', method, gitignoreFixed: fixIgnore, message: `moved ${LEGACY_DATA_DIR} to ${DATA_DIR} (${method})${fixIgnore ? ' and fixed the comment in its .gitignore' : ''}` };
}
