/**
 * P18-PB1: pure board operations behind `board remove|move|group|add --from-file`.
 * Each takes a BoardFile and returns a NEW BoardFile (the input is never changed) plus the lines to print, or
 * `{error, reasons}`. No fs. Every result is judged by `checkBoard` (the one rule set, cycles included): a
 * warning that the input file did not already have refuses the operation. All id-keyed lookups use Map/Set
 * (`__proto__` is a legal id) and every walk is iterative (a 20000-item board must not overflow the stack).
 */
import type { Board, BoardDoc, BoardFile, BoardGroup, BoardItem } from '../types';
import { boardDocProblem } from './docs';
import { descriptionProblem, kindProblem, outcomeProblem, parseDocSpec, priorityProblem, sameDoc, sizeProblem, sprintProblem, statusProblem } from './fields';
import { isValidTag } from '../tags';
import { isBoardDate } from './dates';
import { BOARD_ID_RE } from './parse';
import { checkBoard, DEFAULT_GROUP_IDS } from './check';
import { defaultGroups } from './view';
import { timed } from '../log';
import { isObj } from '../util/obj';
import { didYouMean } from '../util/text';
import { CMD_NAME } from '../constants';

export interface OpOk {
  file: BoardFile;
  /** Human lines describing the change (printed before the dry-run notice). */
  lines: string[];
}
export interface OpError {
  error: string;
  /** One line per reason (blockers, new warnings, bad fields). May be long; the CLI caps the text form. */
  reasons: string[];
}
export type OpResult = OpOk | OpError;

export const isOpError = (r: OpResult): r is OpError => 'error' in r;

const refuse = (error: string, reasons: string[] = []): OpError => ({ error, reasons });

function clone(file: BoardFile): BoardFile {
  return JSON.parse(JSON.stringify(file)) as BoardFile;
}

/** Where every item lives. If a hand-built file repeats an id, the first wins (as checkBoard does). */
function indexItems(file: BoardFile): Map<string, { board: Board; item: BoardItem }> {
  const m = new Map<string, { board: Board; item: BoardItem }>();
  for (const board of file.boards) for (const item of board.items) if (!m.has(item.id)) m.set(item.id, { board, item });
  return m;
}

const warnKey = (f: { rule: string; id: string; message: string }): string => `${f.rule}\u0000${f.id}\u0000${f.message}`;

/**
 * The gate: warnings (and worse) of `checkBoard` on `after` that `before` did not have. Messages, in
 * checkBoard order. `plan` is null: link existence is the CLI's business (it has the plan).
 */
export function newBoardProblems(before: BoardFile, after: BoardFile, today: string): string[] {
  const had = new Set(checkBoard(before, null, { today }).filter((f) => f.severity !== 'info').map(warnKey));
  return checkBoard(after, null, { today })
    .filter((f) => f.severity !== 'info' && !had.has(warnKey(f)))
    .map((f) => f.message);
}

function gated(before: BoardFile, after: BoardFile, lines: string[], today: string): OpResult {
  const problems = timed('board gate', () => newBoardProblems(before, after, today));
  if (problems.length > 0) return refuse(`this would make the board worse (${problems.length} new problem${problems.length === 1 ? '' : 's'}), nothing changed`, problems);
  return { file: after, lines };
}

