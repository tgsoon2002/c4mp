import type { BoardFile, BoardGroup, PlanFinding, ViewBoardEntry, ViewBoardItem, ViewBoardLink, ViewModel, ViewNode } from '../types';
import { BOARD_KINDS, BOARD_SIZES, BOARD_STATUSES, PLAN_PRIORITIES } from '../constants';
import { uidIndex } from '../view/tree';

/** Columns shown for a board that declares no `groups` (section 3b: the status words, not `abandoned`). */
export function defaultGroups(): BoardGroup[] {
  return [
    { id: 'planned', name: 'Planned', status: 'planned' },
    { id: 'in-progress', name: 'In progress', status: 'in-progress' },
    { id: 'done', name: 'Done', status: 'done' },
  ];
}

/**
 * Attach the board to the view model: `model.board` plus `ViewNode.boardCount`. Pure in the sense of
 * `applyFindings`: mutates and returns `model`, never mutates `data`. Call it AFTER `applyFindings`, because
 * `findingCount` reads `node.findings`. Only nodes that carry a `uid` can be linked: every view tree is walked, the arch tree first,
 * then the IO-view tree (b130), then the storage-view tree (STOR-5 b338); the first node with a uid keeps it, so an architecture
 * uid wins on a clash. Any other uid goes to `deadLinks` (never invented). `boardCount` counts items of non-archived boards only
 * (each item once per node).
 */
export function attachBoard(model: ViewModel, data: BoardFile, findings: PlanFinding[]): ViewModel {
  const byUid = uidIndex(model);   // S4: the shared index (arch, IO, storage trees; subregions too; first uid wins)

  const counts = new Map<ViewNode, number>();
  const boards: ViewBoardEntry[] = data.boards.map((board) => {
    const items: ViewBoardItem[] = board.items.map((item) => {
      const linked: ViewBoardLink[] = [];
      const deadLinks: string[] = [];
      for (const uid of new Set(item.links)) {
        const node = byUid.get(uid)?.node;
        if (!node) { deadLinks.push(uid); continue; }
        const link: ViewBoardLink = {
          uid,
          nodeId: node.id,
          name: node.name,
          kind: node.kind,
          state: node.planOnly ? 'planned-no-code' : 'has-code',
          findingCount: node.findings?.length ?? 0,
        };
        if (node.meta?.status !== undefined) link.status = node.meta.status;
        if (node.meta?.owner !== undefined) link.owner = node.meta.owner;
        linked.push(link);
        if (!board.archived) counts.set(node, (counts.get(node) ?? 0) + 1);
      }
      return { ...item, dependsOn: [...item.dependsOn], links: [...item.links], tags: [...item.tags], ...(item.docs ? { docs: item.docs.map((d) => ({ ...d })) } : {}), linked, deadLinks };
    });
    const entry: ViewBoardEntry = {
      id: board.id,
      name: board.name,
      groups: board.groups && board.groups.length > 0 ? board.groups.map((g) => ({ ...g })) : defaultGroups(),
      items,
    };
    if (board.archived !== undefined) entry.archived = board.archived;
    return entry;
  });

  for (const [node, n] of counts) node.boardCount = n;
  model.board = { statuses: [...BOARD_STATUSES], kinds: [...BOARD_KINDS], priorities: [...PLAN_PRIORITIES], sizes: [...BOARD_SIZES], boards, findings };
  return model;
}
