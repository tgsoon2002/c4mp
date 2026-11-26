/**
 * P18-PB3: `c4mp board show|tree|for`: read-only views of the board for people and AI agents. They write nothing,
 * not even `.c4mp/`. Text on stdout, errors on stderr as `error: <code>: <message>`, `--json` = exactly one JSON
 * object on stdout. Exit 0 or 1 (D14). Registered by `registerBoardCommands` (board.ts) with ONE call.
 * b473: the board is read through the Query layer (src/query/board.ts).
 */
import * as path from 'path';
import type { Command } from 'commander';
import type { BoardFile, Graph, GraphNode } from '../types';
import { addExamples, addRepo } from '../cliHelp';
import {
  addDirectionOption, addFenceOption, addFormatOption, addMaxNodesOption, formatGraph, parseGraphOpts, parseMaxNodes,
} from './graphOut';
import { NO_BOARD_MESSAGE, NO_PLAN_MESSAGE, cmdError, emitError, formatBoardItemLine, runAction } from './common';
import { loadPlanState, resolveTarget } from '../services/planState';
import type { CmdError, Opts } from './common';
import { boardTree, docText, itemsLinkedTo, readBoard, showBoardItem } from '../query/board';
import type { ItemView, LinkedElement, TestRef, TestsReport } from '../query/board';

/** The board file, or what to do instead: `exit` = print nothing more and return this code. */
function loadForRead(opts: Opts, command: string): { data: BoardFile } | { exit: number } {
  const loaded = readBoard(path.resolve(opts.repo as string));
  if (loaded.state === 'problems') {
    const lines = loaded.messages.map((m) => `  ${m}`);
    return { exit: emitError(opts, command, cmdError('invalid', `${loaded.file} has problems:\n${lines.join('\n')}`)) };
  }
  if (loaded.state === 'none') {
    console.log(opts.json ? JSON.stringify({ ok: true, command, note: NO_BOARD_MESSAGE }, null, 2) : NO_BOARD_MESSAGE);
    return { exit: 0 };
  }
  return { data: loaded.data };
}

const planOrNull = (opts: Opts) => loadPlanState(opts.repo as string)?.plan ?? null;
/** `label:` padded to 13 columns; an empty label (the 2nd+ line of a list) is blank, not a lone ':'. */
const row = (label: string, value: string): string => `${(label === '' ? '' : label + ':').padEnd(13)}${value}`;

function linkedLine(l: LinkedElement): string {
  if (l.state === 'missing') return `${l.uid}  missing (no plan element has this uid)`;
  if (l.state === 'unchecked') return `${l.uid}  (no plan loaded)`;
  return [l.uid, l.kind, l.fqn, l.title, l.status, l.owner].filter((x) => x !== undefined && x !== '').join('  ');
}

/** Word-wrap each line of `text` to `width`; blank lines and a word longer than the width are kept as they are. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      if (line !== '' && line.length + 1 + word.length > width) { out.push(line); line = word; }
      else line = line === '' ? word : `${line} ${word}`;
    }
    out.push(line);
  }
  return out;
}

function formatShow(v: ItemView): string {
  const out = [formatBoardItemLine(v.item), row('board', `${v.board.id}${v.board.archived ? ' (archived)' : ''}  ${v.board.name}`)];
  const ref = (r: { id: string; title: string; status: string }): string => `${r.id}  ${r.title}  ${r.status}`;
  if (v.parent) out.push(row('parent', ref(v.parent)));
  else if (v.item.parent !== undefined) out.push(row('parent', `${v.item.parent}  missing`));
  v.children.forEach((c, k) => out.push(row(k === 0 ? 'children' : '', ref(c))));
  v.dependsOn.forEach((d, k) => out.push(row(k === 0 ? 'depends on' : '', 'missing' in d ? `${d.id}  missing` : ref(d))));
  v.dependents.forEach((d, k) => out.push(row(k === 0 ? 'required by' : '', ref(d))));
  const dates = (['size', 'sprint', 'priority', 'start', 'due', 'created', 'updated', 'closed', 'group'] as const)
    .filter((k) => v.item[k] !== undefined).map((k) => `${k} ${v.item[k]}`);
  if (dates.length > 0) out.push(row('fields', dates.join(', ')));
  (v.item.docs ?? []).forEach((d, k) => out.push(k === 0 ? row('docs', docText(d)) : `${' '.repeat(13)}${docText(d)}`));
  if (v.item.outcome !== undefined) out.push(row('outcome', v.item.outcome.split('\n').join(`\n${' '.repeat(13)}`)));
  if (v.item.description !== undefined) {
    out.push('description:');
    for (const l of wrapText(v.item.description, 78)) out.push(`  ${l}`);
  }
  v.linked.forEach((l, k) => out.push(row(k === 0 ? 'links' : '', linkedLine(l))));
  if (v.tests) out.push(...testsLines(v.tests));
  return out.join('\n');
}

const TESTS_SHOWN = 20;   // text rows per list; --json lists every test
const SHELL_PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shellWord = (s: string): string => (SHELL_PLAIN.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const pad = ' '.repeat(13);

/** One test to run: where it is, then the command (run from the repo root, as the viewer's Copy gives it). */
function testRefLines(t: TestRef): string[] {
  const where = `${t.file}:${t.line}${t.name === '' ? '' : `  ${t.name}`}  (${t.level}${t.target !== null ? ` ${t.target}` : ''})`;
  const cmd = t.run === null ? 'no run command: no test runner found (config tests.command sets one)'
    : t.run.cwd === '.' ? t.run.command : `cd ${shellWord(t.run.cwd)} && ${t.run.command}`;
  return [where, `  ${cmd}`];
}