/** Item ids `b<n>` for `count` new items: n continues after the highest `b<number>` id in the WHOLE file (hand ids such as epic-1 are ignored). */
export function mintItemIds(file: BoardFile, count: number): string[] {
  let max = 0;
  for (const board of file.boards) {
    for (const item of board.items) {
      const m = /^b(\d+)$/.exec(item.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return Array.from({ length: count }, (_, k) => `b${max + 1 + k}`);
}

const LIST_CAP = 20;
/** `a, b, c` for up to LIST_CAP ids, then `... and N more`. */
function idList(ids: string[]): string {
  return ids.length <= LIST_CAP ? ids.join(', ') : `${ids.slice(0, LIST_CAP).join(', ')} ... and ${ids.length - LIST_CAP} more`;
}

// ---------- remove ----------

/** D21: remove one item. Refused while another item depends on it or nests under it (no cascade); lists them. */
export function removeItem(file: BoardFile, id: string, opts: { today: string }): OpResult {
  const next = clone(file);
  const found = indexItems(next).get(id);
  if (!found) return refuse(`no item '${id}'`);

  const blockers: string[] = [];
  for (const board of next.boards) {
    for (const i of board.items) {
      if (i.parent === id) blockers.push(`${i.id} is nested under ${id}`);
      if (i.dependsOn.includes(id)) blockers.push(`${i.id} depends on ${id}`);
    }
  }
  if (blockers.length > 0) return refuse(`cannot remove '${id}': ${blockers.length} reason${blockers.length === 1 ? '' : 's'} (items depend on it or nest under it; remove or change them first)`, blockers);

  found.board.items = found.board.items.filter((i) => i.id !== id);
  return gated(file, next, [`remove ${id}  ${found.item.title}  (board '${found.board.id}')`], opts.today);
}

// ---------- move ----------

/**
 * b444 (changes D22): move ONE nested item to another board; its children stay on their board. A nest link may not
 * cross boards, so each one that would becomes a dependency, the parent waiting for the child:
 *   up:   old parent P (source board) -> P.dependsOn += item; item.parent is dropped;
 *   down: each child C of the item (source board) -> item.dependsOn += C; C.parent is dropped.
 * A dependency that already exists is kept once. `updated` is set on the item, P and every child. An unknown parent id
 * (a hand-made file) is left as it is. The result goes through gated(): a dependency cycle this creates is refused.
 * `found` and `target` are entries of `next` (the clone being edited). No recursion; Set lookups (big boards).
 */
function moveNestedItem(file: BoardFile, next: BoardFile, found: { board: Board; item: BoardItem }, target: Board, opts: { today: string }): OpResult {
  const { board: source, item } = found;
  const parentId = item.parent!;
  const linkLine = (p: string, c: string, existed: boolean): string =>
    `  nest link ${p} > ${c} becomes a dependency: ${p} depends on ${c}${existed ? ' (already a dependency)' : ''}`;
  const lines = [`move ${item.id}  ${item.title}  from board '${source.id}' to board '${target.id}' (alone: it was nested under ${parentId})`];
  const touched: BoardItem[] = [item];

  const parent = source.items.find((i) => i.id === parentId && i !== item);
  if (parent) {
    const existed = parent.dependsOn.includes(item.id);
    if (!existed) parent.dependsOn.push(item.id);
    delete item.parent;
    touched.push(parent);
    lines.push(linkLine(parent.id, item.id, existed));
  }

  const deps = new Set(item.dependsOn);
  const children = source.items.filter((i) => i.parent === item.id && i !== item);
  children.forEach((c, k) => {
    const existed = deps.has(c.id);
    if (!existed) { item.dependsOn.push(c.id); deps.add(c.id); }
    delete c.parent;
    touched.push(c);
    if (k < LIST_CAP) lines.push(linkLine(item.id, c.id, existed));
  });
  if (children.length > LIST_CAP) lines.push(`  ... and ${children.length - LIST_CAP} more`);

  source.items = source.items.filter((i) => i !== item);
  target.items.push(item);
  for (const t of touched) t.updated = opts.today;
  lines.push(`  updated: ${opts.today} on ${touched.length} item${touched.length === 1 ? '' : 's'}`);
  return gated(file, next, lines, opts.today);
}

/**
 * D22: move an item to another board, ids kept. A top-level item moves with all its nested descendants; a nested item
 * moves alone and its nest links become dependencies (b444, moveNestedItem). Refused: the target board is missing or
 * archived, the item is already there. `updated` is set on every moved or changed item (Q6: move yes). A custom group
 * the target board lacks shows up as a new `board-unknown-group` warning and refuses (clear it first with
 * `board set <id> --group none`).
 */
export function moveItem(file: BoardFile, id: string, boardId: string, opts: { today: string }): OpResult {
  const next = clone(file);
  const found = indexItems(next).get(id);
  if (!found) return refuse(`no item '${id}'`);
  const target = next.boards.find((b) => b.id === boardId);
  if (!target) return refuse(`no board '${boardId}' (boards: ${next.boards.map((b) => b.id).join(', ') || 'none'})`);
  if (target.archived) return refuse(`board '${boardId}' is archived; unarchive it first (${CMD_NAME} board unarchive ${boardId})`);
  if (target === found.board) return refuse(`'${id}' is already in board '${boardId}'`);
  if (found.item.parent !== undefined) return moveNestedItem(file, next, found, target, opts);   // b444: a nested item moves alone

  // Descendants by `parent`, iterative; `seen` stops a parent cycle in a hand-built file.
  const kids = new Map<string, BoardItem[]>();
  for (const i of found.board.items) {
    if (i.parent === undefined) continue;
    const list = kids.get(i.parent);
    if (list) list.push(i); else kids.set(i.parent, [i]);
  }
  const moved: BoardItem[] = [];
  const seen = new Set<string>();
  const stack: BoardItem[] = [found.item];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    moved.push(cur);
    for (const k of kids.get(cur.id) ?? []) stack.push(k);
  }
  found.board.items = found.board.items.filter((i) => !seen.has(i.id));
  for (const m of moved) m.updated = opts.today;
  target.items.push(...moved);

  const lines = [`move ${id}  ${found.item.title}  from board '${found.board.id}' to board '${target.id}'`];
  if (moved.length > 1) lines.push(`  moves with it (${moved.length - 1}): ${idList(moved.filter((m) => m.id !== id).map((m) => m.id))}`);
  lines.push(`  updated: ${opts.today} on ${moved.length} item${moved.length === 1 ? '' : 's'}`);
  return gated(file, next, lines, opts.today);
}

// ---------- groups ----------

/** Same slug the Kanban uses for a new group (Document/v0.5-board-map-demo.html `slug`), plus `g-` when it would start with a digit. */
export function groupSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  return BOARD_ID_RE.test(s) ? s : `g-${s}`;
}

/** The groups a board shows: its own, or the three defaults. */
function groupsOf(board: Board): BoardGroup[] {
  return board.groups ?? defaultGroups();
}

/** A group named by id or by name (name compared case-insensitively). */
function findGroup(groups: BoardGroup[], key: string): BoardGroup | undefined {
  const k = key.trim();
  return groups.find((g) => g.id === k) ?? groups.find((g) => g.name.toLowerCase() === k.toLowerCase());
}

/** A group of `board` named by id or by name (the Kanban prints `--group "<name>"`). Boards without `groups` offer the three defaults. */
export function findBoardGroup(board: Board, key: string): BoardGroup | undefined {
  return findGroup(groupsOf(board), key);
}

function boardOrError(next: BoardFile, boardId: string): Board | OpError {
  return next.boards.find((b) => b.id === boardId) ?? refuse(`no board '${boardId}' (boards: ${next.boards.map((b) => b.id).join(', ') || 'none'})`);
}

/** D23: add a custom group (no `status`). The id is the slug of the name; a duplicate id or name is refused. A board without `groups` gets the three default groups written first, so they are not lost. */
export function addGroup(file: BoardFile, boardId: string, name: string, opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  const clean = name.trim();
  if (clean === '') return refuse('group name must not be empty');
  if (/[,\r\n]/.test(clean)) return refuse(`group name '${clean}' must not contain a comma or a line break (group order is written as a comma list)`);
  const groups = groupsOf(board);
  const id = groupSlug(clean);
  const dup = groups.find((g) => g.id === id || g.name.toLowerCase() === clean.toLowerCase());
  if (dup) return refuse(`board '${boardId}' already has a group '${dup.name}' (id ${dup.id})`);

  const lines = [`add group '${clean}' (id ${id}) to board '${boardId}'`];
  if (board.groups === undefined) {
    board.groups = defaultGroups();
    lines.push(`  the board had no groups: the default ones (${board.groups.map((g) => g.id).join(', ')}) are written too`);
  }
  board.groups.push({ id, name: clean });
  return gated(file, next, lines, opts.today);
}

/** D23: remove a custom group (by name or id). Refused for a group with a `status` (built in) and while an item uses it. */
export function removeGroup(file: BoardFile, boardId: string, key: string, opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  const g = findGroup(groupsOf(board), key);
  if (!g) return refuse(`board '${boardId}' has no group '${key}' (groups: ${groupsOf(board).map((x) => x.name).join(', ')})`);
  if (g.status !== undefined) return refuse(`group '${g.name}' follows the status '${g.status}' and is built in; only custom groups can be removed`);
  const users = board.items.filter((i) => i.group === g.id).map((i) => i.id);
  if (users.length > 0) {
    return refuse(`group '${g.name}' is used by ${users.length} item${users.length === 1 ? '' : 's'}; move them first (${CMD_NAME} board set <id> --group none)`, users.map((u) => `${u} is in group ${g.id}`));
  }
  board.groups = (board.groups ?? []).filter((x) => x.id !== g.id);
  if (board.groups.length === 0) delete board.groups;
  return gated(file, next, [`remove group '${g.name}' (id ${g.id}) from board '${boardId}'`], opts.today);
}

/** D23: set the order of ALL groups: `names` must list every group exactly once (name or id). Only the array order changes. */
export function orderGroups(file: BoardFile, boardId: string, names: string[], opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  const groups = groupsOf(board);
  const picked: BoardGroup[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const raw of names) {
    const g = findGroup(groups, raw);
    if (!g) { problems.push(`'${raw}' is not a group of board '${boardId}'`); continue; }
    if (seen.has(g.id)) { problems.push(`'${raw}' is listed twice`); continue; }
    seen.add(g.id);
    picked.push(g);
  }
  for (const g of groups) if (!seen.has(g.id)) problems.push(`group '${g.name}' is missing from the list`);
  if (problems.length > 0) return refuse(`the list must name every group of board '${boardId}' exactly once (${groups.map((g) => g.name).join(', ')})`, problems);

  board.groups = picked;
  return gated(file, next, [`order groups of board '${boardId}': ${picked.map((g) => g.name).join(', ')}`], opts.today);
}

/**
 * b687: rename a board: change its id and/or its display name. Items keep their ids (they live inside the board, so
 * only the board entry changes). An archived board can be renamed too. Refused: no such board, neither `id` nor
 * `name` given, a new id that is invalid or already used by another board, an empty name, nothing different.
 */
export function renameBoard(file: BoardFile, boardId: string, to: { id?: string; name?: string }, opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  if (to.id === undefined && to.name === undefined) return refuse('say what to change: --id <new-id> and/or --name <text>');
  const newId = to.id?.trim();
  const newName = to.name?.trim();
  if (newId !== undefined && !BOARD_ID_RE.test(newId)) return refuse(`board id '${newId}' must match ${BOARD_ID_RE}`);
  if (newName === '') return refuse('board name must not be empty');
  if (newId !== undefined && newId !== board.id && next.boards.some((b) => b.id === newId)) return refuse(`board '${newId}' already exists (boards: ${next.boards.map((b) => b.id).join(', ')})`);

  const lines: string[] = [];
  if (newId !== undefined && newId !== board.id) { lines.push(`rename board '${board.id}': id '${board.id}' -> '${newId}'`); board.id = newId; }
  if (newName !== undefined && newName !== board.name) { lines.push(`${lines.length === 0 ? `rename board '${board.id}': ` : '  '}name '${board.name}' -> '${newName}'`); board.name = newName; }
  if (lines.length === 0) return refuse(`board '${boardId}' already has that id and name, nothing changed`);
  lines.push(`  its ${board.items.length} item${board.items.length === 1 ? '' : 's'} keep their ids${board.archived ? ' (the board is archived)' : ''}`);
  return gated(file, next, lines, opts.today);
}

/**
 * b443: archive or unarchive a board: only the `archived` flag changes (items, groups, ids stay). An archived board is
 * hidden from board list (unless --all or --board names it) and from the page; board add and move refuse it. Already in
 * that state = the same file (runGuardedWrite prints "nothing to change"). Refused: no such board.
 */
export function setBoardArchived(file: BoardFile, boardId: string, archived: boolean, opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  if ((board.archived === true) === archived) return { file, lines: [`board '${boardId}' is already ${archived ? 'archived' : 'open'}`] };
  const n = board.items.length;
  if (archived) board.archived = true;
  else delete board.archived;
  return gated(file, next, [archived
    ? `archive board '${board.id}' (${board.name}): its ${n} item${n === 1 ? '' : 's'} stay; hidden from board list (see --all) and the page`
    : `unarchive board '${board.id}' (${board.name}): shown again in board list and on the page`], opts.today);
}

/** b443: delete a board that holds no item (archived or not). Refused while it has items; every item is named. */
export function deleteBoard(file: BoardFile, boardId: string, opts: { today: string }): OpResult {
  const next = clone(file);
  const board = boardOrError(next, boardId);
  if ('error' in board) return board;
  const n = board.items.length;
  if (n > 0) {
    return refuse(`board '${boardId}' still has ${n} item${n === 1 ? '' : 's'}; move them (${CMD_NAME} board move <id> --board <other>) or remove them first`, board.items.map((i) => `${i.id}  ${i.title}`));
  }
  next.boards = next.boards.filter((b) => b !== board);
  return gated(file, next, [`delete board '${board.id}' (${board.name})${board.archived ? ' (archived)' : ''}`], opts.today);
}

// ---------- bulk ----------

const BULK_KEYS = ['ref', 'title', 'kind', 'status', 'owner', 'parent', 'parentRef', 'dependsOn', 'dependsOnRefs', 'links', 'tags', 'start', 'due', 'group', 'description', 'docs', 'outcome', 'size', 'sprint', 'priority'];
const REF_RE = /^[A-Za-z0-9_-]+$/;

export interface BulkMinted { index: number; id: string; ref?: string }
export interface BulkOk extends OpOk { minted: BulkMinted[] }

/**
 * Which board an add goes to (single `board add` and `--from-file` share this): `wanted` names it (an unknown id creates
 * it, named `boardName` or the id); omitted = the only OPEN board, or `main` for an empty file. b443: an archived board
 * is refused (named, with the unarchive hint; or every board archived). `boardName` only names a NEW board, so with an
 * existing board it is refused. A new board is pushed onto `file.boards`.
 */
export function pickAddBoard(file: BoardFile, wanted: string | undefined, boardName: string | undefined): { board: Board; created: boolean } | OpError {
  let board: Board | undefined;
  if (wanted === undefined) {
    const open = file.boards.filter((b) => !b.archived);
    if (open.length === 1) board = open[0];
    else if (open.length > 1) return refuse(`the file has ${open.length} open boards; say which with --board <id> (${open.map((b) => b.id).join(', ')})`);
    else if (file.boards.length > 0) return refuse('every board is archived; name one with --board <id> (a new id creates a board) or unarchive one');
  } else {
    board = file.boards.find((b) => b.id === wanted);
    if (board?.archived) return refuse(`board '${board.id}' is archived; unarchive it first (${CMD_NAME} board unarchive ${board.id})`);
  }
  if (board) {
    if (boardName !== undefined) return refuse(`--board-name only names a NEW board; board '${board.id}' already exists`);
    return { board, created: false };
  }
  const id = wanted ?? 'main';
  if (!BOARD_ID_RE.test(id)) return refuse(`board id '${id}' must match ${BOARD_ID_RE}`);
  board = { id, name: boardName || id, items: [] };
  file.boards.push(board);
  return { board, created: true };
}

/**
 * D20: create several items at once. `spec` = `{"items": [{title, kind, status?, owner?, parent?, parentRef?,
 * dependsOn?, dependsOnRefs?, links?, tags?, start?, due?, group?, ref?}]}`. `ref` is a local key; `parentRef` and
 * `dependsOnRefs` name it (forward references allowed); `parent` and `dependsOn` name items that already exist.
 * Ids `b<max+1>` are minted in file order over the whole file. `boardId` omitted = the only open board (an empty
 * file gets `main`); an unknown id creates that board, as `board add` does. One bad item refuses the whole spec.
 * Link uids are NOT checked here (no plan); the CLI checks them.
 */
export function expandBulk(file: BoardFile, spec: unknown, boardId: string | undefined, opts: { today: string; boardName?: string }): BulkOk | OpError {
  // b219: an unknown key names the key it most likely meant
  const hint = (k: string, keys: readonly string[]): string => { const m = didYouMean(k, keys); return m ? `, did you mean '${m}'?` : ''; };
  if (!isObj(spec) || !Array.isArray(spec.items)) return refuse('the file must be a JSON object {"items": [ ... ]}');
  for (const k of Object.keys(spec)) if (k !== 'items') return refuse(`unknown key '${k}'${hint(k, ['items'])} (only "items" is allowed)`);
  if (spec.items.length === 0) return refuse('"items" is empty: nothing to add');

  const next = clone(file);
  const picked = pickAddBoard(next, boardId, opts.boardName?.trim());
  if ('error' in picked) return picked;
  const { board, created } = picked;
  const target = board;

  const raws = spec.items as unknown[];
  const ids = mintItemIds(file, raws.length);
  const label = (i: number, r: unknown): string => `items[${i}]${isObj(r) && typeof r.ref === 'string' ? ` (ref ${r.ref})` : ''}`;
  const problems: string[] = [];
  const bad = (i: number, msg: string): void => { problems.push(`${label(i, raws[i])}: ${msg}`); };

  // pass 1: local keys
  const idOfRef = new Map<string, string>();
  raws.forEach((r, i) => {
    if (!isObj(r) || r.ref === undefined) return;
    if (typeof r.ref !== 'string' || !REF_RE.test(r.ref)) return bad(i, `'ref' must be letters, digits, '_' or '-'`);
    if (idOfRef.has(r.ref)) return bad(i, `'ref' '${r.ref}' is already used by an earlier item`);
    idOfRef.set(r.ref, ids[i]);
  });

  const existing = indexItems(next);
  const groupIds = target.groups ? target.groups.map((g) => g.id) : DEFAULT_GROUP_IDS;
  const today = opts.today;
  const items: BoardItem[] = [];

  raws.forEach((r, i) => {
    if (!isObj(r)) return bad(i, 'must be an object');
    for (const k of Object.keys(r)) if (!BULK_KEYS.includes(k)) bad(i, `unknown key '${k}'${hint(k, BULK_KEYS)} (allowed: ${BULK_KEYS.join(', ')})`);
    const str = (key: string): string | undefined => {
      const v = r[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'string') { bad(i, `'${key}' must be a string`); return undefined; }
      return v.trim();
    };
    const list = (key: string): string[] => {
      const v = r[key];
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { bad(i, `'${key}' must be an array of strings`); return []; }
      return (v as string[]).map((x) => x.trim()).filter((x) => x !== '');
    };

    const title = str('title') ?? '';
    if (title === '') bad(i, `'title' must be a non-empty string`);
    const kind = str('kind') ?? '';
    const kindBad = kindProblem(kind);
    if (kindBad) bad(i, kindBad);
    const status = str('status') ?? 'planned';
    const statusBad = statusProblem(status);
    if (statusBad) bad(i, statusBad);
    const item: BoardItem = { id: ids[i], title, kind, status, dependsOn: [], links: [], tags: [] };

    const owner = str('owner');
    if (owner) item.owner = owner;

    const parent = str('parent');
    const parentRef = str('parentRef');
    if (parent && parentRef) bad(i, `give 'parent' or 'parentRef', not both`);
    else if (parent) {
      const home = existing.get(parent);
      if (!home) bad(i, `parent '${parent}' is not an item`);
      else if (home.board !== target) bad(i, `parent '${parent}' is in board '${home.board.id}', not in board '${target.id}'`);
      else item.parent = parent;
    } else if (parentRef) {
      const pid = idOfRef.get(parentRef);
      if (pid === undefined) bad(i, `parentRef '${parentRef}' matches no "ref" in the file`);
      else item.parent = pid;
    }

    for (const dep of list('dependsOn')) {
      if (!existing.has(dep)) bad(i, `dependsOn '${dep}' is not an item`);
      else if (!item.dependsOn.includes(dep)) item.dependsOn.push(dep);
    }
    for (const dr of list('dependsOnRefs')) {
      const did = idOfRef.get(dr);
      if (did === undefined) bad(i, `dependsOnRefs '${dr}' matches no "ref" in the file`);
      else if (!item.dependsOn.includes(did)) item.dependsOn.push(did);
    }
    for (const uid of list('links')) if (!item.links.includes(uid)) item.links.push(uid);
    for (const t of list('tags')) {
      const tag = t.toLowerCase();
      if (!isValidTag(tag)) bad(i, `tag '${t}' should be lower-case letters, digits and dashes`);
      else if (!item.tags.includes(tag)) item.tags.push(tag);
    }
    for (const key of ['start', 'due'] as const) {
      const v = str(key);
      if (v === undefined) continue;
      if (!isBoardDate(v)) bad(i, `'${key}' '${v}' is not a date YYYY-MM-DD`);
      else item[key] = v;
    }
    const group = str('group');
    if (group) {
      if (!groupIds.includes(group)) bad(i, `group '${group}' is not a group of board '${target.id}' (${groupIds.join(', ')})`);
      else item.group = group;
    }
    // B42 fields (same rules as board add: fields.ts). description/outcome are kept as written minus trailing white space.
    for (const [key, check] of [['description', descriptionProblem], ['outcome', outcomeProblem]] as const) {
      const v = r[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') { bad(i, `'${key}' must be a string`); continue; }
      const text = v.replace(/\s+$/, '');
      const problem = check(text);
      if (problem) bad(i, problem); else item[key] = text;
    }
    for (const [key, check] of [['size', sizeProblem], ['sprint', sprintProblem], ['priority', priorityProblem]] as const) {
      const v = str(key);
      if (v === undefined) continue;
      const problem = check(v);
      if (problem) bad(i, problem); else item[key] = v;
    }
    if (r.docs !== undefined) {
      if (!Array.isArray(r.docs)) bad(i, `'docs' must be an array of "path:..." / "url:..." strings or {label?, path?, url?} objects`);
      else {
        const docs: BoardDoc[] = [];
        r.docs.forEach((d, di) => {
          let doc: BoardDoc | undefined;
          if (typeof d === 'string') {
            const p = parseDocSpec(d);
            if ('error' in p) return bad(i, `docs[${di}]: ${p.error}`);
            doc = p.doc;
          } else if (isObj(d) && Object.keys(d).every((k) => ['label', 'path', 'url'].includes(k)) && Object.values(d).every((x) => typeof x === 'string')) {
            doc = { ...(d as BoardDoc) };
            const problem = boardDocProblem(doc);
            if (problem) return bad(i, `docs[${di}] ${problem}`);
          } else return bad(i, `docs[${di}] must be a spec string or a {label?, path?, url?} object`);
          if (!docs.some((x) => sameDoc(x, doc!))) docs.push(doc);
        });
        if (docs.length > 0) item.docs = docs;
      }
    }
    item.created = today;
    if (status === 'done') item.closed = today;
    items.push(item);
  });
  if (problems.length > 0) return refuse(`${problems.length} problem${problems.length === 1 ? '' : 's'} in the file, nothing changed`, problems);

  target.items.push(...items);
  const lines = [created ? `create board '${target.id}' and add ${items.length} item${items.length === 1 ? '' : 's'}:` : `add ${items.length} item${items.length === 1 ? '' : 's'} to board '${target.id}':`];
  const refOf = new Map<string, string>();
  for (const [ref, id] of idOfRef) refOf.set(id, ref);
  for (const it of items) {
    const bits = [it.id, it.kind, it.status];
    if (it.owner !== undefined) bits.push(it.owner);
    bits.push(it.title);
    if (it.parent !== undefined) bits.push(`parent ${it.parent}`);
    if (it.dependsOn.length > 0) bits.push(`depends ${it.dependsOn.join(',')}`);
    const r = refOf.get(it.id);
    lines.push(`  ${bits.join('  ')}${r !== undefined ? `  (ref ${r})` : ''}`);
  }
  const done = gated(file, next, lines, opts.today);
  if (isOpError(done)) return done;
  return { ...done, minted: items.map((it, index) => ({ index, id: it.id, ...(refOf.has(it.id) ? { ref: refOf.get(it.id)! } : {}) })) };
}
