#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command, Option } from 'commander';
import { showPlanElement as showPlanTarget, planShowJson, formatPlanShow, formatPlanShowError, planOverview, NO_PLAN_MESSAGE } from '../src/query/planShow';
import { loadQueryContext } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { log } from '../src/log';
import { CMD_NAME, CONFIG_FILE, LEGACY_CMD_NAME, MIN_SEVERITIES, TOOL_VERSION } from '../src/constants';
import { startWatch } from '../src/scan/watchSession';
import { openProject, setupProject, createConfig } from '../src/scan/project';
import { takeSnapshot, recordHistory, listSnapshots, diffSnapshots } from '../src/scan/snapshots';
import type { IgnoreFolderEdit } from '../src/scan/project';
import { installHooks, uninstallHooks } from '../src/hooks';
import { runHook } from '../src/hookRun';
import { writeProjectView } from '../src/page/viewExport';
import { formatGithubFindings, exitCodeFor } from '../src/report/github';
import { formatDiff } from '../src/report/diff';
import type { DiffFormat } from '../src/report/diff';
import type { Plan, C4pmConfig, FailOn, Severity } from '../src/types';
import { listTopics, readGuide } from '../src/guide';
import { buildSkill, removeLegacySkill, writeSkillFile } from '../src/guideSkill';
import type { SkillFormat } from '../src/guideSkill';
import {
  PROGRAM_DESCRIPTION,
  PROGRAM_HELP_AFTER,
  addRepo,
  addOptionalRepo,
  addScanOptions,
  addExamples,
  choiceOption,
  isoDateOpt,
  wholeNumberOpt,
} from '../src/cliHelp';

import { runCheck } from '../src/query/check';
import { formatFindings } from '../src/query/format';
import { findStubs } from '../src/query/stubs';
import { resolveLink } from '../src/query/resolveLink';
import { runStatus, formatStatusLines } from '../src/query/status';
import { registerQueryCommands } from '../src/queryCli';
import { registerBoardCommands } from '../src/cli/board';
import { registerSimCommands } from '../src/cli/sim';
import { registerPlanEditCommands } from '../src/cli/planEdit';
import { registerMoveCommands } from '../src/cli/moveCmd';
import { registerUpgradeCommand } from '../src/cli/upgradeCmd';
import { registerEditCommands } from '../src/cli/editCmd';
import { removeTestAction } from '../src/cli/addCmd';
import { planMoveService } from '../src/services/planMove';
import { planUpgradeService } from '../src/services/planUpgrade';
import { generatePlan } from '../src/services/planGenerate';
import { applyLayoutFile, backfillPlanIds, removeElement } from '../src/services/planFileEdits';
import { planGroup, registerPlanCommand } from '../src/cli/planGroup';
import { CommandRefused, addViewOption, checkRepoOption, emitError, emitThrown, formatErrorText, noteLegacyCommandName, parseView, runAction } from '../src/cli/common';
import { isViewGenerate, runGenerateView } from '../src/cli/generateView';
import { registerInstallCommands } from '../src/cli/installCmd';
import { registerLanguagesCommand } from '../src/cli/languagesCmd';
import { registerMigrateCommand } from '../src/cli/migrateCmd';
import { registerServeCommand } from '../src/cli/serveCmd';
import { openInBrowser } from '../src/cli/openBrowser';

const program = new Command();

program
  .name(CMD_NAME)
  .description(PROGRAM_DESCRIPTION)
  .version(TOOL_VERSION.split('@')[1])
  .addHelpText('after', PROGRAM_HELP_AFTER);

/**
 * b706: a command failed: its message on stderr, exit code 1. Commands set process.exitCode and return, never
 * process.exit: it ends the process before a piped stdout is flushed (output cut at 8 KB, src/cli/common.ts).
 */
function failWith(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

/**
 * Helper to parse comma-separated values
 */
function parseList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Helper to build CLI config overrides from command options
 */
function buildCliConfig(opts: Record<string, unknown>): Partial<C4pmConfig> {
  const cliConfig: Partial<C4pmConfig> = {};

  if (opts.lang) {
    cliConfig.languages = parseList(opts.lang as string);
  }

  if (opts.ignore) {
    cliConfig.ignore = parseList(opts.ignore as string);
  }

  if (opts.tests) {
    cliConfig.tests = { globs: parseList(opts.tests as string) };
  }

  if (opts.store) {
    cliConfig.store = opts.store as string;
  }

  if (opts.sprint) {
    cliConfig.sprint = opts.sprint as string;
  }

  if (opts.failOn) {
    cliConfig.failOn = opts.failOn as FailOn;
  }

  return cliConfig;
}

// Create config subcommands
const configCmd = new Command('config')
  .description('Create or show c4mp settings (subcommands: init, show)');

const configInit = addRepo(
  new Command('init').description(`Write a default ${CONFIG_FILE} into the repo folder (fails if it already exists)`),
  `folder that gets the ${CONFIG_FILE} file`,
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const configPath = createConfig(repoRoot);
      console.log(configPath);
    } catch (err) {
      failWith(err);
    }
  });

const configShow = addScanOptions(
  addRepo(
    new Command('show').description(
      `Print the effective settings as JSON (defaults, then ${CONFIG_FILE}, then C4MP_* env vars, then flags)`,
    ),
  ),
  ['lang', 'ignore', 'tests', 'store', 'sprint', 'failOn'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const { config } = openProject(repoRoot, buildCliConfig(opts));
      console.log(JSON.stringify(config, null, 2));
    } catch (err) {
      failWith(err);
    }
  });

