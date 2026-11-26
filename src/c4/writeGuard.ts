import * as fs from 'fs';
import * as path from 'path';
import { log } from '../log';
import { isInsideExportDir } from '../paths';
import type { ProjectPaths } from '../types';

/**
 * True when c4pm may write `absFile` without --force: the file sits inside the project's
 * `.c4pm` folder or inside `<anchor>/C4PM`. No project (no anchor) means false.
 */
export function isAutoWritable(project: ProjectPaths | null, absFile: string): boolean {
  if (!project) return false;
  const rel = path.relative(project.internalDir, path.resolve(absFile));
  const inInternal = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  const ok = inInternal || isInsideExportDir(project.anchor, absFile);
  log('writeGuard', 'isAutoWritable', { absFile, ok });
  return ok;
}

/** A wireframe file name is `<screen fqn>.html`: fqn segments [A-Za-z_][A-Za-z0-9_-]*, joined by dots (the lexer's ident). */
const WIREFRAME_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*\.html$/;

/** 'missing' when nothing is at `p`, else whether it is a symbolic link; null when it cannot be read. */
function linkState(p: string): 'missing' | 'link' | 'plain' | null {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'plain';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null;
  }
}

/**
 * True when a plan command may create, rewrite or remove `absFile` as a screen wireframe (plan move / rename, PS-7.6):
 * a direct child of `ioDir` (`<plan folder>/io`, not a symbolic link) named `<fqn>.html`, and not a symbolic link itself
 * (a missing file is fine: it is the new name). Says nothing about --force: the caller also applies isAutoWritable.
 * W9 (b305) `create` (plan wireframe): `ioDir` may be missing too; the caller makes it.
 */
export function isWireframeFile(ioDir: string, absFile: string, opts: { create?: boolean } = {}): boolean {
  const dir = path.resolve(ioDir);
  const file = path.resolve(absFile);
  const dirState = linkState(dir);
  const dirOk = dirState === 'plain' || (opts.create === true && dirState === 'missing');
  const state = path.dirname(file) === dir && WIREFRAME_NAME_RE.test(path.basename(file)) && dirOk
    ? linkState(file) : null;
  const ok = state === 'missing' || state === 'plain';
  log('writeGuard', 'isWireframeFile', { absFile, create: opts.create === true, ok });
  return ok;
}
