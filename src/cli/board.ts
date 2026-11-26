/**
 * Phase 16: `c4mp board ...` (list now; add, set, link, unlink follow). One module registers itself with ONE
 * call from bin/cli.ts, like src/queryCli.ts. Errors: text on stderr and `process.exitCode = 1`; never
 * `process.exit` (it can truncate piped stdout).
 * b473: reads go through the Query layer (src/query/board.ts), writes through Board editing (src/services/boardEdit.ts);
 * this file keeps the options, the printing and the exit codes.
 */
import * as path from 'path';
import { Option } from 'commander';
import type { Command } from 'commander';
import { BOARD_DESCRIPTION_MAX, BOARD_KINDS, BOARD_OUTCOME_MAX, BOARD_SIZES, BOARD_STATUSES, PLAN_PRIORITIES } from '../constants';
import { addRepo, addExamples, collectValues as collect } from '../cliHelp';
import type { LookupItem } from '../util/lookup';
import { splitTags } from '../tags';
import { listBoardItems, nestedOrder, readBoard } from '../query/board';
import { addBoardItem, addBoardItemOutcome, applyBoardChange, linkBoardItem, setBoardItem } from '../services/boardEdit';
import type { BoardChange, UnresolvedTarget } from '../services/boardEdit';
import { registerBoardRead } from './boardRead';
import { registerBoardWrite } from './boardWrite';
import { runBulkAdd } from './boardBulk';
import { NO_BOARD_MESSAGE, NO_PLAN_MESSAGE, formatBoardItemLine, runGuardedWrite } from './common';

type Opts = Record<string, unknown>;