/** T26-12 (D19): counts, the tests to run with their commands and the tests to write; touching tests are only counted. */
function testsLines(r: TestsReport): string[] {
  const out = [row('tests', `${r.counts.run} to run, ${r.counts.toWrite} to write, ${r.counts.touches} touching (attached elsewhere; --json lists them)`)];
  const list = (label: string, lines: string[][]): void => {
    lines.slice(0, TESTS_SHOWN).forEach((ls, k) => ls.forEach((l, j) => out.push(`  ${(k === 0 && j === 0 ? label + ':' : '').padEnd(11)}${l}`)));
    if (lines.length > TESTS_SHOWN) out.push(`${pad}+${lines.length - TESTS_SHOWN} more (--json lists every one)`);
  };
  list('to run', r.run.map(testRefLines));
  list('to write', r.toWrite.map((p) => [`${p.name}  (on ${p.parent}, ${p.source.file}:${p.source.line})`]));
  return out;
}

/** AI-readable tree: indented `id  [kind]  status owner  title` lines, then who waits for whom. Iterative. */
function formatTreeText(graph: Graph): string {
  const kids = new Map<string | undefined, GraphNode[]>();
  for (const n of graph.nodes) {
    const list = kids.get(n.parent);
    if (list) list.push(n); else kids.set(n.parent, [n]);
  }
  const lines: string[] = [];
  const stack: { n: GraphNode; depth: number }[] = [];
  const push = (parent: string | undefined, depth: number): void => {
    const list = kids.get(parent) ?? [];
    for (let k = list.length - 1; k >= 0; k--) stack.push({ n: list[k], depth });
  };
  push(undefined, 0);
  while (stack.length > 0) {
    const { n, depth } = stack.pop()!;
    const tail = [n.status, n.owner].filter(Boolean).join(' ');
    lines.push(`${'  '.repeat(depth)}${n.id}  [${n.kind}]${tail ? `  ${tail}` : ''}  ${n.label}`);
    push(n.id, depth + 1);
  }
  if (graph.edges.length > 0) {
    lines.push('dependencies:');
    for (const e of graph.edges) lines.push(`  ${e.to} waits for ${e.from}`);
  }
  return lines.join('\n');
}

function runShow(id: string, opts: Opts): number {
  const loaded = loadForRead(opts, 'board show');
  if ('exit' in loaded) return loaded.exit;
  // D19: only with --with-tests is the code scanned (the repo's config, no scan flags)
  const view = showBoardItem(loaded.data, planOrNull(opts), id, opts.withTests === true ? { withTests: { repoRoot: opts.repo as string } } : {});
  if (!view) return emitError(opts, 'board show', cmdError('not-found', `no item '${id}'`));
  console.log(opts.json ? JSON.stringify({ ok: true, command: 'board show', ...view }, null, 2) : formatShow(view));
  return 0;
}

