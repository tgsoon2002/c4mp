import type { Board, BoardFile, BoardItem, Plan, PlanFinding } from '../types';
import { BOARD_DESCRIPTION_MAX, BOARD_OUTCOME_MAX, BOARD_SIZES, BOARD_STATUSES } from '../constants';
import { compareFindings } from '../c4/check';
import { boardDocProblem } from './docs';
import { kindProblem, statusProblem } from './fields';
import { planItems } from '../plan/planItems';
import { isValidTag } from '../tags';
import { findCycles } from './graph';
import { log } from '../log';

const TAG = 'board-check';

/** Finding id for rules about the whole file (not one item or one board). */
export const BOARD_FILE_ID = 'board.json';

/** Group ids a board offers when it declares no `groups` (section 3b of the Phase 16 plan: the three default columns). */
export const DEFAULT_GROUP_IDS = ['planned', 'in-progress', 'done'];

/** Statuses that are finished: a past `due` date on them is not overdue. */
const FINISHED = ['done', 'abandoned'];

/** The `board-overdue` condition, shared with `board list --overdue`: `due` before `today` and the item not finished. */
export function isOverdue(item: BoardItem, today: string): boolean {
  return item.due !== undefined && item.due < today && !FINISHED.includes(item.status);
}
/**
 * Meaning rules for the board file (the parser reports structure only). Pure. `today` is passed in, never read,
 * so tests are deterministic. `opts.fileExists` (repo-relative path -> bool) enables `board-doc-missing`; absent = doc
 * paths are not checked (checkBoard itself never touches the disk). `plan` null = no plan loaded: links cannot be checked. Finding `id` = the item id
 * (the board id for board rules, 'board.json' for whole-file rules). All id-keyed lookups use Map/Set, never
 * plain objects (ids such as `__proto__` and `constructor` are legal).
 */
