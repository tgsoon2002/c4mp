/**
 * P18-PB2: read-only board queries behind `board show|tree|for`. Pure: a BoardFile (and a Plan) in, data out.
 * Links are uids of plan elements; they resolve against `planItems(plan)` (the plan itself, not the map nodes,
 * so a component uid that the map cannot place still resolves). All id-keyed lookups are Map/Set and every walk is
 * iterative (20000 items must not overflow the stack).
 */
import type { Board, BoardFile, BoardItem, Graph, GraphEdge, GraphNode, Plan, PlanElement, RunCommand } from '../types';
import { planItems } from '../plan/planItems';
import { testsReport, treeIdOfPlan } from '../c4/testAttach';
import type { PlannedTestRef, TestCase, TestIndex, TestRef, TestsReport } from '../c4/testAttach';
import { compareItemIds } from './serialize';
import { CMD_NAME } from '../constants';

export interface ItemRef { id: string; title: string; kind: string; status: string }

export interface LinkedElement {
  uid: string;
  /** resolved = found in the plan; missing = no plan element has this uid (dead link); unchecked = no plan loaded. */
  state: 'resolved' | 'missing' | 'unchecked';
  kind?: string;
  fqn?: string;
  title?: string;
  status?: string;
  owner?: string;
}

export interface ItemView {
  board: { id: string; name: string; archived?: boolean };
  item: BoardItem;
  parent: ItemRef | null;
  children: ItemRef[];
  /** Items this one waits for; an id that is not an item is listed with `missing: true`. */
  dependsOn: (ItemRef | { id: string; missing: true })[];
  /** Items that wait for this one (any board). */
  dependents: ItemRef[];
  linked: LinkedElement[];
  /** T26-12 (D19): only when asked (`board show --with-tests`): the tests of the linked c-items, see linkedTests. */
  tests?: TestsReport;
}

/** T26-12: what showItem needs to list tests. The caller scans the code and binds `runOf` (it reads manifests). */
export interface ItemTestsInput { index: TestIndex; runOf: (t: TestCase) => RunCommand | null }

const refOf = (i: BoardItem): ItemRef => ({ id: i.id, title: i.title, kind: i.kind, status: i.status });
const byId = (a: { id: string }, b: { id: string }): number => compareItemIds(a.id, b.id);

/** uid -> the plan facts a link needs. First element wins on a duplicate uid. */
function planByUid(plan: Plan): Map<string, LinkedElement> {
  const m = new Map<string, LinkedElement>();
  for (const { item, el } of planItems(plan)) {
    if (!item.uid || m.has(item.uid)) continue;
    const linked: LinkedElement = { uid: item.uid, state: 'resolved', kind: el.kind, fqn: el.id, title: el.title };
    if (el.metadata.status !== undefined) linked.status = el.metadata.status;
    if (el.metadata.owner !== undefined) linked.owner = el.metadata.owner;
    m.set(item.uid, linked);
  }
  return m;
}

/** Resolve stored uids against the plan (`plan` null = nothing can be checked). */
export function resolveLinks(uids: string[], plan: Plan | null): LinkedElement[] {
  if (plan === null) return uids.map((uid) => ({ uid, state: 'unchecked' as const }));
  const known = planByUid(plan);
  return uids.map((uid) => known.get(uid) ?? { uid, state: 'missing' as const });
}

const byFileLine = (a: TestRef, b: TestRef): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

/** A TestsReport whose run and touching refs are `T` (TestRef or a subtype). */
export type ReportOf<T extends TestRef> = Omit<TestsReport, 'run' | 'touches'> & { run: T[]; touches: T[] };

/**
 * Several TestsReports as one, each test once (by id): a test to run in any report is not also a touching one; the
 * first report that lists a test gives its `relation`. Tests to write once per plan block (file and line), in report
 * order. Run and touches in file, then line order. Generic over the test ref, so a report whose refs carry more
 * (query/itemTests.ts: `noRun`) keeps it.
 */
