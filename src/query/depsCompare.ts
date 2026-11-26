/**
 * b468: `c4pm deps <element> --compare <ref>`: the arrows of one element at a stored snapshot (history) and now.
 * A stored snapshot is built without the plan (history and `snapshot --save` scan plan-less), so its component ids are
 * folder ids. In claim mode its files are therefore owned again by TODAY's plan boxes with today's claims (the same
 * functions the snapshot build uses): "the same boxes, the code of then versus now". A box that did not exist at the
 * ref shows `before 0`; a file gone since then counts for whichever box claims its path today. Folder mode compares
 * the stored folder components directly. Read-only: the store is read, never created.
 */
import type { ComponentEdge, HistoryEntry, Snapshot } from '../types';
import { openProject } from '../scan/project';
import { storedSnapshots } from '../scan/snapshots';
import { toId } from '../names';
import { resolveOwnership } from '../c4/ownership';
import { dominantOwnerPerFile, edgesWithoutTestImporters, rollupEdges } from '../grouper/rollup';
import { testFileMatcher } from '../importer/testMatch';
import { collectDeps } from './depsFiles';
import type { DepsEdge, DepsTargetOf } from './depsFiles';
import type { QueryContext } from './context';
import { QueryError } from './errors';

export interface DepsCompareRow {
  id: string;
  title: string;
  before: number;
  after: number;
  status: 'new' | 'gone' | 'changed' | 'same';
}

export interface DepsCompare {
  ref: string;   // as given
  entry: { id: string; commit: string | null; commitDate: string | null };
  uses: DepsCompareRow[];
  usedBy: DepsCompareRow[];
}

/** What depsOf already worked out for the element: its level, members, roll-up and the map's arrows now. */
export interface DepsCompareInput {
  level: 'container' | 'subregion' | 'component';
  members: Set<string>;
  targetOf: DepsTargetOf;
  /** The map's edges now (model.edges): the code's component edges plus the plan relations. */
  edges: { from: string; to: string; weight: number }[];
  uses: DepsEdge[];
  usedBy: DepsEdge[];
}

/** The stored snapshot `ref` (latest, prev, oldest, an id, a commit prefix, YYYY-MM-DD) of the repo; QueryError('invalid') with the store's message otherwise. */
export function loadRefSnapshot(ctx: QueryContext, ref: string): { entry: HistoryEntry; snapshot: Snapshot } {
  try {
    const { store } = openProject(ctx.repoRoot, ctx.config.store ? { store: ctx.config.store } : {}, { store: 'required' });
    return storedSnapshots(store, toId(ctx.snapshot.meta.repoName), [ref])[0];
  } catch (err) {
    throw new QueryError('invalid', err instanceof Error ? err.message : String(err));
  }
}

/** The code's component edges of the stored snapshot, on today's boxes (claim mode: re-owned by today's claims). */
function codeEdgesAtRef(ctx: QueryContext, ref: Snapshot): ComponentEdge[] {
  if (!ctx.claimMode) return ref.componentEdges;
  // today's test globs too: an old snapshot may have no file roles
  const isTest = testFileMatcher(ctx.config.tests);
  const files = ref.files.map((f) => (f.role !== 'test' && isTest(f.file) ? { ...f, role: 'test' as const } : f));
  const owner = dominantOwnerPerFile(resolveOwnership(ctx.claims, files, ref.fileEdges), files);
  const tests = files.filter((f) => f.role === 'test').map((f) => f.file);
  return rollupEdges(edgesWithoutTestImporters(ref.fileEdges, tests), owner);
}

/**
 * The map's edges at the ref: today's map edges with today's code edges swapped for the ref's, so plan relations
 * (which add to an arrow's weight in the map) count the same on both sides and an unchanged tree compares all `same`.
 */
function mapEdgesAtRef(now: DepsCompareInput['edges'], codeNow: ComponentEdge[], codeRef: ComponentEdge[]): ComponentEdge[] {
  const key = (e: { from: string; to: string }): string => `${e.from}\0${e.to}`;
  const sums = new Map<string, ComponentEdge>();
  for (const e of now) sums.set(key(e), { from: e.from, to: e.to, weight: Number(e.weight) || 0 });
  for (const e of codeNow) {
    const s = sums.get(key(e));
    if (s) s.weight -= e.weight;   // an edge the map dropped (an end is not a box) has nothing to subtract from
  }
  for (const e of codeRef) {
    const s = sums.get(key(e));
    if (s) s.weight += e.weight;
    else sums.set(key(e), { ...e });
  }
  return [...sums.values()].filter((e) => e.weight > 0);
}

/** Rows of the union of `before` and `after` by id: new, gone, changed (by |delta| desc), same; then by id. */
export function compareRows(before: DepsEdge[], after: DepsEdge[]): DepsCompareRow[] {
  const rows = new Map<string, DepsCompareRow>();
  for (const e of before) rows.set(e.id, { id: e.id, title: e.title, before: e.weight, after: 0, status: 'gone' });
  for (const e of after) {
    const b = rows.get(e.id)?.before ?? 0;
    rows.set(e.id, { id: e.id, title: e.title, before: b, after: e.weight, status: b === 0 ? 'new' : b === e.weight ? 'same' : 'changed' });
  }
  const rank = { new: 0, gone: 1, changed: 2, same: 3 } as const;
  return [...rows.values()].sort((a, b) =>
    rank[a.status] - rank[b.status]
    || Math.abs(b.after - b.before) - Math.abs(a.after - a.before)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * deps --compare: per target box, the weight at `ref` -> now (`input.uses` / `input.usedBy`). Folder mode: a folder
 * component gone since the ref is still a box (its stored name; a container's member when it was in the container).
 */
export function depsCompareOf(ctx: QueryContext, input: DepsCompareInput, ref: string): DepsCompare {
  const { entry, snapshot } = loadRefSnapshot(ctx, ref);
  const edges = mapEdgesAtRef(input.edges, ctx.snapshot.componentEdges, codeEdgesAtRef(ctx, snapshot));

  let members = input.members;
  let targetOf = input.targetOf;
  if (!ctx.claimMode) {
    const comps = new Map(snapshot.components.map((c) => [c.id, c] as const));
    const conts = new Map(snapshot.containers.map((c) => [c.id, c] as const));
    if (input.level === 'container') {
      members = new Set([...members, ...snapshot.components.filter((c) => members.has(c.containerId)).map((c) => c.id)]);
    }
    targetOf = (id) => {
      const now = input.targetOf(id);
      if (now) return now;
      const c = comps.get(id);
      if (!c) return undefined;
      if (input.level !== 'container') return { node: { id: c.id, name: c.name } };
      return input.targetOf(c.containerId) ?? { node: { id: c.containerId, name: conts.get(c.containerId)?.name ?? c.containerId } };
    };
  }

  return {
    ref,
    entry: { id: entry.id, commit: entry.commit, commitDate: entry.commitDate },
    uses: compareRows(collectDeps(edges, members, 'out', targetOf), input.uses),
    usedBy: compareRows(collectDeps(edges, members, 'in', targetOf), input.usedBy),
  };
}
