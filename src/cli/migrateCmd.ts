/**
 * Phase 35 A: `c4mp migrate [--yes] [--json]`: move this repo's data folder `.c4pm` to `.c4mp`. Dry run unless --yes.
 * The per-user folder and the git hooks are not touched.
 */
import * as path from 'path';
import type { Command } from 'commander';
import { addExamples, addRepo } from '../cliHelp';
import { migrateDataDir } from '../services/migrateDataDir';
import { runAction } from './common';
import type { Opts } from './common';

export function registerMigrateCommand(program: Command): void {
  const cmd = addRepo(
    program
      .command('migrate')
      .description(
        'Move the repo data folder .c4pm to .c4mp (git mv when git tracks it, else a rename) and fix the comment in its .gitignore. ' +
          'Dry run unless --yes; refuses when both folders exist; says "nothing to migrate" when there is no .c4pm. ' +
          'Does not move the per-user folder and does not touch git hooks',
      ),
  )
    .option('--yes', 'do it (without it: only print what would happen)')
    .option('--json', 'print one JSON object instead of text')
    .action((opts: Opts) => {
      runAction(opts, 'migrate', () => {
        const repo = path.resolve(opts.repo as string);
        const result = migrateDataDir(repo, { yes: opts.yes === true, findAnchor: true });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(result.message);
        return result.status === 'refused' ? 1 : 0;
      });
    });
  addExamples(cmd, [
    'c4mp migrate               dry run: what would move',
    'c4mp migrate --yes         move .c4pm to .c4mp',
  ]);
}
