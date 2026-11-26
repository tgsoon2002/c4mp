// Tables owned by the `files` module (C3 section 3.4).
import { bigint, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, oneOf, timestamptz } from '../columns.ts';
import { users } from './users.ts';

export const FILE_BUCKETS = ['public', 'private'] as const;
export const FILE_PURPOSES = ['material', 'content_image'] as const;
export const FILE_STATUSES = ['pending', 'ready'] as const;

export const files = pgTable(
  'files',
  {
    id: idColumn(),
    bucket: text('bucket', { enum: FILE_BUCKETS }).notNull(),
    key: text('key').notNull().unique('files_key_uniq'),
    purpose: text('purpose', { enum: FILE_PURPOSES }).notNull(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    status: text('status', { enum: FILE_STATUSES }).notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    readyAt: timestamptz('ready_at'),
  },
  (t) => [
    oneOf('files_bucket_check', t.bucket, FILE_BUCKETS),
    oneOf('files_purpose_check', t.purpose, FILE_PURPOSES),
    oneOf('files_status_check', t.status, FILE_STATUSES),
  ],
);
