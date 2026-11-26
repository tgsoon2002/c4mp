/**
 * b473 (ARR-CL-B, row B4): the read-only board questions of the Command Line (`board list|show|tree|for` and the
 * `plan tree --boards` overlay), so the commands reach the board through the Query layer instead of the Boards file
 * engine. Reads only: nothing is written, not even `.c4pm/`. The commands keep the printing and the exit codes.
 */
import type { Board, BoardFile, BoardItem, Plan } from '../types';
import { loadBoard } from '../board/load';
import { tryResolveProject } from '../outputs';
import { boardTreeGraph, itemsFor, showItem } from '../board/query';
import type { BoardTreeResult, ItemView } from '../board/query';
import { isOverdue } from '../board/check';
import { flagProblem, kindProblem, statusProblem } from '../board/fields';
import { isBoardDate, todayIso } from '../util/dates';
import { compareItemIds } from '../board/serialize';
import { loadQueryContext } from './context';
import { testsOfContext } from './testsContext';

export { docText } from '../board/fields';
export type { BoardTreeResult, ItemView, LinkedElement } from '../board/query';
export type { TestRef, TestsReport } from '../c4/testAttach';

/** The board file of a repo: `ok` with its data, `none` (no project or no board file), or `problems` (it does not parse). */
export type BoardRead =
  | { state: 'ok'; data: BoardFile }
  | { state: 'none' }
  | { state: 'problems'; file: string; messages: string[] };

/**
 * Read-only: finds the project (tryResolveProject; the config is not read) and parses its board file (never creates a
 * folder or a file). `file` is the path, or 'board file'.
 */
export function readBoard(repoRoot: string): BoardRead {
  const loaded = loadBoard(tryResolveProject(repoRoot));
  if (loaded.issues.length > 0 || (loaded.path !== null && loaded.data === null)) {
    return { state: 'problems', file: loaded.path ?? 'board file', messages: loaded.issues.map((i) => i.message) };
  }
  if (loaded.data === null) return { state: 'none' };
  return { state: 'ok', data: loaded.data };
}

// ---------- list ----------

/** The filters of `board list`; every one given must match. `tags` (b219): the item must carry every one, compared lower-case. */
export interface BoardListFilter {
  board?: string;
  status?: string;
  kind?: string;
  tags?: string[];
  owner?: string;
  overdue: boolean;
  dueBefore?: string;
  /** b443: also the archived boards (board list --all). */
  all?: boolean;
}

interface ListFilter {
  status?: string;
  kind?: string;
  tags?: string[];
  owner?: string;
  overdue: boolean;
  dueBefore?: string;
  today: string;
}

/** b219: the `--tags` filter lower-cased, blanks dropped; nothing left = no tag filter. */
function tagsFilter(tags: string[] | undefined): string[] | undefined {
  const t = (tags ?? []).map((x) => x.trim().toLowerCase()).filter((x) => x !== '');
  return t.length > 0 ? t : undefined;
}

function matches(item: BoardItem, f: ListFilter): boolean {
  if (f.status !== undefined && item.status !== f.status) return false;
  if (f.kind !== undefined && item.kind !== f.kind) return false;
  if (f.owner !== undefined && item.owner !== f.owner) return false;
  if (f.tags !== undefined && !f.tags.every((t) => item.tags.some((x) => x.toLowerCase() === t))) return false;
  if (f.overdue && !isOverdue(item, f.today)) return false;
  if (f.dueBefore !== undefined && !(item.due !== undefined && item.due < f.dueBefore)) return false;
  return true;
}

/**
 * The boards and items `board list` shows, items sorted by id. Archived boards are hidden unless named with `board` or
 * `all` is set (b443);
 * with a filter, boards with no match are left out. `error`: a bad --due-before or an unknown board.
 */
