import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const legacyUsers = pgTable('users', { id: uuid('id').primaryKey(), email: text('email') });
export const legacyClasses = pgTable('classes', { id: uuid('id').primaryKey(), name: text('name') });
