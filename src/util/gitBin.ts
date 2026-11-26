import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { log } from '../log';

export interface GitBinEnv {
  platform: NodeJS.Platform;
  path: string | undefined;
}

/**
 * The git binary to run. 'git' (PATH lookup, today's behaviour) unless this is macOS and PATH's first git is the
 * /usr/bin/git xcrun shim: then the real git that `xcrun --find git` prints (about 4x faster per call, b628).
 * A PATH with another git first (Homebrew, nix) keeps it. An empty, relative or missing xcrun answer gives 'git'.
 * `find` may throw; the caller handles that. Pure apart from `find` and `isFile`.
 */
export function resolveGitBin(env: GitBinEnv, find: (cmd: string, args: string[]) => string, isFile: (p: string) => boolean): string {
  if (env.platform !== 'darwin') return 'git';
  const dirs = (env.path ?? '').split(path.delimiter);
  const dir = dirs.find((d) => isFile(path.join(d, 'git')));
  if (dir === undefined || path.join(dir, 'git') !== '/usr/bin/git') return 'git';
  const real = find('xcrun', ['--find', 'git']).trim();
  return real !== '' && path.isAbsolute(real) && isFile(real) ? real : 'git';
}

let cached: string | undefined;

/** resolveGitBin for this process, resolved once. A failing xcrun is logged and falls back to 'git' from PATH. */
export function gitBin(): string {
  if (cached !== undefined) return cached;
  const find = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  try {
    cached = resolveGitBin({ platform: process.platform, path: process.env.PATH }, find, isFile);
  } catch (error) {
    log('git', 'xcrun --find git failed, using git from PATH', { error: String(error) });
    cached = 'git';
  }
  log('git', 'gitBin', { bin: cached });
  return cached;
}
