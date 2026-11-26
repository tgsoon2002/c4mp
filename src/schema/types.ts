// P23-D3a (b267): the neutral schema model. A reader (Drizzle today; SQL migrations, Prisma later) turns
// source files into this shape; nothing here knows Drizzle. Plain data only (JSON-safe), so it can later
// go into a snapshot or a plan unchanged. Names: "record type" = table, "field" = column (K decides the
// words shown to users; these are the code names).

/**
 * A foreign key on one field. table / column are SQL names. (P23-D3c b275: the names stay table/column
 * flavoured; for a document store a reader puts the collection and field name here.)
 */
export interface FieldRef {
  table: string;
  column: string;
  onDelete: string | null;
}

export interface Field {
  /** SQL name, e.g. 'class_id'. */
  name: string;
  /** Property key in the source object, e.g. 'classId'. */
  key: string;
  /** Type as written: 'uuid', 'text', 'timestamptz', 'numeric(2,1)', ...; '?' when a helper builds the column. */
  type: string;
  /** The helper name when type is '?'. */
  unresolved?: string;
  nullable: boolean;
  pk: boolean;
  unique: boolean;
  default: string | null;
  /** Allowed values (a Drizzle { enum: [...] }); null = none declared. */
  values: string[] | null;
  fk: FieldRef | null;
  /** 1-based line of the field in its file (`file` when set, else the record's file). */
  line: number;
  /** b613: repo-relative file of the field when it is not the record's file (a later SQL migration adds or redefines the column). Absent = the record's file. Read it with fieldLocation. */
  file?: string;
  /** P23-D3c (b275): nested fields (a document or embedded object). Absent = flat. */
  children?: Field[];
  /** P23-D3c (b275): the field is an array of its type. Absent = single. */
  repeated?: boolean;
}

/** b613: where a field is written: its own file (Field.file) or else its record's file, and its line. The one place that answers it. */
export function fieldLocation(rec: Pick<RecordType, 'file'>, f: Pick<Field, 'file' | 'line'>): { file: string; line: number } {
  return { file: f.file ?? rec.file, line: f.line };
}

export interface Index {
  name: string;
  unique: boolean;
  /** SQL column names; an expression index keeps the expression text, e.g. 'lower(email)'. */
  columns: string[];
  /** Partial-index predicate (SQL text); null = none. */
  where: string | null;
}

export interface Check {
  name: string;
  /** SQL text of the condition; null when the source gives none we can read. */
  expr: string | null;
}

/** STOR-1 (b282): where a record is found in one more place than its main `file` / `line`. */
export interface RecordLocation {
  /** Repo-relative file. */
  file: string;
  /** 1-based first and last line of the declaration. */
  line: number;
  endLine: number;
}

export interface RecordType {
  /** SQL name (first string argument of pgTable). */
  name: string;
  /** TypeScript constant name that holds the table. */
  key: string;
  /** Repo-relative file. */
  file: string;
  /** 1-based first and last line of the declaration. */
  line: number;
  endLine: number;
  fields: Field[];
  /** Composite primary key (SQL names); its members also have pk = true. */
  primaryKey: string[];
  indexes: Index[];
  checks: Check[];
  /** P23-D3c (b275): what this record is. Absent = 'table'. */
  kind?: 'table' | 'collection' | 'file' | 'prefix' | 'keypattern';
  /** P23-D3c (b275): the name pattern for kind 'prefix' / 'keypattern' (e.g. 'session:*'). */
  pattern?: string;
  /** P23-D3c (b275): expiry rule as written, e.g. '24h'. */
  ttl?: string;
  /** b212 D3: SQL schema (namespace) when the source wrote one other than 'public' (e.g. 'billing'). Absent = default schema. */
  schema?: string;
  /** STOR-1 (b282): the same record (same schema + name) found again elsewhere; set by the gateway (dedupeRecords). The first find keeps file / line / fields. Absent = found once. */
  alsoIn?: RecordLocation[];
}

/** A file that defines a schema in a dialect this reader does not read yet. */
export interface UnsupportedFile {
  file: string;
  dialect: string;
  /** b212 D3: a reader that skips single statements (sql-migrations) gives the 1-based line, the statement head ('CREATE FUNCTION') and why. Absent = the whole file. */
  line?: number;
  statement?: string;
  reason?: string;
}

export interface SchemaModel {
  records: RecordType[];
  unsupported: UnsupportedFile[];
  /** P23-D3c (b275): id of the reader that produced it; set by the gateway (readStore). */
  reader?: string;
}
