/**
 * W9 (b305, PHASE_20_WIREFRAMES.md section 7 L5): `c4mp plan wireframe <screen>` writes a starter io/<screen fqn>.html
 * (wireframeStarterEdit: one block per region, its controls in a row, classes only, linking io/site.css) for a person or an
 * AI to arrange. Through the write gate like every plan write: dry run unless --yes, never overwrites, refuses a target
 * that is not a screen and a plan without a folder. Under `c4mp plan` only (a new command: no old top-level name to keep).
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { loadPlanState, resolveTarget } from '../services/planState';
import { NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, withQuietLogs } from './common';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { planGroup } from './planGroup';
import { wireframeStarterEdit, writeSpecOf } from '../services/planOps';

function runWireframe(target: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('wireframe', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const resolved = resolveTarget(state, target);
  if (!resolved.ok) return failedReport('wireframe', opts, resolved.error);
  const built = wireframeStarterEdit(state, resolved.el.id);
  if (!built.ok) return failedReport('wireframe', opts, built.error, built.target);
  return runWrite(writeSpecOf('wireframe', opts, state, built.edit));
}

export function registerWireframeCommand(program: Command, deps: PlanEditDeps): void {
  const cmd = addScanOptions(
    addRepo(
      planGroup(program).command('wireframe').arguments('<screen>').description(
        'Write a starter wireframe io/<screen fqn>.html for a screen: one block per region with its controls in a row, ' +
          'classes only, linking io/site.css (not created). The screen is found by uid, fqn, id or name. ' +
          'Never overwrites; dry run unless --yes',
      ),
    )
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'gate with the full check (scans the code; slower)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((screen: string, opts: Opts) => {
    runAction(opts, 'wireframe', () => emitResult(opts, withQuietLogs(() => runWireframe(screen, opts, deps))));
  });
  addExamples(cmd, [
    'c4mp plan wireframe shop.web.login --repo .           dry run: prints the file',
    'c4mp plan wireframe login --repo . --yes',
  ]);
}
