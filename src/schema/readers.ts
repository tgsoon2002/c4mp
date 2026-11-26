import * as fs from 'fs';
import * as path from 'path';
import drizzleReader from './drizzleReader';
import sqlMigrationsReader from './sqlReader';
import type { StorageReader, StoreDescription, StoreReadResult } from './reader';
import { normalizeTech } from './storageTech';
import type { RecordType, SchemaModel } from './types';

// P23-D3c (b275): the one list of storage readers and the gateway that picks and runs one. A new reader =
// one descriptor in READERS below. v1 runs static readers only.

export interface ReaderRegistry {
  all: StorageReader[];
  byId: Record<string, StorageReader>;
  byTech: Record<string, StorageReader[]>;
}

/** Derive the registry from a reader list (pure: no other input). Throws on a repeated id. */
export function buildReaderRegistry(readers: StorageReader[]): ReaderRegistry {
  const registry: ReaderRegistry = { all: readers, byId: {}, byTech: {} };
  for (const r of readers) {
    if (registry.byId[r.id]) throw new Error(`reader ${r.id} listed twice`);
    registry.byId[r.id] = r;
    for (const t of r.techs) (registry.byTech[t] ??= []).push(r);
  }
  return registry;
}

export const READERS = buildReaderRegistry([drizzleReader, sqlMigrationsReader]);

/** Union of the extra file extensions the static readers ask for ('.sql', ...). Pass it, with the source extensions, to listSourceFiles. */
export function readerExtensions(registry: ReaderRegistry = READERS): string[] {
  return [...new Set(registry.all.flatMap((r) => (r.family === 'static' ? r.extensions ?? [] : [])))];
}

/** Candidate files of every static reader (for listing what a repo holds). */
export function detectAll(repoRoot: string, repoFiles: string[], registry: ReaderRegistry = READERS): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of registry.all) if (r.family === 'static') out[r.id] = r.detect(repoRoot, repoFiles);
  return out;
}

/** Concatenate models (records and unsupported files). */
export function mergeModels(models: SchemaModel[]): SchemaModel {
  return { records: models.flatMap((m) => m.records), unsupported: models.flatMap((m) => m.unsupported) };
}

/**
 * STOR-1 (b282): one record per (schema, name). A later find of the same record becomes an `alsoIn` location of
 * the first (its fields, indexes and checks are not merged); the first keeps its place in the order. Pure.
 */
export function dedupeRecords(records: RecordType[]): RecordType[] {
  const first = new Map<string, RecordType>();
  const out: RecordType[] = [];
  for (const rec of records) {
    const key = JSON.stringify([rec.schema ?? null, rec.name]);
    const kept = first.get(key);
    if (!kept) {
      first.set(key, rec);
      out.push(rec);
      continue;
    }
    const at = { file: rec.file, line: rec.line, endLine: rec.endLine };
    const known = [{ file: kept.file, line: kept.line, endLine: kept.endLine }, ...(kept.alsoIn ?? [])];
    if (known.some((k) => k.file === at.file && k.line === at.line)) continue;
    // Copy before the write: the reader's own object is not changed.
    const merged = { ...kept, alsoIn: [...(kept.alsoIn ?? []), at] };
    first.set(key, merged);
    out[out.indexOf(kept)] = merged;
  }
  return out;
}

const underSource = (file: string, source: string): boolean => {
  const s = source.replace(/\/+$/, '');
  return file === s || file.startsWith(s + '/');
};

/** What the gateway decides for a store before reading (resolveStoreReader). */
export type StoreResolution =
  | { kind: 'reader'; reader: StorageReader; /** Repo files under the store's source. */ files: string[]; /** detect() result when it was already run to pick; absent = not run yet. */ candidates?: string[] }
  | { kind: 'none'; reason: string }
  /** The store cannot be read as described; `readers` = the reader ids involved (all that matched when ambiguous). */
  | { kind: 'error'; reason: string; readers: string[] };

/**
 * Pick the reader for a store, once. No reader fits (or finds files) is kind 'none'; an unknown reader id, an
 * ambiguous technology (several readers find files and the store names no `reader`) and a live reader are kind
 * 'error', returned where they are detected, not thrown. Callers that want a throw use readStore.
 */
