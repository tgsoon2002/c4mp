import * as crypto from 'crypto';
import { realRepoPath } from '../util/userCache';
import { readUserJson, writeUserJson } from '../util/userFiles';
import { newToken } from './security';

// b920: the port and the link key `c4pm serve` keeps for one repo, so a bookmark works and an open page reconnects after a restart.

/** The port range c4pm serve keeps a repo's port in. */
export const SERVE_PORT_FIRST = 4170;
export const SERVE_PORT_COUNT = 100;

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The port kept for a repo: SERVE_PORT_FIRST + (first 4 bytes of sha1 of its real path) mod SERVE_PORT_COUNT. */
export function servePortFor(repoRoot: string): number {
  const digest = crypto.createHash('sha1').update(realRepoPath(repoRoot)).digest();
  return SERVE_PORT_FIRST + (digest.readUInt32BE(0) % SERVE_PORT_COUNT);
}

/** b939: the link key remembered for a repo in `file`, or null (no file, none stored). Reads only: never makes or stores a key. */
export function rememberedServeKey(repoRoot: string, file: string | null): string | null {
  const stored = readUserJson(file).keys;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const known = (stored as Record<string, unknown>)[realRepoPath(repoRoot)];
  return typeof known === 'string' && KEY_SHAPE.test(known) ? known : null;
}

/**
 * The link key for a repo: the one remembered in `file` (keyed by the repo's real path), else a new one that is stored.
 * file null (personal files off) or fresh true -> a new key (fresh also replaces the stored one). Throws when the file cannot be written.
 * No lock: two runs writing at once can lose one entry (that repo then gets a new key next time).
 */
export function serveKeyFor(repoRoot: string, opts: { fresh: boolean; file: string | null }): string {
  if (opts.file === null) return newToken();
  const data = readUserJson(opts.file);
  const stored = data.keys;
  const keys: Record<string, unknown> =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const real = realRepoPath(repoRoot);
  const known = keys[real];
  if (!opts.fresh && typeof known === 'string' && KEY_SHAPE.test(known)) return known;
  const key = newToken();
  writeUserJson(opts.file, { ...data, keys: { ...keys, [real]: key } });
  return key;
}
