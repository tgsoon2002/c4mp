/**
 * Phase 32 (ED-2, b669): `c4mp edit replace / insert / remove <path#name>`: edit code by name through the code edit
 * service (src/services/codeEdit.ts). The new text comes from --from <file> or stdin. Dry run unless --yes.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import { cmdError, emitResult, failedReport, readStdinText, runAction, withQuietLogs } from './common';
import type { Opts, PlanEditDeps, WriteReport } from './common';
import { runCodeEdit } from '../services/codeEdit';
import type { CodeEditOp, CodeEditRequest, CodeEditWhere } from '../services/codeEdit';

const PLACEMENTS: CodeEditWhere[] = ['after', 'before', 'into'];

/** The new text: --from <file> (repo-relative or absolute), else stdin; a TTY stdin without --from is refused. */
function newText(opts: Opts): string | { error: string } {
  if (typeof opts.from === 'string') {
    const file = path.resolve(opts.repo as string, opts.from);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { error: `cannot read --from ${opts.from}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (process.stdin.isTTY) return { error: 'give --from <file> or pipe the new text' };
  return readStdinText();
}

function runEdit(op: CodeEditOp, target: string, opts: Opts, deps: PlanEditDeps): WriteReport {
  const command = `edit ${op}`;
  const req: CodeEditRequest = { op, target };
  if (op === 'insert') {
    const given = PLACEMENTS.filter(p => opts[p] === true);
    if (given.length !== 1) return failedReport(command, opts, cmdError('invalid', 'edit insert needs exactly one of --after, --before, --into'));
    req.where = given[0];
  }
  if (op !== 'remove') {
    const text = newText(opts);
    if (typeof text !== 'string') return failedReport(command, opts, cmdError('invalid', text.error));
    req.text = text;
  }
  return runCodeEdit(opts.repo as string, deps.buildCliConfig(opts), req, { yes: opts.yes === true });
}

/** The options every edit subcommand shares, then its action. */
function editSubcommand(cmd: Command, op: CodeEditOp, deps: PlanEditDeps, examples: string[]): Command {
  const sub = addScanOptions(
    addRepo(cmd)
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--json', 'print one JSON object instead of text'),
    // No --ignore: an edit names its file, it is not limited to scanned files (ED-3).
    ['lang', 'tests'],
  ).action((target: string, opts: Opts) => {
    runAction(opts, `edit ${op}`, () => emitResult(opts, withQuietLogs(() => runEdit(op, target, opts, deps))));
  });
  return addExamples(sub, examples);
}

/** Register `c4mp edit` and its subcommands. Call before the summary loop in bin/cli.ts. */
export function registerEditCommands(program: Command, deps: PlanEditDeps): void {
  const edit = program
    .command('edit')
    .description(
      'Edit code by name: replace, insert or remove. ' +
        'A target is a function, class, method or test, as in c4mp show (path#name, path#Class.method, ' +
        'path#describe > it). ' +
        'A test target is its whole it(...) statement; removing one also removes the plan test block naming it. ' +
        'The new text comes from --from <file> or stdin. Refused when the edit adds parse errors. ' +
        'Dry run unless --yes. Run c4mp edit <command> --help for details',
    );

  editSubcommand(
    edit.command('replace <target>')
      .description('Replace exactly the lines c4mp show prints for <target> (its doc comment and decorators stay). Dry run unless --yes')
      .option('--from <file>', 'read the new text from this file (repo-relative or absolute); default stdin'),
    'replace', deps,
    [
      'c4mp edit replace src/a.ts#login --repo . --from /tmp/login.ts         dry run: the diff',
      "printf 'export function f() {}\\n' | c4mp edit replace src/a.ts#f --repo . --yes",
    ],
  );

  editSubcommand(
    edit.command('insert <target>')
      .description('Insert new text next to <target>: --after it, --before it (above its doc comment), or --into a class or describe (at the end of its body). Dry run unless --yes')
      .option('--after', 'insert below the element')
      .option('--before', 'insert above the element, its doc comment and decorators')
      .option('--into', 'insert at the end of the body (the target is a class or a describe)')
      .option('--from <file>', 'read the new text from this file (repo-relative or absolute); default stdin'),
    'insert', deps,
    [
      'c4mp edit insert src/a.ts#login --after --repo . --from /tmp/logout.ts',
      "c4mp edit insert 'test/a.test.ts#login' --into --repo . --from /tmp/case.ts --yes",
    ],
  );

  editSubcommand(
    edit.command('remove <target>')
      .description('Remove <target> with the doc comment, decorator and bare export lines directly above it. A test case also takes the plan test block whose case names it. Dry run unless --yes'),
    'remove', deps,
    [
      'c4mp edit remove src/a.ts#oldHelper --repo .              dry run: the diff',
      "c4mp edit remove 'test/a.test.ts#login > rejects' --repo . --yes   code and plan",
    ],
  );
}
