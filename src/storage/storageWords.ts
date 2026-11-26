/**
 * b210: the everyday word for a store, a record and a field, by storage technology (postgres: database / table / column).
 * Text only (CLI labels now, the viewer later); the kinds stay store, record and field. Unknown technology falls back to
 * the kind names. The technology is the `technology` line of the nearest store.
 */
import { normalizeTech } from '../schema/storageTech';
import type { StorageTech } from '../schema/storageTech';

export type StorageKind = 'store' | 'record' | 'field';

/** The words per tech key; the keys and normalizeTech live with the readers (src/schema/storageTech.ts). */
export const STORAGE_WORDS: Record<StorageTech, Record<StorageKind, string>> = {
  postgres: { store: 'database', record: 'table', field: 'column' },
  mysql: { store: 'database', record: 'table', field: 'column' },
  sqlite: { store: 'database', record: 'table', field: 'column' },
  mongodb: { store: 'database', record: 'collection', field: 'field' },
  json: { store: 'file', record: 'record', field: 'key' },
  yaml: { store: 'file', record: 'record', field: 'key' },
  csv: { store: 'file', record: 'row', field: 'column' },
  fs: { store: 'folder', record: 'file', field: 'field' },
  s3: { store: 'bucket', record: 'object', field: 'field' },
  redis: { store: 'instance', record: 'key pattern', field: 'field' },
};

/** The tech key of a store's technology text (see normalizeTech), or null. */
export const storageTechOf = (technology: string | null | undefined): StorageTech | null => normalizeTech(technology ?? '');

/** The word for `kind` under `technology` (the store's technology text); the kind name itself for an unknown technology. */
export function storageWord(technology: string | null | undefined, kind: StorageKind): string {
  const tech = storageTechOf(technology);
  return tech === null ? kind : STORAGE_WORDS[tech][kind];
}
