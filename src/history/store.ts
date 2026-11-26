import * as fs from 'fs';
import * as path from 'path';
import { Snapshot, HistoryEntry, Manifest } from '../types';
import { log } from '../log';
import { withFileLock } from '../util/fileLock';
import { writeAtomic } from '../util/fsAtomic';

/** How long a save waits for another process's manifest update (a save holds the lock for well under a second). */
const MANIFEST_LOCK_WAIT_MS = 60_000;

/**
 * Returns the history directory path for a given repo
 */
export function historyDir(storeRoot: string, repoId: string): string {
  return path.join(storeRoot, repoId, 'history');
}

/**
 * Generates an ID for a snapshot in the format: <compactDate>--<commit7|nogit>
 * Example: 2026-01-01T100000Z--aaaaaaa for a commit dated 2026-01-01T10:00:00Z
 */
export function entryId(s: Snapshot): string {
  // Get the time: git date if available, otherwise createdAt
  const time = s.meta.git?.date ?? s.meta.createdAt;

  // Convert to ISO string and format as compactDate
  // Replace .###Z with Z, then remove colons from time
  const isoString = new Date(time).toISOString();
  const withoutMillis = isoString.replace(/\.\d{3}Z$/, 'Z');
  const compactDate = withoutMillis.replace(/:/g, '');

  // Get commit prefix or 'nogit'
  const commitPrefix = s.meta.git?.commit ? s.meta.git.commit.slice(0, 7) : 'nogit';

  return `${compactDate}--${commitPrefix}`;
}

/**
 * Saves a snapshot to the history directory and updates the manifest.
 * The id choice, the snapshot file and the manifest read-modify-write run inside the lock `<histDir>/manifest.lock`
 * (withFileLock, waits up to 60 s, then LockBusyError), so two processes saving at once both keep their entries.
 * Both files are written with writeAtomic: a reader never sees a half-written file. A corrupt manifest is thrown
 * (loadManifest), never replaced.
 */
export function saveToHistory(storeRoot: string, s: Snapshot): HistoryEntry {
  const repoId = s.system.id;
  const histDir = historyDir(storeRoot, repoId);

  // Create directories recursively
  fs.mkdirSync(histDir, { recursive: true });

  return withFileLock(path.join(histDir, 'manifest.lock'), () => saveLocked(storeRoot, histDir, s), {
    waitMs: MANIFEST_LOCK_WAIT_MS,
  });
}

