import {
  BuildInput,
  Snapshot,
  SnapshotFile,
  ExternalUse,
  ImportRecord,
  Plan,
  PlanElement,
  Component,
  Container,
  Claim,
} from '../types';
import { log } from '../log';
import { toId, localId } from '../names';
import { actorHolding, containerFqnOf } from '../plan/standIn';
import { extractClaims, resolveOwnership, isClaimModePlan } from '../c4/ownership';
import { dominantOwnerPerFile, rollupEdges, edgesWithoutTestImporters } from '../grouper/rollup';

/**
 * Resolves a claim-mode component's containerId against the folder/manifest-scanned Container
 * list. PlanElement ids are fqn ('phofast.api'); Container.id is a bare, folder-derived id ('api').
 * These naming schemes only agree when the .c4 author happened to pick the same local identifier
 * as the folder name -- not guaranteed by the grammar. We try, in order: an exact id match (covers
 * a plan with no system/container nesting at all, where the component's parent IS already bare),
 * then a match on the parent fqn's last dot-segment (names.ts's `localId`, covers the common nested
 * case). If neither matches -- e.g. a plan-only repo whose containers don't exist on disk yet, or
 * zero files at all -- we fall back to the parent fqn itself as a synthetic containerId; T9's
 * view/model.ts uses the identical matching order so a component with a synthetic containerId still
 * gets a container node to render under (sourced purely from the plan).
 * b328 EXT-2a: a container held by an actor (`held`, plan/standIn.ts actorHolding) is never matched: its fqn is kept.
 */
function resolveContainerId(parentFqn: string | null, containers: Container[], held = false): string {
  if (held && parentFqn) return parentFqn;
  if (!parentFqn) {
    return containers[0]?.id ?? 'unassigned-container';
  }
  const lid = localId(parentFqn);
  const match = containers.find((c) => c.id === parentFqn || c.id === lid);
  return match ? match.id : parentFqn;
}

function buildClaimComponent(
  plan: Plan,
  el: PlanElement,
  claims: Claim[],
  fileOwnerMap: Record<string, string>,
  containers: Container[]
): Component {
  const files = Object.entries(fileOwnerMap)
    .filter(([, owner]) => owner === el.id)
    .map(([file]) => file)
    .sort();
  const elementClaims = claims.filter((c) => c.elementId === el.id);

  const meta: Component['meta'] = {};
  if (el.metadata.status) meta.status = el.metadata.status;
  if (el.metadata.owner) meta.owner = el.metadata.owner;
  if (el.metadata.sprint) meta.sprint = el.metadata.sprint;
  if (el.metadata.priority) meta.priority = el.metadata.priority;
  if (el.metadata.tags) meta.tags = el.metadata.tags;

  const containerFqn = containerFqnOf(plan, el);
  const component: Component = {
    id: el.id,
    name: el.title,
    containerId: resolveContainerId(containerFqn, containers, actorHolding(plan, containerFqn) !== null),
    path: elementClaims[0]?.path ?? '',
    files,
    mode: 'claim',
    claims: elementClaims,
    source: el.source.file,
    meta,
  };
  log('build', 'claim component', {
    id: component.id,
    containerId: component.containerId,
    files: files.length,
    claims: elementClaims.length,
  });
  return component;
}