configCmd.addCommand(configInit);
configCmd.addCommand(configShow);
const initCmd = addRepo(
  new Command('init').description(
    'Create the .c4mp/ project folders (works without git). ' +
      'Safe to repeat, never overwrites. Creates config.json, .gitignore and data/, history/, plan/ folders; ' +
      'prints what it created and the anchor',
  ),
  'code folder to initialise',
)
  .action((opts: Record<string, unknown>) => {
    try {
      const result = setupProject(path.resolve(opts.repo as string));
      if (result.created.length === 0) {
        console.log('already initialised');
      } else {
        for (const p of result.created) console.log(p);
      }
      console.log(`anchor: ${result.anchor}`);
    } catch (err) {
      failWith(err);
    }
  });

addExamples(initCmd, [
  'c4mp init --repo .                  create .c4mp/ next to the code (or at the git root above it)',
  'c4mp init --repo ~/work/shop/api    a code folder inside a git repository',
]);
addExamples(configInit, ['c4mp config init --repo .']);
addExamples(configShow, [
  'c4mp config show --repo .',
  'c4mp config show --repo . --lang typescript,python --fail-on warning',
]);

program.addCommand(configCmd);
program.addCommand(initCmd);

addScanOptions(
  addRepo(
    program
      .command('status')
      .description(
        'Show snapshot, history, plan and config status. ' +
          'Prints four lines (snapshot size, stored history, plan findings, effective config); scans, writes nothing',
      ),
  ),
  ['lang', 'ignore', 'tests', 'store', 'sprint'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      for (const line of formatStatusLines(runStatus(repoRoot, buildCliConfig(opts)))) console.log(line);
    } catch (err) {
      failWith(err);
    }
  });

addScanOptions(
  addRepo(
    program
      .command('watch')
      .description(
        'Re-scan when source files change. ' +
          'Prints what changed (components, files, functions, critical/warning items); runs until Ctrl+C, writes nothing',
      ),
  )
    .option('--debounce <ms>', 'wait this many milliseconds after the last file change before re-scanning', '2000'),
  ['lang', 'ignore', 'tests'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const debounceMs = wholeNumberOpt('--debounce', opts.debounce, 0) as number;   // has a default
      const stop = startWatch(repoRoot, buildCliConfig(opts), {
        debounceMs,
        onScanStart: (files) => {
          if (files) {
            console.log(`[${new Date().toISOString()}] Changed: ${files.join(', ')}`);
          } else {
            console.log(`[${new Date().toISOString()}] Initial snapshot...`);
          }
        },
        onSnapshot: (diff) => {
          const s = diff.summary;
          console.log(
            `[${new Date().toISOString()}] Summary: components +${s.componentsAdded} -${s.componentsRemoved} | ` +
            `files +${s.filesAdded} -${s.filesRemoved} | ` +
            `functions +${s.elementsAdded} -${s.elementsRemoved}`
          );

          // Print critical and warning messages
          for (const change of diff.changes) {
            if (change.severity === 'critical') {
              console.log(`  [CRITICAL] ${change.id}: ${change.kind}`);
            } else if (change.severity === 'warning') {
              console.log(`  [WARNING] ${change.id}: ${change.kind}`);
            }
          }
        },
        onError: (err) => {
          if (err instanceof Error) {
            console.error(`Error: ${err.message}`);
          } else {
            console.error(String(err));
          }
        },
      });

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        console.log('\nStopping...');
        stop();
        process.exit(0);
      });
    } catch (err) {
      failWith(err);
    }
  });

const installHooksCmd = addScanOptions(
  addRepo(
    program
      .command('install-hooks')
      .description(
        'Install git hooks that keep history current. ' +
          'The post-commit and post-merge hooks run in the background and never block git. ' +
          'post-commit records the new commit; post-merge records the merge result (and the state before it when not ' +
          'stored yet) and writes the drift before vs after to last-drift.txt. Both (if viewOnCommit is true, the ' +
          'default) rewrite c4mpView.html. One hook runs at a time per project (the next one waits); each run adds a ' +
          'line to last-hook.txt in the project data folder. `c4mp history` records the full timeline. ' +
          'Existing hook content is kept; remove with uninstall-hooks',
      ),
    'git repository to install the hooks in',
  ),
  ['store'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      // Embed a store only when the user asked for one (flag or config); otherwise the hook resolves the default at run time.
      const { store } = openProject(repoRoot, buildCliConfig(opts), { store: 'set' });
      const cliFallback = process.argv[1] && process.argv[1].endsWith('.js') ? path.resolve(process.argv[1]) : undefined;
      log('cli', 'install-hooks', { repoRoot, store, cliFallback });
      const hookFiles = installHooks(repoRoot, { store: store ?? undefined, cliFallback });
      for (const hookFile of hookFiles) {
        console.log(hookFile);
      }
    } catch (err) {
      failWith(err);
    }
  });

addExamples(installHooksCmd, [
  'c4mp install-hooks --repo .',
  'c4mp install-hooks --repo . --store /data/c4mp-store   keep history outside the repo',
  'c4mp uninstall-hooks --repo .                          undo it',
]);

addScanOptions(
  addOptionalRepo(
    program
      .command('hook <kind>', { hidden: true })
      .description('Internal: run by the git hooks (post-commit | post-merge). Never fails.'),
    'scan target',
  ),
  ['store'],
)
  // the hook block passes the shas it read when git fired the hook (hidden like the command)
  .addOption(new Option('--head <sha>', 'HEAD when the hook fired').hideHelp())
  .addOption(new Option('--orig-head <sha>', 'ORIG_HEAD when the hook fired (post-merge)').hideHelp())
  .action((kind: string, opts: Record<string, unknown>) => {
    // Never fails: even a missing --repo only logs.
    runHook(kind, path.resolve((opts.repo as string | undefined) ?? '.'), {
      store: opts.store as string | undefined,
      head: opts.head as string | undefined,
      origHead: opts.origHead as string | undefined,
    });
    process.exit(0);
  });