export function checkBoard(data: BoardFile, plan: Plan | null, opts: { today: string; fileExists?: (repoRelativePath: string) => boolean }): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const add = (severity: PlanFinding['severity'], rule: string, id: string, message: string): void => {
    findings.push({ severity, rule, id, message });
  };

  // Where every item lives (ids are unique across the file; if a hand-built file repeats one, the first wins).
  const boardOf = new Map<string, string>();
  const allItems: { item: BoardItem; board: Board }[] = [];
  for (const board of data.boards) {
    for (const item of board.items) {
      if (!boardOf.has(item.id)) boardOf.set(item.id, board.id);
      allItems.push({ item, board });
    }
  }

  // Dead links (or one info when there is no plan).
  if (plan) {
    const uids = new Set<string>();
    for (const e of planItems(plan)) if (e.item.uid) uids.add(e.item.uid);
    for (const { item } of allItems) {
      for (const uid of item.links) {
        if (!uids.has(uid)) add('warning', 'board-dead-link', item.id, `${item.id}: link '${uid}' matches no plan element`);
      }
    }
  } else {
    const n = allItems.reduce((sum, x) => sum + x.item.links.length, 0);
    if (n > 0) add('info', 'board-links-unchecked', BOARD_FILE_ID, `no plan loaded, ${n} link${n === 1 ? '' : 's'} not checked`);
  }

  // Parents, dependencies, fields, groups, dates.
  for (const { item, board } of allItems) {
    if (item.parent !== undefined) {
      const home = boardOf.get(item.parent);
      if (home !== board.id) {
        add('warning', 'board-unknown-parent', item.id, home === undefined
          ? `${item.id}: parent '${item.parent}' is not an item`
          : `${item.id}: parent '${item.parent}' exists in board '${home}', not in board '${board.id}'`);
      }
    }
    for (const dep of item.dependsOn) {
      if (!boardOf.has(dep)) add('warning', 'board-unknown-dependency', item.id, `${item.id}: dependsOn '${dep}' is not an item`);
    }

    for (const problem of [kindProblem(item.kind), statusProblem(item.status)]) {
      if (problem) add('warning', 'board-invalid-field', item.id, `${item.id}: ${problem}`);
    }
    for (const tag of item.tags) {
      if (!isValidTag(tag)) add('warning', 'board-invalid-field', item.id, `${item.id}: tag '${tag}' should be lower-case letters, digits and dashes`);
    }

    if (item.description !== undefined && item.description.length > BOARD_DESCRIPTION_MAX) {
      add('warning', 'board-invalid-field', item.id, `${item.id}: description is ${item.description.length} characters, the limit is ${BOARD_DESCRIPTION_MAX}`);
    }
    if (item.outcome !== undefined && item.outcome.length > BOARD_OUTCOME_MAX) {
      add('warning', 'board-invalid-field', item.id, `${item.id}: outcome is ${item.outcome.length} characters, the limit is ${BOARD_OUTCOME_MAX}`);
    }
    if (item.size !== undefined && !BOARD_SIZES.includes(item.size)) {
      add('warning', 'board-invalid-field', item.id, `${item.id}: size '${item.size}' should be one of ${BOARD_SIZES.join(', ')}`);
    }
    (item.docs ?? []).forEach((doc, di) => {
      const problem = boardDocProblem(doc);
      if (problem) { add('warning', 'board-invalid-field', item.id, `${item.id}: docs[${di}] ${problem}`); return; }
      if (doc.path !== undefined && opts.fileExists && !opts.fileExists(doc.path)) {
        add('info', 'board-doc-missing', item.id, `${item.id}: docs[${di}] path '${doc.path}' does not exist in the repo`);
      }
    });

    if (item.group !== undefined) {
      const groupIds = board.groups ? board.groups.map((g) => g.id) : DEFAULT_GROUP_IDS;
      if (!groupIds.includes(item.group)) add('warning', 'board-unknown-group', item.id, `${item.id}: group '${item.group}' is not a group of board '${board.id}'`);
    }

    if (item.start !== undefined && item.due !== undefined && item.due < item.start) {
      add('warning', 'board-dates-reversed', item.id, `${item.id}: due ${item.due} is earlier than start ${item.start}`);
    }
    if (isOverdue(item, opts.today)) add('info', 'board-overdue', item.id, `${item.id}: due ${item.due} has passed (today ${opts.today}) and status is ${item.status}`);
  }

  for (const board of data.boards) {
    for (const g of board.groups ?? []) {
      if (g.status !== undefined && !BOARD_STATUSES.includes(g.status)) {
        add('warning', 'board-unknown-group', board.id, `board '${board.id}': group '${g.id}' has status '${g.status}', should be one of ${BOARD_STATUSES.join(', ')}`);
      }
    }
  }

  // Cycles. Each search is capped (findCycles); truncation is reported once for the whole file.
  const truncatedIn: string[] = [];
  const reportCycles = (rule: string, label: string, nodes: string[], edges: [string, string][], arrow: string): void => {
    const r = findCycles(nodes, edges);
    for (const cycle of r.cycles) {
      add('warning', rule, cycle[0], `${label} cycle: ${[...cycle, cycle[0]].join(` ${arrow} `)}`);
    }
    if (r.truncated) truncatedIn.push(label);
  };
  for (const board of data.boards) {
    const ids = board.items.map((i) => i.id);
    const edges: [string, string][] = [];
    for (const i of board.items) if (i.parent !== undefined) edges.push([i.id, i.parent]);   // a parent outside this board is not a node here: findCycles ignores the edge (board-unknown-parent reports it)
    reportCycles('board-nest-cycle', `nesting (board '${board.id}')`, ids, edges, '->');
  }
  {
    const ids = allItems.map((x) => x.item.id);
    const edges: [string, string][] = [];
    for (const { item } of allItems) for (const dep of item.dependsOn) edges.push([item.id, dep]);
    reportCycles('board-depends-cycle', 'dependsOn', ids, edges, '->');
  }
  if (truncatedIn.length > 0) {
    add('info', 'board-cycles-truncated', BOARD_FILE_ID, `cycle list truncated (${truncatedIn.join('; ')}): more cycles may exist`);
  }

  findings.sort(compareFindings);   // severity, rule, id: the one order (src/c4/check.ts)
  log(TAG, 'checkBoard complete', { findingCount: findings.length });
  return findings;
}