export function mergeTestsReports<T extends TestRef = TestRef>(reports: ReportOf<T>[]): ReportOf<T> {
  const run = new Map<string, T>();
  for (const r of reports) for (const t of r.run) if (!run.has(t.id)) run.set(t.id, t);
  const touches = new Map<string, T>();
  for (const r of reports) for (const t of r.touches) if (!run.has(t.id) && !touches.has(t.id)) touches.set(t.id, t);
  const toWrite = new Map<string, PlannedTestRef>();
  for (const r of reports) {
    for (const p of r.toWrite) {
      const key = `${p.source.file}:${p.source.line}`;
      if (!toWrite.has(key)) toWrite.set(key, p);
    }
  }
  const merged = { run: [...run.values()].sort(byFileLine), toWrite: [...toWrite.values()], touches: [...touches.values()].sort(byFileLine) };
  return { ...merged, counts: { run: merged.run.length, toWrite: merged.toWrite.length, touches: merged.touches.length } };
}

/**
 * T26-12 (D19): the tests of the c-items that `uids` link (testsReport of c4/testAttach.ts: run = attached to the c-item
 * or below it, touches, planned tests to write), merged. A linked element with no node on the test tree (a layer, a
 * plan-only element) gives its own blocks to write and the reports of its plan children: a layer's tests are its
 * components' (D4). A dead link gives nothing. Iterative, each plan element once.
 */
export function linkedTests(uids: string[], plan: Plan, t: ItemTestsInput): TestsReport {
  const byUid = new Map<string, PlanElement>();
  for (const { item, el } of planItems(plan)) if (item.uid && !byUid.has(item.uid)) byUid.set(item.uid, el);
  const kids = new Map<string, PlanElement[]>();
  for (const el of plan.elements) {
    if (el.parent === null) continue;
    const list = kids.get(el.parent);
    if (list) list.push(el); else kids.set(el.parent, [el]);
  }
  const todo = uids.map((uid) => byUid.get(uid)).filter((el): el is PlanElement => el !== undefined).reverse();
  const seen = new Set<string>();
  const reports: TestsReport[] = [];
  while (todo.length > 0) {
    const el = todo.pop()!;
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    const treeId = treeIdOfPlan(t.index, el);
    if (treeId !== null) { reports.push(testsReport(t.index, treeId, plan, el, t.runOf)); continue; }
    const below = kids.get(el.id) ?? [];
    // el.id names no tree node, so this report holds only tests to write: el's own blocks, and with no plan children
    // its descendants' too (plan passed); plan children report their own below.
    reports.push(testsReport(t.index, el.id, below.length > 0 ? null : plan, el, t.runOf));
    for (let k = below.length - 1; k >= 0; k--) todo.push(below[k]);
  }
  return mergeTestsReports(reports);
}

/**
 * D24: everything about one item, or null when there is no such item. With `opts.tests` (T26-12, D19) also the tests of
 * the c-items it links (`ItemView.tests`); without, no code is read.
 */
export function showItem(file: BoardFile, plan: Plan | null, id: string, opts: { tests?: ItemTestsInput } = {}): ItemView | null {
  const all = new Map<string, { board: Board; item: BoardItem }>();
  for (const board of file.boards) for (const item of board.items) if (!all.has(item.id)) all.set(item.id, { board, item });
  const found = all.get(id);
  if (!found) return null;
  const { board, item } = found;

  const parentHit = item.parent === undefined ? undefined : all.get(item.parent);
  const children: ItemRef[] = [];
  const dependents: ItemRef[] = [];
  for (const b of file.boards) {
    for (const other of b.items) {
      if (other.parent === id && b === board) children.push(refOf(other));
      if (other.dependsOn.includes(id)) dependents.push(refOf(other));
    }
  }
  const view: ItemView = {
    board: { id: board.id, name: board.name, ...(board.archived ? { archived: true } : {}) },
    item,
    parent: parentHit ? refOf(parentHit.item) : null,
    children: children.sort(byId),
    dependsOn: item.dependsOn.map((d) => { const hit = all.get(d); return hit ? refOf(hit.item) : { id: d, missing: true as const }; }),
    dependents: dependents.sort(byId),
    linked: resolveLinks(item.links, plan),
  };
  if (opts.tests) view.tests = plan ? linkedTests(item.links, plan, opts.tests) : mergeTestsReports([]);
  return view;
}

export type BoardTreeResult =
  | { graph: Graph; outside: number; truncated: boolean; boardId: string }
  | { error: string };

/**
 * D24: the nesting of items as a Graph (T7 neutral graph; node id = item id, `parent` = nesting) plus `dependsOn`
 * as edges (from the item waited for, to the item that waits: the order of work). `id` null = every top-level item of
 * a board (`boardId`, or the only non-archived board). One level below the root(s) by default, all with `recursive`.
 * A dependsOn edge with one end outside the view is not drawn and is counted in `outside`.
 * More than `maxNodes` nodes is refused.
 */