addRepo(
  program
    .command('uninstall-hooks')
    .description(
      'Remove the c4mp git hooks. ' +
        'Takes the c4mp blocks out of post-commit and post-merge (other hook content is kept) and prints the hook files',
    ),
  'git repository to remove the hooks from',
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const hookFiles = uninstallHooks(repoRoot);
      for (const hookFile of hookFiles) {
        console.log(hookFile);
      }
    } catch (err) {
      failWith(err);
    }
  });

const snapshotCmd = addScanOptions(
  addRepo(
    program
      .command('snapshot')
      .description(
        'Scan the code and write the data files. ' +
          'Writes outline, imports, components and snapshot.json into data/; with --save, also stores the snapshot in history',
      ),
  )
    .option('--out <dir>', 'folder for the data files (default: <anchor>/.c4mp/projects/<repoId>/data)')
    .option('--save', 'also store this snapshot in the history store (see --store)'),
  ['store', 'lang', 'ignore', 'tests', 'debug'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      // Set C4MP_DEBUG environment variable based on --debug flag
      if (opts.debug !== undefined && opts.debug !== false) {
        process.env.C4MP_DEBUG = opts.debug === true ? '*' : String(opts.debug);
      }

      // --out wins; otherwise the project data dir (fails with the init hint when no anchor)
      const { saved } = takeSnapshot(path.resolve(opts.repo as string), buildCliConfig(opts), {
        out: opts.out as string | undefined,
        save: Boolean(opts.save),
      });
      if (saved) console.log(`saved to history: ${saved.id}`);
    } catch (err) {
      process.exitCode = emitThrown(opts, 'snapshot', err);   // b723: a write command, one failure printer
    }
  });

const historyCmd = addScanOptions(
  addRepo(
    program
      .command('history')
      .description(
        'Build one snapshot per git commit. ' +
          'Snapshots the newest --max commits into the history store so diff can compare them; ' +
          'needs a git repository, prints one line per commit',
      ),
    'git repository to read commits from',
  )
    .option('--max <n>', 'maximum number of commits to snapshot, newest first', '20')
    .option('--since <date>', 'only commits since this date (ISO 8601, e.g. 2026-01-01)'),
  ['store', 'lang', 'ignore', 'tests'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      recordHistory(path.resolve(opts.repo as string), buildCliConfig(opts), {
        max: wholeNumberOpt('--max', opts.max, 1) as number,   // has a default
        since: isoDateOpt('--since', opts.since),
      });
    } catch (err) {
      failWith(err);
    }
  });

addScanOptions(
  addRepo(
    program
      .command('snapshots')
      .description(
        'List stored snapshots. Prints id, short commit, date and counts for each, then the folder they are in',
      ),
  ),
  ['store'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const { entries, dir } = listSnapshots(path.resolve(opts.repo as string), buildCliConfig(opts));

      for (const entry of entries) {
        const commit = entry.commit ? entry.commit.slice(0, 7) : 'nogit';
        const date = (entry.commitDate ?? entry.createdAt).slice(0, 10);
        const comp = entry.stats.components;
        const files = entry.stats.files;
        const elem = entry.stats.codeElements;
        console.log(`${entry.id}  ${commit}  ${date}  ${comp} comp  ${files} files  ${elem} elem`);
      }

      console.log(`${entries.length} snapshots in ${dir}`);
    } catch (err) {
      failWith(err);
    }
  });

const diffCmd = program
  .command('diff')
  .description(
    'Compare two snapshots (the drift). ' +
      'Shows parts that grew, shrank, appeared, disappeared or gained dependencies, between stored snapshots ' +
      '(--repo with --from/--to) or two snapshot files (--a/--b). ' +
      'Exits 1 if a change reaches --fail-on',
  );
diffCmd
  .option('--a <file>', 'first snapshot.json file (use with --b instead of --repo)')
  .option('--b <file>', 'second snapshot.json file (use with --a instead of --repo)');
addOptionalRepo(diffCmd, 'code folder whose stored snapshots to compare (needs c4mp history first)');
diffCmd
  .option('--from <ref>', 'older snapshot: prev, latest, oldest, a snapshot id, a commit hash prefix or YYYY-MM-DD', 'prev')
  .option('--to <ref>', 'newer snapshot, same kinds of ref as --from', 'latest');
addScanOptions(diffCmd, ['store']);
diffCmd
  .addOption(choiceOption('--format <fmt>', 'output format', ['text', 'markdown', 'github', 'json'], 'text'))
  .addOption(choiceOption('--min-severity <level>', 'hide changes below this level', MIN_SEVERITIES, 'info'));
