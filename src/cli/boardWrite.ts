/**
 * P18-PB4: `c4mp board remove|move|rename|archive|unarchive|delete|group add|group remove|group order` (rename b687; archive,
 * unarchive, delete b443). Every write goes through Board editing
 * (src/services/boardEdit.ts, b473) and its guarded board writer (write.ts: dry run unless --yes, refuses when the file changed since it was read, atomic, the whole
 * file re-parsed after the write and rolled back on error, only `.c4mp/.../board.json`) and through the pure
 * operations of ops.ts (which refuse a result that adds a `board-*` warning). `runBoardWrite` (on runGuardedWrite, common.ts) is shared with the
 * bulk add (boardBulk.ts). Output: text on stdout, errors on stderr as `error: <code>: <message>` with at most 10
 * reason lines; `--json` = exactly one object on stdout (full reasons). Exit 0/1, never process.exit.
 */
import type { Command } from 'commander';
import { addExamples, addRepo } from '../cliHelp';
import { emitFailure, runGuardedWrite } from './common';
import type { Opts } from './common';
import { addBoardGroup, archiveRepoBoard, deleteRepoBoard, moveBoardItem, orderBoardGroups, removeBoardGroup, removeBoardItem, renameRepoBoard } from '../services/boardEdit';
import type { BoardOpOutcome } from '../services/boardEdit';

// The failure printer lives in common.ts (T5a); old imports from here keep working.
export { emitFailure };

/** Run one Board editing write and print the dry run or what was written (the generic body is runGuardedWrite, common.ts). Returns the exit code. */
export function runBoardWrite(opts: Opts, command: string, write: (repoRoot: string, yes: boolean) => BoardOpOutcome): number {
  return runGuardedWrite(opts, command, write);
}

function setExit(code: number): void {
  process.exitCode = code;
}

const boardOpt = (opts: Opts): string | undefined => (typeof opts.board === 'string' ? opts.board : undefined);

/** Add `remove`, `move`, `rename`, `archive`, `unarchive`, `delete` and `group` to the `board` command. */
export function registerBoardWrite(board: Command): void {
  const yesOpt = '--yes';
  const yesText = 'write the change; without it only the change is printed';
  const jsonText = 'print one JSON object instead of text';

  const removeCmd = addRepo(board.command('remove <id>'))
    .description('Remove one item. Refused while another item depends on it or is nested under it (they are listed); nothing is removed with it. Prints the change (dry run) and writes only with --yes')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((id: string, opts: Opts) => setExit(runBoardWrite(opts, 'board remove', (repo, yes) => removeBoardItem(repo, id, yes))));
  addExamples(removeCmd, ['c4mp board remove b7 --repo .          show the change', 'c4mp board remove b7 --repo . --yes    write it']);

  const moveCmd = addRepo(board.command('move <id>'))
    .description('Move an item to another board; ids stay. A top-level item takes everything nested under it; a nested item moves alone and each nest link that would cross boards (to its parent, to its children) becomes a dependency, the parent waiting for the child (listed in the dry run). Refused for a missing or archived board. Sets updated. Prints the change (dry run) and writes only with --yes')
    .requiredOption('--board <id>', '(required) the board to move to')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((id: string, opts: Opts) => setExit(runBoardWrite(opts, 'board move', (repo, yes) => moveBoardItem(repo, id, String(opts.board), yes))));
  addExamples(moveCmd, ['c4mp board move b3 --board backlog --repo .', 'c4mp board move b3 --board backlog --repo . --yes']);

  const renameCmd = addRepo(board.command('rename <board>'))
    .description('Rename a board: change its id and/or its display name. Items keep their ids; an archived board can be renamed too. Prints the change (dry run) and writes only with --yes')
    .option('--id <new-id>', 'the new board id')
    .option('--name <text>', 'the new display name')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((boardId: string, opts: Opts) => setExit(runBoardWrite(opts, 'board rename', (repo, yes) => renameRepoBoard(repo, boardId, { id: typeof opts.id === 'string' ? opts.id : undefined, name: typeof opts.name === 'string' ? opts.name : undefined }, yes))));
  addExamples(renameCmd, ['c4mp board rename polishing --name "Polishing" --repo .', 'c4mp board rename sprint-s12 --id sprint-s13 --repo . --yes']);

  for (const archived of [true, false]) {   // b443
    const name = archived ? 'archive' : 'unarchive';
    const cmd = addRepo(board.command(`${name} <board>`))
      .description(archived
        ? 'Archive a board: it is hidden from board list (shown with --all) and from the page, and board add and move refuse it; its items stay. Prints the change (dry run) and writes only with --yes'
        : 'Bring an archived board back: shown again in board list and on the page. Prints the change (dry run) and writes only with --yes')
      .option(yesOpt, yesText)
      .option('--json', jsonText)
      .action((boardId: string, opts: Opts) => setExit(runBoardWrite(opts, `board ${name}`, (repo, yes) => archiveRepoBoard(repo, boardId, archived, yes))));
    addExamples(cmd, [`c4mp board ${name} phase-8 --repo .`, `c4mp board ${name} phase-8 --repo . --yes`]);
  }

  const deleteCmd = addRepo(board.command('delete <board>'))   // b443
    .description('Delete an EMPTY board (archived or not). Refused while it holds items (they are listed); to keep a finished board, archive it instead. Prints the change (dry run) and writes only with --yes')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((boardId: string, opts: Opts) => setExit(runBoardWrite(opts, 'board delete', (repo, yes) => deleteRepoBoard(repo, boardId, yes))));
  addExamples(deleteCmd, ['c4mp board delete phase-8 --repo .', 'c4mp board delete phase-8 --repo . --yes']);

  const group = board.command('group').description('Kanban groups of a board: add, remove or order them. Run c4mp board group <command> --help for details');

  const addCmd = addRepo(group.command('add <name>'))
    .description('Add a custom group (no status). The id is made from the name. Refused for a duplicate name or id. Prints the change (dry run) and writes only with --yes')
    .option('--board <id>', 'board of the group (default: the only open board)')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((name: string, opts: Opts) => setExit(runBoardWrite(opts, 'board group add', (repo, yes) => addBoardGroup(repo, boardOpt(opts), name, yes))));
  addExamples(addCmd, ['c4mp board group add "Needs triage" --board sprint-s12 --repo . --yes']);

  const rmCmd = addRepo(group.command('remove <name>'))
    .description('Remove a custom group, by name or id. Refused while an item is in it, and for a group that follows a status. Prints the change (dry run) and writes only with --yes')
    .option('--board <id>', 'board of the group (default: the only open board)')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((name: string, opts: Opts) => setExit(runBoardWrite(opts, 'board group remove', (repo, yes) => removeBoardGroup(repo, boardOpt(opts), name, yes))));
  addExamples(rmCmd, ['c4mp board group remove "Needs triage" --board sprint-s12 --repo . --yes']);

  const orderCmd = addRepo(group.command('order <names>'))
    .description('Set the order of the groups. Names (or ids) as a comma list that names every group of the board exactly once. Only the order changes. Prints the change (dry run) and writes only with --yes')
    .option('--board <id>', 'board of the groups (default: the only open board)')
    .option(yesOpt, yesText)
    .option('--json', jsonText)
    .action((names: string, opts: Opts) => setExit(runBoardWrite(opts, 'board group order', (repo, yes) => orderBoardGroups(repo, boardOpt(opts), names.split(',').map((s) => s.trim()).filter((s) => s !== ''), yes))));
  addExamples(orderCmd, ['c4mp board group order "Needs triage,Planned,Done" --board sprint-s12 --repo .']);
}
