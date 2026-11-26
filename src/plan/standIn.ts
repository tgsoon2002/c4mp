import type { Plan, PlanElement, PlanLink } from '../types';
import { localId, c4Id } from '../names';
import { containerOf, planById } from './layers';
import { isMapActor } from './kinds';
import { log } from '../log';

/** P14-T44c-a: a repo-relative path without a trailing '/' and without a leading './'. */
function normalisePath(p: string): string {
  return p.replace(/\/$/, '').replace(/^\.\//, '');
}

/** P14-T44c-a: the folder a plan link points at. A folder link (trailing '/') is the folder; a file link is its dirname. */
function linkFolder(link: PlanLink): string {
  const p = normalisePath(link.path);
  if (link.path.endsWith('/')) return p;
  const slash = p.lastIndexOf('/');
  return slash < 0 ? '.' : p.slice(0, slash);
}

/**
 * Phase 28 (LK-C): the fqn of the container a component belongs to, seeing through layers (Q-1). A null from
 * containerOf for an element with a parent means the chain through a layer broke: the direct parent is passed
 * explicitly and logged, never a default container. Shared by the snapshot builder and stand-in matching.
 */
export function containerFqnOf(plan: Plan, el: PlanElement): string | null {
  const container = containerOf(plan, el);
  if (container === null && el.parent !== null) log('layers', 'containerOf: broken layer chain, using the direct parent', { id: el.id, parent: el.parent });
  return container ?? el.parent;
}

/**
 * P14-T44c-a: the id of the scanned component that a plan component with no exact-fqn node already stands
 * for, or null. (a) Exact path: one of its links points at the scanned component's folder (not 'inside').
 * (b) Only for a component with zero links whose container (layers skipped) is a scanned container: localId(fqn) equals
 * c4Id(folder id) of a scanned component under that container (`_root` -> root_files). Each scanned
 * component stands for at most one plan component (standsFor).
 */
function scannedStandIn(
  el: PlanElement,
  scannedParentId: string | null,
  components: { id: string; path: string }[],
  taken: Set<string>,
  standsFor: Set<string>,
): string | null {
  const free = components.filter((c) => taken.has(c.id) && !standsFor.has(c.id));
  if (el.links.length > 0) {
    const folders = new Set(el.links.map(linkFolder));
    const hit = free.find((c) => normalisePath(c.path) !== '' && folders.has(normalisePath(c.path)));
    return hit ? hit.id : null;
  }
  if (scannedParentId === null) return null;
  const prefix = scannedParentId + '/';
  const hit = free.find((c) => c.id.startsWith(prefix) && c4Id(c.id.slice(prefix.length)) === localId(el.id));
  return hit ? hit.id : null;
}

/**
 * Folder mode: which plan components stand for a scanned component and which match nothing. A component
 * whose fqn is already in `taken` has an exact node and is in neither list. `scannedParentId(fqn)` gives the
 * scanned container id that a plan container fqn stands for (or null). Shared by the view model (which draws
 * the unmatched ones as plan-only nodes) and the check (which warns about them), so the two never disagree.
 * Returns `standIns` (scanned component id -> plan component) and `unmatched` (plan order).
 */
export function matchPlanComponents(
  plan: Plan,
  components: { id: string; path: string }[],
  taken: Set<string>,
  scannedParentId: (containerFqn: string | null) => string | null,
): { standIns: Map<string, PlanElement>; unmatched: PlanElement[] } {
  const standIns = new Map<string, PlanElement>();
  const unmatched: PlanElement[] = [];
  const standsFor = new Set<string>();
  for (const el of plan.elements) {
    if (el.kind !== 'component' || taken.has(el.id)) continue;
    const stand = scannedStandIn(el, scannedParentId(containerFqnOf(plan, el)), components, taken, standsFor);
    if (stand) {
      standsFor.add(stand);
      standIns.set(stand, el);
    } else unmatched.push(el);
  }
  return { standIns, unmatched };
}

/**
 * b837: true when the plan element is outside our system at C1: an actor (person, external: isMapActor) or a plan system
 * that is not ours. `ownSystem` = the fqn of the plan system our snapshot maps to; null = not known (none maps, or no view),
 * then no system is outside (the behaviour before b837). The one rule for "outside" on the plan side.
 */
export function isOutsideElement(el: PlanElement, ownSystem: string | null = null): boolean {
  return isMapActor(el.kind) || (ownSystem !== null && el.kind === 'system' && el.id !== ownSystem);
}

/**
 * b328 EXT-2a: the fqn of the actor (an `external`: KIND_TABLE container parents) that holds the plan container `fqn`,
 * else null. Such a container is someone else's: it never stands for a scanned container (no id or localId match) and
 * the map draws it inside its actor. Shared by the snapshot builder and the view model.
 * b837: with `ownSystem` (the view model), a plan system that is not ours holds its containers the same way
 * (isOutsideElement); null (the snapshot builder) keeps the actors only.
 */
export function actorHolding(plan: Plan, fqn: string | null, ownSystem: string | null = null): string | null {
  if (fqn === null) return null;
  const byId = planById(plan);
  const el = byId.get(fqn);
  const parent = el && el.kind === 'container' && el.parent !== null ? byId.get(el.parent) : undefined;
  return parent && isOutsideElement(parent, ownSystem) ? parent.id : null;
}

/** The scanned container id that a plan container fqn stands for: the same id, else the same localId (as claim mode). */
export function scannedContainerFor(fqn: string, scannedIds: Iterable<string>): string | null {
  const ids = [...scannedIds];
  return ids.find((id) => id === fqn) ?? ids.find((id) => id === localId(fqn)) ?? null;
}
