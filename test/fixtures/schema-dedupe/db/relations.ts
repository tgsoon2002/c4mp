import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

// Same table as core.ts, declared again for a join.
export const classesAgain = pgTable('classes', { id: uuid('id').primaryKey(), name: text('name').notNull() });
export const enrollments = pgTable('enrollments', { id: uuid('id').primaryKey(), classId: uuid('class_id').notNull() });