export function boardTreeGraph(
  file: BoardFile, id: string | null, opts: { recursive: boolean; maxNodes: number; boardId?: string },
): BoardTreeResult {
  let board: Board | undefined;
  let roots: BoardItem[];
  if (id !== null) {
    board = file.boards.find((b) => b.items.some((i) => i.id === id));
    if (!board) return { error: `no item '${id}'` };
    roots = [board.items.find((i) => i.id === id)!];
  } else {
    if (opts.boardId !== undefined) {
      board = file.boards.find((b) => b.id === opts.boardId);
      if (!board) return { error: `no board '${opts.boardId}' (boards: ${file.boards.map((b) => b.id).join(', ') || 'none'})` };
    } else {
      const open = file.boards.filter((b) => !b.archived);
      if (open.length === 0) return { error: `the file has no board (${CMD_NAME} board add starts one)` };
      if (open.length > 1) return { error: `the file has ${open.length} boards; say which with --board <id> (${open.map((b) => b.id).join(', ')})` };
      board = open[0];
    }
    const here = new Set(board.items.map((i) => i.id));
    roots = board.items.filter((i) => i.parent === undefined || i.parent === i.id || !here.has(i.parent)).sort(byId);
  }

  const kids = new Map<string, BoardItem[]>();
  for (const i of board.items) {
    if (i.parent === undefined) continue;
    const list = kids.get(i.parent);
    if (list) list.push(i); else kids.set(i.parent, [i]);
  }
  for (const list of kids.values()) list.sort(byId);

  if (id === null) {
    // Items stuck in a parent cycle have no root above them: make the smallest id of each such group a root, so none is hidden.
    const reach = new Set<string>();
    const mark = (start: BoardItem): void => {
      const todo = [start];
      while (todo.length > 0) {
        const cur = todo.pop()!;
        if (reach.has(cur.id)) continue;
        reach.add(cur.id);
        for (const k of kids.get(cur.id) ?? []) todo.push(k);
      }
    };
    for (const r of roots) mark(r);
    for (const i of [...board.items].sort(byId)) {
      if (reach.has(i.id)) continue;
      roots.push(i);
      mark(i);
    }
  }

  const nodes: GraphNode[] = [];
  const shown = new Set<string>();
  const shownItems: BoardItem[] = [];
  let truncated = false;
  const stack: { item: BoardItem; parent: string | undefined; depth: number }[] = [];
  for (let k = roots.length - 1; k >= 0; k--) stack.push({ item: roots[k], parent: undefined, depth: 0 });
  while (stack.length > 0) {
    const { item, parent, depth } = stack.pop()!;
    if (shown.has(item.id)) continue;   // a parent cycle in a hand-built file must not loop
    shown.add(item.id);
    shownItems.push(item);
    nodes.push({
      id: item.id, label: item.title, kind: item.kind || 'item',
      ...(item.status ? { status: item.status } : {}),
      ...(item.owner !== undefined ? { owner: item.owner } : {}),
      ...(parent !== undefined ? { parent } : {}),
    });
    const below = kids.get(item.id) ?? [];
    if (!opts.recursive && depth >= 1) {
      if (below.length > 0) truncated = true;
      continue;
    }
    for (let k = below.length - 1; k >= 0; k--) stack.push({ item: below[k], parent: item.id, depth: depth + 1 });
  }
  if (nodes.length > opts.maxNodes) {
    return { error: `${nodes.length} nodes is more than --max-nodes ${opts.maxNodes}; name one item, drop -r or raise --max-nodes` };
  }

  const edges: GraphEdge[] = [];
  let outside = 0;
  for (const item of shownItems) {
    for (const dep of item.dependsOn) {
      if (shown.has(dep)) edges.push({ from: dep, to: item.id });
      else outside++;
    }
  }
  return { graph: { nodes, edges }, outside, truncated, boardId: board.id };
}

/** D24: every item (any board, archived too) whose `links` holds the uid, with its board. Boards in file order, items by id. */
export function itemsFor(file: BoardFile, uid: string): { board: Board; item: BoardItem }[] {
  const out: { board: Board; item: BoardItem }[] = [];
  for (const board of file.boards) {
    for (const item of [...board.items].sort(byId)) if (item.links.includes(uid)) out.push({ board, item });
  }
  return out;
}
