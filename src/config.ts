import * as fs from 'fs';
import * as path from 'path';
import type { C4pmConfig, FailOn, LayersConfig, TestsConfig } from './types';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, FAIL_ON_LEVELS } from './constants';
import { LANGUAGE_IDS } from './languages/registry';
import { log } from './log';
import { readEnv } from './env';

export const DEFAULT_CONFIG: C4pmConfig = {
  languages: ['typescript'],
  ignore: [],
  store: null,
  sprint: null,
  failOn: 'none',
  architectureDir: null,
  viewOnCommit: true,
};

/**
 * Normalize an ignore path: strip leading `./` and trailing `/`
 */
function normalizeIgnore(entry: string): string {
  let normalized = entry;
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Parse comma-separated list from env var or string.
 * Returns empty array if empty, drops empty entries.
 */
function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Load a config file at an absolute path.
 * Returns null if file doesn't exist, throws on invalid JSON (message names the path).
 */
function loadConfigFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    const message =
      err instanceof SyntaxError
        ? `Invalid JSON in ${filePath}: ${err.message}`
        : `Error reading ${filePath}: ${String(err)}`;
    throw new Error(message);
  }
}

/**
 * Load config from environment variables.
 * Parses: C4PM_LANGUAGES, C4PM_IGNORE, C4PM_FILE_ONLY, C4PM_TESTS (comma lists; C4PM_TESTS sets tests.globs),
 *         C4PM_STORE, C4PM_SPRINT, C4PM_FAIL_ON, C4PM_ARCHITECTURE_DIR,
 *         C4PM_VIEW_ON_COMMIT, C4PM_LAYERS_SKIP (true/false/1/0; C4PM_LAYERS_SKIP sets layers.skip)
 * Returns the parsed values plus errors for values that cannot be parsed.
 */
function loadConfigEnv(): { result: Partial<C4pmConfig>; errors: string[] } {
  const result: Partial<C4pmConfig> = {};
  const errors: string[] = [];

  const languages = parseCommaSeparatedList(readEnv('LANGUAGES'));
  if (languages.length > 0) {
    result.languages = languages;
  }

  const ignore = parseCommaSeparatedList(readEnv('IGNORE'));
  if (ignore.length > 0) {
    result.ignore = ignore;
  }

  const testGlobs = parseCommaSeparatedList(readEnv('TESTS'));
  if (testGlobs.length > 0) {
    result.tests = { globs: testGlobs };
  }

  const fileOnly = parseCommaSeparatedList(readEnv('FILE_ONLY'));
  if (fileOnly.length > 0) {
    result.fileOnlyExtensions = fileOnly;
  }

  const store = readEnv('STORE');
  if (store) {
    result.store = store;
  }

  const sprint = readEnv('SPRINT');
  if (sprint) {
    result.sprint = sprint;
  }

  const failOn = readEnv('FAIL_ON');
  if (failOn) {
    result.failOn = failOn as FailOn;
  }

  const architectureDir = readEnv('ARCHITECTURE_DIR');
  if (architectureDir) {
    result.architectureDir = architectureDir;
  }

  const rawView = readEnv('VIEW_ON_COMMIT');
  if (rawView) {
    const v = rawView.trim().toLowerCase();
    if (v === 'true' || v === '1') {
      result.viewOnCommit = true;
    } else if (v === 'false' || v === '0') {
      result.viewOnCommit = false;
    } else {
      errors.push(`env: C4PM_VIEW_ON_COMMIT must be 'true', 'false', '1' or '0', got "${rawView}"`);
    }
  }

  const rawSkip = readEnv('LAYERS_SKIP');
  if (rawSkip) {
    const v = rawSkip.trim().toLowerCase();
    if (v === 'true' || v === '1') {
      result.layers = { skip: true };
    } else if (v === 'false' || v === '0') {
      result.layers = { skip: false };
    } else {
      errors.push(`env: C4PM_LAYERS_SKIP must be 'true', 'false', '1' or '0', got "${rawSkip}"`);
    }
  }

  return { result, errors };
}

const TESTS_KEYS = ['globs', 'ignoreReach', 'command', 'noTests'];
const TESTS_PLACEHOLDERS = ['{file}', '{name}', '{nameRegex}'];

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string' && e.trim() !== '');

