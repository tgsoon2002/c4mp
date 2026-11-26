// STOR-2 (b334): one place that decides whether two SQL type texts mean the same type. A plan field says
// `type 'character varying(255)'`, SQL migrations say `varchar(255)`, Drizzle says `varchar`: the readers keep
// the type as written (Field.type), the comparison goes through here. Pure, no plan or reader types.

/** Alias (lowercase, single spaces) -> the one spelling used for comparing. */
const BASE_ALIASES: Record<string, string> = {
  'character varying': 'varchar', 'char varying': 'varchar',
  character: 'char', bpchar: 'char',
  int: 'integer', int4: 'integer',
  int2: 'smallint', int8: 'bigint',
  bool: 'boolean',
  decimal: 'numeric',
  float4: 'real', float8: 'double precision', double: 'double precision',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  'time with time zone': 'timetz', 'time without time zone': 'time',
};

export interface SqlType {
  /** Lowercase base name after aliasing: 'varchar', 'integer', 'timestamptz', 'double precision'. */
  base: string;
  /** Arguments without spaces: '255', '10,2'; null = none written. */
  params: string | null;
  /** The type is an array ('text[]'). */
  array: boolean;
}

/** Split a type text into its parts. Null for text that is not a type ('', or '?' = a helper builds the column and the reader could not tell). */
export function normalizeSqlType(text: string): SqlType | null {
  let rest = text.trim().toLowerCase();
  if (rest === '' || rest === '?') return null;
  const array = /(\[\s*\])+$/.test(rest);
  rest = rest.replace(/(\[\s*\])+$/, '');
  // Arguments may sit inside the name: 'timestamp(3) with time zone'.
  const open = rest.indexOf('(');
  const close = open < 0 ? -1 : rest.indexOf(')', open);
  let params: string | null = null;
  if (open >= 0 && close > open) {
    params = rest.slice(open + 1, close).replace(/\s+/g, '');
    rest = rest.slice(0, open) + ' ' + rest.slice(close + 1);
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  return { base: BASE_ALIASES[rest] ?? rest, params: params === '' ? null : params, array };
}

/**
 * Do two type texts mean the same type. Same base (aliases folded), same array flag, and the same arguments when both
 * write them: 'varchar' equals 'varchar(255)' (one side did not say the length) but not 'varchar(100)'. Text that is not a
 * type ('?') is never different, so it is never reported.
 */
export function sqlTypesEqual(a: string, b: string): boolean {
  const x = normalizeSqlType(a);
  const y = normalizeSqlType(b);
  if (!x || !y) return true;
  return x.base === y.base && x.array === y.array && (x.params === null || y.params === null || x.params === y.params);
}
