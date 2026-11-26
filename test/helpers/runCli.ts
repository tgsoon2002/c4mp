import * as path from 'path';
import { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';

/** Project root (the folder holding package.json). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** The compiled CLI. test/globalSetup.js builds it once per jest run, so no ts-node compile per spawn. */
export const CLI_JS = path.join(PROJECT_ROOT, 'dist', 'bin', 'cli.js');

/**
 * Timeout for any test that starts a child process and waits on it. Under load macOS can hold a new process at exec
 * (_dyld_start, syspolicyd busy) for 10-40 s, measured during the combined jest runs (b621, b628). One source for
 * every such test: wait on the child's own signal (exit, a line, a file) with this deadline, not a short fixed one.
 */
export const SPAWN_TIMEOUT_MS = 90_000;

/** Runs `c4pm <args>` as a plain `node dist/bin/cli.js` child. cwd defaults to the Project root. */
export function runCli(
  args: string[],
  opts: Partial<SpawnSyncOptionsWithStringEncoding> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_JS, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', ...opts });
}
