// Tables owned by the `center` module (C3 section 3.5, D-42).
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  halfStepRange,
  idColumn,
  jsonb,
  legacyId,
  legacyIdUnique,
  oneOf,
  timestamptz,
  updatedAt,
} from '../columns.ts';
import { files } from './files.ts';
import { studentProfiles } from './students.ts';
import { users } from './users.ts';

export const CENTER_PAGE_KEYS = ['home', 'about', 'programs', 'contact', 'footer'] as const;
export const CONTENT_STATUSES = ['draft', 'published'] as const;

export const centerPages = pgTable(
  'center_pages',
  {
    key: text('key', { enum: CENTER_PAGE_KEYS }).primaryKey(),
    title: text('title').notNull(),
    // Shape checked by a Zod schema per key (C35).
    blocks: jsonb('blocks').notNull(),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    status: text('status', { enum: CONTENT_STATUSES }).notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    oneOf('center_pages_key_check', t.key, CENTER_PAGE_KEYS),
    oneOf('center_pages_status_check', t.status, CONTENT_STATUSES),
  ],
);

export const newsPosts = pgTable(
  'news_posts',
  {
    id: idColumn(),
    slug: text('slug').notNull().unique('news_posts_slug_uniq'),
    title: text('title').notNull(),
    category: text('category').notNull(),
    summary: text('summary'),
    // Sanitised on write in the API (P5-14, P6-16).
    contentHtml: text('content_html'),
    coverFileId: uuid('cover_file_id').references(() => files.id),
    coverAlt: text('cover_alt'),
    authorDisplay: text('author_display').default('Admin Acme'),
    status: text('status', { enum: CONTENT_STATUSES }).notNull(),
    isFeatured: boolean('is_featured').notNull().default(false),
    publishedAt: timestamptz('published_at'),
    readMinutes: integer('read_minutes'),
    searchText: text('search_text'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyId: legacyId(),
  },
  (t) => [
    oneOf('news_posts_status_check', t.status, CONTENT_STATUSES),
    check('news_posts_published_at_check', sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`),
    // nullsFirst() = Postgres' plain DESC, so `ORDER BY published_at DESC` can use the index.
    index('news_posts_status_published_at_idx').on(t.status, t.publishedAt.desc().nullsFirst()),
    legacyIdUnique('news_posts', t.legacyId),
  ],
);

// Fixture: trimmed copy (honors table removed).
