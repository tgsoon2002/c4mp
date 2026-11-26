/**
 * P18-T12: `c4mp plan unplanned`: code the plan does not own, as a filter over the `check` findings (one source of truth,
 * D11). Read-only: writes nothing, not even `.c4mp/`. Like `check`, a repo without a plan prints a hint and exits 0.
 */
import * as path from 'path';
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { runCheck } from '../query/check';
import { groupUnplanned } from '../query/unplanned';
import type { UnplannedGroup } from '../query/unplanned';
import { unplannedStorage } from '../query/unplannedStorage';
import { NO_PLAN_MESSAGE, addViewOption, emitError, cmdError, parseView, runAction, withQuietLogs } from './common';
import { loadPlanState } from '../services/planState';
import type { Opts, PlanEditDeps } from './common';
import { registerPlanCommand } from './planGroup';

function formatGroups(groups: UnplannedGroup[]): string {
  if (groups.length === 0) return 'nothing unplanned';
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`${g.rule} (${g.items.length}): ${g.hint}`);
    for (const i of g.items) lines.push(`  ${i.id}  ${i.message}`);
  }
  return lines.join('\n');
}

/** b273: what `--view io` says: the io view has no code reader yet. */
export const NO_IO_READER_MESSAGE = 'no code reader for the io view yet; nothing to list';

export function registerUnplannedCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'unplanned' }, cmd => buildUnplanned(cmd, deps));
}

function buildUnplanned(cmd: Command, deps: PlanEditDeps): Command {
  const unplannedCmd = addScanOptions(
    addRepo(
      addViewOption(cmd
        .description(
          'List code that no plan element owns. ' +
            'Files (folder mode) or functions (claim mode) found by the scan that no component links to, with a fix hint per group; ' +
            'the same findings as c4mp check, filtered. ' +
            '--view storage lists instead the records in the code that no store lists (unplanned-record) and the records no store covers (unplanned-store); ' +
            '--view io has no code reader yet. Read-only: writes nothing',
        )),
    ).option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((opts: Opts) => {
    runAction(opts, 'unplanned', () => {
      const view = parseView(opts);
      if (typeof view !== 'string') return emitError(opts, 'unplanned', view);
      if (view === 'io') {
        console.log(opts.json ? JSON.stringify({ groups: [], note: NO_IO_READER_MESSAGE }, null, 2) : NO_IO_READER_MESSAGE);
        return 0;
      }
      if (view === 'storage') {
        const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
        if (!state) {
          console.log(opts.json ? JSON.stringify({ groups: [], note: NO_PLAN_MESSAGE }, null, 2) : NO_PLAN_MESSAGE);
          return 0;
        }
        const { groups, problems } = withQuietLogs(() =>
          unplannedStorage(state.plan, state.repoRoot, state.config));
        if (opts.json) console.log(JSON.stringify({ groups, ...(problems.length > 0 ? { problems } : {}) }, null, 2));
        else console.log([formatGroups(groups), ...problems.map(p => `warning: ${p}`)].join('\n'));
        return 0;
      }
      let result;
      try {
        result = withQuietLogs(() => runCheck(path.resolve(opts.repo as string), deps.buildCliConfig(opts), {}));
      } catch (err) {
        return emitError(opts, 'unplanned', cmdError('invalid', err instanceof Error ? err.message : String(err)));
      }
      if (!result) {
        console.log(opts.json ? JSON.stringify({ groups: [], note: NO_PLAN_MESSAGE }, null, 2) : NO_PLAN_MESSAGE);
        return 0;
      }
      const groups = groupUnplanned(result.findings);
      console.log(opts.json ? JSON.stringify({ groups }, null, 2) : formatGroups(groups));
      return 0;
    });
  });
  addExamples(unplannedCmd, [
    'c4mp plan unplanned --repo .                     code no component owns',
    'c4mp plan unplanned --repo . --json',
    'c4mp plan unplanned --repo . --lang typescript',
    'c4mp plan unplanned --repo . --view storage      records the plan lacks',
  ]);
  return unplannedCmd;
}
