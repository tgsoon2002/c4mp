import * as fs from 'fs';
import { runSnapshot } from '../pipeline';
import { runHistory } from './historyRun';
import { historyDir, loadFromHistory, loadManifest, resolveRef, saveToHistory } from '../history/store';
import { compareSnapshots } from '../compare/index';
import { DEFAULT_CONFIG } from '../config';
import { toId } from '../names';
import { readRepoIdentity } from '../history/meta';
import { ensureInternalDirFor, pickScanConfig, requireProject, tryResolveProject } from '../outputs';
import { log } from '../log';
import { isObj } from '../util/obj';
import { openProject } from './project';
import type { C4pmConfig, FailOn, HistoryEntry, Snapshot, SnapshotDiff } from '../types';
import { CMD_NAME } from '../constants';

/** What takeSnapshot built and, with `save`, the history entry it stored. */
export interface TakenSnapshot {
  snapshot: Snapshot;
  saved: HistoryEntry | null;
}

/**
 * `c4pm snapshot`: scan the repo and write outline, imports, components and snapshot.json into `out`
 * (default: the project data dir; without `out` the anchor is required, init hint otherwise). With `save`, also
 * store the snapshot in the history store, resolved after the scan: so `out` + `save` with no anchor and no store
 * writes the files and then throws the store's init hint (today's behaviour, kept).
 * Prints the scan's progress lines; throws the anchor, config, scan or store error unchanged.
 */
export function takeSnapshot(
  repoRoot: string,
  cli: Partial<C4pmConfig> = {},
  opts: { out?: string; save?: boolean } = {},
): TakenSnapshot {
  // the anchor (required without --out) and .c4pm/.gitignore come before the config is read (openProject reads it
  // first), so a bad config file still leaves .c4pm/.gitignore written, as before
  const project = opts.out ? tryResolveProject(repoRoot) : requireProject(repoRoot);
  const defaultOut = opts.out ? undefined : project?.dataDir;
  log('project', 'takeSnapshot output', { out: opts.out, defaultOut });
  // first automatic write under .c4pm: make sure .c4pm/.gitignore exists (no-op outside .c4pm)
  if (project) ensureInternalDirFor(project, opts.out ?? defaultOut ?? '');
  const { config } = openProject(repoRoot, cli);
  const snapshot = runSnapshot({ repo: repoRoot, out: opts.out, defaultOut, config: pickScanConfig(config) });
  if (!opts.save) return { snapshot, saved: null };

  const { store } = openProject(repoRoot, cli, { store: 'required', create: true });
  log('project', 'takeSnapshot save store', { store });
  return { snapshot, saved: saveToHistory(store, snapshot) };
}

/**
 * `c4pm history`: snapshot the newest `max` commits (since `since`) into the history store (required, init hint
 * otherwise; .c4pm prepared first). Prints one line per commit; returns the new entries.
 */
export function recordHistory(
  repoRoot: string,
  cli: Partial<C4pmConfig> = {},
  opts: { max?: number; since?: string } = {},
): HistoryEntry[] {
  const { config, store } = openProject(repoRoot, cli, { store: 'required', create: true });
  log('project', 'recordHistory store', { store });
  return runHistory({ repo: repoRoot, store, max: opts.max, since: opts.since, config: pickScanConfig(config) });
}

/**
 * `c4pm snapshots`: the stored snapshots of the repo (oldest first) and the history folder they are in.
 * The store is opts.store when given (a caller that already opened the project and chose its store), else the
 * project's store, required (init hint otherwise). A missing manifest lists no entries; an unreadable or corrupt one
 * throws loadManifest's error (path and reason).
 */
export function listSnapshots(
  repoRoot: string,
  cli: Partial<C4pmConfig> = {},
  opts: { store?: string } = {},
): { entries: HistoryEntry[]; dir: string } {
  const store = opts.store ?? openProject(repoRoot, cli, { store: 'required' }).store;
  log('project', 'listSnapshots store', { store });
  const repoId = toId(readRepoIdentity(repoRoot).repoName);
  const { entries } = loadManifest(store, repoId);
  return { entries, dir: historyDir(store, repoId) };
}

/**
 * What `c4pm diff` compares: two snapshot.json files, or two stored snapshots of the repo by ref
 * (prev, latest, oldest, an id, a commit prefix or YYYY-MM-DD; see resolveRef).
 */
