import { Command, Option } from 'commander';
import { LANGUAGE_IDS, LANGUAGES, defaultRepoRoot } from './scan/project';
import { FAIL_ON_LEVELS } from './constants';

/**
 * Shared option definitions and help text for bin/cli.ts, so each option is described once.
 * Facts here were checked against src/ (config.ts defaults, history/store.ts resolveRef,
 * outputs.ts store precedence, report/github.ts exit codes).
 */

/** b570: the languages whose functions and imports c4mp reads, from the language registry (never typed here). */
const PARSED_LANGUAGES = LANGUAGES.ids.join(', ');

export const PROGRAM_DESCRIPTION =
  'Architecture-first project tool: zoomable C4 map, task boards, simulations\n\n' +
  'c4mp scans a code base into a C4 map: system, containers, components,\n' +
  'files, functions. It compares the map with a plan you write in .c4 text\n' +
  'files, keeps one snapshot per git commit, and writes an HTML page you open\n' +
  'in a browser.\n' +
  `Languages (--lang): ${PARSED_LANGUAGES}.`;

export const PROGRAM_HELP_AFTER = `
Quick start (replace . with your code folder):
  c4mp init --repo .               only if there is no .git above the folder
  c4mp history --repo . --max 20   one snapshot per recent git commit
  c4mp view --repo . --open        write the map page and open it
  c4mp install-hooks --repo .      keep history and page current on every commit
  Other languages: add --lang with their ids to every scan command (default
  typescript), e.g. --lang typescript,python. c4mp languages checks them.

Concepts:
  .c4mp/       internal data and your plan, at the anchor. Commit it; its own
               .gitignore skips the regenerable data/ and history/.
               An older repo has .c4pm/ instead: it is read as it is; c4mp
               migrate moves it.
  anchor       nearest folder at or above --repo that holds .git (or .c4mp).
  repoId       project folder name: package.json name, else the folder name,
               lower-cased with dashes. Data lives in .c4mp/projects/<repoId>/.
  C4MP/        generated page <repoId>/c4mpView.html at the anchor; it ignores
               itself, so git sees nothing in it.
  .c4 files    the plan: human-written architecture (names, relations, links to
               code, status). Normally in .c4mp/projects/<repoId>/plan/.
  snapshot     one saved scan result: files, functions, imports, components.
  drift        what changed in the architecture between two snapshots.
  ref          a snapshot named on --from/--to: prev, latest, oldest, a snapshot
               id (see c4mp snapshots), a commit hash prefix (4+ hex chars) or
               a date YYYY-MM-DD (the last snapshot on or before that day).

Config (settings, lowest priority first):
  built-in defaults < .c4mp/config.json (or <repo>/.c4mprc.json; old names
                    .c4pm/config.json, .c4pmrc.json also read)
                    < C4MP_* environment variables < command-line flags.
  Keys: languages (default typescript), ignore (default none), store, sprint,
  failOn (none), architectureDir, viewOnCommit (default true: the git hooks also
  rewrite c4mpView.html after each commit), tests (object: globs = test files,
  default **/*.test.*, **/test/ and the like; ignoreReach; command), layers
  (object: skip = true turns on the check rule layer-skip: an entry point
  that skips the services).
  Env: C4MP_LANGUAGES, C4MP_IGNORE, C4MP_TESTS (tests.globs), C4MP_STORE,
  C4MP_SPRINT, C4MP_FAIL_ON, C4MP_ARCHITECTURE_DIR, C4MP_VIEW_ON_COMMIT,
  C4MP_LAYERS_SKIP (layers.skip). The old C4PM_* names are still read
  (C4MP_* wins).
  Scans currently take languages only from --lang.
  See: c4mp config show, c4mp config init.

Exit codes:
  0 success.  1 an error, or (check and diff) a finding at or above --fail-on.
  --fail-on none (default) never fails on findings; warning also fails on
  critical; critical fails only on critical.

Run c4mp <command> --help for details and examples.
`;

/** Text for one shared option; `choices` = the only values it takes (commander refuses any other, exit 1). */
interface OptionSpec {
  flags: string;
  description: string;
  choices?: readonly string[];
}

/**
 * b707: an option that takes one of `choices` (commander lists them in the help and refuses any other value with exit 1,
 * so a typo can never fall back to a default and hide findings in CI).
 */
export function choiceOption(flags: string, description: string, choices: readonly string[], defaultValue?: string): Option {
  const option = new Option(flags, description).choices(choices);
  return defaultValue === undefined ? option : option.default(defaultValue);
}

const REPO: OptionSpec = {
  flags: '--repo <path>',
  description: 'path to the code folder to scan (the git root or a folder inside it)',
};

/** How the --repo default shows in help (the value itself is defaultRepoRoot() of the working folder). */
const REPO_DEFAULT_TEXT = 'the folder that holds .c4mp, found from the working folder';

