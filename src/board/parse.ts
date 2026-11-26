import type { Board, BoardDoc, BoardFile, BoardGroup, BoardItem, ParseIssue } from '../types';
import { isBoardDate } from './dates';
import { log } from '../log';
import { isObj } from '../util/obj';

/** Same rule as .c4 ids (Project/guide/c4.md): a letter or '_', then letters, digits, '_' or '-'. */
export const BOARD_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const FILE_KEYS = ['schemaVersion', 'boards'];
const BOARD_KEYS = ['id', 'name', 'archived', 'groups', 'items'];
const GROUP_KEYS = ['id', 'name', 'status'];
const ITEM_STRING_KEYS = ['owner', 'parent', 'sprint', 'priority', 'group'] as const;
const ITEM_DATE_KEYS = ['start', 'due', 'created', 'updated', 'closed'] as const;
const ITEM_LIST_KEYS = ['dependsOn', 'links', 'tags'] as const;
const ITEM_TEXT_KEYS = ['description', 'outcome'] as const;   // free text, kept as written (no trim); limits are checkBoard's
const DOC_KEYS = ['label', 'path', 'url'] as const;
const ITEM_KEYS = ['id', 'title', 'kind', 'status', ...ITEM_STRING_KEYS, ...ITEM_LIST_KEYS, ...ITEM_DATE_KEYS, ...ITEM_TEXT_KEYS, 'docs', 'size'];

type Obj = Record<string, unknown>;

/**
 * Parse the text of `board/board.json`. Reports STRUCTURE only (types, required fields, id shape, unique ids,
 * date shape, unknown keys). Rules about meaning (dead link, bad kind/status, unknown parent, cycles, ...)
 * belong to checkBoard. Never throws; bad pieces are dropped with an issue, so a caller that must not lose
 * data (the writer) refuses to write while any issue exists.
 */
export function parseBoard(text: string): { data: BoardFile | null; issues: ParseIssue[]; notes: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const notes: ParseIssue[] = [];   // tolerated: unknown item keys. Kept in data (item.extra) and re-written; shown as warnings, never block a write.
  const issue = ((where: string, message: string): void => {
    issues.push({ file: '', line: 0, message: where ? `${where}: ${message}` : message });
  }) as IssueFn;
  issue.note = (where: string, message: string): void => {
    notes.push({ file: '', line: 0, message: `${where}: ${message}` });
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    issue('', `board file is not valid JSON (${(err as Error).message})`);
    return { data: null, issues, notes };
  }
  if (!isObj(raw)) {
    issue('', 'board file must be a JSON object {"schemaVersion": 1, "boards": [...]}');
    return { data: null, issues, notes };
  }
  if (raw.schemaVersion !== 1) {
    issue('schemaVersion', `must be 1 (found ${JSON.stringify(raw.schemaVersion)})`);
    return { data: null, issues, notes };
  }
  if (!Array.isArray(raw.boards)) {
    issue('boards', 'must be an array');
    return { data: null, issues, notes };
  }
  for (const k of Object.keys(raw)) if (!FILE_KEYS.includes(k)) issue('', `unknown key '${k}'`);

  const boards: Board[] = [];
  const boardIds = new Set<string>();
  const itemIds = new Set<string>();   // unique across the WHOLE file

  raw.boards.forEach((rb, bi) => {
    const bw = `boards[${bi}]`;
    if (!isObj(rb)) return issue(bw, 'must be an object');
    const board = parseBoardEntry(rb, bw, bi, boardIds, itemIds, issue);
    if (board) boards.push(board);
  });

  log('board', 'parseBoard', { boards: boards.length, issues: issues.length });
  return { data: { schemaVersion: 1, boards }, issues, notes };
}

type IssueFn = ((where: string, message: string) => void) & { note: (where: string, message: string) => void };

function parseBoardEntry(
  rb: Obj, bw: string, _bi: number, boardIds: Set<string>, itemIds: Set<string>, issue: IssueFn,
): Board | null {
  for (const k of Object.keys(rb)) if (!BOARD_KEYS.includes(k)) issue(bw, `unknown key '${k}'`);

  const id = typeof rb.id === 'string' ? rb.id.trim() : '';
  if (!BOARD_ID_RE.test(id)) { issue(bw, `board skipped: 'id' must match ${BOARD_ID_RE} (found ${JSON.stringify(rb.id)})`); return null; }
  const name = typeof rb.name === 'string' ? rb.name.trim() : '';
  if (!name) { issue(bw, `board '${id}' skipped: 'name' must be a non-empty string`); return null; }
  if (boardIds.has(id)) { issue(bw, `board skipped: id '${id}' is already used by an earlier board`); return null; }
  boardIds.add(id);

  const board: Board = { id, name, items: [] };
  if (rb.archived !== undefined) {
    if (typeof rb.archived === 'boolean') { if (rb.archived) board.archived = true; }
    else issue(bw, `'archived' must be true or false`);
  }

  if (rb.groups !== undefined) {
    if (!Array.isArray(rb.groups)) issue(bw, `'groups' must be an array`);
    else {
      const groupIds = new Set<string>();
      const groups: BoardGroup[] = [];
      rb.groups.forEach((rg, gi) => {
        const g = parseGroup(rg, `${bw}.groups[${gi}]`, groupIds, issue);
        if (g) groups.push(g);
      });
      board.groups = groups;
    }
  }

  if (rb.items !== undefined && !Array.isArray(rb.items)) issue(bw, `'items' must be an array`);
  else if (Array.isArray(rb.items)) {
    rb.items.forEach((ri, ii) => {
      const item = parseItem(ri, `${bw}.items[${ii}]`, itemIds, issue);
      if (item) board.items.push(item);
    });
  }
  return board;
}