export function resolveStoreReader(repoRoot: string, repoFiles: string[], store: StoreDescription, registry: ReaderRegistry = READERS): StoreResolution {
  const files = store.source ? repoFiles.filter((f) => underSource(f, store.source as string)) : repoFiles;
  let reader: StorageReader | undefined;
  let candidates: string[] | undefined;
  if (store.reader) {
    reader = registry.byId[store.reader];
    if (!reader) return { kind: 'error', reason: `unknown reader '${store.reader}'; known readers: ${Object.keys(registry.byId).join(', ')}`, readers: [] };
  } else {
    // normalizeTech (src/schema/storageTech.ts) is the one place free technology text becomes a tech key.
    const word = normalizeTech(store.technology ?? '');
    const served = word ? registry.byTech[word] ?? [] : [];
    if (served.length === 0) return { kind: 'none', reason: `no reader for technology '${store.technology ?? ''}'` };
    if (served.length === 1) reader = served[0];
    else {
      const found = served.map((r) => ({ r, c: r.detect(repoRoot, files) })).filter((x) => x.c.length > 0);
      if (found.length > 1) {
        const ids = found.map((x) => x.r.id);
        return { kind: 'error', reason: `ambiguous: readers ${ids.join(', ')} all find files for '${word}'; set metadata reader`, readers: ids };
      }
      if (found.length === 0) return { kind: 'none', reason: `no reader finds files for technology '${word}'` };
      reader = found[0].r;
      candidates = found[0].c;
    }
  }
  if (reader.family === 'live') return { kind: 'error', reason: `reader '${reader.id}' is a live reader; only static readers run in this version`, readers: [reader.id] };
  return { kind: 'reader', reader, files, candidates };
}

/**
 * Read the files of a resolved reader and return the model. Errors: a limit exceeded and whatever the reader throws.
 * Finding no files is a result with model null.
 */
export function readResolved(repoRoot: string, repoFiles: string[], store: StoreDescription, resolved: Extract<StoreResolution, { kind: 'reader' }>): StoreReadResult {
  const { reader, files, candidates } = resolved;
  // An explicit source FILE is always read (the user named it); a folder or no source goes through detect().
  const namedFile = store.source !== undefined && repoFiles.includes(store.source) ? [store.source] : undefined;
  const toRead = namedFile ?? candidates ?? reader.detect(repoRoot, files);
  if (toRead.length === 0) return { reader: reader.id, model: null, reason: `reader '${reader.id}' found no files` };
  const lim = reader.limits;
  if (lim?.maxFiles !== undefined && toRead.length > lim.maxFiles) throw new Error(`reader '${reader.id}': ${toRead.length} files exceed maxFiles ${lim.maxFiles}`);
  if (lim?.maxBytes !== undefined) {
    const bytes = toRead.reduce((n, f) => n + fs.statSync(path.join(repoRoot, f)).size, 0);
    if (bytes > lim.maxBytes) throw new Error(`reader '${reader.id}': ${bytes} bytes exceed maxBytes ${lim.maxBytes}`);
  }
  const read = reader.read(repoRoot, toRead);
  const model = { ...read, records: dedupeRecords(read.records) };
  if (lim?.maxRecords !== undefined && model.records.length > lim.maxRecords) throw new Error(`reader '${reader.id}': ${model.records.length} records exceed maxRecords ${lim.maxRecords}`);
  return { reader: reader.id, model: { ...model, reader: reader.id } };
}

/**
 * Pick the reader for a store, read its files, return the model. No reader fits (or it finds no files) is a
 * result with model null, not an error. Errors: unknown reader id, ambiguous technology, a live reader,
 * a limit exceeded, and whatever the reader throws.
 */
export function readStore(repoRoot: string, repoFiles: string[], store: StoreDescription, registry: ReaderRegistry = READERS): StoreReadResult {
  const resolved = resolveStoreReader(repoRoot, repoFiles, store, registry);
  if (resolved.kind === 'error') throw new Error(resolved.reason);
  if (resolved.kind === 'none') return { reader: null, model: null, reason: resolved.reason };
  return readResolved(repoRoot, repoFiles, store, resolved);
}