export function listBoardItems(data: BoardFile, f: BoardListFilter): { error: string } | { shown: { board: Board; items: BoardItem[] }[] } {
  const dueBefore = f.dueBefore;
  if (dueBefore !== undefined && !isBoardDate(dueBefore)) return { error: `--due-before '${dueBefore}' is not a date YYYY-MM-DD` };
  // b709: an unknown status or kind (a typo) used to list nothing, exit 0; the same check as board add and set.
  const statusBad = f.status === undefined ? null : statusProblem(f.status);
  const kindBad = f.kind === undefined ? null : kindProblem(f.kind);
  const valueBad = flagProblem(statusBad ?? kindBad);
  if (valueBad !== null) return { error: valueBad };
  const boardId = f.board;
  if (boardId !== undefined && !data.boards.some((b) => b.id === boardId)) {
    return { error: `no board '${boardId}' (boards: ${data.boards.map((b) => b.id).join(', ') || 'none'})` };
  }
  const filter: ListFilter = {
    status: f.status, kind: f.kind, owner: f.owner,
    tags: tagsFilter(f.tags),
    overdue: f.overdue, dueBefore, today: todayIso(),
  };
  const filtered = filter.status !== undefined || filter.kind !== undefined || filter.owner !== undefined ||
    filter.tags !== undefined || filter.overdue || filter.dueBefore !== undefined;

  const shown: { board: Board; items: BoardItem[] }[] = [];
  for (const board of data.boards) {
    if (boardId !== undefined ? board.id !== boardId : (board.archived && !f.all)) continue;
    const items = board.items.filter((i) => matches(i, filter));
    if (filtered && items.length === 0) continue;
    shown.push({ board, items: [...items].sort((a, b) => compareItemIds(a.id, b.id)) });
  }
  return { shown };
}

/**
 * Items in display order: parents before their children, children indented one level (2 spaces) per depth.
 * Iterative (a nesting chain of any length cannot overflow the stack). An item whose parent is not in `items`
 * (other board, filtered out, unknown) is shown at the top; items stuck in a parent cycle are appended at the
 * top too, so none is ever hidden.
 */
export function nestedOrder(items: BoardItem[]): { item: BoardItem; depth: number }[] {
  const sorted = [...items].sort((a, b) => compareItemIds(a.id, b.id));
  const present = new Map<string, BoardItem>();
  for (const i of sorted) present.set(i.id, i);
  const children = new Map<string, BoardItem[]>();
  const roots: BoardItem[] = [];
  for (const i of sorted) {
    if (i.parent !== undefined && i.parent !== i.id && present.has(i.parent)) {
      const list = children.get(i.parent);
      if (list) list.push(i); else children.set(i.parent, [i]);
    } else roots.push(i);
  }
  const out: { item: BoardItem; depth: number }[] = [];
  const seen = new Set<string>();
  const emit = (start: BoardItem): void => {
    const stack: { item: BoardItem; depth: number }[] = [{ item: start, depth: 0 }];
    while (stack.length > 0) {
      const { item, depth } = stack.pop()!;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ item, depth });
      const kids = children.get(item.id) ?? [];
      for (let k = kids.length - 1; k >= 0; k--) stack.push({ item: kids[k], depth: depth + 1 });
    }
  };
  for (const r of roots) emit(r);
  for (const i of sorted) if (!seen.has(i.id)) emit(i);   // parent cycles
  return out;
}

// ---------- show / tree / for ----------

/**
 * One item with its parent, children, dependencies, dependents and linked plan elements (`plan` null = links are
 * not checked); null when no item has this id. `withTests` (D19): only then is the code of `repoRoot` scanned
 * (the repo's config) to list the tests of the linked c-items.
 */
export function showBoardItem(data: BoardFile, plan: Plan | null, id: string, opts: { withTests?: { repoRoot: string } } = {}): ItemView | null {
  const view = showItem(data, plan, id);
  if (!view || !opts.withTests) return view;
  const ctx = loadQueryContext(opts.withTests.repoRoot);
  return showItem(data, ctx.plan, id, { tests: testsOfContext(ctx) })!;
}

/** The nesting of items as a graph with the dependencies as edges (see boardTreeGraph); `error` for an unknown item or board. */
export function boardTree(data: BoardFile, id: string | null, opts: { recursive: boolean; maxNodes: number; boardId?: string }): BoardTreeResult {
  return boardTreeGraph(data, id, opts);
}

/** Every item (any board, archived ones too) that links to the plan element with this uid, with its board. */
export function itemsLinkedTo(data: BoardFile, uid: string): { board: Board; item: BoardItem }[] {
  return itemsFor(data, uid);
}
