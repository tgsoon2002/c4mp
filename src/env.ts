import { ENV_PREFIX, LEGACY_ENV_PREFIX } from './constants';

/** Phase 35 A: the value of C4MP_<name>, else of the legacy C4PM_<name>, else undefined. The one place env vars are read. */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name];
}

const noted = new Set<string>();

/**
 * Phase 35 A: print `text` on stderr once per process for `key`. Never on stdout, and silent when --json is on the
 * command line, so machine-readable runs stay clean. C4MP_NO_NOTES=1 turns the notes off (the test suite sets it).
 */
export function noteOnce(key: string, text: string): void {
  if (noted.has(key)) return;
  noted.add(key);
  if (process.argv.includes('--json') || readEnv('NO_NOTES') === '1') return;
  process.stderr.write(text + '\n');
}
