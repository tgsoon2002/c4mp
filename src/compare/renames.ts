import { Component } from '../types';
import { RENAME_MIN_SIMILARITY } from '../constants';
import { log } from '../log';

/**
 * Extract file paths from a component with the component's path prefix stripped.
 * Result is sorted.
 */
export function relativeFiles(c: Component): string[] {
  const prefix = c.path + '/';
  return c.files
    .map(f => f.startsWith(prefix) ? f.slice(prefix.length) : f)
    .sort();
}

/**
 * Compute Jaccard similarity between two arrays of strings.
 * Returns |a ∩ b| / |a ∪ b|, or 0 when both are empty.
 */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;

  // Compute intersection: count items in both
  const bSet = new Set(b);
  let intersection = 0;
  for (let i = 0; i < a.length; i++) {
    if (bSet.has(a[i])) intersection++;
  }

  // Compute union: combine and deduplicate
  const unionSet = new Set<string>();
  for (let i = 0; i < a.length; i++) {
    unionSet.add(a[i]);
  }
  for (let i = 0; i < b.length; i++) {
    unionSet.add(b[i]);
  }

  const unionSize = unionSet.size;
  if (unionSize === 0) return 0;
  return intersection / unionSize;
}

/**
 * Detect component renames by comparing removed and added components.
 * Scores based on relative file similarity; returns a map of old id → new id.
 */
export function detectRenames(
  removed: Component[],
  added: Component[]
): Record<string, string> {
  // Score all pairs
  const candidates: Array<{
    oldId: string;
    newId: string;
    score: number;
  }> = [];

  for (const r of removed) {
    const rFiles = relativeFiles(r);
    for (const a of added) {
      const aFiles = relativeFiles(a);
      const score = similarity(rFiles, aFiles);

      if (score >= RENAME_MIN_SIMILARITY) {
        candidates.push({ oldId: r.id, newId: a.id, score });
        log('renames', `pair score: ${r.id} → ${a.id}`, { score });
      }
    }
  }

  // Sort by score desc, then oldId, then newId
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.oldId !== b.oldId) return a.oldId < b.oldId ? -1 : 1;
    return a.newId < b.newId ? -1 : 1;
  });

  // Assign greedily: each id used at most once
  const result: Record<string, string> = {};
  const usedOldIds = new Set<string>();
  const usedNewIds = new Set<string>();

  for (const candidate of candidates) {
    if (!usedOldIds.has(candidate.oldId) && !usedNewIds.has(candidate.newId)) {
      result[candidate.oldId] = candidate.newId;
      usedOldIds.add(candidate.oldId);
      usedNewIds.add(candidate.newId);
      log('renames', `accepted: ${candidate.oldId} → ${candidate.newId}`, {});
    }
  }

  return result;
}
