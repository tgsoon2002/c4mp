import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../log';
import { writeAtomic, writeError } from './fsAtomic';
import { DATA_DIR, LEGACY_DATA_DIR } from '../constants';
import { readEnv } from '../env';

/**
 * b646/b920: c4pm's personal files under ~/.c4pm (settings.json now, serve-keys.json later). C4PM_USER_DIR=<path> moves
 * them, C4PM_USER_DIR=off turns them off. Written privately (folder 0700, file 0600) and atomically.
 * The legacy ~/.c4pm/store is not moved by C4PM_USER_DIR.
 */

export const SETTINGS_FILE = 'settings.json';
export const SERVE_KEYS_FILE = 'serve-keys.json';

const SETTING_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const SETTING_VALUE = /^[a-z0-9-]{1,32}$/;
const MAX_SETTINGS = 32;

/** The personal folder: off -> null; a path -> path.resolve(path); else <home>/.c4pm. Pure: pass env/home in tests. */
export function userDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const override = readEnv('USER_DIR', env);
  if (override === 'off') return null;
  if (override) return path.resolve(override);
  const next = path.join(home, DATA_DIR);
  const old = path.join(home, LEGACY_DATA_DIR);
  return !fs.existsSync(next) && fs.existsSync(old) ? old : next;
}
/**
 * Phase 35 A: the legacy history store folder: <home>/.c4mp/store when it exists, else <home>/.c4pm/store when only that
 * exists, else <home>/.c4mp/store. Not moved by C4MP_USER_DIR.
 */
export function legacyStoreDir(home: string = os.homedir()): string {
  const next = path.join(home, DATA_DIR, 'store');
  const old = path.join(home, LEGACY_DATA_DIR, 'store');
  return !fs.existsSync(next) && fs.existsSync(old) ? old : next;
}

/** One personal file by name, or null when the personal folder is off. */
export function userFile(name: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const dir = userDir(env, home);
  return dir === null ? null : path.join(dir, name);
}

/** Read a personal JSON file: null, missing, bad JSON or not a plain object -> {} (bad ones are logged). */
export function readUserJson(file: string | null): Record<string, unknown> {
  if (file === null) return {};
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('userFiles', 'unreadable', { file, error: (err as Error).message });
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    log('userFiles', 'unreadable', { file, error: 'not an object' });
  } catch (err) {
    log('userFiles', 'unreadable', { file, error: (err as Error).message });
  }
  return {};
}

/** Write a personal JSON file privately: folder 0700, file 0600, through a temp file and rename. Errors are writeError. */
export function writeUserJson(file: string, value: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw writeError(file, err as NodeJS.ErrnoException);
  }
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

/** Check a settings object from outside (the page): at most 32 names (letter + up to 31 letters/digits), lower-case word values. */
export function cleanSettings(raw: unknown): { settings: Record<string, string> } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'settings must be an object of setting names and words' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_SETTINGS) return { error: `too many settings: ${entries.length} (at most ${MAX_SETTINGS})` };
  const settings: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!SETTING_KEY.test(k)) return { error: `setting name '${k}' must be a letter then up to 31 letters or digits` };
    if (typeof v !== 'string' || !SETTING_VALUE.test(v)) {
      return { error: `setting ${k}: the value must be a lower-case word (letters, digits, dashes; at most 32)` };
    }
    settings[k] = v;
  }
  return { settings };
}

/** The settings of a personal file: only the entries that pass the name and value rules, at most the first 32. */
export function readUserSettings(file: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(readUserJson(file))) {
    if (n >= MAX_SETTINGS) break;
    if (SETTING_KEY.test(k) && typeof v === 'string' && SETTING_VALUE.test(v)) {
      out[k] = v;
      n++;
    }
  }
  return out;
}
