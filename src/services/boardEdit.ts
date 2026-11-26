/**
 * b473 (ARR-CL-B, rows B1-B3): the Board editing service. Every board write of the Command Line (`board add`, `set`,
 * `link`, `unlink`, `remove`, `move`, `rename`, `archive`, `unarchive`, `delete`, `group add|remove|order`, `add --from-file`) goes through here instead of the
 * Boards file engine, Workspace and Plan files directly. Each write is the same steps as before: open the board for
 * editing (openBoard: loadBoardForEdit), build the new file, and pass it through the write gate (planBoardWrite, the re-parse
 * check, applyBoardWrite only on --yes). The functions return what to print; the commands print it and set the exit
 * code. A refusal is thrown as a BoardRefusal (`error: <message>`, nothing written).
 * L3: imports nothing from src/cli/ (entry points).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Board, BoardDoc, BoardFile, BoardItem, ProjectPaths, UnresolvedTarget } from '../types';
import { planItems, resolvePlanTarget } from '../plan/planItems';
import { splitTags, isValidTag } from '../tags';
import {
  descriptionProblem, docText, editList, flagProblem, joinDescription, kindProblem, outcomeProblem, parseDocSpec, priorityProblem, sameDoc, sizeProblem, splitDocSpecs,
  sprintProblem, statusProblem,
} from '../board/fields';
import { parseBoard, BOARD_ID_RE } from '../board/parse';
import { checkBoard, DEFAULT_GROUP_IDS } from '../board/check';
import { isBoardDate, todayIso } from '../util/dates';
import { optionFlag } from '../util/text';
import { loadBoardForEdit, planBoardWrite, applyBoardWrite } from '../board/write';
import type { BoardWritePlan } from '../board/write';
import {
  addGroup, deleteBoard, expandBulk, findBoardGroup, isOpError, mintItemIds, moveItem, orderGroups, pickAddBoard, removeGroup, removeItem, renameBoard,
  setBoardArchived,
} from '../board/ops';
import type { BulkOk, OpError, OpOk } from '../board/ops';
import { ensureInternalDirFor, requireProject } from '../outputs';
import { planNoScan } from '../scan/planScan';
import { boardFileFor } from '../board/load';
import { guardedWriteJson, thrownOutcome } from '../query/guardedWrite';
import type { GuardedOutcome, GuardedWriteJson } from '../query/guardedWrite';
import { textStamp } from '../util/stamp';
import { CMD_NAME } from '../constants';

export type { BulkOk, OpOk } from '../board/ops';

/**
 * The flag values of a board command, by commander's camelCase names (strings; string[] for --doc/--add-doc). `tags` is the
 * merged `--tags` / old `--tag` value (cli/board.ts tagsOf, b219); `tag` itself is not read here.
 */
export type BoardFlags = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A reason to refuse: printed as `error: <message>`, exit 1, nothing written. */
export class BoardRefusal extends Error {}
function refuse(message: string): never {
  throw new BoardRefusal(message);
}
/** Refuse when a field check found a problem (board/fields.ts); null passes. */
function refuseIf(problem: string | null): void {
  if (problem !== null) refuse(problem);
}

// ---------- the write gate, shared by add, set, link, unlink ----------

/** A checked write, not applied yet: the change lines to print, the line after a real write, and the planned file text. */
export interface BoardChange {
  kind: 'change';
  lines: string[];
  done: string;
  project: ProjectPaths;
  write: BoardWritePlan;
}

/** A board opened for one edit: the project, the file as read and its exact text (null = no file yet; the write gate's `before`). */
export interface OpenedBoard {
  project: ProjectPaths;
  data: BoardFile;
  text: string | null;
}

/**
 * Open the board of a repo for editing: find the project (requireProject: else the error with the `c4pm init` hint),
 * then loadBoardForEdit; no file yet = an empty board file; a file with any parse issue throws. Neither the config nor
 * the plan is read here: a write loads them (planNoScan, the config through openProject) only when it names a link,
 * so a broken config or plan never blocks other writes.
 */
export function openBoard(repoRoot: string): OpenedBoard {
  const project = requireProject(repoRoot);
  return { project, ...loadBoardForEdit(project) };
}

/** The --yes step of every board write: make `.c4pm/` ready when the file changes, then the guarded write. */
function writeBoard(project: ProjectPaths, write: BoardWritePlan): void {
  if (write.changed) ensureInternalDirFor(project, write.path);
  applyBoardWrite(project, write);
}

/** `a,b` -> ['a','b'] (trimmed, empties dropped). */
function csv(v: unknown): string[] {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
}

function cloneFile(data: BoardFile): BoardFile {
  return JSON.parse(JSON.stringify(data)) as BoardFile;
}

