/**
 * P18-T15: `c4mp plan link <target> <path[#name]>`: add a code link to a plan element (D9). The path is repo-relative; the
 * written line is relative to the .c4 file (formatLink). The target must exist (resolveLinks, the scan always runs).
 * Dry run unless --yes. A link the element already has is refused, so a second identical run adds nothing.
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, withQuietLogs } from './common';
import { loadPlanState } from '../services/planState';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { registerPlanCommand } from './planGroup';
import { isCmdError, linkCheckError, linkEdit, parseLinkArgs, unlinkEdit, writeSpecOf } from '../services/planOps';

function runLink(target: string, linkArg: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const args = parseLinkArgs(linkArg, typeof opts.title === 'string' ? opts.title : undefined);
  if (isCmdError(args)) return failedReport('link', opts, args);
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('link', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const built = linkEdit(state, target, args);
  if (!built.ok) return failedReport('link', opts, built.error, built.target);
  const bad = linkCheckError(state, built.edit);
  if (bad) return failedReport('link', opts, bad, built.edit.target);
  return runWrite(writeSpecOf('link', opts, state, built.edit));
}

export function registerLinkCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'link', args: '<target> <path>' }, cmd => buildLink(cmd, deps));
}

function buildLink(cmd: Command, deps: PlanEditDeps): Command {
  const linkCmd = addScanOptions(
    addRepo(
      cmd
        .description(
          'Link a plan element to code. ' +
            'Path is repo-relative, optionally #functionName or #Lx-Ly; a folder ends with /. The code must exist. ' +
            'The line is written relative to the .c4 file. Dry run unless --yes',
        ),
    )
      .option('--title <text>', 'link title')
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'also gate with the full check (the link check always scans)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((target: string, linkArg: string, opts: Opts) => {
    runAction(opts, 'link', () => emitResult(opts, withQuietLogs(() => runLink(target, linkArg, opts, deps))));
  });
  addExamples(linkCmd, [
    'c4mp plan link auth src/auth/ --repo .                 a folder',
    'c4mp plan link auth src/auth/login.ts --repo . --yes',
    'c4mp plan link auth src/auth/login.ts#login --repo .   one function',
  ]);
  return linkCmd;
}

function runUnlink(target: string, linkArg: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const args = parseLinkArgs(linkArg);
  if (isCmdError(args)) return failedReport('unlink', opts, args);
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('unlink', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const built = unlinkEdit(state, target, args);
  if (!built.ok) return failedReport('unlink', opts, built.error, built.target);
  return runWrite(writeSpecOf('unlink', opts, state, built.edit));
}

export function registerUnlinkCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'unlink', args: '<target> <path>', noAlias: true }, cmd => buildUnlink(cmd, deps));
}

function buildUnlink(cmd: Command, deps: PlanEditDeps): Command {
  const unlinkCmd = addScanOptions(
    addRepo(
      cmd
        .description(
          'Remove one code link from a plan element. ' +
            'Path is repo-relative as in plan link, optionally #functionName or #Lx-Ly; a folder ends with /. ' +
            'The element keeps everything else; to delete the whole element use c4mp plan remove. Dry run unless --yes',
        ),
    )
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'also gate with the full check (the gate always scans)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((target: string, linkArg: string, opts: Opts) => {
    runAction(opts, 'unlink', () => emitResult(opts, withQuietLogs(() => runUnlink(target, linkArg, opts, deps))));
  });
  addExamples(unlinkCmd, [
    'c4mp plan unlink auth src/auth/ --repo .',
    'c4mp plan unlink auth src/auth/login.ts --repo . --yes',
    'c4mp plan unlink auth src/auth/login.ts#login --repo .   one function',
  ]);
  return unlinkCmd;
}
