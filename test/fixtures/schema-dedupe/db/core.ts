// Dedupe fixture (STOR-1, b282): tables declared in more than one file, as found in a real repo.
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', { id: uuid('id').primaryKey(), email: text('email').notNull() });
export const classes = pgTable('classes', { id: uuid('id').primaryKey(), name: text('name').notNull() });