function checkedDate(flag: string, value: string): string {
  const v = value.trim();
  if (!isBoardDate(v)) refuse(`${flag} '${value}' is not a date YYYY-MM-DD`);
  return v;
}

function checkedTags(value: string): string[] {
  const tags = splitTags(value);
  for (const t of tags) if (!isValidTag(t)) refuse(`tag '${t}' should be lower-case letters, digits and dashes`);
  return tags;
}

/** Every item of the file, with the board that holds it (ids are unique across the file). */
function indexItems(data: BoardFile): Map<string, { board: Board; item: BoardItem }> {
  const m = new Map<string, { board: Board; item: BoardItem }>();
  for (const board of data.boards) for (const item of board.items) if (!m.has(item.id)) m.set(item.id, { board, item });
  return m;
}

function groupIdsOf(board: Board): string[] {
  return board.groups ? board.groups.map((g) => g.id) : DEFAULT_GROUP_IDS;
}

/** Field order of an item as stored (the interface order in types.ts); used to print items and changes. */
const ITEM_FIELDS = ['id', 'title', 'kind', 'status', 'owner', 'parent', 'dependsOn', 'links', 'tags', 'sprint', 'priority', 'start', 'due', 'created', 'updated', 'closed', 'group', 'description', 'docs', 'outcome', 'size'] as const;
type ItemField = (typeof ITEM_FIELDS)[number];

const SHORT = 70;
function showValue(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : v.map((x) => (typeof x === 'object' && x !== null ? docText(x as BoardDoc) : String(x))).join(typeof v[0] === 'object' ? '; ' : ', ');
  if (typeof v === 'string' && (v.length > SHORT || v.includes('\n'))) {
    const first = v.split('\n')[0];
    return `"${first.length > SHORT ? `${first.slice(0, SHORT)}...` : first}${first.length < v.length && first.length <= SHORT ? ' ...' : ''}" (${v.length} characters)`;
  }
  return v === undefined ? '(none)' : String(v);
}

type DescriptionMode = 'replace' | 'append' | 'prepend';
/** b440: [option key, mode, from a file] of the six description options of board set (add has the first two); at most ONE may be given. */
const DESCRIPTION_OPTIONS = [
  ['description', 'replace', false], ['descriptionFile', 'replace', true],
  ['appendDescription', 'append', false], ['appendDescriptionFile', 'append', true],
  ['prependDescription', 'prepend', false], ['prependDescriptionFile', 'prepend', true],
] as const;

/**
 * The one description option given (b440: replace, append or prepend; text or a UTF-8 file, a relative path is relative
 * to the current directory), its mode and its flag. Two or more are refused. Trailing white space is dropped.
 */
function readDescription(opts: BoardFlags): { text: string; fromFile: boolean; mode: DescriptionMode; flag: string } | undefined {
  const given = DESCRIPTION_OPTIONS.filter(([key]) => str(opts[key]) !== undefined);
  if (given.length === 0) return undefined;
  if (given.length > 1) refuse(`give only one description option, not both ${optionFlag(given[0][0])} and ${optionFlag(given[1][0])}`);
  const [key, mode, fromFile] = given[0];
  const flag = optionFlag(key);
  const value = str(opts[key])!;
  if (!fromFile) return { text: value.replace(/\s+$/, ''), fromFile, mode, flag };
  let content: string;
  try { content = fs.readFileSync(path.resolve(value), 'utf8'); } catch (err) { return refuse(`${flag}: cannot read ${value} (${(err as Error).message})`); }
  return { text: content.replace(/\s+$/, ''), fromFile, mode, flag };
}

const orRefuse = (flag: string, problem: string | null): void => { if (problem) refuse(`${flag}: ${problem}`); };

/** `--doc` / `--add-doc` / `--remove-doc` values -> documents (each value may be a comma list; the same path or url is kept once). Refuses a bad spec. */
function parseDocs(values: unknown): BoardDoc[] {
  const docs: BoardDoc[] = [];
  for (const spec of splitDocSpecs(Array.isArray(values) ? (values as string[]) : typeof values === 'string' ? [values] : [])) {
    const r = parseDocSpec(spec);
    if ('error' in r) refuse(r.error);
    if (!docs.some((d) => sameDoc(d, r.doc))) docs.push(r.doc);
  }
  return docs;
}

/**
 * The B42 fields, shared by add and set (rules: fields.ts). On `set` the word none clears a field; `--doc` replaces
 * the list (`--add-doc` / `--remove-doc`: applyListFlags, set only). Refuses on the first bad value.
 */
