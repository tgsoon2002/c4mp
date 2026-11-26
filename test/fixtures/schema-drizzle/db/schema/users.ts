// Tables owned by the `users` module (C3 section 3.1).
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, date, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  createdAt,
  idColumn,
  legacyId,
  legacyIdUnique,
  maxLength,
  oneOf,
  timestamptz,
  updatedAt,
} from '../columns.ts';

export const USER_ROLES = ['admin', 'teacher', 'student', 'parent'] as const;
export const USER_STATUSES = ['pending', 'active', 'locked'] as const;

export const users = pgTable(
  'users',
  {
    id: idColumn(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    phone: text('phone'),
    birthDate: date('birth_date'),
    address: text('address'),
    lastLoginAt: timestamptz('last_login_at'),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyId: legacyId(),
  },
  (t) => [
    oneOf('users_role_check', t.role, USER_ROLES),
    oneOf('users_status_check', t.status, USER_STATUSES),
    maxLength('users_name_length_check', t.name, 100),
    uniqueIndex('users_email_lower_uniq').on(sql`lower(${t.email})`),
    legacyIdUnique('users', t.legacyId),
  ],
);