addScanOptions(diffCmd, ['failOn']);
diffCmd
  .option('--write <file>', 'write the output to this file instead of printing it')
  .action((opts: Record<string, unknown>) => {
    try {
      if (!(opts.a && opts.b) && !opts.repo) {
        console.error('Either --a and --b, or --repo must be specified');
        process.exitCode = 1;
        return;
      }
      // --a/--b compare two files (--repo then only gives the config); else the stored snapshots of --repo
      const { diff, failOn } = diffSnapshots(
        opts.repo ? path.resolve(opts.repo as string) : null,
        buildCliConfig(opts),
        opts.a && opts.b
          ? { files: { a: opts.a as string, b: opts.b as string } }
          : { refs: { from: opts.from as string, to: opts.to as string } },
      );

      // Filter by severity
      const severityLevels: Record<string, number> = { critical: 2, warning: 1, info: 0 };
      const minSevLevel = severityLevels[(opts.minSeverity ?? 'info') as string] ?? 0;
      if (minSevLevel > 0) {
        diff.changes = diff.changes.filter(c => severityLevels[c.severity] >= minSevLevel);
      }

      // Format output: json here, the text formats in Report (b707: commander refuses any other --format)
      const output = opts.format === 'json' ? JSON.stringify(diff, null, 2) : formatDiff(diff, opts.format as DiffFormat);

      // Write or print
      if (opts.write) {
        fs.writeFileSync(opts.write as string, output);
      } else {
        console.log(output);
      }

      // Handle fail-on, from merged config (file < env < CLI), not just the raw CLI flag
      const severities = diff.changes.map(c => c.severity);
      process.exitCode = exitCodeFor(severities, failOn);
    } catch (err) {
      failWith(err);
    }
  });

addExamples(historyCmd, [
  'c4mp history --repo .                          the 20 newest commits',
  'c4mp history --repo . --max 50 --since 2026-01-01 --lang typescript,python',
]);
addExamples(snapshotCmd, [
  'c4mp snapshot --repo .                         write data/ files only',
  'c4mp snapshot --repo . --save                  also add it to history',
  'c4mp snapshot --repo . --out ./out --lang typescript,python',
]);
addExamples(diffCmd, [
  'c4mp diff --repo .                             previous vs latest snapshot',
  'c4mp diff --repo . --from <commit-hash> --to latest --format markdown',
  'c4mp diff --repo . --from oldest --to latest --min-severity warning',
  'c4mp diff --repo . --format github --fail-on critical     for CI',
  'c4mp diff --a before/snapshot.json --b after/snapshot.json',
]);

// b252: `c4mp plan` groups the c-item commands; registerPlanCommand (src/cli/planGroup.ts) adds each one below.
planGroup(program);

/** `plan show` without a target: counts, then each element and each parse issue. */
function showPlanOverview(opts: Record<string, unknown>): void {
  try {
    // b273: --view lists only the elements of that view (its kinds); absent = everything, as before.
    const view = opts.view === undefined ? null : parseView(opts);
    if (view !== null && typeof view !== 'string') {
      process.exitCode = emitError(opts, 'show', view);
      return;
    }
    const overview = planOverview(path.resolve(opts.repo as string), view);
    if (overview === null) {
      console.log(NO_PLAN_MESSAGE);
      return;
    }
    const { elements: shown, relations, issues } = overview;

    // Print summary
    console.log(
      `${overview.fileCount} .c4 files, ${shown.length} elements${view === null ? '' : ` (${view} view)`}, ${relations.length} relations, ${issues.length} issues`
    );

    // Print elements
    for (const el of shown) {
      const status = el.metadata.status ? ` [${el.metadata.status}]` : '';
      console.log(`  ${el.id}  [${el.kind}] ${el.title}${status}`);
    }

    // Print issues
    for (const issue of issues) {
      console.log(`${issue.file}:${issue.line} ${issue.message}`);
    }
  } catch (err) {
    failWith(err);
  }
}

const checkCmd = addScanOptions(
  addRepo(
    program
      .command('check')
      .description(
        'Check the plan against the code. ' +
          'Validates the .c4 plan and compares it with the code; prints findings (severity, rule, id, message). ' +
          'Writes nothing. Exits 1 if a finding reaches --fail-on',
      ),
  ),
  ['lang', 'ignore', 'tests', 'sprint'],
)
  .addOption(choiceOption('--format <fmt>', 'output format', ['text', 'github', 'json'], 'text'))
  .addOption(choiceOption('--min-severity <level>', 'hide findings below this level', MIN_SEVERITIES, 'info'));
addScanOptions(checkCmd, ['failOn']);
checkCmd
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const cliConfig = buildCliConfig(opts);
      // Plan first, snapshot built with it, checkPlan, severity filter: all in runCheck
      const result = runCheck(repoRoot, cliConfig, {
        sprint: opts.sprint as string | undefined,
        minSeverity: opts.minSeverity as Severity | undefined,
      });

      if (!result) {
        // b566: --format json keeps its shape (an empty findings array) on stdout; the note goes to stderr.
        if (opts.format === 'json') {
          console.log('[]');
          console.error(NO_PLAN_MESSAGE);
        } else console.log(NO_PLAN_MESSAGE);
        return;
      }
      const { config, repoName } = result;
      // result.findings = plan + board findings from collectFindings, the same source as MCP, status and the page.
      const filtered = result.findings;

      // Format output
      let output: string;

      if (opts.format === 'github') {
        output = formatGithubFindings(filtered, repoName);
      } else if (opts.format === 'json') {
        output = JSON.stringify(filtered, null, 2);
      } else {
        output = formatFindings(filtered, repoName);
      }

      console.log(output);

      // Handle fail-on, from merged config (file < env < CLI), not just the raw CLI flag
      const severities = filtered.map(f => f.severity);
      process.exitCode = exitCodeFor(severities, config.failOn);
    } catch (err) {
      failWith(err);
    }
  });

addExamples(checkCmd, [
  'c4mp check --repo .',
  'c4mp check --repo . --sprint S15 --min-severity warning',
  'c4mp check --repo . --format github --fail-on critical   for CI: exit 1 on critical',
]);