function applyFieldFlags(item: BoardItem, opts: BoardFlags, isSet: boolean): void {
  const clears = (v: string): boolean => isSet && v.trim().toLowerCase() === NONE;
  const desc = readDescription(opts);
  if (desc !== undefined) {
    if (desc.mode === 'replace') {
      if (!desc.fromFile && clears(desc.text)) delete item.description;
      else { orRefuse('--description', descriptionProblem(desc.text)); item.description = desc.text; }
    } else {
      // b440: append / prepend keep the old text, one blank line between; `none` is plain text here
      if (desc.text.trim() === '') refuse(`${desc.flag}: the text to add is empty`);
      const joined = joinDescription(item.description, desc.text, desc.mode);
      orRefuse(desc.flag, descriptionProblem(joined));
      item.description = joined;
    }
  }
  const outcome = str(opts.outcome)?.replace(/\s+$/, '');
  if (outcome !== undefined) {
    if (clears(outcome)) delete item.outcome;
    else { orRefuse('--outcome', outcomeProblem(outcome)); item.outcome = outcome; }
  }
  for (const [key, check] of [['size', sizeProblem], ['sprint', sprintProblem], ['priority', priorityProblem]] as const) {
    const v = str(opts[key])?.trim();
    if (v === undefined) continue;
    if (clears(v)) delete item[key];
    else { orRefuse(`--${key}`, check(v)); item[key] = v; }
  }
  if (opts.doc !== undefined) {
    const raw = splitDocSpecs(opts.doc as string[]);
    if (isSet && raw.length === 1 && raw[0].toLowerCase() === NONE) delete item.docs;
    else { const docs = parseDocs(opts.doc); if (docs.length > 0) item.docs = docs; }
  }
  // b441: the add / remove flags of the list fields are for set only (applyListFlags)
  if (!isSet) {
    for (const f of LIST_FLAGS) {
      for (const key of [f.add, f.remove]) if (opts[key] !== undefined) refuse(`${optionFlag(key)} is for board set; board add takes ${optionFlag(f.replace)}`);
    }
  }
}

/** b441: the list fields `board set` can edit value by value: the replace flag, the add and remove flags (Commander keys). */
const LIST_FLAGS = [
  { field: 'tags', replace: 'tags', add: 'addTag', remove: 'removeTag', noun: 'tag' },
  { field: 'dependsOn', replace: 'depends', add: 'addDepends', remove: 'removeDepends', noun: 'dependency' },
  { field: 'docs', replace: 'doc', add: 'addDoc', remove: 'removeDoc', noun: 'document' },
] as const;

/** The values of a repeatable flag (Commander `collect`: string[]; a plain string from a direct caller). */
function flagValues(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
}

/**
 * b441: apply `--add-x` / `--remove-x` of every list field (tags, dependsOn, docs) through editList. Refused: a bad
 * value, an added dependency that is not an item, the replace flag of the same field given too, a value both added and
 * removed. A removed value the item does not hold is no error: one note line each (K 2026-11-22). Cycles: commit().
 */
function applyListFlags(item: BoardItem, opts: BoardFlags, all: Map<string, { board: Board; item: BoardItem }>): string[] {
  const notes: string[] = [];
  for (const f of LIST_FLAGS) {
    const addValues = flagValues(opts[f.add]);
    const removeValues = flagValues(opts[f.remove]);
    if (opts[f.add] === undefined && opts[f.remove] === undefined) continue;
    if (opts[f.replace] !== undefined) refuse(`give ${optionFlag(f.replace)} or ${optionFlag(f.add)}/${optionFlag(f.remove)}, not both`);
    let edited: { list: unknown[]; missing: unknown[]; clash: unknown[] };
    let show: (v: unknown) => string = String;
    if (f.field === 'tags') {
      edited = editList(item.tags, checkedTags(addValues.join(',')), splitTags(removeValues.join(',')));
    } else if (f.field === 'dependsOn') {
      const add = addValues.flatMap(csv);
      for (const dep of add) if (!all.has(dep)) refuse(`${optionFlag(f.add)} '${dep}' is not an item`);
      edited = editList(item.dependsOn, add, removeValues.flatMap(csv));   // a dangling id stays removable
    } else {
      edited = editList(item.docs ?? [], parseDocs(addValues), parseDocs(removeValues), sameDoc);
      show = (d) => docText(d as BoardDoc);
    }
    if (edited.clash.length > 0) refuse(`${optionFlag(f.add)} and ${optionFlag(f.remove)} both name '${show(edited.clash[0])}'`);
    for (const m of edited.missing) notes.push(`  note: ${item.id} has no ${f.noun} '${show(m)}' (nothing to remove)`);
    if (f.field === 'tags') item.tags = edited.list as string[];
    else if (f.field === 'dependsOn') item.dependsOn = edited.list as string[];
    else if (edited.list.length > 0) item.docs = edited.list as BoardDoc[];
    else delete item.docs;
  }
  return notes;
}

