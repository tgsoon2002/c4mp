import type { C4pmConfig, Plan, PlanElement } from '../types';
import { READERS, readResolved, resolveStoreReader } from '../schema/readers';
import type { ReaderRegistry } from '../schema/readers';
import { storeDescriptionOf } from '../schema/planStore';
import { matchRecords, recordsOfStore } from './matchRecords';
import type { RecordMatching } from './matchRecords';
import { fieldDiff } from './fieldDiff';
import type { FieldDiff } from './fieldDiff';
import { listStoreFiles, scanStoreHits } from '../schema/storeScan';
import type { StoreHit } from '../schema/storeScan';
import { fieldLocation } from '../schema/types';
import type { SchemaModel } from '../schema/types';

// STOR-2 (b334), S3 of the phase 23/24 plan: one walk over the plan's stores, the reader of each detected once, and the
// result the storage rules and the view share. A store that cannot be read is an entry with `error`, never a throw.

export type { FieldDiff, FieldDiffKind } from './fieldDiff';

/** One plan store and what its reader finds. */
export interface StoreState {
  element: PlanElement;
  /** Id of the reader used; null when none fits or none could be chosen. */
  reader: string | null;
  /** null when no reader fits, it found no files, or `error` is set. */
  model: SchemaModel | null;
  /** Why the store could not be read (unknown reader, ambiguous technology, live reader, a limit, a reader failure). Reported by the caller. */
  error?: string;
  /** STOR-3: why the store has no code files (no reader fits its technology, or the reader found none). Absent when read or `error`. */
  reason?: string;
  /** Reader ids involved in `error`: all that matched when the technology is ambiguous. Absent when no error. */
  candidates?: string[];
  /**
   * Repo-relative files that hold the store's records (including `alsoIn` locations) or their fields (fieldLocation: a
   * later SQL migration that only ALTERs a table counts, b614); sorted, unique. Empty without a model.
   */
  files: string[];
  /** The plan's records under the store against the model; null without a model. */
  matching: RecordMatching | null;
  /** Field differences of every matched record, in matching order. Empty without a model. */
  fieldDiffs: FieldDiff[];
}

/**
 * b611: the store was read without error and has no code (no reader fits, or the reader found no files). The one test for
 * "no code": checkStorage's missing-store and the storage view's planOnly store both use it. A store with `error` is not it.
 */
export const storeHasNoCode = (s: StoreState): boolean => s.error === undefined && s.model === null;

export interface StorageState {
  /** Plan stores, in plan order. */
  stores: StoreState[];
  /** What every static reader finds in the repo (for stores the plan lacks). [] when the scan failed (`hitsError`). */
  hits: StoreHit[];
  /** STOR-3 (S10): the message of a reader failure during the repo scan; reported as store-unreadable, never dropped. */
  hitsError?: string;
}

export interface StorageStateInput {
  repoRoot: string;
  /** Repo files, as listStoreFiles gives them. */
  files: string[];
  registry?: ReaderRegistry;
}

const filesOf = (model: SchemaModel): string[] =>
  [...new Set(model.records.flatMap((r) => [
    r.file,
    ...(r.alsoIn ?? []).map((l) => l.file),
    ...r.fields.map((f) => fieldLocation(r, f).file),
  ]))].sort();

/**
 * Walk the plan's stores once: pick each store's reader (resolveStoreReader, once), read it, match its records, diff their
 * fields. An unresolvable store (unknown reader id, ambiguous technology with no `reader` key, live reader) becomes an
 * entry with `error` at the place it is detected. A failure while reading (a limit exceeded, an unreadable file) is also
 * the store's `error`, with the reader's own message. A reader error on the repo scan is kept as `hitsError` (hits then []).
 */
export function buildStorageState(plan: Plan, input: StorageStateInput): StorageState {
  const { repoRoot, files, registry = READERS } = input;
  const stores = plan.elements.filter((e) => e.kind === 'store').map((element): StoreState => {
    const empty = { element, model: null, files: [], matching: null, fieldDiffs: [] };
    const desc = storeDescriptionOf(element);
    const resolved = resolveStoreReader(repoRoot, files, desc, registry);
    if (resolved.kind === 'none') return { ...empty, reader: null, reason: resolved.reason };
    if (resolved.kind === 'error') return { ...empty, reader: null, error: resolved.reason, candidates: resolved.readers };
    let read;
    try {
      read = readResolved(repoRoot, files, desc, resolved);
    } catch (err) {
      return { ...empty, reader: resolved.reader.id, error: err instanceof Error ? err.message : String(err), candidates: [resolved.reader.id] };
    }
    if (!read.model) return { ...empty, reader: read.reader, ...(read.reason !== undefined ? { reason: read.reason } : {}) };
    const model = read.model;
    const matching = matchRecords(recordsOfStore(plan, element), model);
    const fieldDiffs = matching.matched.flatMap((m) =>
      fieldDiff(m.code.name, plan.elements.filter((e) => e.kind === 'field' && e.parent === m.element.id), m.code.fields));
    return { element, reader: read.reader, model, files: filesOf(model), matching, fieldDiffs };
  });
  try {
    return { stores, hits: scanStoreHits(repoRoot, files, registry) };
  } catch (err) {
    return { stores, hits: [], hitsError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * STOR-3 (S4): the one storage read. The store files of the config (listStoreFiles: its ignore, languages and tests),
 * then buildStorageState. collectFindings (the rules, the page) and `plan unplanned --view storage` read through it.
 */
export function readStorage(
  plan: Plan,
  repoRoot: string,
  config: Pick<C4pmConfig, 'ignore' | 'languages' | 'tests'>,
  registry?: ReaderRegistry,
): StorageState {
  return buildStorageState(plan, { repoRoot, files: listStoreFiles(repoRoot, config), registry });
}