const buildGenerate = (cmd: Command): Command => addScanOptions(
  addRepo(
    addViewOption(cmd)
      .description(
        'Generate a starter .c4 plan from the code. ' +
          'Writes a draft into <anchor>/.c4mp/projects/<repoId>/plan/ ' +
          '(or --out, or config architectureDir). Re-running keeps metadata you added and adds components ' +
          'for new code. Prints each file written. ' +
          '--view storage instead adds a store (records, fields) for every reader hit that no store covers, ' +
          'under the container whose components own most of its files; dry run unless --yes, existing stores are never changed',
      ),
  )
    .option('--out <dir>', 'folder for the .c4 files (default: config architectureDir, else the project plan/ folder)')
    .option('--container <target>', '--view storage: put the new stores under this container (needed when no component owns the files)')
    .option('--yes', '--view storage: write the change; without it only the diff is printed')
    .option('--force', '--view storage: also write plan files outside .c4mp/ and C4MP/'),
  ['lang', 'ignore', 'tests'],
)
  .action((opts: Record<string, unknown>) => {
    if (isViewGenerate(opts)) {
      runAction(opts, 'generate', () => runGenerateView(opts, { buildCliConfig }));
      return;
    }
    try {
      // b472 (P1): the work is the Plan editing service's generatePlan; each file is printed as it is written.
      const { kept } = generatePlan(opts.repo as string, buildCliConfig(opts), {
        out: opts.out as string | undefined,
        onWritten: file => console.log(file),
      });
      if (kept.titles + kept.components + kept.relations > 0) {
        console.log(`kept ${kept.titles} titles, ${kept.components} components, ${kept.relations} relations`);
      }
    } catch (err) {
      process.exitCode = emitThrown(opts, 'generate', err);   // b723: a write command, one failure printer
    }
  });

registerPlanCommand(program, { name: 'generate', old: 'generate-c4' }, cmd => addExamples(buildGenerate(cmd), [
  'c4mp plan generate --repo .                      draft plan into .c4mp/projects/<repoId>/plan/',
  'c4mp plan generate --repo . --lang typescript,python',
  'c4mp plan generate --repo . --out ./architecture',
  'c4mp plan generate --repo . --view storage       show the stores to add from the code (dry run)',
  'c4mp plan generate --repo . --view storage --yes',
]));

addScanOptions(
  addRepo(
    program
      .command('stubs')
      .description(
        'List functions that are not implemented yet. ' +
          'Stubs are empty, TODO or "not implemented" bodies; prints one per line as file:line name (kind), ' +
          'then a count. Writes nothing',
      ),
  ),
  ['lang', 'ignore', 'tests'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const stubs = findStubs(path.resolve(opts.repo as string), buildCliConfig(opts));

      // Print stubs
      for (const stub of stubs) {
        console.log(`${stub.file}:${stub.startLine} ${stub.name} (${stub.stub})`);
      }

      console.log(`${stubs.length} stubs`);
    } catch (err) {
      failWith(err);
    }
  });

const buildResolveLink = (cmd: Command): Command => addScanOptions(
  addRepo(
    cmd
      .description(
        'Resolve a link to a code element. ' +
          'Takes a repo-relative path (optionally #functionName or #Lx-Ly) and prints the element it points at as JSON; ' +
          'use it to test a link before writing it in a .c4 file. Writes nothing',
      ),
  ),
  ['lang', 'ignore', 'tests'],
)
  .argument('<target>', 'repo-relative path, optionally with #functionName or #Lx-Ly')
  .action((target: string, opts: Record<string, unknown>) => {
    try {
      const resolved = resolveLink(path.resolve(opts.repo as string), buildCliConfig(opts), target);

      // Print the resolved link as JSON
      if (resolved) {
        console.log(JSON.stringify(resolved, null, 2));
      }
    } catch (err) {
      failWith(err);
    }
  });

registerPlanCommand(program, { name: 'resolve-link' }, cmd => addExamples(buildResolveLink(cmd), [
  'c4mp plan resolve-link src/orders/routes.ts --repo .',
  'c4mp plan resolve-link src/orders/routes.ts#createOrder --repo .',
]));

const buildApplyLayout = (cmd: Command): Command => addRepo(
  cmd
    .description(
      'Write an exported viewer layout into the .c4 files. ' +
        'Takes the layout file (version 2) saved by Export layout on the map page, usually c4mp-layout.json,' +
        'and stores it as layout metadata, checked by the plan write gate like plan set; ' +
        'use --dry-run to preview, --force for a plan outside .c4mp/',
    ),
)
  .requiredOption('--file <layout.json>', '(required) layout file exported by the viewer')
  .option('--dry-run', 'show what would change; write nothing')
  .option('--force', 'also write plan files outside .c4mp/ and C4MP/ (e.g. a plan in <repo>/c4/)')
  .action((opts: Record<string, unknown>) => {
    try {
      const { report, write, text } = applyLayoutFile(opts.repo as string, opts.file as string, { dryRun: !!opts.dryRun, force: !!opts.force });
      console.log(text);
      if (!write.ok && write.error) console.error(formatErrorText(write.error));
      if (report.failed.length > 0 || !write.ok) process.exitCode = 1;
    } catch (err) {
      process.exitCode = emitThrown(opts, 'apply-layout', err);   // b723: a write command, one failure printer
    }
  });

