// A shop project's own wrappers, named differently from any other project's.
import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uuid, customType } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';

export const pk = () => uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID());
export function sku() {
  return text('sku').notNull();
}
export const stamp = (name: string) => timestamp(name, { withTimezone: true });
export const born = () => stamp('born_at').notNull().defaultNow();
export const cents = (name: string, fallback = 0) => integer(name).notNull().default(fallback);
export const tsvector = (name: string) =>
  customType<{ data: string }>({ dataType: () => 'tsvector' })(name);

// three helper calls deep: shop.ts must leave these unresolved
export const deep1 = () => deep2();
export const deep2 = () => deep3();
export const deep3 = () => text('deep');

export const positive = (name: string, col: PgColumn) => check(name, sql`${col} > 0`);
export const shorter = (name: string, col: PgColumn, n: number) => check(name, sql`length(${col}) < ${n}`);
export const oneIn = (name: string, col: PgColumn, vals: readonly string[]) =>
  check(name, sql`${col} IN (${sql.join(vals.map((v) => sql.raw(`'${v.replaceAll("'", "''")}'`)), sql`, `)})`);
export const lookup = (table: string, col: PgColumn) => index(`${table}_lookup_idx`).on(col);
export const twoHops = (name: string, col: PgColumn) => positive(name, col);
export const threeHops = (name: string, col: PgColumn) => twoHops(name, col);