export type DiffSource = { files: { a: string; b: string } } | { refs: { from: string; to: string } };

/**
 * `c4pm diff`: compare two snapshots. The config (for failOn) is the repo's merged config when repoRoot is given,
 * else the defaults merged with `cli`. Stored refs need repoRoot and the history store (init hint otherwise).
 * Returns the diff and the merged failOn; throws the config, file, store or ref error unchanged.
 */
export function diffSnapshots(
  repoRoot: string | null,
  cli: Partial<C4pmConfig>,
  source: DiffSource,
): { diff: SnapshotDiff; failOn: FailOn } {
  if ('files' in source) {
    const config = repoRoot ? openProject(repoRoot, cli).config : { ...DEFAULT_CONFIG, ...cli };
    return { diff: compareSnapshots(readSnapshotFile(source.files.a), readSnapshotFile(source.files.b)), failOn: config.failOn };
  }
  if (!repoRoot) throw new Error('diffSnapshots: stored snapshots need a repo');
  const { config, store } = openProject(repoRoot, cli, { store: 'required' });
  log('project', 'diffSnapshots store', { store });
  const repoId = toId(readRepoIdentity(repoRoot).repoName);
  const [from, to] = storedSnapshots(store, repoId, [source.refs.from, source.refs.to]);
  return { diff: compareSnapshots(from.snapshot, to.snapshot), failOn: config.failOn };
}

/** The parts of a snapshot that the drift compare reads (src/compare/diff.ts), each an array. */
const SNAPSHOT_LISTS = ['containers', 'components', 'files', 'componentEdges', 'externals'];

/**
 * b710: a snapshot.json file given to `diff --a/--b`, read and shape-checked: a JSON object with a numeric schemaVersion,
 * a meta object, a stats object and the lists the compare reads. Anything else throws
 * `invalid: <file> is not a c4pm snapshot.json` (before: a raw TypeError deep in the compare). A missing file throws
 * the fs error unchanged.
 */
export function readSnapshotFile(file: string): Snapshot {
  const text = fs.readFileSync(file, 'utf8');
  const notSnapshot = (why: string): Error => new Error(`invalid: ${file} is not a ${CMD_NAME} snapshot.json (${why})`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw notSnapshot(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(data)) throw notSnapshot('not a JSON object');
  const obj = data;
  const missing = [
    ...(typeof obj.schemaVersion === 'number' ? [] : ['schemaVersion']),
    ...['meta', 'stats'].filter((k) => !isObj(obj[k])),
    ...SNAPSHOT_LISTS.filter((k) => !Array.isArray(obj[k])),
  ];
  if (missing.length > 0) throw notSnapshot(`missing or wrong: ${missing.join(', ')}`);
  return obj as unknown as Snapshot;
}

/** One stored snapshot: its history entry (id, commit, dates) and the snapshot itself. */
export interface StoredSnapshot {
  entry: HistoryEntry;
  snapshot: Snapshot;
}

/**
 * b507 (row G3): the one way to load stored snapshots of a repo by ref (prev, latest, oldest, an id, a commit prefix
 * or YYYY-MM-DD; see resolveRef), in the order of `refs`. The manifest is read once and every ref is resolved before
 * any snapshot file is read, so a bad ref is reported before a bad file. A missing store or manifest has no entries
 * (the unknown-ref error); an unreadable or corrupt manifest throws loadManifest's error. Throws the manifest, ref,
 * file or JSON error unchanged.
 */
export function storedSnapshots(store: string, repoId: string, refs: string[]): StoredSnapshot[] {
  const manifest = loadManifest(store, repoId);
  const entries = refs.map((ref) => resolveRef(manifest, ref));
  return entries.map((entry) => ({ entry, snapshot: loadFromHistory(store, repoId, entry) }));
}

/**
 * `c4pm view --from` (b507, row G3): what changed since the stored snapshot `ref` of the same repo (repo id from
 * `current`'s meta) in `store`, compared old -> current. Returns the stored entry (for the label) and the diff;
 * throws storedSnapshots' errors unchanged.
 */
export function driftFrom(store: string, ref: string, current: Snapshot): { entry: HistoryEntry; diff: SnapshotDiff } {
  const [{ entry, snapshot }] = storedSnapshots(store, toId(current.meta.repoName), [ref]);
  return { entry, diff: compareSnapshots(snapshot, current) };
}
