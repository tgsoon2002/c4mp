/**
 * b456 (SR1): `c4mp plan upgrade`. Rewrites old plan words to the current plan standard (today: the kind `layer` becomes
 * `subregion`, also in a `specification` block). This file only declares options and prints; the work is the L3 service
 * src/services/planUpgrade.ts, handed in by bin/cli.ts (`UpgradeDeps.planUpgrade`), so src/cli imports nothing new from
 * src/services or src/c4 (as moveCmd.ts). A new command: no hidden top-level alias (noAlias).
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { emitResult, runAction, withQuietLogs } from './common';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import type { C4pmConfig } from '../types';
import { registerPlanCommand } from './planGroup';

export interface UpgradeDeps extends PlanEditDeps {
  planUpgrade: (repo: string, cli: Partial<C4pmConfig>, opts: Opts) => WriteReport;
}

export function registerUpgradeCommand(program: Command, deps: UpgradeDeps): void {
  registerPlanCommand(program, { name: 'upgrade', noAlias: true }, cmd =>
    addExamples(
      addScanOptions(
        addRepo(cmd)
          .description(
            'Rewrite old plan words to the current plan standard (today: the kind layer becomes subregion, also in a ' +
              'specification block). Only kind words change: ids, strings and comments stay. Dry run by default (prints ' +
              'the diff); --yes writes through the plan write gate. Safe to repeat',
          )
          .option('--yes', 'write the change; without it only the diff is printed')
          .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
          .option('--check', 'gate with the full check (scans the code; slower)')
          .option('--json', 'print one JSON object instead of text'),
        ['lang', 'ignore', 'tests'],
      ).action((opts: Opts) => {
        runAction(opts, 'upgrade', () =>
          emitResult(opts, withQuietLogs(() => deps.planUpgrade(opts.repo as string, deps.buildCliConfig(opts), opts))));
      }),
      [
        'c4mp plan upgrade --repo .              dry run: the diff of every old word',
        'c4mp plan upgrade --repo . --yes',
        'c4mp plan upgrade --repo . --json',
      ],
    ),
  );
}
