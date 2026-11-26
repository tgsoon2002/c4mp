// Tables owned by the `students` module (C3 section 3.2).
import { numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  createdAt,
  halfStepRange,
  idColumn,
  legacyId,
  legacyIdUnique,
  maxLength,
  updatedAt,
} from '../columns.ts';
import { users } from './users.ts';

export const studentProfiles = pgTable(
  'student_profiles',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .unique('student_profiles_user_id_uniq')
      .references(() => users.id),
    schoolName: text('school_name'),
    note: text('note'),
    targetBand: numeric('target_band', { precision: 2, scale: 1, mode: 'number' }),
    goal: text('goal'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyId: legacyId(),
  },
  (t) => [
    maxLength('student_profiles_note_length_check', t.note, 1000),
    halfStepRange('student_profiles_target_band_check', t.targetBand, 4, 9),
    maxLength('student_profiles_goal_length_check', t.goal, 2000),
    legacyIdUnique('student_profiles', t.legacyId),
  ],
);