const SCAN_OPTIONS = {
  lang: {
    flags: '--lang <ids>',
    description:
      `comma-separated languages to scan: ${LANGUAGE_IDS.join(', ')} (default: typescript). ` +
      "'files' lists files of other languages (java, go, ...) without reading functions; " +
      'off by default; extensions: config key fileOnlyExtensions. ' +
      'Pass the same value to every command',
  },
  ignore: {
    flags: '--ignore <patterns>',
    description:
      'comma-separated repo-relative patterns to skip: folder prefix, file path, or glob (* ** ?), ' +
      'e.g. dist,src/gen.ts,**/*.test.ts (default: none). Also applies to .c4 discovery; ' +
      'a pattern that matches nothing is reported as a scan warning',
  },
  tests: {
    flags: '--tests <patterns>',
    description:
      'comma-separated patterns of test files (role test), same syntax as --ignore; replaces config tests.globs ' +
      '(default: the usual test file and folder names, e.g. **/*.test.*, **/test/; full list in the guide)',
  },
  store: {
    flags: '--store <dir>',
    description: 'history store folder (default: config store, else <anchor>/.c4mp/projects)',
  },
  sprint: {
    flags: '--sprint <s>',
    description: 'current sprint, e.g. S15; plan items from earlier sprints that are not done become "late"',
  },
  failOn: {
    flags: '--fail-on <level>',
    description: 'exit 1 when a finding reaches this level; none (the default, else config failOn) never fails',
    choices: FAIL_ON_LEVELS,
  },
  debug: {
    flags: '--debug [tags]',
    description: 'print debug logs: comma-separated tags, or no value for all (same as C4MP_DEBUG)',
  },
} satisfies Record<string, OptionSpec>;

export type ScanOption = keyof typeof SCAN_OPTIONS;

/** Add --repo with the shared default (defaultRepoRoot); `description` overrides the default text for one command. */
export function addRepo(cmd: Command, description?: string): Command {
  // R7: --repo is optional; without it the folder that holds .c4mp (found from the working folder) is used.
  return cmd.addOption(new Option(REPO.flags, description ?? REPO.description).default(defaultRepoRoot(), REPO_DEFAULT_TEXT));
}

/** Add --repo as an optional option (diff, hook) with its own text. */
export function addOptionalRepo(cmd: Command, description: string): Command {
  return cmd.option(REPO.flags, description);
}

/** Add the shared scan/config options listed in `names`, in that order. */
export function addScanOptions(cmd: Command, names: ScanOption[]): Command {
  for (const n of names) {
    const spec: OptionSpec = SCAN_OPTIONS[n];
    if (spec.choices) cmd.addOption(choiceOption(spec.flags, spec.description, spec.choices));
    else cmd.option(spec.flags, spec.description);
  }
  return cmd;
}

/** Number option from commander's string; undefined when absent. A non-number becomes NaN, which the caller's range check refuses (the query layer as `invalid`, wholeNumberOpt). */
export function numberOpt(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** b708: why `raw` is not a whole number of `min` or more (`<flag> must be a whole number of <min> or more, got '<raw>'`), or null when it is one. */
export function wholeNumberProblem(flag: string, raw: unknown, min: number): string | null {
  const n = numberOpt(raw);
  return n !== undefined && Number.isInteger(n) && n >= min ? null : `${flag} must be a whole number of ${min} or more, got '${String(raw)}'`;
}

/** b708: a whole number option of `min` or more; undefined when absent. Throws wholeNumberProblem's message for any other value. */
export function wholeNumberOpt(flag: string, raw: unknown, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const problem = wholeNumberProblem(flag, raw, min);
  if (problem !== null) throw new Error(problem);
  return Number(raw);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** b708: an ISO 8601 date option (YYYY-MM-DD, optionally with a time); undefined when absent. Throws for anything else (`2026-13-45` too). */
export function isoDateOpt(flag: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw);
  const m = ISO_DATE.exec(text);
  const day = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  const real = day !== null && m !== null && day.getUTCMonth() === Number(m[2]) - 1 && day.getUTCDate() === Number(m[3]);
  if (!real || Number.isNaN(Date.parse(text))) throw new Error(`${flag} must be an ISO 8601 date (YYYY-MM-DD), got '${text}'`);
  return text;
}

/** Append an "Examples:" block (lines are written without indentation). */
/** b908: the collector of a repeatable commander option (`--meta a --meta b` gives ['a', 'b']). */
export const collectValues = (v: string, prev: string[] = []): string[] => [...prev, v];

export function addExamples(cmd: Command, lines: string[]): Command {
  return cmd.addHelpText('after', '\nExamples:\n' + lines.map(l => (l ? `  ${l}` : '')).join('\n') + '\n');
}
