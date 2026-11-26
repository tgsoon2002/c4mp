// Fixture: another dialect. The reader lists the file as unsupported and does not crash.
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const accounts = mysqlTable('accounts', { name: varchar('name', { length: 50 }) });
