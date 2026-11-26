import type { SchemaModel } from './types';

// P23-D3c (b275): the storage reader interface. One descriptor per reader (Drizzle, later SQL migrations,
// Prisma, Mongo, ...); readers.ts lists them in one place and derives every lookup, the way
// languages/define.ts + registry.ts do for languages. Named StorageReader because `Index` already
// exists in types.ts.

/** static = reads repo files only; live = connects to a running store (the gateway refuses it in v1). */
export type ReaderFamily = 'static' | 'live';

export interface ReaderLimits {
  /** Most files one read may be given; more is an error, never a silent cut. */
  maxFiles?: number;
  /** Most total bytes of the files one read may be given. */
  maxBytes?: number;
  /** Most record types one read may return. */
  maxRecords?: number;
}

export interface StorageReader {
  /** 'drizzle', 'sql-migrations', 'prisma', ... Unique in the list. */
  id: string;
  family: ReaderFamily;
  /** Store technology values it serves, lowercase: ['postgres']. */
  techs: string[];
  /** File extensions (with the dot, e.g. '.sql') this reader needs in repoFiles beyond source-code ones. The caller lists files by the union of these (readerExtensions in readers.ts). */
  extensions?: string[];
  /** Repo-relative candidate files out of repoFiles. Cheap: extension, name or text sniff, no parsing. */
  detect(repoRoot: string, repoFiles: string[]): string[];
  /** Files in, model out. Throws on an unreadable file (no error masking). */
  read(repoRoot: string, files: string[]): SchemaModel;
  limits?: ReaderLimits;
}

/** A store as the gateway sees it (plain data; the plan types are wired in later). */
export interface StoreDescription {
  /** Technology text, e.g. 'postgres' or 'PostgreSQL 16'; the first word that names a reader tech is used. */
  technology?: string;
  /** Reader id; wins over technology. */
  reader?: string;
  /** Repo-relative file or folder; restricts the files the reader looks at. */
  source?: string;
}

export interface StoreReadResult {
  /** Id of the reader chosen; null when none fits. */
  reader: string | null;
  /** null when no reader fits or it found no files. */
  model: SchemaModel | null;
  /** Why model is null. */
  reason?: string;
}
