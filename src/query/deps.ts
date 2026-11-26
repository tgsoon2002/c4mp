import { localId } from '../names';
import type { ViewNode } from '../types';
import type { QueryContext } from './context';
import { closestIds, getModel, resolveElementId } from './elements';
import type { ElementMatch } from './elements';
import { QueryError } from './errors';
import type { LookupTier } from '../util/lookup';
import { collectItems } from './showElement';
import { subregionMembers, subtreeIds } from '../view/tree';
import type { CollectedElement } from './showElement';
import { collectDeps, depsFilesOf } from './depsFiles';
import type { DepsEdge, DepsFileGroup } from './depsFiles';
import { depsCompareOf } from './depsCompare';
import type { DepsCompare } from './depsCompare';

export type { DepsEdge, DepsFileGroup, DepsImportLine } from './depsFiles';
export type { DepsCompare, DepsCompareRow } from './depsCompare';

/** b467/b468: what `deps` adds. files: the import lines behind each arrow; compare: a history ref (b468). */
export interface DepsOptions { files?: boolean; compare?: string; }
export interface DeclaredRelation { from: string; to: string; label: string | null; source: { file: string; line: number }; }
export interface UnresolvedRelation { from: string; to: string; reason: string; }

export interface DepsResult {
  id: string;
  uid?: string;
  title: string;
  level: 'container' | 'subregion' | 'component';   // b456: 'subregion' was 'layer' before plan standard 1.9
  resolvedFrom: LookupTier;
  uses: DepsEdge[];          // "Depends on" in the viewer
  usedBy: DepsEdge[];        // "Used by" in the viewer
  declared: DeclaredRelation[];
  unresolvedDeclared: UnresolvedRelation[];
  /** b467 (`files`): `uses` / `usedBy` again, each arrow with the import lines behind it. */
  usesFiles?: DepsFileGroup[];
  usedByFiles?: DepsFileGroup[];
  /** b468 (`compare`): per target box, the weight at the stored snapshot -> now. */
  compare?: DepsCompare;
}

function describe(m: ElementMatch): string {
  return `${m.id} | ${m.title} | ${m.level}`;
}

/** Dependencies of one container, subregion or component, as the map's panel shows them, plus declared plan relations. */
export function depsOf(ctx: QueryContext, input: string, opts: DepsOptions = {}): DepsResult {
  const res = resolveElementId(ctx, input);
  if (res.matches.length === 0 || res.tier === null) {
    throw new QueryError('not-found', `no element matches "${input}"`, closestIds(ctx, input, 5).map(describe));
  }
  if (res.matches.length > 1) {
    throw new QueryError('ambiguous', `"${input}" matches ${res.matches.length} elements`, res.matches.map(describe));
  }
  const match = res.matches[0];
  if (match.level !== 'container' && match.level !== 'subregion' && match.level !== 'component') {
    throw new QueryError('invalid', `"${match.id}" is a ${match.level}; deps works on containers, subregions and components`);
  }
  const level = match.level;

  const model = getModel(ctx);
  const byId = new Map<string, CollectedElement>();
  for (const c of collectItems(model.root)) if (!byId.has(c.node.id)) byId.set(c.node.id, c);
  const self = byId.get(match.id);
  if (!self) throw new QueryError('not-found', `element "${match.id}" is not in the map`);

  // S11: a container's (or a subregion's) deps roll up to the nearest node of its own kind.
  const nearestOfKind = (id: string): CollectedElement | undefined => {
    const start = byId.get(id);
    let cur = start;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.node.id)) {
      if (cur.node.kind === level) return cur;
      seen.add(cur.node.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    return start;
  };
  const targetOf = level === 'component' ? (id: string) => byId.get(id) : nearestOfKind;

  // A subregion has no children of its own (LK-G: notation on its container): its members are its components' subtrees.
  const container = level === 'subregion' && self.parentId !== null ? byId.get(self.parentId)?.node : undefined;
  const members = container
    ? new Set([self.node.id, ...subregionMembers(container, self.node.id).flatMap((c) => [...subtreeIds(c)])])
    : subtreeIds(self.node);
  const edges = model.edges;
  const uses = collectDeps(edges, members, 'out', targetOf);
  const usedBy = collectDeps(edges, members, 'in', targetOf);

  // Declared: relations touching the element (container or subregion: or anything inside it).
  const touches = level === 'component' ? new Set([match.id]) : members;
  const rels = model.relations ?? [];
  const declared: DeclaredRelation[] = rels
    .filter((r) => touches.has(r.from) || touches.has(r.to))
    .map((r) => ({ from: r.from, to: r.to, label: r.label, source: { file: r.file, line: r.line } }));

  // Plan relations the map dropped (an endpoint is not in the map) that name this element.
  const names = new Set<string>([match.id, localId(match.id)]);
  if (match.uid) {
    const planEl = ctx.plan?.elements.find((e) => e.metadata.uid === match.uid);
    if (planEl) { names.add(planEl.id); names.add(localId(planEl.id)); }
  }
  const kept = new Set(rels.map((r) => `${r.file}:${r.line}`));
  const unresolvedDeclared: UnresolvedRelation[] = (ctx.plan?.relations ?? [])
    .filter((r) => !kept.has(`${r.source.file}:${r.source.line}`))
    .filter((r) => [r.from, localId(r.from), r.to, localId(r.to)].some((t) => names.has(t)))
    .map((r) => ({ from: r.from, to: r.to, reason: 'endpoint not found in the map' }));

  const result: DepsResult = {
    id: match.id,
    ...(match.uid !== undefined ? { uid: match.uid } : {}),
    title: match.title,
    level,
    resolvedFrom: res.tier,
    uses,
    usedBy,
    declared,
    unresolvedDeclared,
  };
  if (opts.files) {
    result.usesFiles = depsFilesOf(ctx, members, 'out', targetOf, uses);
    result.usedByFiles = depsFilesOf(ctx, members, 'in', targetOf, usedBy);
  }
  if (opts.compare !== undefined) {
    result.compare = depsCompareOf(ctx, { level, members, targetOf, edges, uses, usedBy }, opts.compare);
  }
  return result;
}
