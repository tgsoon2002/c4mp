/**
 * b467: the import lines behind the arrows of `c4pm deps` (`--files`), and the edge summing both deps and its compare
 * (b468) use. Pure: reads the QueryContext's in-memory snapshot (Snapshot.imports, Snapshot.calls), writes nothing.
 */
import type { FileCalls, ImportKind } from '../types';
import type { QueryContext } from './context';
import type { CollectedElement } from './showElement';

export interface DepsEdge { id: string; title: string; weight: number; }

/** The box an edge end rolls up to (a component itself, or the nearest container / subregion); undefined = not a box.
 *  A map element (CollectedElement), or (deps --compare, b468) a box that is gone from the map since the ref. */
export type DepsTargetOf = (id: string) => Pick<CollectedElement, 'node'> | { node: { id: string; name: string } } | undefined;

/** One import statement behind an arrow: `file:line` imports `target` (repo-relative files). */
export interface DepsImportLine {
  file: string;
  line: number;
  spec: string;
  kind: ImportKind;
  target: string;
  /** Names the file binds from `spec` (exported name, `default`, `* as <local>`); joined by (file, spec), so two import
   *  lines of one spec in one file show the same list. Empty for a language without import bindings (Python, ...). */
  names: string[];
}

/** One arrow of `deps` with the import lines behind it. An arrow made by a plan relation alone has no lines. */
export interface DepsFileGroup extends DepsEdge { imports: DepsImportLine[]; }

/**
 * Viewer `collectDeps` (Project/viewer/viewModel.js): sum edge weights of `members` towards outside nodes.
 * Component: the other end as is. Container or subregion: the other end rolled up to its nearest node of the same kind
 * (or itself when it has none).
 */
export function collectDeps(
  edges: { from: string; to: string; weight: number }[],
  members: Set<string>,
  dir: 'out' | 'in',
  targetOf: DepsTargetOf,
): DepsEdge[] {
  const sums = new Map<string, DepsEdge>();
  for (const e of edges) {
    const mine = dir === 'out' ? e.from : e.to;
    const other = dir === 'out' ? e.to : e.from;
    if (!members.has(mine) || members.has(other)) continue;
    const target = targetOf(other);
    if (!target || members.has(target.node.id)) continue;
    const prev = sums.get(target.node.id);
    sums.set(target.node.id, {
      id: target.node.id,
      title: target.node.name,
      weight: (prev ? prev.weight : 0) + (Number(e.weight) || 0),
    });
  }
  return [...sums.values()].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Names each file binds per import spec: key `${file}\0${spec}`, sorted unique (`default`, `* as ns`, exported names). */
function bindingNames(calls: FileCalls[] | undefined): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const fc of calls ?? []) {
    for (const b of fc.bindings) {
      const key = `${fc.file}\0${b.spec}`;
      const name = b.imported === '*' ? `* as ${b.local}` : b.imported;
      (sets.get(key) ?? sets.set(key, new Set()).get(key)!).add(name);
    }
  }
  return new Map([...sets].map(([k, s]) => [k, [...s].sort()]));
}

const byFileLine = (a: DepsImportLine, b: DepsImportLine): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0);

/**
 * The import lines behind each edge of `edges` (the `uses` or `usedBy` of depsOf). dir 'out': imports in files owned by
 * `members` that resolve to a file owned outside; 'in': imports in files owned outside that resolve to a file of
 * `members`. Grouped by the box `targetOf` rolls the outside owner up to; test-file importers are skipped, as the
 * arrows skip them (edgesWithoutTestImporters). Same ids, titles, weights and order as `edges`; a group can have more
 * lines than its weight (the weight counts file pairs, a pair can have several import statements).
 */
export function depsFilesOf(
  ctx: QueryContext,
  members: Set<string>,
  dir: 'out' | 'in',
  targetOf: DepsTargetOf,
  edges: DepsEdge[],
): DepsFileGroup[] {
  const ownerOf = new Map(ctx.snapshot.files.map((f) => [f.file, f.componentId] as const));
  const tests = new Set(ctx.snapshot.files.filter((f) => f.role === 'test').map((f) => f.file));
  const names = bindingNames(ctx.snapshot.calls);
  const groups = new Map<string, DepsImportLine[]>();
  for (const fi of ctx.snapshot.imports ?? []) {
    if (tests.has(fi.file)) continue;
    for (const r of fi.imports) {
      if (r.status !== 'internal' || !r.target) continue;
      const [mineFile, otherFile] = dir === 'out' ? [fi.file, r.target] : [r.target, fi.file];
      const mine = ownerOf.get(mineFile);
      const other = ownerOf.get(otherFile);
      if (!mine || !other || !members.has(mine) || members.has(other)) continue;
      const box = targetOf(other);
      if (!box || members.has(box.node.id)) continue;
      const line: DepsImportLine = {
        file: fi.file, line: r.line, spec: r.spec, kind: r.kind, target: r.target, names: names.get(`${fi.file}\0${r.spec}`) ?? [],
      };
      (groups.get(box.node.id) ?? groups.set(box.node.id, []).get(box.node.id)!).push(line);
    }
  }
  return edges.map((e) => ({ ...e, imports: (groups.get(e.id) ?? []).sort(byFileLine) }));
}
