/**
 * P18-T13: `c4mp plan add <kind> <name> --parent <target>`: add an element to the plan (D2-D5, D12-D15). P20-T9 (b131):
 * every kind comes from the one kind table (src/plan/kinds.ts) with its parent rule, read through addRules
 * (src/services/planState.ts, b462); `context <name> --as person|external|system` is an alias for a top-level kind. Never creates a .c4 file: the child goes into the file that
 * already holds its parent's children of the same view (W5, b301: addTargetOf, the defining file first, else the first
 * `extend <parent>` block holding one, else the defining file), a top-level element into the model block of the file that
 * holds the first system.
 * Dry run unless --yes. A second identical run is refused (the id already exists), so nothing is added twice.
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions, collectValues as collect } from '../cliHelp';
import { addRules, loadPlanState } from '../services/planState';
import { NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, withQuietLogs } from './common';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { registerPlanCommand } from './planGroup';
import { ADD_CONTEXT as CONTEXT, addEdit, isCmdError, linkCheckError, orList, parseAddArgs, removeTestEdit, writeSpecOf } from '../services/planOps';


function runAdd(kindWord: string, name: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const args = parseAddArgs(kindWord, name, opts);
  if (isCmdError(args)) return failedReport('add', opts, args);
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('add', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const built = addEdit(state, args);
  if (!built.ok) return failedReport('add', opts, built.error, built.target);
  const bad = linkCheckError(state, built.edit);
  if (bad) return failedReport('add', opts, bad);
  return runWrite(writeSpecOf('add', opts, state, built.edit));
}

/**
 * Phase 26 (T26-13, D18): `c4mp plan remove <target> --test "<name>"`: removes one test block of the target through the
 * write gate (dry run unless --yes). bin/cli.ts calls it from the remove command when --test is given.
 */
export function removeTestAction(target: string, name: string, opts: Opts, deps: PlanEditDeps): void {
  runAction(opts, 'remove', () => emitResult(opts, withQuietLogs(() => {
    if (opts.relations) return failedReport('remove', opts, cmdError('invalid', '--relations does not go with --test'));
    const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
    if (!state) return failedReport('remove', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
    const built = removeTestEdit(state, target, name);
    if (!built.ok) return failedReport('remove', opts, built.error, built.target);
    return runWrite(writeSpecOf('remove', opts, state, built.edit));
  })));
}

export function registerAddCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'add', args: '<kind> <name>' }, cmd => buildAdd(cmd, deps));
}

function buildAdd(cmd: Command, deps: PlanEditDeps): Command {
  const rules = addRules();
  const addCmd = addScanOptions(
    addRepo(
      cmd
        .description(
          `Add an element to the plan. Kind is ${orList(rules.kinds)}; ` +
            `${CONTEXT} <name> --as ${orList(rules.topLevel)} adds a top-level element. ` +
            `Allowed parents: ${rules.kinds.map(k => `${k} -> ${orList(rules.parents[k]) || 'none (top level)'}`).join('; ')}. ` +
            'test adds a one-line test block to its parent (a test to write; with --case a hand link), not an element. ' +
            'Written next to its siblings of the same view: the file that defines the parent when it holds one, else the first ' +
            'extend <parent> block that holds one, else the defining file (a top-level element into the model block); dry run unless --yes',
        ),
    )
      .option('--parent <target>', 'uid, fqn, id or name of the parent element (required unless the kind is top level)')
      .option('--as <kind>', `with ${CONTEXT}: ${orList(rules.topLevel)} (required)`)
      .option('--title <text>', 'title (default: the name)')
      .option('--id <id>', 'id (default: the name made safe for the plan)')
      .option('--description <text>', 'description')
      .option('--tech <text>', 'technology')
      .option('--link <path[#name]>', 'repo-relative code link; must exist')
      .option('--status <s>', 'planned, in-progress, done or abandoned')
      .option('--owner <name>', 'owner (needed for done)')
      .option('--sprint <S15>', 'sprint, like S15')
      .option('--priority <p>', 'high, medium or low')
      .option('--meta <key=value>', 'extra metadata line, repeatable (storage kinds: type=uuid, fk=customers.id)', collect, [] as string[])
      .option('--signature <text>', 'planned code: signature')
      .option('--purpose <text>', 'planned code: purpose')
      .option('--case <test>', "with kind test: a hand link, a test case id (file#describe › name) or a test helper file; without it the test is to write")
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'gate with the full check (scans the code; slower)')
      .option('--json', 'print one JSON object instead of text'),
    ['lang', 'ignore', 'tests'],
  ).action((kind: string, name: string, opts: Opts) => {
    runAction(opts, 'add', () => emitResult(opts, withQuietLogs(() => runAdd(kind, name, opts, deps))));
  });
  addExamples(addCmd, [
    'c4mp plan add component Billing --parent api --repo .',
    'c4mp plan add component Billing --parent api --repo . --yes',
    'c4mp plan add context Admin --as person --repo .',
    'c4mp plan add screen Login --parent web --repo .',
    'c4mp plan add store "Main DB" --tech postgres --parent api --repo .',
    'c4mp plan add field customer_id --parent orders --meta type=uuid --meta fk=customers.id --repo .',
    'c4mp plan add planned-fn chargeCard --parent billing --repo . \\',
    '  --signature "chargeCard(id: string): void" --status planned --yes',
    'c4mp plan add test "groups files by folder" --parent billing --repo .',
    'c4mp plan add test "cli help" --parent cli --case "test/cli-help.test.ts#help › lists commands" --repo .',
  ]);
  return addCmd;
}
