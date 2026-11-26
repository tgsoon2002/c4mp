// Fixture: another dialect (sqlite).
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', { body: text('body') });