/** Errors of config key `tests`: an object with only globs / ignoreReach (string lists), command (string template), noTests (boolean). */
function validateTests(tests: unknown, source: string): string[] {
  if (typeof tests !== 'object' || tests === null || Array.isArray(tests)) {
    return [`${source}: tests must be an object with keys ${TESTS_KEYS.join(', ')}, got ${JSON.stringify(tests)}`];
  }
  const errors: string[] = [];
  const t = tests as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (!TESTS_KEYS.includes(key)) errors.push(`${source}: tests: unknown key "${key}" (valid: ${TESTS_KEYS.join(', ')})`);
  }
  for (const key of ['globs', 'ignoreReach']) {
    if (t[key] !== undefined && !isStringList(t[key])) {
      errors.push(`${source}: tests.${key} must be an array of non-empty strings (globs), got ${JSON.stringify(t[key])}`);
    }
  }
  if (t.noTests !== undefined && typeof t.noTests !== 'boolean') {
    errors.push(`${source}: tests.noTests must be true or false, got ${JSON.stringify(t.noTests)}`);
  }
  if (t.command !== undefined) {
    if (typeof t.command !== 'string' || t.command.trim() === '') {
      errors.push(`${source}: tests.command must be a non-empty string, got ${JSON.stringify(t.command)}`);
    } else {
      const unknown = (t.command.match(/\{[^}]*\}/g) ?? []).filter((p) => !TESTS_PLACEHOLDERS.includes(p));
      if (unknown.length > 0) {
        errors.push(`${source}: tests.command has unknown placeholder ${unknown.join(', ')} (valid: ${TESTS_PLACEHOLDERS.join(', ')})`);
      }
    }
  }
  return errors;
}

/** `over` on top of `base`, key by key: env and CLI set tests.globs only and keep the file's ignoreReach and command. */
const mergeTests = (base: TestsConfig | undefined, over: TestsConfig): TestsConfig => ({ ...base, ...over });

const LAYERS_KEYS = ['skip'];

/** b466: errors of config key `layers`: an object with only `skip` (boolean; turns on the opt-in check rule layer-skip). */
function validateLayers(layers: unknown, source: string): string[] {
  if (typeof layers !== 'object' || layers === null || Array.isArray(layers)) {
    return [`${source}: layers must be an object with keys ${LAYERS_KEYS.join(', ')}, got ${JSON.stringify(layers)}`];
  }
  const l = layers as Record<string, unknown>;
  const errors = Object.keys(l).filter((k) => !LAYERS_KEYS.includes(k))
    .map((k) => `${source}: layers: unknown key "${k}" (valid: ${LAYERS_KEYS.join(', ')})`);
  if (l.skip !== undefined && typeof l.skip !== 'boolean') {
    errors.push(`${source}: layers.skip must be true or false, got ${JSON.stringify(l.skip)}`);
  }
  return errors;
}

/** `over` on top of `base`, key by key (same rule as mergeTests). */
const mergeLayers = (base: LayersConfig | undefined, over: LayersConfig): LayersConfig => ({ ...base, ...over });

/**
 * Validate a partial config and return errors (or empty array if valid).
 * source parameter is for error messages.
 */
function validateConfig(partial: Partial<C4pmConfig>, source: string): string[] {
  const errors: string[] = [];

  if (partial.languages !== undefined) {
    if (!Array.isArray(partial.languages)) {
      errors.push(`${source}: languages must be an array`);
    } else {
      for (const lang of partial.languages) {
        if (!LANGUAGE_IDS.includes(lang)) {
          errors.push(`${source}: unknown language "${lang}" (valid: ${LANGUAGE_IDS.join(', ')})`);
        }
      }
    }
  }

  if (partial.ignore !== undefined) {
    if (!Array.isArray(partial.ignore)) {
      errors.push(`${source}: ignore must be an array`);
    }
  }

  if (partial.tests !== undefined) {
    errors.push(...validateTests(partial.tests, source));
  }

  if (partial.layers !== undefined) {
    errors.push(...validateLayers(partial.layers, source));
  }

  if (partial.failOn !== undefined) {
    if (!FAIL_ON_LEVELS.includes(partial.failOn)) {
      errors.push(`${source}: failOn must be 'critical', 'warning', or 'none', got "${partial.failOn}"`);
    }
  }

  if (partial.viewOnCommit !== undefined) {
    if (typeof partial.viewOnCommit !== 'boolean') {
      errors.push(`${source}: viewOnCommit must be a boolean, got ${JSON.stringify(partial.viewOnCommit)}`);
    }
  }

  if (partial.fileOnlyExtensions !== undefined) {
    const ext = partial.fileOnlyExtensions as unknown;
    if (!Array.isArray(ext) || !ext.every((e) => typeof e === 'string' && e.startsWith('.') && e.length >= 2)) {
      errors.push(`${source}: fileOnlyExtensions must be an array of extensions like ".java"`);
    }
  }

  return errors;
}

/**
 * Load and merge config from all sources (file, env, CLI).
 * Precedence: CLI > env > file > defaults.
 * Validates all sources and returns a fresh config object.
 * Logs where each final value came from.
 */