function fail(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------- list ----------

/** b219: the tags option: `--tags` (shown in help) or the hidden old spelling `--tag`; both given = an error. */
export function tagsOf(opts: Opts): string | undefined {
  const tags = str(opts.tags);
  const old = str(opts.tag);
  if (tags !== undefined && old !== undefined) throw new Error('give --tags or --tag, not both (--tag is the old spelling of --tags)');
  return tags ?? old;
}

function runList(opts: Opts): void {
  const repoRoot = path.resolve(opts.repo as string);
  const loaded = readBoard(repoRoot);
  const asJson = !!opts.json;
  if (loaded.state === 'problems') {
    console.error(`${loaded.file} has problems:`);
    for (const m of loaded.messages) console.error(`  ${m}`);
    process.exitCode = 1;
    return;
  }
  if (loaded.state === 'none') {
    if (asJson) console.log(JSON.stringify({ boards: [] }, null, 2));
    else console.log(NO_BOARD_MESSAGE);
    return;
  }

  const listed = listBoardItems(loaded.data, {
    board: str(opts.board), status: str(opts.status), kind: str(opts.kind), owner: str(opts.owner), tags: splitTags(tagsOf(opts)),
    overdue: !!opts.overdue, dueBefore: str(opts.dueBefore), all: !!opts.all,
  });
  if ('error' in listed) return fail(listed.error);
  const shown = listed.shown;

  if (asJson) {
    const boards = shown.map(({ board, items }) => ({ id: board.id, name: board.name, ...(board.archived ? { archived: true } : {}), items }));
    console.log(JSON.stringify({ boards }, null, 2));
    return;
  }
  if (shown.length === 0) { console.log('no matching items'); return; }
  for (const { board, items } of shown) {
    console.log(`board ${board.id}  ${board.name}${board.archived ? '  (archived)' : ''}  (${items.length} item${items.length === 1 ? '' : 's'})`);
    for (const { item, depth } of nestedOrder(items)) console.log(`${'  '.repeat(depth + 1)}${formatBoardItemLine(item)}`);
  }
}

// ---------- shared by the writing commands (add, set, link, unlink) ----------

/** Runs one command body; any failure (refusal, unreadable file, write rollback, no project) becomes `error: ...` + exit 1. */
function guarded(body: () => void): void {
  try {
    body();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Print what would change, and write only with --yes (Board editing: the guarded writer). */
function commit(change: BoardChange, yes: boolean): void {
  for (const l of change.lines) console.log(l);
  if (!yes) {
    console.log('dry run: nothing written. Add --yes to apply.');
    return;
  }
  applyBoardChange(change);
  console.log(change.done);
}


// ---------- add ----------

function runAdd(opts: Opts): void {
  const repoRoot = path.resolve(opts.repo as string);
  commit(addBoardItem(repoRoot, { ...opts, tags: tagsOf(opts) }), !!opts.yes);
}

// ---------- set ----------

function runSet(id: string, opts: Opts): void {
  const repoRoot = path.resolve(opts.repo as string);
  const change = setBoardItem(repoRoot, id, { ...opts, tags: tagsOf(opts) });
  if (change.kind === 'nothing') {
    for (const n of change.notes) console.log(n);   // b441: e.g. a --remove-tag value the item did not have
    console.log('nothing to change');
    return;
  }
  commit(change, !!opts.yes);
}

// ---------- link / unlink ----------

/** The none / ambiguous / no-uid messages of a link target that names no single plan element with a uid (exit 1). */
export function printUnresolved(target: string, u: UnresolvedTarget): void {
  const line = (m: LookupItem): string => `  ${m.uid ?? '(no uid)'}  ${m.fqn ?? m.id}  ${m.title}`;
  if (u.reason === 'no-plan') {
    console.log(NO_PLAN_MESSAGE);
  } else if (u.reason === 'none') {
    console.log(`no element matches '${target}'`);
    for (const c of u.closest) console.log(line(c));
  } else if (u.reason === 'ambiguous') {
    console.log(`'${target}' matches ${u.matches.length} elements, use a uid:`);
    for (const m of u.matches) console.log(line(m));
    if (u.matches.some((m) => !m.uid)) console.log('run c4mp plan ids to give every element a uid');
  } else {
    console.log(`'${u.item.fqn ?? u.item.id}' has no uid; run c4mp plan ids to give every element a uid`);
  }
  process.exitCode = 1;
}

function runLink(id: string, target: string, opts: Opts, unlink: boolean): void {
  const repoRoot = path.resolve(opts.repo as string);
  const change = linkBoardItem(repoRoot, id, target, unlink);
  if (change.kind === 'unresolved') return printUnresolved(target, change);
  if (change.kind === 'nothing') {
    console.log('nothing to change');
    return;
  }
  commit(change, !!opts.yes);
}

/** Register `c4mp board` and its subcommands. Call before the summary loop in bin/cli.ts. */
export function registerBoardCommands(program: Command): void {
  const board = program
    .command('board')
    .description(
      'Tasks, features, issues and bugs on boards. ' +
        'Boards live in .c4mp/projects/<repoId>/board/board.json; items nest, depend on each other and link to plan elements by uid. ' +
        'Run c4mp board <command> --help for details',
    );

  const listCmd = addRepo(board.command('list'))
    .description('List board items, grouped by board. Read-only: writes nothing')
    .option('--board <id>', 'only this board (also shows an archived board)')
    .option('--status <status>', `only items with this status: ${BOARD_STATUSES.join(', ')}`)
    .option('--kind <kind>', `only items of this kind: ${BOARD_KINDS.join(', ')}`)
    .option('--tags <tags>', 'only items with every one of these tags (comma list)')
    .addOption(new Option('--tag <tags>', 'old spelling of --tags (hidden)').hideHelp())   // b219: the old spelling of --tags
    .option('--owner <owner>', 'only items with this owner')
    .option('--overdue', 'only items past their due date and not done or abandoned')
    .option('--due-before <date>', 'only items due before this date (YYYY-MM-DD)')
    .option('--all', 'also list archived boards (marked archived)')
    .option('--json', 'print one JSON object { boards: [...] } instead of text')
    .action((opts: Opts) => {
      try {
        runList(opts);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  addExamples(listCmd, [
    'c4mp board list --repo .',
    'c4mp board list --repo . --status in-progress --owner K',
    'c4mp board list --repo . --overdue',
    'c4mp board list --repo . --json',
    'c4mp board list --repo . --all',
  ]);

  const addCmd = addRepo(board.command('add'))
    .description(
      'Add an item to a board. ' +
        'Mints the next id (b1, b2, ...). A board name that does not exist yet creates that board. ' +
        'Prints the item (dry run) and writes only with --yes',
    )
    .option('--title <text>', 'item title (required without --from-file)')
    .option('--kind <kind>', `${BOARD_KINDS.join(', ')} (required without --from-file)`)
    .option('--from-file <path>', 'create many items from a JSON file {"items": [...]}; other item options are not allowed')
    .option('--json', 'print one JSON object instead of text (the new ids are under "minted")')
    .option('--board <id>', 'board to add to (required when the file has more than one; a new id creates the board)')
    .option('--board-name <name>', 'display name for a board created by --board (default: the id)')
    .option('--status <status>', 'planned, in-progress, done or abandoned', 'planned')
    .option('--owner <owner>', 'who owns the item')
    .option('--parent <id>', 'nest under this item of the same board')
    .option('--depends <ids>', 'comma separated ids of items this one waits for')
    .option('--tags <tags>', 'comma separated tags: lower-case letters, digits and dashes')
    .addOption(new Option('--tag <tags>', 'old spelling of --tags (hidden)').hideHelp())   // b219: the old spelling of --tags
    .option('--link <uids>', 'comma separated uids of plan elements (see c4mp plan show)')
    .option('--start <date>', 'start date YYYY-MM-DD')
    .option('--due <date>', 'due date YYYY-MM-DD')
    .option('--group <name>', 'Kanban group of the board, by name or id')
    .option('--description <text>', `free text, several lines allowed, up to ${BOARD_DESCRIPTION_MAX} characters`)
    .option('--description-file <path>', 'read the description from a UTF-8 text file (for long text)')
    .option('--doc <spec>', 'a document: path:docs/x.md (repo-relative) or url:https://... ; optional label Label=path:docs/x.md ; repeat the flag or use a comma list', collect)
    .option('--outcome <text>', `how it ended: a commit hash or a verified-by note, up to ${BOARD_OUTCOME_MAX} characters`)
    .option('--size <size>', BOARD_SIZES.join(', '))
    .option('--sprint <sprint>', 'sprint label such as S15')
    .option('--priority <priority>', PLAN_PRIORITIES.join(', '))
    .option('--yes', 'write the change; without it only the item is printed')
    .action((opts: Opts) => {
      if (opts.fromFile !== undefined) process.exitCode = runBulkAdd(opts);   // P18-PB5
      else if (opts.json) process.exitCode = runGuardedWrite(opts, 'board add', (repo, yes) => addBoardItemOutcome(repo, { ...opts, tags: tagsOf(opts) }, yes));   // b445
      else guarded(() => runAdd(opts));
    });
  addExamples(addCmd, [
    'c4mp board add --repo . --title "Fix header" --kind bug              show the item',
    'c4mp board add --repo . --title "Fix header" --kind bug --yes        write it',
    'c4mp board add --repo . --title Quiz --kind feature --board sprint-s12 --due 2026-10-30 --yes',
    'c4mp board add --repo . --from-file items.json --board sprint-s12',
    'c4mp board add --repo . --title "Pick a database" --kind decision --description-file notes.txt --doc path:docs/db.md --size M --yes',
  ]);

  const setCmd = addRepo(board.command('set <id>'))
    .description(
      'Change fields of one item. ' +
        'Only the named fields change; none clears parent, depends, tags, start, due, group, owner, description, outcome, size, sprint, priority and docs. ' +
        'Sets updated (and closed when the status becomes done). Prints before and after (dry run) and writes only with --yes',
    )
    .option('--status <status>', 'planned, in-progress, done or abandoned')
    .option('--title <text>', 'new title')
    .option('--owner <owner>', 'new owner, or none')
    .option('--kind <kind>', BOARD_KINDS.join(', '))
    .option('--parent <id>', 'nest under this item of the same board, or none')
    .option('--depends <ids>', 'comma separated ids this item waits for, or none')
    .option('--add-depends <ids>', 'ADD items this one waits for (comma list or repeat the flag)', collect)
    .option('--remove-depends <ids>', 'REMOVE items from the ones this one waits for (comma list or repeat the flag)', collect)
    .option('--tags <tags>', 'comma separated tags, or none')
    .addOption(new Option('--tag <tags>', 'old spelling of --tags (hidden)').hideHelp())   // b219: the old spelling of --tags
    .option('--add-tag <tags>', 'ADD tags to the existing ones (comma list or repeat the flag; one already there is kept once)', collect)
    .option('--remove-tag <tags>', 'REMOVE these tags (comma list or repeat the flag)', collect)
    .option('--start <date>', 'start date YYYY-MM-DD, or none')
    .option('--due <date>', 'due date YYYY-MM-DD, or none')
    .option('--group <name>', 'Kanban group of the board, by name or id, or none')
    .option('--description <text>', 'REPLACE the description (several lines allowed), or none; only one description option per call')
    .option('--description-file <path>', 'read the new description from a UTF-8 text file')
    .option('--append-description <text>', 'add text after the description, one blank line between (several lines allowed)')
    .option('--append-description-file <path>', 'like --append-description, the text read from a UTF-8 file')
    .option('--prepend-description <text>', 'add text before the description, one blank line between')
    .option('--prepend-description-file <path>', 'like --prepend-description, the text read from a UTF-8 file')
    .option('--doc <spec>', 'REPLACE the documents: path:docs/x.md or url:https://... (optional Label=); repeat or comma list; none clears', collect)
    .option('--add-doc <spec>', 'ADD documents to the existing ones (same syntax as --doc; a repeated path or url is kept once)', collect)
    .option('--remove-doc <spec>', 'REMOVE documents, matched by path or url (same syntax as --doc; the label is ignored)', collect)
    .option('--outcome <text>', 'how it ended (commit hash, verified-by note), or none')
    .option('--size <size>', `${BOARD_SIZES.join(', ')}, or none`)
    .option('--sprint <sprint>', 'sprint label such as S15, or none')
    .option('--priority <priority>', `${PLAN_PRIORITIES.join(', ')}, or none`)
    .option('--yes', 'write the change; without it only the change is printed')
    .action((id: string, opts: Opts) => guarded(() => runSet(id, opts)));
  addExamples(setCmd, [
    'c4mp board set b3 --repo . --status done              show the change',
    'c4mp board set b3 --repo . --status done --yes        write it',
    'c4mp board set b3 --repo . --due none --owner K --yes',
    'c4mp board set b3 --repo . --add-doc "Design=path:docs/design.md" --add-doc url:https://example.com/spec --yes',
    'c4mp board set b3 --repo . --outcome "verified by test run, commit 1a2b3c4" --size S --yes',
    'c4mp board set b3 --repo . --append-description "Round 2: also the --from-file error" --yes',
    'c4mp board set b3 --repo . --add-tag api --remove-tag old --add-depends b7 --yes',
  ]);

  for (const unlink of [false, true]) {
    const name = unlink ? 'unlink' : 'link';
    const cmd = addRepo(board.command(`${name} <id> <target>`))
      .description(
        unlink
          ? 'Remove the link from an item to a plan element. Target is a uid, fqn, local id or name; prints the change (dry run) and writes only with --yes'
          : 'Link an item to a plan element. Target is a uid, fqn, local id or name (one match needed); stores its uid; prints the change (dry run) and writes only with --yes. Never edits the plan',
      )
      .option('--yes', 'write the change; without it only the change is printed')
      .action((id: string, target: string, opts: Opts) => guarded(() => runLink(id, target, opts, unlink)));
    addExamples(cmd, [
      `c4mp board ${name} b3 app.api --repo .          show the change`,
      `c4mp board ${name} b3 app.api --repo . --yes    write it`,
    ]);
  }

  registerBoardRead(board);   // show, tree, for (P18-PB3)
  registerBoardWrite(board);  // remove, move, group (P18-PB4)
}
