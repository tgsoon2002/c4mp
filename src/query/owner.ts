import { claimMatches, ownerIdOf, SPECIFICITY } from '../c4/ownership';
import type { Claim, ClaimKind, SnapshotFile } from '../types';
import { QueryError } from './errors';
import { fileOf } from './context';
import type { PlanView, QueryContext } from './context';

/** Who owns a file or function: a component, the auto "shared" bucket, or nobody. */
export interface OwnerRef {
  id: string;
  title: string;
  kind: 'component' | 'shared' | 'unassigned';
}

/**
 * Why a function has its owner (P15-T1b). `claim.link` is the raw plan text (relative to `planFile`); `claim.path` the same
 * claim repo-relative (`src/a.ts`, `src/lib/`, `src/a.ts#fn`), as the show header prints it (b665).
 */
export interface OwnerExplanation {
  mode: 'folder-mode' | 'claim';
  claim?: { kind: ClaimKind; link: string; path: string; planFile: string; elementId: string };
  auto?: 'shared' | 'unassigned';
}

/**
 * Turn an owner id into an OwnerRef. The auto ids (`shared-auto`, `unassigned`) in both modes: folder mode gives a test file
 * outside every component 'unassigned' too (T26-14b, b705). Else claim mode: a PlanElement id; folder mode: a Component id.
 */
function refFor(ctx: PlanView & { snapshot?: QueryContext['snapshot'] }, id: string): OwnerRef {
  if (id === 'shared-auto') return { id, title: 'Shared', kind: 'shared' };
  if (id === 'unassigned') return { id, title: 'Unassigned', kind: 'unassigned' };
  if (ctx.claimMode) {
    const element = ctx.plan?.elements.find((e) => e.id === id);
    if (!element) throw new QueryError('not-found', `Owner '${id}' is not an element of the plan`);
    return { id, title: element.title, kind: 'component' };
  }
  const component = ctx.snapshot?.components.find((c) => c.id === id);
  if (!component) throw new QueryError('not-found', `Owner '${id}' is not a component of the snapshot`);
  return { id, title: component.name, kind: 'component' };
}

/**
 * Owner of `file` (no `name`) or of function `name` in `file`.
 * Claim mode + name: `Ownership.owner['file#name']`. Claim mode, no name: `Ownership.fileOwner[file]`,
 * else the file's `componentId` (its dominant owner). Folder mode: the file's `componentId`.
 * Unknown file, function or owner id throw QueryError('not-found').
 * Duplicate names in one file (Python property getter + setter) share one key, so both return the same owner.
 */
export function ownerOf(ctx: QueryContext, file: string, name?: string): OwnerRef {
  const snapshotFile = fileOf(ctx, file);
  if (!snapshotFile) throw new QueryError('not-found', `File '${file}' is not in the scan`);

  const id = ownerIdOf(ctx.claimMode ? ctx.ownership : null, snapshotFile, name === undefined ? undefined : ownedName(snapshotFile, name));
  if (id === undefined) throw new QueryError('not-found', `No function '${name}' in '${file}'`);
  return refFor(ctx, id);
}

/** b782: the name ownership knows for `name` in `file`: a nested function's outer element, else `name` itself. */
function ownedName(file: SnapshotFile, name: string): string {
  return file.nested?.find((n) => n.name === name)?.outer ?? name;
}

const UNASSIGNED: OwnerRef = { id: 'unassigned', title: 'Unassigned', kind: 'unassigned' };

/**
 * STOR-4 (b336): owner of any repo path, scanned or not. A scanned file: ownerOf (unchanged). A file the scan does not walk
 * (a .sql migration): the component whose folder or file claim (ctx.claims) matches the path, as resolveOwnership picks a
 * file's owner from path claims: the most specific claim wins, a tie goes to the element first in ctx.claims (plan order).
 * No claim (or folder mode, which has no claims): unassigned.
 */
export function ownerOfPath(ctx: QueryContext, file: string): OwnerRef {
  if (fileOf(ctx, file)) return ownerOf(ctx, file);
  return ownerByPathClaims(ctx, file);
}

/**
 * How function `name` in `file` got its owner. Folder mode: `{mode:'folder-mode'}`.
 * Claim mode: re-match `ctx.claims` (shared `claimMatches` + `SPECIFICITY`), group by elementId, highest
 * specificity wins, ties go to the element that appears first in `ctx.claims`. Shared/unassigned owners
 * return `{mode:'claim', auto}`.
 */
export function explainOwner(ctx: QueryContext, file: string, name: string): OwnerExplanation {
  const owner = ownerOf(ctx, file, name);
  const owned = ownedName(fileOf(ctx, file)!, name); // b782: ownerOf already threw when the file is missing
  if (!ctx.claimMode) return { mode: 'folder-mode' };
  if (owner.kind !== 'component') return { mode: 'claim', auto: owner.kind };

  // Best matching claim per element; Map keeps first-appearance order of elementId.
  const bestByElement = new Map<string, Claim>();
  for (const claim of ctx.claims) {
    if (!claimMatches(claim, file, owned)) continue;
    const best = bestByElement.get(claim.elementId);
    if (!best || SPECIFICITY[claim.kind] > SPECIFICITY[best.kind]) bestByElement.set(claim.elementId, claim);
  }
  let winner: Claim | undefined;
  for (const claim of bestByElement.values()) {
    if (!winner || SPECIFICITY[claim.kind] > SPECIFICITY[winner.kind]) winner = claim;
  }
  if (!winner || winner.elementId !== owner.id) {
    throw new QueryError(
      'invalid',
      `Claims give '${winner?.elementId ?? 'nothing'}' for ${file}#${name} but ownership says '${owner.id}'`,
    );
  }

  const element = ctx.plan?.elements.find((e) => e.id === winner.elementId);
  const link = element?.links[winner.claimIndex];
  if (!element || !link) {
    throw new QueryError('not-found', `Claim ${winner.claimIndex} of '${winner.elementId}' is not in the plan`);
  }
  const claimPath = winner.fn ? `${winner.path}#${winner.fn}` : winner.path;
  return {
    mode: 'claim',
    claim: { kind: winner.kind, link: link.raw, path: claimPath, planFile: element.source.file, elementId: winner.elementId },
  };
}

/**
 * b683: the owner of a file by the plan's folder and file claims alone (no scan): the most specific claim wins (plan
 * order on a tie), else unassigned. Folder mode has no claims, so unassigned.
 */
export function ownerByPathClaims(view: PlanView, file: string): OwnerRef {
  let winner: Claim | undefined;
  for (const claim of view.claims) {
    if (claim.kind === 'function' || !claimMatches(claim, file, '')) continue;
    if (!winner || SPECIFICITY[claim.kind] > SPECIFICITY[winner.kind]) winner = claim;
  }
  return winner ? refFor(view, winner.elementId) : UNASSIGNED;
}
