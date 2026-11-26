/**
 * P18-T14: `c4mp plan set <target> key=value ...`: change status, owner, sprint, priority, signature, purpose, title,
 * description or technology of one plan element (D6-D8). The writer quotes every value; `uid` and `layout` are refused.
 * Dry run unless --yes. A value equal to the current one is "no change" (exit 0, nothing written).
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions, collectValues } from '../cliHelp';
import { NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, withQuietLogs } from './common';
import { loadPlanState } from '../services/planState';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { registerPlanCommand } from './planGroup';
import { SET_ALLOWED_KEYS as ALLOWED, SET_UNSET_KEYS as UNSET_KEYS, isCmdError, parseSetArgs, parseUnsetArgs, setEdit, writeSpecOf } from '../services/planOps';

function runSet(target: string, pairs: string[] | undefined, opts: Opts, deps: PlanEditDeps): WriteReport {
  const fields = parseSetArgs(pairs ?? []);
  if (isCmdError(fields)) return failedReport('set', opts, fields);
  const unset = parseUnsetArgs((opts.unset as string[] | undefined) ?? [], fields);
  if (isCmdError(unset)) return failedReport('set', opts, unset);
  if (fields.length === 0 && unset.length === 0) return failedReport('set', opts, cmdError('invalid', 'give key=value pairs or --unset <key>'));
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('set', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const built = setEdit(state, target, fields, unset);
  if (!built.ok) return failedReport('set', opts, built.error, built.target);
  return runWrite(writeSpecOf('set', opts, state, built.edit));
}

export function registerSetCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'set', args: '<target> [pairs...]' }, cmd => buildSet(cmd, deps));
}

function buildSet(cmd: Command, deps: PlanEditDeps): Command {
  const setCmd = addScanOptions(
    addRepo(
      cmd
        .description(
          'Change fields of one plan element. ' +
            `Pairs are key=value; keys: ${ALLOWED.join(', ')}. Values are quoted for you ` +
            '(status, priority, sprint, shape and role are checked); --unset <key> removes a metadata key; uid and layout are refused. Dry run unless --yes',
        ),
    )
      .option('--unset <key>', `remove a metadata key (repeatable; ${UNSET_KEYS.join(', ')}); never uid or layout`, collectValues, [] as string[])
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'gate with the full check (scans the code; slower)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((target: string, pairs: string[], opts: Opts) => {
    runAction(opts, 'set', () => emitResult(opts, withQuietLogs(() => runSet(target, pairs, opts, deps))));
  });
  addExamples(setCmd, [
    'c4mp plan set auth status=in-progress owner=K --repo .',
    'c4mp plan set auth status=done owner=K --repo . --yes',
    'c4mp plan set auth description="Login and sessions" --repo . --yes',
    'c4mp plan set 3f2a... sprint=S15 priority=high --repo . --yes',
    'c4mp plan set helpers role=foundation --repo . --yes',
    'c4mp plan set helpers --unset role --repo . --yes',
  ]);
  return setCmd;
}