/** Info lines for doc paths that do not exist (yet) under the repo: the document may be written later, so not an error. */
function docNotes(repoRoot: string, item: BoardItem): string[] {
  return (item.docs ?? []).filter((d) => d.path !== undefined && !fs.existsSync(path.join(repoRoot, d.path))).map((d) => `  note: docs path '${d.path}' does not exist in the repo yet`);
}

/** Cycle findings of a file as "rule: message" strings; a result may add cycles that the file did not have. */
function cycleKeys(data: BoardFile): Set<string> {
  return new Set(
    checkBoard(data, null, { today: todayIso() })
      .filter((f) => f.rule === 'board-nest-cycle' || f.rule === 'board-depends-cycle')
      .map((f) => `${f.rule}: ${f.message}`),
  );
}

/**
 * The common tail of every writing command, up to the write: refuse a result that adds a cycle or would not parse.
 * The command prints `lines` and writes only with --yes (applyBoardChange: through the guarded writer, only
 * `.c4pm/`, re-parsed after the write, rolled back on error).
 */
function commit(project: ProjectPaths, current: BoardFile, next: BoardFile, lines: string[], done: string, loadedText: string | null): BoardChange {
  const before = cycleKeys(current);
  const added = [...cycleKeys(next)].filter((k) => !before.has(k));
  if (added.length > 0) refuse(`this would create a cycle (${added.map((k) => k.slice(k.indexOf(': ') + 2)).join('; ')})`);
  const write = planBoardWrite(project, next, loadedText);
  const parsed = parseBoard(write.after);
  if (parsed.data === null || parsed.issues.length > 0) {
    refuse(`the result would not be a valid board file:\n${parsed.issues.map((i) => `  ${i.message}`).join('\n')}`);
  }
  return { kind: 'change', lines, done, project, write };
}

/** Write a checked change (the --yes step). */
export function applyBoardChange(change: BoardChange): void {
  writeBoard(change.project, change.write);
}

// ---------- add ----------

/** Next item id: `b<n + 1>`, n = highest number among ids of the form b<number> in the WHOLE file (hand ids such as epic-1 are ignored). */
export function nextItemId(data: BoardFile): string {
  return mintItemIds(data, 1)[0];   // one rule for the single add and the bulk add (ops.ts)
}

/** A single add: the checked change plus the new item and the whole next file (b445 builds its JSON from them). */
export interface AddedItem extends BoardChange { item: BoardItem; next: BoardFile }

/** `board add`: one new item (dry-run lines, minted id, created date). Refuses on the first bad flag. */
export function addBoardItem(repoRoot: string, opts: BoardFlags): AddedItem {
  const { project, data: current, text } = openBoard(repoRoot);
  const next = cloneFile(current);

  if (opts.title === undefined) refuse(`required option '--title <text>' not specified (or use --from-file)`);
  if (opts.kind === undefined) refuse(`required option '--kind <kind>' not specified (or use --from-file)`);
  const title = (str(opts.title) ?? '').trim();
  if (title === '') refuse(`--title must not be empty`);
  const kind = (str(opts.kind) ?? '').trim();
  refuseIf(flagProblem(kindProblem(kind)));
  const status = (str(opts.status) ?? 'planned').trim();
  refuseIf(flagProblem(statusProblem(status)));

  // Which board: --board names it (a new name creates it); with none given, the only board, or `main` for an empty file.
  const wanted = str(opts.board)?.trim();
  const boardName = str(opts.boardName)?.trim();
  const picked = pickAddBoard(next, wanted, boardName);
  if ('error' in picked) refuse(picked.error);
  const { board, created } = picked;

  const all = indexItems(next);
  const item: BoardItem = { id: nextItemId(current), title, kind, status, dependsOn: [], links: [], tags: [] };

  const owner = str(opts.owner)?.trim();
  if (owner) item.owner = owner;
  const parent = str(opts.parent)?.trim();
  if (parent) {
    const home = all.get(parent);
    if (!home) refuse(`--parent '${parent}' is not an item`);
    if (home.board.id !== board.id) refuse(`--parent '${parent}' is in board '${home.board.id}', not in board '${board.id}'`);
    item.parent = parent;
  }
  for (const dep of csv(opts.depends)) {
    if (!all.has(dep)) refuse(`--depends '${dep}' is not an item`);
    if (!item.dependsOn.includes(dep)) item.dependsOn.push(dep);
  }
  if (typeof opts.tags === 'string') item.tags = checkedTags(opts.tags);
  const uids = csv(opts.link);
  if (uids.length > 0) {
    const plan = planNoScan(repoRoot);
    if (plan === null) refuse(`--link needs the plan, and no plan found (${CMD_NAME} plan generate starts one)`);
    const known = new Set(planItems(plan).map((e) => e.item.uid));
    for (const uid of uids) {
      if (!known.has(uid)) refuse(`--link '${uid}' matches no plan element (use a uid from ${CMD_NAME} plan show)`);
      if (!item.links.includes(uid)) item.links.push(uid);
    }
  }
  if (typeof opts.start === 'string') item.start = checkedDate('--start', opts.start);
  if (typeof opts.due === 'string') item.due = checkedDate('--due', opts.due);
  if (item.start !== undefined && item.due !== undefined && item.due < item.start) refuse(`--due ${item.due} is earlier than --start ${item.start}`);
  const group = str(opts.group)?.trim();
  if (group) {
    const g = findBoardGroup(board, group);
    if (!g) refuse(`--group '${group}' is not a group of board '${board.id}' (${groupIdsOf(board).join(', ')})`);
    item.group = g.id;
  }
  applyFieldFlags(item, opts, false);
  const today = todayIso();
  item.created = today;
  if (status === 'done') item.closed = today;

  board.items.push(item);
  const lines = [created ? `create board '${board.id}' (${board.name}) and add:` : `add to board '${board.id}':`];
  for (const f of ITEM_FIELDS) {
    const v = item[f as ItemField];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) lines.push(`  ${f}: ${showValue(v)}`);
  }
  lines.push(...docNotes(repoRoot, item));
  return { ...commit(project, current, next, lines, `added ${item.id} to board '${board.id}'`, text), item, next };
}

