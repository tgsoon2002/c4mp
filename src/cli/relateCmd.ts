/**
 * P18-T16: `c4mp plan relate <from> <to>`: declare a relation between two plan elements (D10). Both ends must resolve to ONE
 * element each (check does not catch a relation to a missing element). The line `-> <to-fqn> ['label']` is written
 * inside the body of `from`. Dry run unless --yes. The same pair twice is refused, so a second run adds nothing.
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, withQuietLogs } from './common';
import { loadPlanState } from '../services/planState';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { registerPlanCommand } from './planGroup';
import { isCmdError, parseRelateArgs, relateEdit, writeSpecOf } from '../services/planOps';

function runRelate(fromArg: string, toArg: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const args = parseRelateArgs(typeof opts.label === 'string' ? opts.label : undefined);
  if (isCmdError(args)) return failedReport('relate', opts, args);
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('relate', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const built = relateEdit(state, fromArg, toArg, args);
  if (!built.ok) return failedReport('relate', opts, built.error, built.target);
  return runWrite(writeSpecOf('relate', opts, state, built.edit));
}

export function registerRelateCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'relate', args: '<from> <to>' }, cmd => buildRelate(cmd, deps));
}

function buildRelate(cmd: Command, deps: PlanEditDeps): Command {
  const relateCmd = addScanOptions(
    addRepo(
      cmd
        .description(
          'Declare that one plan element uses another. ' +
            'Both are found by uid, fqn, id or name and must exist; the line is written inside <from>. ' +
            'The same pair twice is refused. Dry run unless --yes',
        ),
    )
      .option('--label <text>', 'what the relation is, shown on the arrow')
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'gate with the full check (scans the code; slower)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((from: string, to: string, opts: Opts) => {
    runAction(opts, 'relate', () => emitResult(opts, withQuietLogs(() => runRelate(from, to, opts, deps))));
  });
  addExamples(relateCmd, [
    'c4mp plan relate orders auth --repo .                    dry run',
    'c4mp plan relate orders auth --label "checks login" --repo . --yes',
    'c4mp plan relate 3f2a... 9b1c... --repo . --yes          by uid',
  ]);
  return relateCmd;
}
