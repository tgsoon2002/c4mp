/**
 * b210: the metadata keys of the storage kinds (store > record > field) and the one-line formats of their values.
 * This is the only code that knows these formats; nothing is checked yet (unknown keys are kept, PS-4.4).
 * Field keys: type, pk ("true"), nullable ("true"/"false"), unique, default, values (comma list),
 * fk "<record>.<field>", onDelete. Record keys: pk "col1,col2", index.<name>, check.<name>.
 */
export const FIELD_META_KEYS = ['type', 'pk', 'nullable', 'unique', 'default', 'values', 'fk', 'onDelete'] as const;
/**
 * b275: store keys. reader = a reader id from READERS (src/schema/readers.ts); it wins over the store's technology.
 * source = repo-relative file or folder, no leading ./ . A named file is always read; a folder, or no source,
 * goes through the reader's detect(). Not validated yet.
 */
export const STORE_META_KEYS = ['reader', 'source'] as const;
export const RECORD_META_KEYS = ['pk'] as const;
export const INDEX_KEY_PREFIX = 'index.';
export const CHECK_KEY_PREFIX = 'check.';

export interface FkRef { record: string; field: string }
export interface IndexSpec { unique: boolean; columns: string[]; where: string | null }

const UNIQUE_PREFIX = 'unique ';
const WHERE = ' where ';

/** `customers.id` -> { record: 'customers', field: 'id' }; split on the LAST dot. Null when malformed. */
export function parseFk(text: string): FkRef | null {
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return null;
  return { record: text.slice(0, dot), field: text.slice(dot + 1) };
}

export const formatFk = (fk: FkRef): string => `${fk.record}.${fk.field}`;

/** `[unique ]col1,col2[ where <expr>]` -> parts. Null when there is no column. */
export function parseIndex(text: string): IndexSpec | null {
  let rest = text.trim();
  const unique = rest.startsWith(UNIQUE_PREFIX);
  if (unique) rest = rest.slice(UNIQUE_PREFIX.length);
  const w = rest.indexOf(WHERE);
  const where = w < 0 ? null : rest.slice(w + WHERE.length).trim();
  const cols = (w < 0 ? rest : rest.slice(0, w)).split(',').map(c => c.trim()).filter(c => c !== '');
  return cols.length === 0 ? null : { unique, columns: cols, where: where === '' ? null : where };
}

export const formatIndex = (ix: IndexSpec): string =>
  `${ix.unique ? UNIQUE_PREFIX : ''}${ix.columns.join(',')}${ix.where !== null ? `${WHERE}${ix.where}` : ''}`;

/** Record metadata key of a named index / check: `index.by_email`, `check.positive`. */
export const indexKey = (name: string): string => INDEX_KEY_PREFIX + name;
export const checkKey = (name: string): string => CHECK_KEY_PREFIX + name;
