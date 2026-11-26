import type { Board, BoardFile, BoardGroup, BoardItem } from '../types';

const NUMBERED_ID = /^b(\d+)$/;

/** Item order: `b<number>` ids first by number (b9 before b10), then any other id by plain string comparison. */
export function compareItemIds(a: string, b: string): number {
  const ma = NUMBERED_ID.exec(a);
  const mb = NUMBERED_ID.exec(b);
  if (ma && mb) return Number(ma[1]) - Number(mb[1]) || (a < b ? -1 : a > b ? 1 : 0);
  if (ma) return -1;
  if (mb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Key order below = the order of the interfaces in types.ts (Phase 16 block).
function groupOut(g: BoardGroup): Record<string, unknown> {
  const o: Record<string, unknown> = { id: g.id, name: g.name };
  if (g.status !== undefined) o.status = g.status;
  return o;
}

function itemOut(i: BoardItem): Record<string, unknown> {
  const o: Record<string, unknown> = { id: i.id, title: i.title, kind: i.kind, status: i.status };
  if (i.owner !== undefined) o.owner = i.owner;
  if (i.parent !== undefined) o.parent = i.parent;
  o.dependsOn = i.dependsOn;
  o.links = i.links;
  o.tags = i.tags;
  for (const k of ['sprint', 'priority', 'start', 'due', 'created', 'updated', 'closed', 'group'] as const) {
    if (i[k] !== undefined) o[k] = i[k];
  }
  // Phase 16 B41 keys come LAST, in this order, so a file without them serializes exactly as before:
  // description, docs (each entry: label, path, url), outcome, size. Omitted when absent or empty.
  if (i.description) o.description = i.description;
  if (i.docs && i.docs.length > 0) {
    o.docs = i.docs.map((d) => {
      const x: Record<string, unknown> = {};
      if (d.label !== undefined) x.label = d.label;
      if (d.path !== undefined) x.path = d.path;
      if (d.url !== undefined) x.url = d.url;
      return x;
    });
  }
  if (i.outcome) o.outcome = i.outcome;
  if (i.size !== undefined) o.size = i.size;
  // unknown keys from a newer file: kept, written last in their original order (never overwrite a known key)
  for (const [k, v] of Object.entries(i.extra ?? {})) if (!(k in o)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

function boardOut(b: Board): Record<string, unknown> {
  const o: Record<string, unknown> = { id: b.id, name: b.name };
  if (b.archived) o.archived = true;
  if (b.groups !== undefined) o.groups = b.groups.map(groupOut);   // group order is what the Kanban shows: kept
  o.items = [...b.items].sort((x, y) => compareItemIds(x.id, y.id)).map(itemOut);
  return o;
}

/** Deterministic text for `board/board.json`: 2-space JSON plus a final newline. Boards and groups keep their order; items are sorted. */
export function serializeBoard(data: BoardFile): string {
  return JSON.stringify({ schemaVersion: data.schemaVersion, boards: data.boards.map(boardOut) }, null, 2) + '\n';
}
