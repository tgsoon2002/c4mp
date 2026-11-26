// Tables owned by the `classes` module (C3 section 3.3).
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
import { users } from './users.ts';

export const CLASS_STATES = ['active', 'closed'] as const;

export const classes = pgTable(
  'classes',
  {
    id: idColumn(),
    code: text('code').notNull().unique('classes_code_uniq'),
    name: text('name').notNull(),
    description: text('description'),
    level: text('level'),
    format: text('format'),
    schoolName: text('school_name'),
    note: text('note'),
    state: text('state', { enum: CLASS_STATES }).notNull().default('active'),
    closedAt: timestamptz('closed_at'),
    deletedAt: timestamptz('deleted_at'),
    // C3 3.3 gives no FK for deleted_by and join_code_rotated_by; kept as plain uuid.
    deletedBy: uuid('deleted_by'),
    mainTeacherEmail: text('main_teacher_email').notNull(),
    mainTeacherId: uuid('main_teacher_id').references(() => users.id),
    joinCode: text('join_code'),
    joinCodeEnabled: boolean('join_code_enabled').notNull().default(true),
    joinCodeRotatedAt: timestamptz('join_code_rotated_at'),
    joinCodeRotatedBy: uuid('join_code_rotated_by'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyId: legacyId(),
  },
  (t) => [
    maxLength('classes_name_length_check', t.name, 100),
    maxLength('classes_description_length_check', t.description, 500),
    oneOf('classes_state_check', t.state, CLASS_STATES),
    uniqueIndex('classes_join_code_uniq')
      .on(t.joinCode)
      .where(sql`${t.joinCode} IS NOT NULL`),
    index('classes_main_teacher_id_idx').on(t.mainTeacherId),
    index('classes_main_teacher_email_idx').on(t.mainTeacherEmail),
    index('classes_state_idx').on(t.state),
    index('classes_deleted_at_idx').on(t.deletedAt),
    legacyIdUnique('classes', t.legacyId),
  ],
);

export const classSupportTeachers = pgTable(
  'class_support_teachers',
  {
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    userId: uuid('user_id').references(() => users.id),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    addedAt: timestamptz('added_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'class_support_teachers_pkey', columns: [t.classId, t.email] }),
    index('class_support_teachers_user_id_idx').on(t.userId),
  ],
);