function parseGroup(rg: unknown, gw: string, groupIds: Set<string>, issue: IssueFn): BoardGroup | null {
  if (!isObj(rg)) { issue(gw, 'group dropped: must be an object'); return null; }
  for (const k of Object.keys(rg)) if (!GROUP_KEYS.includes(k)) issue(gw, `unknown key '${k}'`);
  const id = typeof rg.id === 'string' ? rg.id.trim() : '';
  if (!BOARD_ID_RE.test(id)) { issue(gw, `group dropped: 'id' must match ${BOARD_ID_RE} (found ${JSON.stringify(rg.id)})`); return null; }
  const name = typeof rg.name === 'string' ? rg.name.trim() : '';
  if (!name) { issue(gw, `group '${id}' dropped: 'name' must be a non-empty string`); return null; }
  if (groupIds.has(id)) { issue(gw, `group dropped: id '${id}' is already used in this board`); return null; }
  groupIds.add(id);
  const g: BoardGroup = { id, name };
  if (rg.status !== undefined) {
    if (typeof rg.status === 'string') { if (rg.status.trim()) g.status = rg.status.trim(); }
    else issue(gw, `'status' must be a string`);
  }
  return g;
}

function parseItem(ri: unknown, iw: string, itemIds: Set<string>, issue: IssueFn): BoardItem | null {
  if (!isObj(ri)) { issue(iw, 'item skipped: must be an object'); return null; }
  const extra: Record<string, unknown> = {};   // unknown keys survive a rewrite so a newer file does not lose data in an older tool
  for (const k of Object.keys(ri)) {
    if (ITEM_KEYS.includes(k)) continue;
    issue.note(iw, `unknown key '${k}' (kept as written)`);
    Object.defineProperty(extra, k, { value: ri[k], enumerable: true, writable: true, configurable: true });   // defineProperty: a key named __proto__ stays an own key
  }

  const id = typeof ri.id === 'string' ? ri.id.trim() : '';
  if (!BOARD_ID_RE.test(id)) { issue(iw, `item skipped: 'id' must match ${BOARD_ID_RE} (found ${JSON.stringify(ri.id)})`); return null; }
  const title = typeof ri.title === 'string' ? ri.title.trim() : '';
  if (!title) { issue(iw, `item '${id}' skipped: 'title' must be a non-empty string`); return null; }
  if (itemIds.has(id)) { issue(iw, `item skipped: id '${id}' is already used by an earlier item (ids are unique across the file)`); return null; }
  itemIds.add(id);

  // kind and status are kept as written (checkBoard judges them); a missing value becomes '' so checkBoard reports it.
  const text = (key: string): string => {
    const v = ri[key];
    if (v === undefined) return '';
    if (typeof v !== 'string') { issue(iw, `'${key}' must be a string`); return ''; }
    return v.trim();
  };
  const item: BoardItem = {
    id, title, kind: text('kind'), status: text('status'),
    dependsOn: [], links: [], tags: [],
  };

  for (const key of ITEM_STRING_KEYS) {
    const v = ri[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') { issue(iw, `'${key}' must be a string`); continue; }
    if (v.trim()) item[key] = v.trim();
  }
  for (const key of ITEM_LIST_KEYS) {
    const v = ri[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) { issue(iw, `'${key}' must be an array of strings`); continue; }
    for (const el of v) {
      if (typeof el !== 'string') { issue(iw, `'${key}' holds a non-string entry (dropped)`); continue; }
      if (el.trim()) item[key].push(el.trim());
    }
  }
  for (const key of ITEM_DATE_KEYS) {
    const v = ri[key];
    if (v === undefined) continue;
    const t = typeof v === 'string' ? v.trim() : v;
    if (isBoardDate(t)) item[key] = t;
    else issue(iw, `'${key}' ${JSON.stringify(v)} is not a date YYYY-MM-DD (dropped)`);
  }

  for (const key of ITEM_TEXT_KEYS) {
    const v = ri[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') { issue(`${iw}.${key}`, 'must be a string'); continue; }
    if (v.trim()) item[key] = v;
  }
  if (ri.size !== undefined) {
    if (typeof ri.size !== 'string') issue(`${iw}.size`, 'must be a string');
    else if (ri.size.trim()) item.size = ri.size.trim();
  }
  if (ri.docs !== undefined) {
    if (!Array.isArray(ri.docs)) issue(`${iw}.docs`, 'must be an array of {label?, path?, url?}');
    else {
      const docs: BoardDoc[] = [];
      ri.docs.forEach((rd, di) => {
        const dw = `${iw}.docs[${di}]`;
        if (!isObj(rd)) { issue(dw, 'doc dropped: must be an object'); return; }
        const doc: BoardDoc = {};
        for (const k of Object.keys(rd)) if (!(DOC_KEYS as readonly string[]).includes(k)) issue(dw, `unknown key '${k}'`);
        for (const k of DOC_KEYS) {
          const v = rd[k];
          if (v === undefined) continue;
          if (typeof v !== 'string') { issue(`${dw}.${k}`, 'must be a string'); continue; }
          if (v.trim()) doc[k] = v.trim();
        }
        docs.push(doc);
      });
      if (docs.length > 0) item.docs = docs;
    }
  }
  if (Object.keys(extra).length > 0) item.extra = extra;
  return item;
}