const viewCmd = addScanOptions(
  addRepo(
    program
      .command('view')
      .description(
        'Generate the zoomable architecture map page (c4mpView.html).' +
          'Scans the code, reads the plan and writes one HTML file; prints its path. Never changes the plan',
      ),
  )
    .option('--out <file>', 'HTML file to write (default: <anchor>/C4MP/<repoId>/c4mpView.html)')
    .option(
      '--from <ref>',
      'mark what changed since this stored snapshot: prev, latest, oldest, a snapshot id, a commit hash prefix or YYYY-MM-DD (default: no comparison)',
    )
    .option('--open', 'open the page in the default browser after writing it')
    .option('--no-source', 'leave the function and method source out of the page (the map, plan text and board stay), e.g. for a copy to share with --out'),
  ['lang', 'ignore', 'tests', 'store', 'sprint'],
)
  .action((opts: Record<string, unknown>) => {
    try {
      const repoRoot = path.resolve(opts.repo as string);
      const outFile = writeProjectView(repoRoot, {
        cliConfig: buildCliConfig(opts),
        outFile: opts.out as string | undefined,
        from: opts.from as string | null | undefined,
        store: opts.store as string | undefined,
        sprint: opts.sprint as string | null | undefined,
        noSource: opts.source === false,
      });
      console.log(outFile);

      if (opts.open) openInBrowser(outFile);
    } catch (err) {
      failWith(err);
    }
  });

const buildIds = (cmd: Command): Command => addRepo(
  cmd
    .description(
      'Give every plan element a stable uid. ' +
        'Adds a random uid to each element (system, container, component, screen, ...) of the .c4 plan that has none; ' +
        'shows a summary and writes only with --yes',
    ),
)
  .option('--yes', 'write the changes; without it only a summary is printed')
  .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
  .action((opts: Record<string, unknown>) => {
    try {
      const ids = backfillPlanIds(opts.repo as string, { force: !!opts.force });
      if (!ids) {
        console.log(NO_PLAN_MESSAGE);
        return;
      }

      // Plan files outside .c4mp/ and C4MP/ are written only with --force.
      for (const f of ids.outside) console.log(`skipped ${f}: outside .c4mp/ (use --force)`);
      const blocked = ids.outside.length > 0;

      for (const f of ids.files) console.log(`${f.file}: +${f.added} uid`);
      for (const s of ids.skipped) console.log(`skipped ${s.fqn} in ${s.file}: ${s.reason}`);

      if (!opts.yes) {
        console.log(`${ids.added} would be added; run again with --yes`);
        process.exitCode = blocked ? 1 : 0;
        return;
      }

      if (!ids.write()) {
        console.log('rolled back: the plan has new parse issues');
        process.exitCode = 1;
        return;
      }
      console.log(`${ids.added} added`);
      process.exitCode = blocked ? 1 : 0;
    } catch (err) {
      process.exitCode = emitThrown(opts, 'ids', err);   // b723: a write command, one failure printer
    }
  });

