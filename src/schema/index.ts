// P23-D3a (b267): schema readers. Nothing here is wired into a command, check, snapshot or viewer yet.
export type { SchemaModel, RecordType, Field, FieldRef, Index, Check, UnsupportedFile, RecordLocation } from './types';
export { fieldLocation } from './types';
export { readDrizzleSchema } from './drizzle';
// P23-D3c (b275): the reader gateway.
export type { StorageReader, ReaderFamily, ReaderLimits, StoreDescription, StoreReadResult } from './reader';
export { READERS, buildReaderRegistry, readStore, resolveStoreReader, readResolved, detectAll, mergeModels, dedupeRecords, readerExtensions } from './readers';
export type { ReaderRegistry, StoreResolution } from './readers';
// b275 part C: plan store element -> reader.
export { storeDescriptionOf, readPlanStore } from './planStore';
// b212 D3: reader #2.
export { applySqlFiles, readSqlSchema, sortMigrationFiles } from './sqlMigrations';
// STOR-2 (b334): the SQL type comparison. The storage state and field diffs are an engine: src/storage/ (b485).
export { normalizeSqlType, sqlTypesEqual } from './sqlTypes';
export type { SqlType } from './sqlTypes';
