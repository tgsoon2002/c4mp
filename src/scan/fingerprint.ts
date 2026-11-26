import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findPlanFiles } from '../plan/files';
import type { C4pmConfig } from '../types';
import { inputFilter, inputRootFiles } from '../watch';
import { projectInputRoots } from './inputs';
import { sourceFiles } from './sourceFiles';

/**
 * Staleness fingerprint of everything a scan result (the Query layer's QueryContext) or a page build is built from:
 * scanned source files, plan (.c4) files, and the other input folders of projectInputRoots (b679: plan folder with its
 * wireframes and site.css, board.json, s-items, config files). Only stat data (mtimeMs, size) is read, never file contents.
 * Cost note: the directory walk dominates on a cold tree (UNVERIFIED size).
 */

/** What isStale and withFingerprint read: the repo and config the result was built from, and its fingerprint. */
export interface Fingerprinted {
  repoRoot: string;
  config: C4pmConfig;
  fingerprint: string;
  /** STOR-4 (b336, A17): more file extensions the result reads (the storage readers' '.sql', ...), given by the caller. */
  extraExtensions?: string[];
}

function statLine(repoRoot: string, rel: string): string {
  try {
    const st = fs.statSync(path.resolve(repoRoot, rel));
    return `${rel}\t${st.mtimeMs}\t${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${rel}\tmissing`;
    throw err;
  }
}

/**
 * sha1 hex of `path\tmtimeMs\tsize` lines (a vanished file gives `path\tmissing`). `extraExtensions` (STOR-4, A17): files of
 * these extensions join the walk too (the caller names them; this component does not know the storage readers).
 */
export function computeFingerprint(repoRoot: string, config: C4pmConfig, extraExtensions: string[] = []): string {
  const root = path.resolve(repoRoot);
  // b679 (SV3): the one list of input folders; the first is the repo (sources and .c4, as before)
  const [repo, ...others] = projectInputRoots(root, config, extraExtensions);
  const sources = sourceFiles(root, config, repo.extensions.filter(e => e !== '.c4'));
  const plans = findPlanFiles(root, config).files;
  // plan folder (.c4, wireframes, site.css), board, s-items and the two config files
  const filter = inputFilter(root, config);
  const inputs = others.flatMap(r => inputRootFiles(r, filter)).map(f => path.relative(root, f).split(path.sep).join('/'));

  const lines = [...new Set([...sources, ...plans, ...inputs])].map(rel => statLine(root, rel));
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** True when the tree changed since ctx was built. */
export function isStale(ctx: Fingerprinted): boolean {
  return computeFingerprint(ctx.repoRoot, ctx.config, ctx.extraExtensions) !== ctx.fingerprint;
}

/** ctx with its `fingerprint` filled (loadQueryContext leaves it ''). */
export function withFingerprint<T extends Fingerprinted>(ctx: T): T {
  return { ...ctx, fingerprint: computeFingerprint(ctx.repoRoot, ctx.config, ctx.extraExtensions) };
}