export function buildSnapshot(input: BuildInput, plan?: Plan): Snapshot {
  const { meta, containers, outlines, imports, fileEdges } = input;
  const testFiles = new Set(input.testFiles ?? []);
  let components = input.components;
  let componentEdges = input.componentEdges;

  const claimMode = !!plan && isClaimModePlan(plan);
  let fileOwnerMap: Record<string, string>;

  if (claimMode && plan) {
    log('build', 'claim-mode plan detected', { elementCount: plan.elements.length });

    // Ownership needs file outlines + import edges, not a committed component assignment --
    // componentId is irrelevant to resolveOwnership (it only reads file/elements), so a placeholder
    // is enough to satisfy the SnapshotFile shape before the real per-file owner is known.
    // The role goes in too: ownership skips role-test files (Phase 26 T26-2).
    const prelimFiles: SnapshotFile[] = outlines.map((o) => ({ ...o, componentId: '', ...(testFiles.has(o.file) ? { role: 'test' as const } : {}) }));

    const claims = extractClaims(plan);
    const ownership = resolveOwnership(claims, prelimFiles, fileEdges);
    fileOwnerMap = dominantOwnerPerFile(ownership, prelimFiles);

    components = plan.elements
      .filter((el) => el.kind === 'component')
      .map((el) => buildClaimComponent(plan, el, claims, fileOwnerMap, containers));

    // The componentEdges passed in on `input` were rolled up against folder-mode component ids
    // (computed by the caller before buildSnapshot ever saw the plan) -- stale now that claim-mode
    // components exist under different ids. Re-roll using the claim-based per-file owner map so
    // edges reference real component ids again. rollupEdges is pure and already drops same-owner
    // edges, same as the folder-mode path.
    componentEdges = rollupEdges(edgesWithoutTestImporters(fileEdges, input.testFiles), fileOwnerMap);
  } else {
    fileOwnerMap = {};
    for (const component of components) {
      for (const file of component.files) {
        fileOwnerMap[file] = component.id;
      }
    }
    // Phase 26 (T26-14b, D9): folder mode makes no test-only component, so a test file outside every component gets
    // 'unassigned', as an unclaimed test file does in claim mode (dominantOwnerPerFile). A source file still must have one.
    for (const file of testFiles) {
      if (!fileOwnerMap[file]) fileOwnerMap[file] = 'unassigned';
    }
  }

  // Build system from metadata
  const system = { id: toId(meta.repoName), name: meta.repoName };

  // Process files: add componentId to each outline, and role 'test' to test files only (absent = source).
  // A test file keeps its claim owner as componentId (Phase 26 T26-1).
  const files: SnapshotFile[] = [];
  for (const outline of outlines) {
    const componentId = fileOwnerMap[outline.file];
    if (!componentId) {
      throw new Error(`File ${outline.file} is not in any component`);
    }
    files.push({
      ...outline,
      componentId,
      ...(testFiles.has(outline.file) ? { role: 'test' as const } : {}),
    });
    log('build', 'file', { file: outline.file, componentId, elements: outline.elements.length });
  }

  // Build externals from imports with status 'external'
  const externalMap: Record<string, Set<string>> = {};
  for (const fileImports of imports) {
    for (const importRecord of fileImports.imports) {
      if (importRecord.status === 'external' && importRecord.pkg) {
        if (!externalMap[importRecord.pkg]) {
          externalMap[importRecord.pkg] = new Set();
        }
        // Get the component id for the importing file
        const componentId = fileOwnerMap[fileImports.file];
        if (componentId) {
          externalMap[importRecord.pkg].add(componentId);
        }
      }
    }
  }

  // Convert external map to sorted array
  const externals: ExternalUse[] = Object.entries(externalMap)
    .map(([pkg, componentIds]) => ({
      pkg,
      usedBy: Array.from(componentIds).sort(),
    }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));

  for (const external of externals) {
    log('build', 'external', { pkg: external.pkg, usedBy: external.usedBy });
  }

  // Calculate stats
  const stats = {
    containers: containers.length,
    components: components.length,
    files: files.length,
    codeElements: files.reduce((sum, f) => sum + f.elements.length, 0),
    componentEdges: componentEdges.length,
    unresolvedImports: imports.reduce(
      (sum, fileImports) =>
        sum +
        fileImports.imports.filter((imp) => imp.status === 'unresolved').length,
      0
    ),
  };

  log('build', 'stats', stats);

  // Sort all arrays as per Snapshot interface
  const sortedContainers = [...containers].sort((a, b) => a.id.localeCompare(b.id));
  const sortedComponents = [...components]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({ ...c, files: [...c.files].sort() }));
  const sortedFiles = [...files].sort((a, b) => a.file.localeCompare(b.file));
  const sortedComponentEdges = [...componentEdges].sort((a, b) => {
    const fromCmp = a.from.localeCompare(b.from);
    return fromCmp !== 0 ? fromCmp : a.to.localeCompare(b.to);
  });
  const sortedFileEdges = [...fileEdges].sort((a, b) => {
    const fromCmp = a.from.localeCompare(b.from);
    return fromCmp !== 0 ? fromCmp : a.to.localeCompare(b.to);
  });

  const snapshot: Snapshot = {
    schemaVersion: 2,
    meta,
    system,
    containers: sortedContainers,
    components: sortedComponents,
    files: sortedFiles,
    componentEdges: sortedComponentEdges,
    fileEdges: sortedFileEdges,
    externals,
    stats,
  };

  return snapshot;
}
