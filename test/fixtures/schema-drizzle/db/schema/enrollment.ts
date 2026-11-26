// Tables owned by the `enrollment` module (C3 section 3.3).
import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idColumn, legacyId, legacyIdUnique, oneOf, timestamptz } from '../columns.ts';
import { classes } from './classes.ts';
import { studentProfiles } from './students.ts';
import { users } from './users.ts';

export const ENROLLMENT_SOURCES = ['admin', 'teacher', 'join_code', 'import'] as const;

export const enrollments = pgTable(
  'enrollments',
  {
    id: idColumn(),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    studentProfileId: uuid('student_profile_id')
      .notNull()
      .references(() => studentProfiles.id),
    joinedAt: timestamptz('joined_at').notNull(),
    leftAt: timestamptz('left_at'),
    source: text('source', { enum: ENROLLMENT_SOURCES }).notNull(),
    addedBy: uuid('added_by').references(() => users.id),
    removedBy: uuid('removed_by').references(() => users.id),
    legacyId: legacyId(),
  },
  (t) => [
    oneOf('enrollments_source_check', t.source, ENROLLMENT_SOURCES),
    // One active row per student and class; rejoining adds a new row (C3 3.3).
    uniqueIndex('enrollments_active_uniq')
      .on(t.classId, t.studentProfileId)
      .where(sql`${t.leftAt} IS NULL`),
    index('enrollments_student_profile_id_idx').on(t.studentProfileId),
    legacyIdUnique('enrollments', t.legacyId),
  ],
);
