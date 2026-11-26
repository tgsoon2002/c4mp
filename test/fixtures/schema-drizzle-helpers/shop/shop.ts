import { pgTable, text, integer } from 'drizzle-orm/pg-core';
import { nanoid } from 'some-id-package';
import { ORDER_STATUSES } from './consts';
import { born, cents, deep1, lookup, oneIn, pk, positive, shorter, sku, stamp, threeHops, tsvector, twoHops } from './wrappers';

const label = (name: string) => text(name).notNull();
const audit = { by: text('by') };

export const orders = pgTable(
  'orders',
  {
    id: pk(),
    sku: sku(),
    title: label('title'),
    status: text('status').notNull(),
    total: cents('total_cents'),
    tax: cents('tax_cents', 7),
    placedAt: born(),
    shippedAt: stamp('shipped_at'),
    search: tsvector('search_doc'),
    token: nanoid(),
    deep: deep1(),
    spreadStamp: stamp(...['x']),
    ...audit,
    qty: integer('qty'),
  },
  (t) => [
    positive('orders_total_pos', t.total),
    shorter('orders_title_len', t.title, 80),
    oneIn('orders_status_ok', t.status, ORDER_STATUSES),
    lookup('orders', t.sku),
    twoHops('orders_qty_pos', t.qty),
    threeHops('orders_tax_pos', t.tax),
  ],
);
