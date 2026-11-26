import { ComponentEdge, FileEdge, Ownership, SnapshotFile } from '../types';
import { log } from '../log';

export function rollupEdges(
  fileEdges: FileEdge[],
  fileToComponent: Record<string, string>
): ComponentEdge[] {
  // Map to aggregate weights: "${from}->${to}" -> weight
  const edgeMap = new Map<string, { from: string; to: string; weight: number }>();

  for (const edge of fileEdges) {
    const fromComponent = fileToComponent[edge.from];
    const toComponent = fileToComponent[edge.to];

    // Log each edge processed
    log('rollup', 'edge', { from: edge.from, to: edge.to, fromC: fromComponent, toC: toComponent });

    // Skip if either end is unmapped
    if (!fromComponent || !toComponent) {
      log('rollup', 'skip', { reason: 'unmapped', from: edge.from, to: edge.to });
      continue;
    }

    // Skip if both ends are in the same component
    if (fromComponent === toComponent) {
      log('rollup', 'skip', { reason: 'self', from: edge.from, to: edge.to });
      continue;
    }

    // Create or update component edge
    const key = `${fromComponent}->${toComponent}`;
    if (edgeMap.has(key)) {
      const existing = edgeMap.get(key)!;
      existing.weight += 1;
    } else {
      edgeMap.set(key, {
        from: fromComponent,
        to: toComponent,
        weight: 1,
      });
    }
  }

  // Convert map to array
  const result = Array.from(edgeMap.values());

  // Sort by from, then to
  result.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from.localeCompare(b.from);
    }
    return a.to.localeCompare(b.to);
  });

  log('rollup', 'result', { count: result.length });

  return result;
}

/**
 * Phase 26 (T26-3, D8): the input for `rollupEdges` -- a copy of `fileEdges` without the edges whose importer is a
 * test file, so tests give no component arrows. The caller's `fileEdges` (snapshot.fileEdges) keeps them.
 */
export function edgesWithoutTestImporters(fileEdges: FileEdge[], testFiles: readonly string[] | undefined): FileEdge[] {
  const tests = new Set(testFiles ?? []);
  return fileEdges.filter((e) => !tests.has(e.from));
}

// For each file, count owners (by function/element) among its elements and pick the most common
// owner id to represent that file for edge-rollup purposes. Ties are broken by lower elementId
// string (standard string comparison) for determinism. A file with zero elements maps to
// `ownership.fileOwner[file]` when present, else 'unassigned'. A file where all
// elements are 'unassigned' maps to 'unassigned'. A file entirely owned by 'shared-auto' maps to
// 'shared-auto'. `rollupEdges` itself is unchanged; callers in claim mode build their
// `fileToComponent` map by calling this first, then pass the result in exactly as before.
export function dominantOwnerPerFile(
  ownership: Ownership,
  files: SnapshotFile[]
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const file of files) {
    const counts = new Map<string, number>();

    for (const element of file.elements) {
      const key = `${file.file}#${element.name}`;
      const owner = ownership.owner[key] ?? 'unassigned';
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }

    let dominant = 'unassigned';
    if (counts.size > 0) {
      let bestCount = -1;
      for (const [ownerId, count] of counts) {
        if (count > bestCount || (count === bestCount && ownerId < dominant)) {
          bestCount = count;
          dominant = ownerId;
        }
      }
    } else {
      dominant = ownership.fileOwner?.[file.file] ?? 'unassigned';
    }

    log('rollup', 'dominant-owner', { file: file.file, owner: dominant });
    result[file.file] = dominant;
  }

  return result;
}