/**
 * b445: `board add --json` (one item) as an operation outcome, so runGuardedWrite prints the one JSON object every board
 * write prints; `minted` = [{ index: 0, id }] (same key as add --from-file). Writes only with `yes`. A refusal throws
 * (BoardRefusal), which runGuardedWrite reports as {ok: false, ...}.
 */
export function addBoardItemOutcome(repoRoot: string, opts: BoardFlags, yes: boolean): BoardOpOutcome {
  const a = addBoardItem(repoRoot, opts);
  if (yes && a.write.changed) applyBoardChange(a);
  const result: BulkOk = { file: a.next, lines: a.lines, minted: [{ index: 0, id: a.item.id }] };
  return { result, file: path.relative(repoRoot, a.write.path) || a.write.path, changed: a.write.changed, written: yes && a.write.changed };
}

// ---------- set ----------

const NONE = 'none';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `board set`: change the named fields of one item; `nothing` when no field changes. Refuses on the first bad flag. */
export function setBoardItem(repoRoot: string, id: string, opts: BoardFlags): BoardChange | { kind: 'nothing'; notes: string[] } {
  const { project, data: current, text } = openBoard(repoRoot);
  const next = cloneFile(current);
  const all = indexItems(next);
  const found = all.get(id);
  if (!found) refuse(`no item '${id}'`);
  const { board, item } = found;
  const original: BoardItem = JSON.parse(JSON.stringify(item)) as BoardItem;
  const given = (k: string): string | undefined => str(opts[k])?.trim();
  const clears = (v: string): boolean => v.toLowerCase() === NONE;

  const title = given('title');
  if (title !== undefined) {
    if (title === '') refuse('--title must not be empty');
    item.title = title;
  }
  const kind = given('kind');
  if (kind !== undefined) {
    refuseIf(flagProblem(kindProblem(kind)));
    item.kind = kind;
  }
  const status = given('status');
  if (status !== undefined) {
    refuseIf(flagProblem(statusProblem(status)));
    item.status = status;
  }
  const owner = given('owner');
  if (owner !== undefined) { if (clears(owner) || owner === '') delete item.owner; else item.owner = owner; }
  const parent = given('parent');
  if (parent !== undefined) {
    if (clears(parent)) delete item.parent;
    else {
      const home = all.get(parent);
      if (!home) refuse(`--parent '${parent}' is not an item`);
      if (home.board.id !== board.id) refuse(`--parent '${parent}' is in board '${home.board.id}', not in board '${board.id}' (moving between boards is not part of set)`);
      item.parent = parent;
    }
  }
  const depends = given('depends');
  if (depends !== undefined) {
    if (clears(depends)) item.dependsOn = [];
    else {
      item.dependsOn = [];
      for (const dep of csv(depends)) {
        if (!all.has(dep)) refuse(`--depends '${dep}' is not an item`);
        if (!item.dependsOn.includes(dep)) item.dependsOn.push(dep);
      }
    }
  }
  const tags = given('tags');
  if (tags !== undefined) item.tags = clears(tags) ? [] : checkedTags(tags);
  for (const [flag, key] of [['start', 'start'], ['due', 'due']] as const) {
    const v = given(flag);
    if (v === undefined) continue;
    if (clears(v)) delete item[key]; else item[key] = checkedDate(`--${flag}`, v);
  }
  const group = given('group');
  if (group !== undefined) {
    if (clears(group)) delete item.group;
    else {
      const g = findBoardGroup(board, group);
      if (!g) refuse(`--group '${group}' is not a group of board '${board.id}' (${groupIdsOf(board).join(', ')})`);
      item.group = g.id;
    }
  }
  applyFieldFlags(item, opts, true);
  const listNotes = applyListFlags(item, opts, all);   // b441
  if (item.start !== undefined && item.due !== undefined && item.due < item.start) refuse(`due ${item.due} is earlier than start ${item.start}`);

  const named = ITEM_FIELDS.filter((f) => !same(original[f as ItemField], item[f as ItemField]));
  if (named.length === 0) return { kind: 'nothing', notes: listNotes };
  // Bookkeeping, only on a real change: updated always, closed when the status enters or leaves done.
  const today = todayIso();
  item.updated = today;
  if (original.status !== 'done' && item.status === 'done') item.closed = today;
  else if (original.status === 'done' && item.status !== 'done') delete item.closed;

  const lines = [`set ${item.id} (board '${board.id}'):`];
  for (const f of ITEM_FIELDS) {
    if (!same(original[f as ItemField], item[f as ItemField])) lines.push(`  ${f}: ${showValue(original[f as ItemField])} -> ${showValue(item[f as ItemField])}`);
  }
  lines.push(...listNotes, ...docNotes(repoRoot, item));
  return commit(project, current, next, lines, `updated ${item.id}`, text);
}

