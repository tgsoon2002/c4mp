// Fixture: small constructs the Acme files do not use. Reads: later table referenced first, inline enum,
// plain timestamp, numeric(p) and numeric, a pg-core builder the reader does not read, object-form extras,
// an aliased import, a spread in the columns object.
import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgTable as table, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const orders = table(
  'orders',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    kind: text('kind', { enum: ['web', 'shop'] }).default('web'),
    at: timestamp('at').defaultNow(),
    qty: integer('qty').notNull().default(1),
    price: numeric('price', { precision: 10 }),
    ratio: numeric('ratio'),
    tag: varchar('tag', { length: 10 }),
    ...extraColumns,
  },
  (t) => ({
    byCustomer: index('orders_customer_idx').on(t.customerId),
    rawChecked: sql`ignored`,
  }),
);

export const customers = table('customers', { id: uuid('id').primaryKey() });
