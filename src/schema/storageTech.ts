/**
 * b485: the storage technology keys and the one mapping from free technology text to a key. The reader gateway
 * (readers.ts) picks a reader by this key; the display words per key (src/storage/storageWords.ts) build on it.
 */
export const STORAGE_TECHS = ['postgres', 'mysql', 'sqlite', 'mongodb', 'json', 'yaml', 'csv', 'fs', 's3', 'redis'] as const;
export type StorageTech = typeof STORAGE_TECHS[number];

const TECH_KEYS: ReadonlySet<string> = new Set(STORAGE_TECHS);

/** Other spellings of a tech key (one word each: "Amazon S3" and "AWS S3" match on the word s3). */
const TECH_ALIASES: Record<string, StorageTech> = {
  postgresql: 'postgres', pg: 'postgres', psql: 'postgres',
  mongo: 'mongodb', sqlite3: 'sqlite', mariadb: 'mysql', yml: 'yaml',
};

/**
 * The ONLY place that maps free technology text to a tech key of STORAGE_TECHS: lowercase, split on non-alphanumerics,
 * take the first word that is a key or an alias. Null when no word matches. Pure, no plan types.
 */
export function normalizeTech(text: string): StorageTech | null {
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const key = Object.prototype.hasOwnProperty.call(TECH_ALIASES, w) ? TECH_ALIASES[w] : w;
    if (TECH_KEYS.has(key)) return key as StorageTech;
  }
  return null;
}