export function loadConfig(
  repoRoot: string,
  cli?: Partial<C4pmConfig>,
  opts?: { configPath?: string },
): C4pmConfig {
  const tag = 'config';
  const validKeys = new Set([
    'languages', 'ignore', 'store', 'sprint', 'failOn', 'architectureDir', 'viewOnCommit',
    'fileOnlyExtensions', 'tests', 'layers',
  ]);

  // Load file layers, highest priority first: configPath (new), then legacy <repoRoot>/.c4pmrc.json
  const layers: { name: string; filePath: string; raw: Record<string, unknown> }[] = [];
  if (opts?.configPath) {
    const raw = loadConfigFile(opts.configPath);
    if (raw) {
      layers.push({ name: path.basename(opts.configPath), filePath: opts.configPath, raw });
    } else {
      log(tag, 'configPath given but file missing, using legacy file/defaults', { configPath: opts.configPath });
    }
  }
  // Phase 35 B2: the new name wins; the old name is read only when the new file is absent.
  for (const name of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    const rcPath = path.join(repoRoot, name);
    const rcRaw = loadConfigFile(rcPath);
    if (rcRaw) {
      layers.push({ name, filePath: rcPath, raw: rcRaw });
      break;
    }
  }

  const fileConfig: Partial<C4pmConfig> = {};
  const fileSource: Record<string, string> = {};
  const fileErrors: string[] = [];

  for (const layer of layers) {
    const layerConfig: Partial<C4pmConfig> = {};
    const unknownKeys: string[] = [];
    for (const [key, value] of Object.entries(layer.raw)) {
      if (validKeys.has(key)) {
        layerConfig[key as keyof C4pmConfig] = value as never;
      } else {
        unknownKeys.push(key);
      }
    }
    if (unknownKeys.length > 0) {
      log(tag, `Unknown keys in ${layer.name}, ignored`, { keys: unknownKeys });
    }
    fileErrors.push(...validateConfig(layerConfig, layer.name));
    for (const key of Object.keys(layerConfig)) {
      if (key in fileConfig) {
        log(tag, `Key in ${layer.name} shadowed by ${fileSource[key]}`, { key });
      } else {
        (fileConfig as Record<string, unknown>)[key] = (layerConfig as Record<string, unknown>)[key];
        fileSource[key] = layer.name;
      }
    }
  }

  // Load from env
  const { result: envConfig, errors: envParseErrors } = loadConfigEnv();

  // Validate all sources before merging
  const envErrors = [
    ...envParseErrors,
    ...(Object.keys(envConfig).length > 0 ? validateConfig(envConfig, 'env') : []),
  ];
  const cliErrors = cli ? validateConfig(cli, 'cli') : [];

  const allErrors = [...fileErrors, ...envErrors, ...cliErrors];
  if (allErrors.length > 0) {
    throw new Error(allErrors.join('; '));
  }

  // Merge with precedence: cli > env > file > defaults
  const merged: C4pmConfig = { ...DEFAULT_CONFIG };
  const sources: Record<string, string> = {};

  // Apply file config
  if (fileConfig.languages) {
    merged.languages = fileConfig.languages;
    sources.languages = fileSource.languages;
  } else {
    sources.languages = 'defaults';
  }

  if (fileConfig.ignore) {
    merged.ignore = (fileConfig.ignore as string[]).map(normalizeIgnore);
    sources.ignore = fileSource.ignore;
  } else {
    sources.ignore = 'defaults';
  }

  if (fileConfig.store !== undefined) {
    merged.store = fileConfig.store as string | null;
    sources.store = fileSource.store;
  } else {
    sources.store = 'defaults';
  }

  if (fileConfig.sprint !== undefined) {
    merged.sprint = fileConfig.sprint as string | null;
    sources.sprint = fileSource.sprint;
  } else {
    sources.sprint = 'defaults';
  }

  if (fileConfig.failOn) {
    merged.failOn = fileConfig.failOn as FailOn;
    sources.failOn = fileSource.failOn;
  } else {
    sources.failOn = 'defaults';
  }

  if (fileConfig.architectureDir !== undefined) {
    merged.architectureDir = fileConfig.architectureDir as string | null;
    sources.architectureDir = fileSource.architectureDir;
  } else {
    sources.architectureDir = 'defaults';
  }

  if (fileConfig.viewOnCommit !== undefined) {
    merged.viewOnCommit = fileConfig.viewOnCommit as boolean;
    sources.viewOnCommit = fileSource.viewOnCommit;
  } else {
    sources.viewOnCommit = 'defaults';
  }

  if (fileConfig.fileOnlyExtensions) {
    merged.fileOnlyExtensions = fileConfig.fileOnlyExtensions as string[];
    sources.fileOnlyExtensions = fileSource.fileOnlyExtensions;
  }

  if (fileConfig.tests) {
    merged.tests = fileConfig.tests as TestsConfig;
    sources.tests = fileSource.tests;
  }

  if (fileConfig.layers) {
    merged.layers = fileConfig.layers as LayersConfig;
    sources.layers = fileSource.layers;
  }

  // Apply env config (overrides file)
  if (envConfig.languages) {
    merged.languages = envConfig.languages;
    sources.languages = 'env';
  }

  if (envConfig.ignore) {
    merged.ignore = (envConfig.ignore as string[]).map(normalizeIgnore);
    sources.ignore = 'env';
  }

  if (envConfig.store !== undefined) {
    merged.store = envConfig.store as string | null;
    sources.store = 'env';
  }

  if (envConfig.sprint !== undefined) {
    merged.sprint = envConfig.sprint as string | null;
    sources.sprint = 'env';
  }

  if (envConfig.failOn) {
    merged.failOn = envConfig.failOn as FailOn;
    sources.failOn = 'env';
  }

  if (envConfig.architectureDir !== undefined) {
    merged.architectureDir = envConfig.architectureDir as string | null;
    sources.architectureDir = 'env';
  }

  if (envConfig.viewOnCommit !== undefined) {
    merged.viewOnCommit = envConfig.viewOnCommit;
    sources.viewOnCommit = 'env';
  }

  if (envConfig.fileOnlyExtensions) {
    merged.fileOnlyExtensions = envConfig.fileOnlyExtensions;
    sources.fileOnlyExtensions = 'env';
  }

  if (envConfig.tests) {
    merged.tests = mergeTests(merged.tests, envConfig.tests);
    sources.tests = 'env';
  }

  if (envConfig.layers) {
    merged.layers = mergeLayers(merged.layers, envConfig.layers);
    sources.layers = 'env';
  }

  // Apply CLI config (overrides env and file)
  if (cli?.languages) {
    merged.languages = cli.languages;
    sources.languages = 'cli';
  }

  if (cli?.ignore) {
    merged.ignore = cli.ignore.map(normalizeIgnore);
    sources.ignore = 'cli';
  }

  if (cli?.store !== undefined) {
    merged.store = cli.store;
    sources.store = 'cli';
  }

  if (cli?.sprint !== undefined) {
    merged.sprint = cli.sprint;
    sources.sprint = 'cli';
  }

  if (cli?.failOn) {
    merged.failOn = cli.failOn;
    sources.failOn = 'cli';
  }

  if (cli?.architectureDir !== undefined) {
    merged.architectureDir = cli.architectureDir;
    sources.architectureDir = 'cli';
  }

  if (cli?.viewOnCommit !== undefined) {
    merged.viewOnCommit = cli.viewOnCommit;
    sources.viewOnCommit = 'cli';
  }

  if (cli?.fileOnlyExtensions) {
    merged.fileOnlyExtensions = cli.fileOnlyExtensions;
    sources.fileOnlyExtensions = 'cli';
  }

  if (cli?.tests) {
    merged.tests = mergeTests(merged.tests, cli.tests);
    sources.tests = 'cli';
  }

  if (cli?.layers) {
    merged.layers = mergeLayers(merged.layers, cli.layers);
    sources.layers = 'cli';
  }

  // Log sources
  log(tag, 'languages', { value: merged.languages, source: sources.languages });
  log(tag, 'ignore', { value: merged.ignore, source: sources.ignore });
  log(tag, 'store', { value: merged.store, source: sources.store });
  log(tag, 'sprint', { value: merged.sprint, source: sources.sprint });
  log(tag, 'failOn', { value: merged.failOn, source: sources.failOn });
  log(tag, 'architectureDir', { value: merged.architectureDir, source: sources.architectureDir });
  log(tag, 'viewOnCommit', { value: merged.viewOnCommit, source: sources.viewOnCommit });
  log(tag, 'fileOnlyExtensions', { value: merged.fileOnlyExtensions, source: sources.fileOnlyExtensions ?? 'defaults' });
  log(tag, 'tests', { value: merged.tests, source: sources.tests ?? 'defaults' });
  log(tag, 'layers', { value: merged.layers, source: sources.layers ?? 'defaults' });

  return merged;
}

/**
 * Initialize a config file at <repoRoot>/.c4pmrc.json.
 * Writes DEFAULT_CONFIG in pretty JSON with a trailing newline.
 * Throws if the file already exists.
 * Returns the path to the file that was written.
 */
export function initConfig(repoRoot: string): string {
  const filePath = path.join(repoRoot, CONFIG_FILE);

  if (fs.existsSync(filePath)) {
    throw new Error(`Config file already exists at ${filePath}`);
  }

  const content = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}
