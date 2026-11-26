import type { Snapshot, SnapshotDiff } from '../types';
import { diffSnapshots } from './diff';
import { classify } from './classify';

/**
 * Compare two snapshots: diff → classify → endpoints.
 * Returns a SnapshotDiff with endpoints from meta and classified changes.
 */
export function compareSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const { changes: rawChanges, summary } = diffSnapshots(a, b);

  // Classify raw changes (adds severity + rule)
  const changes = classify(rawChanges);

  // Build endpoints from metadata
  const from = {
    repoName: a.meta.repoName,
    createdAt: a.meta.createdAt,
    commit: a.meta.git?.commit ?? null,
    commitDate: a.meta.git?.date ?? null,
  };

  const to = {
    repoName: b.meta.repoName,
    createdAt: b.meta.createdAt,
    commit: b.meta.git?.commit ?? null,
    commitDate: b.meta.git?.date ?? null,
  };

  return {
    schemaVersion: 1,
    from,
    to,
    summary,
    changes,
  };
}

// Re-export diff for direct use if needed
export { diffSnapshots } from './diff';
export { detectRenames, relativeFiles, similarity } from './renames';
export { findCycles } from './cycles';
export { classify, sortChanges } from './classify';
export { formatText, formatMarkdown, describe, endpointLabel } from './report';