// ---------- link / unlink ----------

/** Why a link target names no single plan element with a uid (the command prints it, exit 1). T4a: the type is src/types.ts's. */
export type { UnresolvedTarget };

/**
 * Resolve `target` to the uid of exactly one plan element, the way `c4pm plan show` does (uid, fqn, local id or
 * name); otherwise why not (no plan, no match with the closest 5, several matches, or a match without a uid).
 */
function resolveUid(repoRoot: string, target: string): { uid: string } | UnresolvedTarget {
  const plan = planNoScan(repoRoot);
  if (plan === null) return { kind: 'unresolved', reason: 'no-plan' };
  const resolved = resolvePlanTarget(plan, target);
  if ('kind' in resolved) return resolved;
  const uid = resolved.el.metadata.uid;
  if (!uid) return { kind: 'unresolved', reason: 'no-uid', item: planItems(plan).find((e) => e.el === resolved.el)!.item };
  return { uid };
}

/** `board link` / `board unlink`: add or remove a link from an item to a plan element; `nothing` when already linked. */
export function linkBoardItem(repoRoot: string, id: string, target: string, unlink: boolean): BoardChange | { kind: 'nothing' } | UnresolvedTarget {
  const { project, data: current, text } = openBoard(repoRoot);
  const next = cloneFile(current);
  const found = indexItems(next).get(id);
  if (!found) refuse(`no item '${id}'`);
  const item = found.item;

  // unlink may name a uid that is already stored (also one the plan no longer has, a dead link)
  const resolved = unlink && item.links.includes(target) ? { uid: target } : resolveUid(repoRoot, target);
  if ('kind' in resolved) return resolved;
  const uid = resolved.uid;

  const before = [...item.links];
  if (unlink) {
    if (!item.links.includes(uid)) refuse(`${id} is not linked to ${uid}`);
    item.links = item.links.filter((u) => u !== uid);
  } else {
    if (item.links.includes(uid)) return { kind: 'nothing' };
    item.links.push(uid);
  }
  const oldUpdated = item.updated;
  item.updated = todayIso();
  const lines = [
    `${unlink ? 'unlink' : 'link'} ${id} (board '${found.board.id}'):`,
    `  links: ${showValue(before)} -> ${showValue(item.links)}`,
  ];
  if (oldUpdated !== item.updated) lines.push(`  updated: ${showValue(oldUpdated)} -> ${item.updated}`);
  return commit(project, current, next, lines, `${unlink ? 'unlinked' : 'linked'} ${id} ${unlink ? 'from' : 'to'} ${uid}`, text);
}

// ---------- remove, move, group, add --from-file (the operations of ops.ts) ----------

/** The outcome of one operation write: refused (`error`, `reasons`), or done / dry run with the change lines. */
export type BoardOpOutcome =
  | { error: string; reasons: string[] }
  | { result: OpOk; file: string; changed: boolean; written: boolean };

type BoardOp = (data: BoardFile, today: string) => OpOk | OpError;

/**
 * Load the board for editing, run `op` on it, check the result parses, and write it only with `yes` (and only when
 * it changed). `file` is the board file relative to the repo. A load, concurrent-change or rollback error is thrown.
 */
