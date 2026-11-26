import * as path from 'path';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internal, unresolved } from '../resolveKit';

export function createPythonResolver(
  repoRoot: string,
  sourceFiles: string[]
): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('python', repoRoot, sourceFiles);

  return kit.resolver((fromFile: string, spec: string): ResolveResult => {
    // Determine if this is a relative import (starts with dots)
    const isRelative = spec.startsWith('.');

    if (isRelative) {
      // Count leading dots
      let dotCount = 0;
      for (const char of spec) {
        if (char === '.') {
          dotCount++;
        } else {
          break;
        }
      }

      // Get the module part (after the dots)
      const modulePart = spec.slice(dotCount);

      // Get the directory of the source file (use posix since paths are repo-relative with /)
      const fromFileDir = path.posix.dirname(fromFile);

      // Go up dotCount - 1 levels (one dot = current directory, two dots = parent, etc.)
      let baseDir = fromFileDir;
      for (let i = 1; i < dotCount; i++) {
        baseDir = path.dirname(baseDir);
      }

      // Build candidate paths
      const candidates: string[] = [];

      if (!modulePart) {
        // Bare relative import: 'from . import x' or 'from .. import x'
        // This resolves to baseDir/__init__.py
        candidates.push(path.posix.join(baseDir, '__init__.py'));
      } else {
        // Relative import with module name: 'from .m import x' or 'from ..m import x'
        // Replace dots with forward slashes for path building
        const modulePath = modulePart.replace(/\./g, '/');
        candidates.push(path.posix.join(baseDir, modulePath + '.py'));
        candidates.push(path.posix.join(baseDir, modulePath, '__init__.py'));
        // The last segment may be a name defined in its package rather than a module
        // ('from . import Name' gives '.Name'): fall back to that package's __init__.py.
        candidates.push(path.posix.join(path.posix.dirname(path.posix.join(baseDir, modulePath)), '__init__.py'));
      }

      // Check if any candidate is in sourceFiles
      const target = kit.firstExisting(candidates);
      if (target) return internal(target);

      // Relative import not found → unresolved
      return unresolved('relative module not found');
    } else {
      // Absolute import: walk up the directory tree from the file's location
      let currentDir = path.posix.dirname(fromFile);

      // Keep trying up the directory tree until we reach the repo root
      while (true) {
        // Try direct file
        const modulePath = spec.replace(/\./g, '/');
        const candidates = [
          path.posix.join(currentDir, modulePath + '.py'),
          path.posix.join(currentDir, modulePath, '__init__.py'),
        ];

        const target = kit.firstExisting(candidates);
        if (target) return internal(target);

        // Move up one directory (use posix)
        const parentDir = path.posix.dirname(currentDir);
        if (parentDir === currentDir) {
          // Reached the root
          break;
        }
        currentDir = parentDir;
      }

      // Absolute import not found → external, pkg = first segment
      return external(spec.split('.')[0]);
    }
  });
}
