// Tables owned by the `materials` module (C3 section 3.4).
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
import { classes } from './classes.ts';
import { files } from './files.ts';
import { users } from './users.ts';

export const MATERIAL_KINDS = ['file', 'link'] as const;
export const MATERIAL_VISIBILITIES = ['private', 'public'] as const;

export const materials = pgTable(
  'materials',
  {
    id: idColumn(),
    title: text('title').notNull(),
    kind: text('kind', { enum: MATERIAL_KINDS }).notNull(),
    url: text('url'),
    visibility: text('visibility', { enum: MATERIAL_VISIBILITIES }).notNull().default('private'),
    // NN when kind = 'file' is checked in the service (C3 3.4), not in the database.
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => materialVersions.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz('deleted_at'),
    legacyId: legacyId(),
  },
  (t) => [
    maxLength('materials_title_length_check', t.title, 200),
    oneOf('materials_kind_check', t.kind, MATERIAL_KINDS),
    check('materials_link_url_check', sql`${t.kind} <> 'link' OR ${t.url} IS NOT NULL`),
    oneOf('materials_visibility_check', t.visibility, MATERIAL_VISIBILITIES),
    legacyIdUnique('materials', t.legacyId),
  ],
);

export const materialVersions = pgTable(
  'material_versions',
  {
    id: idColumn(),
    materialId: uuid('material_id')
      .notNull()
      .references((): AnyPgColumn => materials.id),
    versionNo: integer('version_no').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('material_versions_version_no_check', sql`${t.versionNo} >= 1`),
    uniqueIndex('material_versions_material_id_version_no_uniq').on(t.materialId, t.versionNo),
  ],
);

export const classMaterials = pgTable(
  'class_materials',
  {
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    attachedBy: uuid('attached_by')
      .notNull()
      .references(() => users.id),
    attachedAt: timestamptz('attached_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'class_materials_pkey', columns: [t.classId, t.materialId] }),
    index('class_materials_material_id_idx').on(t.materialId),
  ],
);