function runTree(id: string | undefined, opts: Opts): number {
  const bad = (e: CmdError): number => emitError(opts, 'board tree', e);
  const parsed = parseGraphOpts(opts);
  if ('code' in parsed) return bad(parsed);
  const { format, direction } = parsed;
  const maxNodes = parseMaxNodes(opts);
  if (typeof maxNodes !== 'number') return bad(maxNodes);
  if (id !== undefined && opts.board !== undefined) return bad(cmdError('invalid', 'name an item or --board, not both (an item already knows its board)'));

  const loaded = loadForRead(opts, 'board tree');
  if ('exit' in loaded) return loaded.exit;
  const built = boardTree(loaded.data, id ?? null, {
    recursive: opts.recursive === true, maxNodes, ...(typeof opts.board === 'string' ? { boardId: opts.board } : {}),
  });
  if ('error' in built) return bad(cmdError(built.error.startsWith('no ') ? 'not-found' : 'invalid', built.error));

  console.log(formatGraph(format, direction, built.graph, opts, {
    json: () => JSON.stringify({ ok: true, command: 'board tree', board: built.boardId, ...built.graph, outside: built.outside, truncated: built.truncated }, null, 2),
    text: () => formatTreeText(built.graph),
    comments: (dropped) => {
      const comments: string[] = [];
      if (built.outside > 0) comments.push(`${built.outside} dependency link(s) leave this view`);
      if (built.truncated) comments.push('deeper levels are hidden (use -r)');
      if (dropped > 0) comments.push(`${dropped} dependency link(s) between an item and its own descendant are not drawn`);
      return comments;
    },
  }));
  return 0;
}

function runFor(target: string, opts: Opts): number {
  const loaded = loadForRead(opts, 'board for');
  if ('exit' in loaded) return loaded.exit;
  const state = loadPlanState(opts.repo as string);
  if (!state) return emitError(opts, 'board for', cmdError('no-plan', NO_PLAN_MESSAGE));
  const resolved = resolveTarget(state, target);
  if (!resolved.ok) return emitError(opts, 'board for', resolved.error);
  const uid = resolved.el.metadata.uid;
  if (!uid) {
    return emitError(opts, 'board for', cmdError('invalid', `'${resolved.el.id}' has no uid`, { hint: 'run c4mp plan ids to give every element a uid' }));
  }
  const hits = itemsLinkedTo(loaded.data, uid);
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true, command: 'board for', target: { uid, fqn: resolved.el.id, kind: resolved.el.kind },
      items: hits.map((h) => ({ board: h.board.id, ...(h.board.archived ? { archived: true } : {}), item: h.item })),
    }, null, 2));
  } else if (hits.length === 0) {
    console.log(`no board item links ${resolved.el.id} (uid ${uid})`);
  } else {
    console.log(`${resolved.el.id}  (uid ${uid})  is linked by ${hits.length} item${hits.length === 1 ? '' : 's'}:`);
    for (const h of hits) console.log(`  ${h.board.id}${h.board.archived ? ' (archived)' : ''}  ${formatBoardItemLine(h.item)}`);
  }
  return 0;
}

/** Add `show`, `tree` and `for` to the `board` command. */
export function registerBoardRead(board: Command): void {
  const showCmd = addRepo(board.command('show <id>'))
    .description('Show one item: parent, children, dependencies, who waits for it, and the plan elements it links to (kind, fqn, status, owner; a dead uid is listed as missing). Read-only: writes nothing')
    .option('--json', 'print one JSON object instead of text')
    .option('--with-tests', 'also list the tests of the linked c-items and the c-items below them: to run (with run commands) and to write; scans the code (repo config)')
    .action((id: string, opts: Opts) => runAction(opts, 'board show', () => runShow(id, opts)));
  addExamples(showCmd, ['c4mp board show b12 --repo .', 'c4mp board show b12 --repo . --json', 'c4mp board show b12 --repo . --with-tests   what to run and what to write']);

  const treeCmd = addRepo(board.command('tree [id]'))
    .description('Draw items and their nesting; dependencies are arrows from the item waited for to the item that waits. With an id: that item and one level below it; without: the top-level items of a board. Prints Mermaid, text or JSON. Read-only: writes nothing')
    .option('--board <id>', 'board to draw when no id is given (needed when there are 2+ open boards)')
    .option('-r, --recursive', 'show every level below');
  addFormatOption(treeCmd);
  addDirectionOption(treeCmd);
  addMaxNodesOption(treeCmd);
  addFenceOption(treeCmd);
  treeCmd.action((id: string | undefined, opts: Opts) => runAction(opts, 'board tree', () => runTree(id, opts)));
  addExamples(treeCmd, [
    'c4mp board tree --repo . --board sprint-s12',
    'c4mp board tree b1 --repo . -r              a feature and all its tasks',
    'c4mp board tree b1 --repo . --format text',
  ]);

  const forCmd = addRepo(board.command('for <target>'))
    .description('List every item (any board) that links to a plan element. Target is a uid, fqn, local id or name (one match needed; the element needs a uid). Read-only: writes nothing')
    .option('--json', 'print one JSON object instead of text')
    .action((target: string, opts: Opts) => runAction(opts, 'board for', () => runFor(target, opts)));
  addExamples(forCmd, ['c4mp board for app.api --repo .', 'c4mp board for app.api --repo . --json']);
}
