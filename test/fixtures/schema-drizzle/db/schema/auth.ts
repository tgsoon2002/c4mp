// Tables owned by the `auth` module (C3 section 3.1).
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, oneOf, timestamptz } from '../columns.ts';
import { users } from './users.ts';

export const LOGIN_PROVIDERS = ['google', 'microsoft', 'password'] as const;

export const loginIdentities = pgTable(
  'login_identities',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: LOGIN_PROVIDERS }).notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    createdAt: createdAt(),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (t) => [
    oneOf('login_identities_provider_check', t.provider, LOGIN_PROVIDERS),
    // A password hash is allowed only on a `password` row (C3 3.1).
    check('login_identities_password_hash_check', sql`${t.passwordHash} IS NULL OR ${t.provider} = 'password'`),
    uniqueIndex('login_identities_provider_subject_uniq').on(t.provider, t.subject),
    uniqueIndex('login_identities_user_id_provider_uniq').on(t.userId, t.provider),
  ],
);
