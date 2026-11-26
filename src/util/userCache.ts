import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readEnv } from '../env';
import { CMD_NAME } from '../constants';

/**
 * QS-2: c4pm's per-user cache folder (D1, K 2026-11-10). C4PM_CACHE_DIR=<path> moves it, C4PM_CACHE_DIR=off turns it
 * off (D2: tests, CI, a read-only home). Nothing here creates a folder; the writer does.
 */

/** Root of c4pm's per-user cache, or null when turned off (C4PM_CACHE_DIR=off). Pure: pass env/platform/home in tests. */
export function userCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  const override = readEnv('CACHE_DIR', env);
  if (override === 'off') return null;
  if (override) return path.resolve(override);
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', CMD_NAME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), CMD_NAME, 'Cache');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), CMD_NAME);
}

/** b920: the real path of a repo (a symlink or /tmp vs /private/tmp gives one path); the resolved path when it does not exist. */
export function realRepoPath(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

/** Cache folder of one repo: <root>/<basename>-<first 16 hex of sha1(realpath of repoRoot)>; null when the cache is off. */
export function repoCacheDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = userCacheRoot(env);
  if (root === null) return null;
  const real = realRepoPath(repoRoot);
  const hash = crypto.createHash('sha1').update(real).digest('hex').slice(0, 16);
  return path.join(root, `${path.basename(real) || 'root'}-${hash}`);
}