/** `plan show <target>`: one element, found by uid, fqn, id or name, with its tests (src/query/planShow.ts). */
function showPlanElement(target: string, opts: Record<string, unknown>): void {
  try {
    const ctx = loadQueryContext(path.resolve(opts.repo as string), { cli: buildCliConfig(opts) });
    const shown = showPlanTarget(ctx, target);
    console.log(opts.json ? JSON.stringify(planShowJson(shown), null, 2) : formatPlanShow(shown, { all: opts.all === true }));
  } catch (err) {
    // No plan, no match or several matches: stdout, as before the move; anything else (a failed scan): stderr.
    if (err instanceof QueryError && (err.code === 'not-found' || err.code === 'ambiguous')) console.log(formatPlanShowError(err));
    else console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/**
 * P14-T22c: `remove` for a box that exists only in the scan: print the ignore edit of its folder (planned by Plan
 * editing removeElement), write it with --yes, and return the exit code (b706: the caller sets process.exitCode).
 */
function removeScannedBox(box: string, edit: IgnoreFolderEdit, yes: boolean): number {
  const { folder, configFile } = edit;
  const ignoreOf = (text: string): string => {
    try {
      return JSON.stringify((JSON.parse(text) as { ignore?: unknown }).ignore ?? []);
    } catch {
      return '[]';
    }
  };
  console.log(`remove scanned box ${box}: add '${folder}' to ignore in ${configFile}`);
  if (edit.status === 'already') {
    console.log(`'${folder}' is already in ignore; nothing to change`);
    return 0;
  }
  console.log(`config: ${configFile}`);
  console.log(`  before: "ignore": ${ignoreOf(edit.before)}`);
  console.log(`  after:  "ignore": ${ignoreOf(edit.after)}`);
  console.log(`the scan will no longer see '${folder}'. To undo: remove the entry from ignore in ${configFile}, or restore the file from git`);
  if (!yes) {
    console.log('dry run: nothing written. Add --yes to apply.');
    return 0;
  }
  const failed = edit.write();
  if (failed !== null) {
    console.log(`rolled back: the config no longer loads (${failed})`);
    return 1;
  }
  console.log(`added '${folder}' to ignore`);
  return 0;
}

const buildRemove = (cmd: Command): Command => addRepo(
  cmd
    .description(
      'Remove one element from the .c4 plan. ' +
        'Finds it by uid, id or name, prints the lines that would go (dry run), and writes only with --yes. ' +
        'With --test "<name>" only that test block of the element goes (through the write gate). ' +
        'The plan is committed to git, so git can restore it',
    ),
)
  .option('--yes', 'write the change; without it only the diff is printed')
  .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
  .option('--relations', 'also delete the relation lines that mention the element')
  .option('--test <name>', 'remove the test block with this name from the target instead of the element')
  .option('--json', 'with --test: print one JSON object instead of text')
  .action((target: string, opts: Record<string, unknown>) => {
    // Phase 26 (T26-13, D18): one test block, through the write gate (src/cli/addCmd.ts); the element removal below is untouched.
    if (typeof opts.test === 'string') { removeTestAction(target, opts.test, opts, { buildCliConfig }); return; }
    try {
      // b472 (P7): Plan editing removeElement finds the element (or the scanned box) and plans the edit; this prints.
      const withRelations = !!opts.relations;
      const found = removeElement(opts.repo as string, target, { relations: withRelations, force: !!opts.force });
      if (found.kind === 'ignore') {
        process.exitCode = removeScannedBox(found.box, found.edit, !!opts.yes);
        return;
      }
      process.exitCode = 1;   // every refusal below; the removal sets 0
      if (found.kind === 'scanned-ambiguous') {
        console.log(`'${target}' matches ${found.matches.length} scanned boxes; use the full id:`);
        for (const m of found.matches) console.log(`  ${m.id}  ${m.title}  ${m.level}`);
        return;
      }
      if (found.kind === 'refused') {
        console.log(found.message);
        return;
      }
      if (found.kind === 'none') {
        if (found.noPlan) console.log(NO_PLAN_MESSAGE);
        console.log(`no plan element matches '${target}'`);
        for (const m of found.closest) console.log(`  ${m.uid ?? '(no uid)'}  ${m.fqn ?? m.id}  ${m.title}`);
        return;
      }
      if (found.kind === 'ambiguous') {
        console.log(`'${target}' matches ${found.matches.length} elements; use a uid:`);
        for (const { item: m, file, line } of found.matches) {
          console.log(`  ${m.uid ?? '(no uid)'}  ${m.id}  ${m.title}  ${file}:${line}`);
        }
        if (found.matches.some(({ item: m }) => !m.uid)) console.log('run c4mp plan ids to give every element a uid');
        return;
      }
      if (found.kind === 'blocked') {
        console.log('these children live in other files; remove them first:');
        for (const c of found.children) console.log(`  ${c.uid ?? '(no uid)'}  ${c.fqn}`);
        return;
      }
      process.exitCode = 0;

      const { item, fqn } = found;
      console.log(`remove ${item.level} ${item.title} (${fqn})`);
      console.log(`uid: ${item.uid ?? 'none'}`);
      console.log(`removes ${found.removedElements.length} element(s): ${found.removedElements.join(', ')}`);
      for (const r of found.relations) {
        const status = r.insideBlock
          ? 'removed (inside the block)'
          : r.manual
            ? 'kept, edit by hand'
            : withRelations
              ? 'removed'
              : 'kept';
        console.log(`relation ${r.from} -> ${r.to} (${r.file}:${r.line}): ${status}`);
      }
      for (const f of found.files) process.stdout.write(f.diff);

      if (!opts.yes) {
        console.log('dry run: nothing written. Add --yes to apply.');
        return;
      }

      // Plan files outside .c4mp/ and C4MP/ are written only with --force; nothing is written if one is refused.
      for (const f of found.outside) console.log(`refused: ${f} is outside .c4mp/ (use --force)`);
      if (found.outside.length > 0) {
        process.exitCode = 1;
        return;
      }

      if (!found.write()) {
        console.log('rolled back: the plan has new parse issues or the element is still there');
        process.exitCode = 1;
        return;
      }
      console.log(`removed ${fqn}`);
    } catch (err) {
      // b723: one failure printer. --json belongs to --test (handled above), so the element removal stays text.
      process.exitCode = emitThrown({ ...opts, json: false }, 'remove', err);
    }
  });

// P14-T42b-1: prints the built-in guide. No process.exit on success: the guide is long and exit can cut piped stdout.
const guideCmd = program
  .command('guide')
  .argument('[topic]', 'guide topic, for example c4')
  .description('Print a built-in guide (for people and AI agents). With `guide ai --skill` it makes a thin Claude Code skill file (SKILL.md) from the AI guide')
  .option('--skill', 'with topic ai: print a short agent file made from the marked rules of the AI guide (a Claude Code SKILL.md)')
  .option('--format <format>', 'with --skill: skill (SKILL.md, default) or agents (an AGENTS.md snippet)')
  .option('--out <path>', 'with --skill: write the file here (parent folders are created) instead of printing it')
  .option('--force', 'with --out: overwrite an existing file that differs')
  .action((topic: string | undefined, opts: { skill?: boolean; format?: string; out?: string; force?: boolean }) => {
    const skill = opts.skill === true || opts.format !== undefined;
    if (skill || opts.out !== undefined || opts.force) {
      const format = opts.format ?? 'skill';
      const problem = !skill ? '--out and --force need --skill'
        : topic !== 'ai' ? '--skill is made from the AI guide: c4mp guide ai --skill'
          : format !== 'skill' && format !== 'agents' ? `unknown --format '${format}' (skill or agents)`
            : opts.force && opts.out === undefined ? '--force needs --out' : '';
      if (problem) {
        console.error(`error: ${problem}`);
        process.exitCode = 1;
        return;
      }
      try {
        const text = buildSkill(readGuide('ai') ?? '', format as SkillFormat);
        if (opts.out === undefined) { process.stdout.write(text); return; }
        const done = writeSkillFile(opts.out, text, opts.force === true);
        console.log(done.status === 'written' ? `wrote ${done.path}` : `unchanged: ${done.path} already has this content`);
        const removed = removeLegacySkill(opts.out);   // Phase 35 B: an old c4pm skill folder beside it goes (never two skills)
        if (removed) console.log(`removed the old ${LEGACY_CMD_NAME} skill ${removed}`);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
      return;
    }
    if (!topic) {
      for (const t of listTopics()) console.log(`${t.topic}  ${t.summary}`);
      return;
    }
    const text = readGuide(topic);
    if (text === null) {
      console.error(`unknown topic '${topic}'. Topics:`);
      for (const t of listTopics()) console.error(`${t.topic}  ${t.summary}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(text);
  });

// P15-T5b: find, show, outline, deps (src/queryCli.ts). Registered before the summary loop below.
registerQueryCommands(program, { buildCliConfig });
registerBoardCommands(program);
// T5b (b701): c4mp sim list|show|add|set|remove|step|stage|apply (src/cli/sim.ts).
registerSimCommands(program);
registerPlanEditCommands(program, { buildCliConfig });
// Phase 32 (ED-2): c4mp edit replace / insert / remove (src/cli/editCmd.ts).
registerEditCommands(program, { buildCliConfig });
registerMoveCommands(program, { buildCliConfig, planMove: planMoveService });
// b456 (SR1): c4mp plan upgrade (src/cli/upgradeCmd.ts), the service handed in like planMoveService.
registerUpgradeCommand(program, { buildCliConfig, planUpgrade: planUpgradeService });
registerPlanCommand(program, { name: 'show', args: '[target]', old: 'element', oldArgs: '<target>', isDefault: true }, cmd =>
  addExamples(
    addScanOptions(
      addRepo(addViewOption(cmd)).description(
        'Show the plan, or one element of it. ' +
          'Without a target: counts of elements, relations and issues, then each element (id, kind, title, status) and each parse issue. ' +
          'With a target: finds the element by uid, fqn, local id or name and prints its kind, uid, fqn, parent, children, plan lines, links and status; ' +
          'in claim mode also its origin and claims; then its tests: to run (attached to it or below it, each with a run command), ' +
          'to write (test blocks of the plan no test case matches yet) and touching it. Writes nothing. ' +
          '--view arch|io|storage without a target lists only that view\'s elements; with a target it does nothing',
      )
        .option('--json', 'with a target: print JSON instead of text (every test listed)')
        .option('--all', 'with a target: list every test (text lists the first 10 of each list)'),
      ['lang', 'ignore', 'tests'],
    ).action((target: string | undefined, opts: Record<string, unknown>) => {
      if (target === undefined) showPlanOverview(opts);
      else showPlanElement(target, opts);
    }),
    [
      'c4mp plan show --repo .                 the plan structure',
      'c4mp plan show 3f2a... --repo .         one element, by uid',
      'c4mp plan show app.web.auth --repo .    by id',
      'c4mp plan show Auth --repo . --json',
      'c4mp plan show app.web.auth --repo . --all  every test to run, to write and touching',
      'c4mp plan show --repo . --view storage  only the stores, records and fields',
    ],
  ));
registerInstallCommands(program);
registerLanguagesCommand(program);
registerMigrateCommand(program);
// Phase 30 SV7 (b794): c4mp serve (src/cli/serveCmd.ts).
registerServeCommand(program, { buildCliConfig });

addExamples(guideCmd, ['c4mp guide', 'c4mp guide c4 > c4-guide.md', 'c4mp guide ai --skill --out ~/.claude/skills/c4mp/SKILL.md', 'c4mp guide ai --skill --format agents']);
registerPlanCommand(program, { name: 'ids' }, cmd => addExamples(buildIds(cmd), [
  'c4mp plan ids --repo .                       show what would be added',
  'c4mp plan ids --repo . --yes                 write the uids',
]));
registerPlanCommand(program, { name: 'remove', args: '<target>' }, cmd => addExamples(buildRemove(cmd), [
  'c4mp plan remove 3f2a... --repo .             show what would be removed',
  'c4mp plan remove 3f2a... --repo . --yes       remove it',
  'c4mp plan remove Auth --repo . --relations    include relation lines',
  'c4mp plan remove billing --test "groups files by folder" --repo .   one test block',
]));
registerPlanCommand(program, { name: 'apply-layout' }, cmd => addExamples(buildApplyLayout(cmd), [
  'c4mp plan apply-layout --repo . --file ~/Downloads/c4mp-layout.json --dry-run',
  'c4mp plan apply-layout --repo . --file ~/Downloads/c4mp-layout.json',
]));
addExamples(viewCmd, [
  'c4mp view --repo . --open                      write the page and open it',
  'c4mp view --repo . --from prev                 mark what changed since the previous snapshot',
  'c4mp view --repo . --out /tmp/map.html --lang typescript,python',
]);

// The command list shows only the first sentence of each description; `<cmd> --help` shows it all.
for (const c of [...program.commands, ...planGroup(program).commands]) {
  const first = c.description().split('. ')[0];
  c.summary(first);
}

// b518: the reader closed the pipe early (`c4mp guide ai | head`): stop quietly, as other Unix tools do.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// b564: every command with --repo checks it once here (src/cli/common.ts checkRepoOption): not a folder = refused
// before the action runs; a folder that would start a new project next to existing ones = a stderr note. The hidden
// git-hook command is left out: it never fails.
program.hook('preAction', (_root, action) => {
  if (action.parent === program && action.name() === 'hook') return;
  checkRepoOption(action);
});

noteLegacyCommandName();   // Phase 35 B: one stderr line when started as `c4pm`

try {
  program.parse(process.argv);
} catch (err) {
  // A refused --repo was already reported by the hook; the action never ran.
  if (!(err instanceof CommandRefused)) throw err;
  process.exitCode = 1;
}