function runBoardOp(repoRoot: string, yes: boolean, op: BoardOp): BoardOpOutcome {
  const { project, data, text } = openBoard(repoRoot);
  const result = op(data, todayIso());
  if (isOpError(result)) return { error: result.error, reasons: result.reasons };

  const write = planBoardWrite(project, result.file, text);
  const parsed = parseBoard(write.after);
  if (parsed.data === null || parsed.issues.length > 0) {
    return { error: 'the result would not be a valid board file', reasons: parsed.issues.map((i) => i.message) };
  }
  const rel = path.relative(repoRoot, write.path) || write.path;
  if (write.changed && yes) writeBoard(project, write);
  return { result, file: rel, changed: write.changed, written: write.changed && yes };
}

/** `--board` given, else the only non-archived board, else an error naming the choices. */
function boardIdFor(data: BoardFile, wanted: string | undefined): string | OpError {
  if (typeof wanted === 'string' && wanted.trim() !== '') return wanted.trim();
  const open = data.boards.filter((b) => !b.archived);
  if (open.length === 1) return open[0].id;
  return { error: open.length === 0 ? `the file has no open board (${CMD_NAME} board add starts one)` : `the file has ${open.length} open boards; say which with --board <id> (${open.map((b) => b.id).join(', ')})`, reasons: [] };
}

/** `board remove`: one item (refused while another item depends on it or nests under it). */
export function removeBoardItem(repoRoot: string, id: string, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => removeItem(d, id, { today }));
}

/** `board move`: an item (a top-level one with everything nested under it; a nested one alone, b444) to another board. */
export function moveBoardItem(repoRoot: string, id: string, toBoard: string, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => moveItem(d, id, toBoard, { today }));
}

/** `board rename`: the id and/or the display name of a board; its items keep their ids. */
export function renameRepoBoard(repoRoot: string, boardId: string, to: { id?: string; name?: string }, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => renameBoard(d, boardId, to, { today }));
}

/** b443: `board archive` / `board unarchive`: only the board's `archived` flag changes. */
export function archiveRepoBoard(repoRoot: string, boardId: string, archived: boolean, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => setBoardArchived(d, boardId, archived, { today }));
}

/** b443: `board delete`: an empty board (archived or not). */
export function deleteRepoBoard(repoRoot: string, boardId: string, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => deleteBoard(d, boardId, { today }));
}

/** `board group add`: a custom group on `board` (undefined = the only open board). */
export function addBoardGroup(repoRoot: string, board: string | undefined, name: string, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => {
    const id = boardIdFor(d, board);
    return typeof id === 'string' ? addGroup(d, id, name, { today }) : id;
  });
}

/** `board group remove`: a custom group, by name or id, of `board` (undefined = the only open board). */
export function removeBoardGroup(repoRoot: string, board: string | undefined, name: string, yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => {
    const id = boardIdFor(d, board);
    return typeof id === 'string' ? removeGroup(d, id, name, { today }) : id;
  });
}

/** `board group order`: the groups of `board` (undefined = the only open board) in the order of `names`. */
export function orderBoardGroups(repoRoot: string, board: string | undefined, names: string[], yes: boolean): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (d, today) => {
    const id = boardIdFor(d, board);
    return typeof id === 'string' ? orderGroups(d, id, names, { today }) : id;
  });
}

/** b645 (SV11a): the b-item fields the page may set (K 2026-11-23) plus the kanban group; values in the CLI's words. */
export const BOARD_PAGE_FIELDS = ['title', 'status', 'priority', 'owner', 'start', 'due', 'size', 'sprint', 'tags', 'group'] as const;
export type BoardPageField = (typeof BOARD_PAGE_FIELDS)[number];
export type BoardPageOp =
  | { op: 'set'; id: string; fields: Partial<Record<BoardPageField, string>> }
  | { op: 'group-add'; board: string; name: string }
  | { op: 'group-remove'; board: string; name: string }
  | { op: 'group-order'; board: string; names: string[] };
export interface BoardOpsResult {
  ok: boolean;
  /** One per op that ran, in order (the refused one last). */
  results: GuardedWriteJson[];
  /** Index of the refused op; null when every op ran (or none ran because of `error`). */
  stoppedAt: number | null;
  /** textStamp([['board', text]]) of the board file after the run; null when it cannot be read. */
  stamp: string | null;
  /** The whole run refused before any op. */
  error: { code: 'changed'; message: string } | null;
}
/** The command name each page op reports in its guarded JSON. */
const BOARD_PAGE_COMMANDS: Record<BoardPageOp['op'], string> = {
  set: 'board set', 'group-add': 'board group add', 'group-remove': 'board group remove', 'group-order': 'board group order',
};

/** b645 (SV11a): one `board set` as a guarded outcome (the shape of addBoardItemOutcome); writes only with `yes`. A refusal throws (BoardRefusal). */
export function setBoardItemOutcome(repoRoot: string, id: string, flags: BoardFlags, yes: boolean): GuardedOutcome {
  const c = setBoardItem(repoRoot, id, flags);
  if (c.kind === 'nothing') {
    const file = boardFileFor(requireProject(repoRoot));
    return { result: { lines: [...c.notes, 'nothing to change'] }, file: path.relative(repoRoot, file) || file, changed: false, written: false };
  }
  if (yes) applyBoardChange(c);
  return { result: { lines: c.lines }, file: path.relative(repoRoot, c.write.path) || c.write.path, changed: c.write.changed, written: yes && c.write.changed };
}

