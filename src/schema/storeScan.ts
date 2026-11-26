import type { C4pmConfig, Plan, PlanElement } from '../types';
import { listSourceFiles } from '../importer/walk';
import { testFileMatcher } from '../importer/testMatch';
import { SOURCE_EXTENSIONS, languageIgnorePatterns } from '../languages/registry';
import { READERS, readStore, readerExtensions } from './readers';
import type { ReaderRegistry } from './readers';
import { readPlanStore } from './planStore';
import type { SchemaModel } from './types';

// b273 (D6): what the readers find in a repo (hits), what the plan's stores read (their models), and whether a
// plan store already covers a hit. Used by `plan unplanned --view storage` and `plan generate --view storage`.

/**
 * The repo files the readers look at: the scan's walk (config ignore + languages) plus the file types the readers read
 * (readerExtensions), without test files (config tests.globs): a test fixture is not the project's store.
 */
export function listStoreFiles(repoRoot: string, config: Pick<C4pmConfig, 'ignore' | 'languages' | 'tests'>): string[] {
  const isTest = testFileMatcher(config.tests);
  return listSourceFiles(repoRoot, { extensions: [...SOURCE_EXTENSIONS, ...readerExtensions()], ignore: config.ignore, languageIgnores: languageIgnorePatterns(config.languages) })
    .filter((f) => !isTest(f));
}

/** One reader's finding: the files that hold records, and the model. Never empty: a reader with no records is not a hit. */
export interface StoreHit {
  reader: string;
  /** Technology of the store to plan: the reader's first. */
  tech: string | undefined;
  /** Repo-relative files that hold at least one record, sorted. */
  files: string[];
  /** Common folder of the files, or the file itself when there is one; null = the repo root (no `source`). */
  source: string | null;
  model: SchemaModel;
}

/** Folder (no trailing slash) all files share; the file itself for one file; null when only the repo root is common. */
export function commonSource(files: string[]): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  const common: string[] = [];
  for (let i = 0; i < dirs[0].length; i++) {
    if (dirs.every((d) => d[i] === dirs[0][i])) common.push(dirs[0][i]);
    else break;
  }
  return common.length === 0 ? null : common.join('/');
}

/** No leading ./ and no trailing / (the form of a store's `source` key). */
export const normalizeSource = (s: string): string => s.replace(/^\.\//, '').replace(/\/+$/, '');

/** Every static reader that finds records in the repo. Reader errors (limits, unreadable file) are not caught. */
export function scanStoreHits(repoRoot: string, repoFiles: string[], registry: ReaderRegistry = READERS): StoreHit[] {
  const hits: StoreHit[] = [];
  for (const r of registry.all) {
    if (r.family !== 'static') continue;
    const read = readStore(repoRoot, repoFiles, { reader: r.id }, registry);
    if (!read.model || read.model.records.length === 0) continue;
    const files = [...new Set(read.model.records.map((rec) => rec.file))].sort();
    hits.push({ reader: r.id, tech: r.techs[0], files, source: commonSource(files), model: read.model });
  }
  return hits;
}

/** A plan store and what its reader finds. error = the reader failed (reported by the caller, not hidden). */
export interface PlanStoreRead {
  element: PlanElement;
  reader: string | null;
  model: SchemaModel | null;
  error?: string;
}

export function readPlanStores(plan: Plan, repoRoot: string, repoFiles: string[], registry?: ReaderRegistry): PlanStoreRead[] {
  return plan.elements.filter((e) => e.kind === 'store').map((element) => {
    try {
      const r = readPlanStore(repoRoot, repoFiles, element, registry);
      return { element, reader: r.reader, model: r.model };
    } catch (err) {
      return { element, reader: null, model: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Does this plan store already cover the hit: same reader, and its `source` (if any) holds every file of the hit. */
export function storeCovers(store: PlanStoreRead, hit: StoreHit): boolean {
  if (store.reader !== hit.reader) return false;
  const src = store.element.metadata.source;
  if (!src) return true;
  const s = normalizeSource(src);
  return hit.files.every((f) => f === s || f.startsWith(s + '/'));
}
