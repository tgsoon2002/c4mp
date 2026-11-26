import * as fs from 'fs';
import * as path from 'path';
import type { Container, RunCommand } from '../types';
import type { LanguageDescriptor, TestRunnerProbe } from './define';
import { LANGUAGES } from './registry';
import { getHandlers, handlerFor } from './index';
import { log } from '../log';

// Phase 26 (T26-9, D12): the command that runs one test case. A language says in its descriptor (`testRunner`)
// which runners it knows, how each shows in a container root (manifest content or a config file) and its
// command template. Config `tests.command` wins over detection. The command runs in the container root, so
// `{file}` is relative to it. No runner and no config: no command (never a guessed default).

/** The runner of one container and language: a command template, or why there is none. */
export type TestRunner =
  | { id: string; template: string; cwd: string; name: (name: string) => string }
  | { id: null; reason: string };

/** The ` (2)`, ` (3)` a repeated case name gets in the outline (T26-4); runners know only the written title. */
const DEDUPE_SUFFIX = / \(\d+\)$/;
const PLACEHOLDER = /\{(file|name|nameRegex)\}/g;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Safe inside double quotes in a POSIX shell (and unquoted, for names without spaces). */
const escapeShell = (s: string): string => s.replace(/[\\"$`]/g, '\\$&');

/** Files of the container root that a probe looks at (sorted entry names). */
function probeFiles(entries: string[], probe: TestRunnerProbe, lang: LanguageDescriptor): string[] {
  const { file } = probe;
  if (typeof file === 'string') return entries.includes(file) ? [file] : [];
  if (file) return entries.filter((n) => file.test(n));
  const names = Object.keys(lang.manifests ?? {});
  const suffixes = Object.keys(lang.suffixManifests ?? {});
  return entries.filter((n) => names.includes(n) || suffixes.some((s) => n.endsWith(s)));
}

/**
 * The test runner of `container` for `languageId`: the `command` template (config `tests.command`) when given,
 * else the first runner of the language's descriptor whose probe matches a file of the container root.
 */
export function detectTestRunner(repoRoot: string, container: Container, languageId: string, command?: string): TestRunner {
  const lang = LANGUAGES.handlers[languageId];
  if (!lang) throw new Error(`Unknown language: ${languageId}`);
  const spec = lang.testRunner;
  const name = (n: string): string => {
    const base = n.replace(DEDUPE_SUFFIX, '');
    return spec?.name ? spec.name(base) : base;
  };
  const cwd = container.path;
  if (command) return { id: 'config', template: command, cwd, name };

  const dir = path.join(repoRoot, cwd);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  const matches = (probe: TestRunnerProbe): boolean => probeFiles(entries, probe, lang).some((f) =>
    !probe.contains || probe.contains.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  const runner = spec?.runners.find((r) => r.detect.some(matches));
  log('tests', 'runner', { container: container.id, language: languageId, runner: runner?.id ?? null });
  if (runner) return { id: runner.id, template: runner.command, cwd, name };
  const looked = spec ? `no ${spec.runners.map((r) => r.id).join(', ')} found` : 'no runner known';
  return { id: null, reason: `${languageId} tests in ${cwd}: ${spec?.unknown ?? looked}; set config tests.command` };
}

/**
 * The command that runs the case `name` (outline name) of the test file `file` (repo-relative), or null when the
 * runner is unknown. Placeholders: {file} relative to the container root, {name} as the runner writes it,
 * {nameRegex} the same as a regular expression; each escaped for a double-quoted shell word.
 */
export function testRunCommand(runner: TestRunner, file: string, name: string): RunCommand | null {
  if (runner.id === null) return null;
  const root = runner.cwd === '.' ? '' : `${runner.cwd}/`;
  if (!file.startsWith(root)) throw new Error(`test file ${file} is outside the container root ${runner.cwd}`);
  const runName = runner.name(name);
  const values: Record<string, string> = { file: file.slice(root.length), name: runName, nameRegex: escapeRegex(runName) };
  return { command: runner.template.replace(PLACEHOLDER, (_m, key: string) => escapeShell(values[key])), cwd: runner.cwd };
}

/** The runner of a test file in no container, or in a language the scan does not read. */
export const NO_RUNNER: TestRunner = { id: null, reason: 'the test file is in no container, or its language is not scanned' };

/** The runner of a test file (repo-relative); `{ id: null, reason }` when there is none. */
export type RunnerOf = (file: string) => TestRunner;

/** The container whose root holds `file`: the longest path prefix (as grouper/components.ts assigns files). */
function containerOfFile(containers: Container[], file: string): Container | null {
  let best: Container | null = null;
  let bestLength = -1;
  for (const c of containers) {
    const root = c.path === '.' ? '' : c.path + '/';
    if (file.startsWith(root) && root.length > bestLength) { best = c; bestLength = root.length; }
  }
  return best;
}

/**
 * Binds detectTestRunner for the files of one scan: runner per container and language, detected once. One lookup for
 * the map page, `plan show`, `show` and MCP. `command` is config `tests.command` (wins over detection).
 */
export function testRunnerOf(repoRoot: string, containers: Container[], languages: string[], command?: string): RunnerOf {
  const handlers = getHandlers(languages);
  const memo = new Map<string, TestRunner>();
  return (file) => {
    const container = containerOfFile(containers, file);
    const handler = handlerFor(file, handlers);
    if (!container || !handler) return NO_RUNNER;
    const key = `${container.id}\0${handler.id}`;
    if (!memo.has(key)) memo.set(key, detectTestRunner(repoRoot, container, handler.id, command));
    return memo.get(key)!;
  };
}
