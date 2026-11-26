import * as fs from 'fs';
import * as path from 'path';
import { log } from '../log';
import type { ResolveResult } from '../types';

// Plumbing shared by the language resolvers; each language keeps only its own rules (Python import
// forms, Rust module tree, PHP PSR-4, C++ include dirs).

/** An import found in the repo. */
export const internal = (target: string): ResolveResult => ({ status: 'internal', target });
/**
 * An import found in several repo files (C# `using N`: every file declaring N). Targets are sorted and
 * deduplicated; one target gives the same result as `internal`. Needs at least one target.
 */
export function internalAll(targets: string[]): ResolveResult {
  const sorted = [...new Set(targets)].sort();
  if (sorted.length === 0) throw new Error('internalAll needs a target');
  return sorted.length === 1 ? internal(sorted[0]) : { status: 'internal', target: sorted[0], targets: sorted };
}

/**
 * What the pipeline stores for one resolve result: `reason` dropped, and one result per target when
 * there are several (same shape as a single-target result, no `targets` field).
 */
export function storedResults({ reason: _reason, targets, ...result }: ResolveResult): ResolveResult[] {
  return targets && targets.length > 0 ? targets.map((target) => ({ ...result, target })) : [result];
}

/** An import of a package outside the repo. */
export const external = (pkg: string): ResolveResult => ({ status: 'external', pkg });
/** An import not found; `reason` says why (logs and reason counts only: the pipeline does not store it). */
export const unresolved = (reason: string): ResolveResult => ({ status: 'unresolved', reason });

/**
 * Reason for an import whose target is a file in the repo that the scan skipped (an ignored folder such
 * as build/ or vendor/, an ignore pattern, a dot-folder): still unresolved, only the reason differs.
 */
export const TARGET_IGNORED = 'target-ignored';

/**
 * True when `target` (repo-relative) is a file on disk inside the repo that is not one of `files`, i.e.
 * the scan skipped it. One stat; meant for imports that are already unresolved.
 */
export function isSkippedFile(repoRoot: string, files: Set<string>, target: string): boolean {
  const rel = path.posix.normalize(target);
  if (files.has(rel) || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return false;
  try {
    return fs.statSync(path.join(repoRoot, rel)).isFile();
  } catch {
    return false;
  }
}

export interface ResolverKit {
  repoRoot: string;
  /** The repo-relative files the resolver can point at. */
  files: Set<string>;
  /** Folder of a repo-relative file; '' for the repo root (not '.'). */
  dirOf(file: string): string;
  /**
   * The nearest folder, from the folder of `fromFile` up to the repo root, where `read` gives a value
   * for `fileName` (`read` gets the absolute file path and the repo-relative folder). Each folder is
   * read once per resolver and file name.
   */
  findUp<T>(fromFile: string, fileName: string, read: (file: string, dir: string) => T | null): T | null;
  /** The first candidate that is one of `files`. */
  firstExisting(candidates: string[]): string | undefined;
  /**
   * The resolver the pipeline calls: runs `resolve`, logs one '<lang>-resolve' line per import. An
   * unresolved result whose `firstExisting` candidates include a file the scan skipped gets the reason
   * TARGET_IGNORED (still unresolved).
   */
  resolver(resolve: (fromFile: string, spec: string) => ResolveResult): (fromFile: string, spec: string) => ResolveResult;
}

export function createResolverKit(lang: string, repoRoot: string, sourceFiles: string[]): ResolverKit {
  const files = new Set(sourceFiles);
  const found = new Map<string, unknown>();   // `${fileName}|${dir}` -> value or null
  let tried: string[] = [];                   // firstExisting candidates of the import being resolved
  const dirOf = (file: string): string => {
    const dir = path.posix.dirname(file);
    return dir === '.' ? '' : dir;
  };
  return {
    repoRoot,
    files,
    dirOf,
    findUp<T>(fromFile: string, fileName: string, read: (file: string, dir: string) => T | null): T | null {
      for (let dir = dirOf(fromFile); ; dir = dirOf(dir)) {
        const key = `${fileName}|${dir}`;
        if (!found.has(key)) found.set(key, read(path.join(repoRoot, dir, fileName), dir));
        const value = found.get(key) as T | null;
        if (value !== null) return value;
        if (dir === '') return null;
      }
    },
    firstExisting(candidates: string[]): string | undefined {
      tried.push(...candidates);
      return candidates.find((c) => files.has(c));
    },
    resolver(resolve) {
      return (fromFile, spec) => {
        tried = [];
        let result = resolve(fromFile, spec);
        if (result.status === 'unresolved' && tried.some((c) => isSkippedFile(repoRoot, files, c))) {
          result = unresolved(TARGET_IGNORED);
        }
        tried = [];
        log(`${lang}-resolve`, result.status, {
          from: fromFile, spec,
          ...(result.target && { target: result.target }),
          ...(result.targets && { targets: result.targets }),
          ...(result.pkg && { pkg: result.pkg }),
          ...(result.reason && { reason: result.reason }),
        });
        return result;
      };
    },
  };
}
