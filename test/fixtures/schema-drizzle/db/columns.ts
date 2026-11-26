// Column and constraint helpers shared by every schema file (C03a, C3 section 3 conventions).
// TypeScript keys are camelCase; every SQL name is written out in snake_case.
import { sql } from 'drizzle-orm';
import { check, customType, type PgColumn, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** UUID v7 primary key, made by the app (no DB default). */
export const idColumn = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());

/** timestamptz column; JS value is a Date. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** `created_at`: NN, default now(). */
export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/** `updated_at`: NN, default now() on insert, set by Drizzle on every update. */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * jsonb column for Drizzle over Bun's SQL driver (b103). Use this, never drizzle's own
 * `jsonb()` (src/db/jsonb.test.ts checks every jsonb column of the schema).
 *
 * Bun.sql encodes a value bound to a json/jsonb parameter as JSON itself. Drizzle's `jsonb()`
 * also calls JSON.stringify first (its postgres-js driver turns that driver encoding off;
 * the bun-sql driver has no such hook), so an object was stored as a JSON *string*
 * ("{\"a\":1}", jsonb_typeof = 'string'). Here the value goes to the driver as it is, and
 * comes back as Bun parsed it: no second JSON.parse that would turn a stored JSON string
 * such as "1" into a number.
 *
 * Top-level value: an object, an array, a string or null. Bun binds a bare number or boolean
 * as integer/boolean, which Postgres refuses for jsonb (an error, never a wrong row).
 * Needs prepared statements, Bun's default (`prepare: true`): unprepared, Bun cannot know the
 * parameter is jsonb and Postgres refuses the object (again an error, not a wrong row).
 */
export const jsonb = <TData = unknown>(name: string) =>
  customType<{ data: TData; driverData: TData }>({
    dataType: () => 'jsonb',
    toDriver: (value) => value,
    fromDriver: (value) => value,
  })(name);

/** `legacy_id` text NULL (D-08); pair it with legacyIdUnique(). */
export const legacyId = () => text('legacy_id');

/** Unique index on legacy_id where it is not null. */
export const legacyIdUnique = (table: string, column: PgColumn) =>
  uniqueIndex(`${table}_legacy_id_uniq`)
    .on(column)
    .where(sql`${column} IS NOT NULL`);

/** CHECK that a text column holds one of the given values (enum-like columns, C3 section 3). */
export const oneOf = (name: string, column: PgColumn, values: readonly string[]) =>
  check(name, sql`${column} IN (${sql.join(values.map((v) => sql.raw(`'${v.replaceAll("'", "''")}'`)), sql`, `)})`);

/** CHECK on the maximum length (characters) of a text column. NULL passes. */
export const maxLength = (name: string, column: PgColumn, max: number) =>
  check(name, sql`char_length(${column}) <= ${sql.raw(String(max))}`);

/** CHECK that a numeric column is within [min, max] and a multiple of 0.5. NULL passes. */
export const halfStepRange = (name: string, column: PgColumn, min: number, max: number) =>
  check(
    name,
    sql`${column} BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))} AND ${column} * 2 = trunc(${column} * 2)`,
  );