/** The board file's stamp (textStamp of [['board', text]]); null when the board cannot be read. */
function boardStamp(repoRoot: string): string | null {
  try {
    return textStamp([['board', openBoard(repoRoot).text]]);
  } catch {
    return null;
  }
}

/** One page op as its guarded outcome; a field outside BOARD_PAGE_FIELDS is refused (own guard, SV18 checks too). */
function pageOpOutcome(repoRoot: string, op: BoardPageOp, yes: boolean): GuardedOutcome {
  if (op.op === 'set') {
    const bad = Object.keys(op.fields).find((k) => !(BOARD_PAGE_FIELDS as readonly string[]).includes(k));
    if (bad !== undefined) return { error: `field '${bad}' cannot be set from the page`, reasons: [] };
    return setBoardItemOutcome(repoRoot, op.id, { ...op.fields }, yes);
  }
  if (op.op === 'group-add') return addBoardGroup(repoRoot, op.board, op.name, yes);
  if (op.op === 'group-remove') return removeBoardGroup(repoRoot, op.board, op.name, yes);
  return orderBoardGroups(repoRoot, op.board, op.names, yes);
}

/**
 * b645 (SV11a): the page's board edits, run IN ORDER through the board writers, STOPPING at the first refusal (earlier
 * ops stay written; K 2026-11-23). With `expectStamp` that differs from the board file's stamp nothing runs (`error`
 * 'changed'). `yes` false = a dry run of every op.
 */
export function runBoardOps(repoRoot: string, ops: BoardPageOp[], opts: { yes: boolean; expectStamp?: string }): BoardOpsResult {
  const { yes, expectStamp } = opts;
  if (typeof expectStamp === 'string' && expectStamp !== boardStamp(repoRoot)) {
    return {
      ok: false, results: [], stoppedAt: null, stamp: boardStamp(repoRoot),
      error: { code: 'changed', message: 'the board changed since this page loaded; nothing written. Reload the page and try again' },
    };
  }
  const results: GuardedWriteJson[] = [];
  let stoppedAt: number | null = null;
  for (let i = 0; i < ops.length && stoppedAt === null; i++) {
    let outcome: GuardedOutcome;
    try {
      outcome = pageOpOutcome(repoRoot, ops[i], yes);
    } catch (err) {
      outcome = thrownOutcome(err);
    }
    const json = guardedWriteJson(BOARD_PAGE_COMMANDS[ops[i].op], outcome, yes);
    results.push(json);
    if (!json.ok) stoppedAt = i;
  }
  return { ok: stoppedAt === null, results, stoppedAt, stamp: boardStamp(repoRoot), error: null };
}

/**
 * `board add --from-file`: the items of `spec` (`{"items": [...]}`, already read) in ONE write. Checked by expandBulk
 * (kinds, statuses, dates, groups, refs, cycles) and by the plan: every link uid must be a plan element, as
 * `board add --link` requires. The result is a BulkOk (it lists the minted ids).
 */
export function addItemsFromFile(repoRoot: string, spec: unknown, board: string | undefined, yes: boolean, boardName?: string): BoardOpOutcome {
  return runBoardOp(repoRoot, yes, (data, today) => {
    const r = expandBulk(data, spec, board, { today, boardName });
    if (isOpError(r)) return r;

    // links: every uid must be a plan element (same rule as `board add --link`)
    const raw = (spec as { items: unknown[] }).items;
    const wanted: { index: number; uid: string }[] = [];
    raw.forEach((it, index) => {
      const links = (it as { links?: unknown }).links;
      if (Array.isArray(links)) for (const uid of links) if (typeof uid === 'string' && uid.trim() !== '') wanted.push({ index, uid: uid.trim() });
    });
    if (wanted.length > 0) {
      const plan = planNoScan(repoRoot);
      if (plan === null) return { error: `links need the plan, and no plan found (${CMD_NAME} plan generate starts one)`, reasons: [] };
      const known = new Set<string>();
      for (const e of planItems(plan)) if (e.item.uid) known.add(e.item.uid);
      const dead = wanted.filter((w) => !known.has(w.uid)).map((w) => `items[${w.index}]: link '${w.uid}' matches no plan element (use a uid from ${CMD_NAME} plan show)`);
      if (dead.length > 0) return { error: `${dead.length} link${dead.length === 1 ? '' : 's'} match no plan element, nothing changed`, reasons: dead };
    }
    return r;
  });
}