/** saveToHistory's work, run while holding the manifest lock. */
function saveLocked(storeRoot: string, histDir: string, s: Snapshot): HistoryEntry {
  const repoId = s.system.id;
  // Load existing manifest (empty when there is none yet; throws when it cannot be read)
  const manifest = loadManifest(storeRoot, repoId);

  // Generate entry. A commit snapshot replaces the entry of the same commit (upsert below). A snapshot
  // without git has no identity but its time, which is to the second: a second one in the same second is
  // a new state, so it gets the next free `-2`, `-3` suffix instead of overwriting the first.
  let id = entryId(s);
  if (!s.meta.git?.commit) {
    const taken = new Set(manifest.entries.map(e => e.id));
    const base = id;
    for (let n = 2; taken.has(id) || fs.existsSync(path.join(histDir, `${id}.json`)); n++) id = `${base}-${n}`;
  }
  const entry: HistoryEntry = {
    id,
    file: `${id}.json`,
    createdAt: s.meta.createdAt,
    commit: s.meta.git?.commit ?? null,
    commitDate: s.meta.git?.date ?? null,
    branch: s.meta.git?.branch ?? null,
    depth: s.meta.git?.depth ?? null,
    stats: s.stats,
  };

  // Write snapshot to file
  const snapshotPath = path.join(histDir, entry.file);
  writeAtomic(snapshotPath, JSON.stringify({ ...s, calls: undefined, imports: undefined }, null, 2));   // calls and imports stay in memory (Snapshot.calls, .imports)
  log('store', 'save', { id, path: snapshotPath });

  // Update manifest: upsert by id (replace if exists)
  const existingIndex = manifest.entries.findIndex(e => e.id === id);
  if (existingIndex >= 0) {
    manifest.entries[existingIndex] = entry;
  } else {
    manifest.entries.push(entry);
  }

  // Sort entries by depth, then time (commitDate ?? createdAt), then id
  // Entries with depth come before entries without depth
  manifest.entries.sort((a, b) => {
    // Entries with depth should come before entries without depth
    const hasDepthA = a.depth !== null && a.depth !== undefined;
    const hasDepthB = b.depth !== null && b.depth !== undefined;
    if (hasDepthA !== hasDepthB) {
      return hasDepthA ? -1 : 1;  // entries with depth come first
    }
    // If both have or both lack depth, sort by depth (or time if both lack depth)
    if (hasDepthA && hasDepthB) {
      if (a.depth !== b.depth) {
        return a.depth! - b.depth!;
      }
    }
    // Then by time
    const timeA = new Date(a.commitDate ?? a.createdAt).getTime();
    const timeB = new Date(b.commitDate ?? b.createdAt).getTime();
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    // Finally by id
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Ensure repoName is set from snapshot meta
  if (!manifest.repoName) {
    manifest.repoName = s.meta.repoName;
  }

  // Write manifest
  const manifestPath = path.join(histDir, 'manifest.json');
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  log('store', 'manifest', { entries: manifest.entries.length, path: manifestPath });

  return entry;
}

/**
 * Loads the manifest for a repo. No manifest file yet (ENOENT) = an empty manifest (no history stored).
 * Any other read error, bad JSON or a value without an `entries` list throws an Error naming the path and the reason:
 * a corrupt manifest is reported, never treated as empty (an empty one would be saved over the whole index).
 */
export function loadManifest(storeRoot: string, repoId: string): Manifest {
  const histDir = historyDir(storeRoot, repoId);
  const manifestPath = path.join(histDir, 'manifest.json');

  let data: string;
  try {
    data = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { repoId, repoName: '', entries: [] };
    throw new Error(`history manifest ${manifestPath} cannot be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new Error(`history manifest ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Manifest).entries)) {
    throw new Error(`history manifest ${manifestPath} has no entries list`);
  }
  return parsed as Manifest;
}

/**
 * Loads a snapshot from history
 */
export function loadFromHistory(storeRoot: string, repoId: string, e: HistoryEntry): Snapshot {
  const histDir = historyDir(storeRoot, repoId);
  const snapshotPath = path.join(histDir, e.file);

  const data = fs.readFileSync(snapshotPath, 'utf8');
  return JSON.parse(data) as Snapshot;
}

/**
 * Resolves a reference to a HistoryEntry
 * Supports:
 *   - 'latest': last entry
 *   - 'oldest': first entry
 *   - 'prev': second-to-last entry (error if < 2 entries)
 *   - exact id match
 *   - commit prefix (4-40 hex chars): must match exactly one entry
 *   - date in YYYY-MM-DD format: last entry on or before that day
 */
export function resolveRef(m: Manifest, ref: string): HistoryEntry {
  const { entries } = m;

  if (entries.length === 0) {
    throw new Error(`Unknown snapshot ref '${ref}'. Known: <none>`);
  }

  // Handle named refs
  if (ref === 'latest') {
    log('store', 'resolve', { ref, id: entries[entries.length - 1].id });
    return entries[entries.length - 1];
  }

  if (ref === 'oldest') {
    log('store', 'resolve', { ref, id: entries[0].id });
    return entries[0];
  }

  if (ref === 'prev') {
    if (entries.length < 2) {
      throw new Error(`Cannot resolve 'prev': only ${entries.length} snapshot(s) in history`);
    }
    log('store', 'resolve', { ref, id: entries[entries.length - 2].id });
    return entries[entries.length - 2];
  }

  // Try exact id match
  const exactMatch = entries.find(e => e.id === ref);
  if (exactMatch) {
    log('store', 'resolve', { ref, id: exactMatch.id });
    return exactMatch;
  }

  // Try commit prefix (4-40 hex chars)
  if (/^[0-9a-f]{4,40}$/.test(ref)) {
    const matches = entries.filter(e => e.commit && e.commit.startsWith(ref));
    if (matches.length === 0) {
      const ids = entries.map(e => e.id).join(', ');
      throw new Error(`Unknown snapshot ref '${ref}'. Known: ${ids}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous commit prefix '${ref}' matches ${matches.length} snapshots`);
    }
    log('store', 'resolve', { ref, id: matches[0].id });
    return matches[0];
  }

  // Try date (YYYY-MM-DD format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
    // Find the last entry whose commitDate/createdAt is <= that day at 23:59:59.999Z
    const targetDate = new Date(ref);
    targetDate.setUTCHours(23, 59, 59, 999);
    const targetTime = targetDate.getTime();

    let match: HistoryEntry | undefined;
    for (const e of entries) {
      const entryTime = new Date(e.commitDate ?? e.createdAt).getTime();
      if (entryTime <= targetTime) {
        match = e;
      } else {
        break;  // entries are sorted by time
      }
    }

    if (!match) {
      const ids = entries.map(e => e.id).join(', ');
      throw new Error(`Unknown snapshot ref '${ref}'. Known: ${ids}`);
    }
    log('store', 'resolve', { ref, id: match.id });
    return match;
  }

  // No match
  const ids = entries.map(e => e.id).join(', ');
  throw new Error(`Unknown snapshot ref '${ref}'. Known: ${ids}`);
}
