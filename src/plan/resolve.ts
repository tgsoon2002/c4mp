import * as fs from 'fs';
import * as path from 'path';
import type { Plan, ResolvedLink, FileOutline, Snapshot } from '../types';
import { log } from '../log';
import { PYTHON_EXTENSIONS, PHP_EXTENSIONS } from '../languages/registry';
import { elementsNamed } from '../languages/treesitter';

const TAG = 'resolve-links';

// Extensions whose line comments start with `#` (beside `//` and `/* */`, which every outline language uses).
const HASH_COMMENT_EXTENSIONS = [...PYTHON_EXTENSIONS, ...PHP_EXTENSIONS];

/** Text of a source file with its comments removed. Only emptiness is read from it, so a string holding `//` is harmless. */
function stripComments(text: string, file: string): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.replace(/\/\/.*$/gm, '');
  return HASH_COMMENT_EXTENSIONS.includes(path.extname(file)) ? noLine.replace(/#.*$/gm, '') : noLine;
}

/** Text with the empty-module statements `export {}` (optional semicolon) and stray semicolons removed. Holds no code. */
function stripEmptyModule(text: string): string {
  return text.replace(/\bexport\s*\{\s*\}\s*;?/g, '').replace(/;/g, '');
}

/**
 * True when a scanned file holds code. An outline element always counts. A file-only file (no outline, e.g. .java)
 * counts when it is not blank. Any other file counts when it has text left after its comments, `export {};` and
 * stray semicolons are removed, so `export * from './x'` is code and `// todo`, `export {};` or an empty index.ts is not.
 */
export function fileHasCode(file: FileOutline, repoRoot: string): boolean {
  if (file.elements.length > 0) return true;
  const text = fs.readFileSync(path.join(repoRoot, file.file), 'utf8');
  const code = file.fileOnly ? text : stripEmptyModule(stripComments(text, file.file));
  return code.trim() !== '';
}

/**
 * True when a resolved link's target holds code: a file link needs its file to hold code; a folder link needs
 * at least one scanned file under it to hold code. Missing targets are false. Scanned files only (snapshot.files):
 * a file the scan does not list (e.g. a .md, or an ignored folder) is not code here.
 */
export function hasCode(link: ResolvedLink, snapshot: Snapshot, repoRoot: string): boolean {
  if (!link.exists) return false;
  if (link.target === 'folder') {
    const prefix = link.link.path.replace(/\/+$/, '');
    return snapshot.files.some(f => (prefix === '' || f.file.startsWith(prefix + '/')) && fileHasCode(f, repoRoot));
  }
  const file = snapshot.files.find(f => f.file === link.link.path);
  return file !== undefined && fileHasCode(file, repoRoot);
}

/**
 * Resolves all links in a plan against the repository and code outlines.
 * Returns one ResolvedLink per link, in plan element order then link order.
 */
export function resolveLinks(plan: Plan, repoRoot: string, outlines: FileOutline[]): ResolvedLink[] {
  log(TAG, 'resolveLinks', { elementCount: plan.elements.length, fileCount: outlines.length });

  const resolved: ResolvedLink[] = [];

  // Create a map from file path to outline for quick lookup
  const outlineMap = new Map<string, FileOutline>();
  for (const outline of outlines) {
    outlineMap.set(outline.file, outline);
  }

  // Process each element's links in order
  for (const element of plan.elements) {
    for (const link of element.links) {
      const fullPath = path.join(repoRoot, link.path);
      const exists = fs.existsSync(fullPath);

      log(TAG, 'resolve link', {
        elementId: element.id,
        raw: link.raw,
        path: link.path,
        exists,
        isDir: exists && fs.statSync(fullPath).isDirectory(),
      });

      // Determine target type and resolve
      let target: 'file' | 'folder' | 'function' | 'lines';
      let range: { start: number; end: number } | null = null;
      let found = false;

      if (!exists) {
        // Path doesn't exist; infer type from path format
        target = link.path.endsWith('/') ? 'folder' : 'file';
        found = false;
      } else if (fs.statSync(fullPath).isDirectory() || link.path.endsWith('/')) {
        // It's a folder. "Found" requires at least one scanned source file inside it: an empty folder,
        // one with only non-source files (docs, config), or one whose sources the scan ignores (config
        // ignore, language build folders) does not count as built. The outlines ARE the scan result, so
        // this follows the same ignore/languages/extensions rules without a second directory walk.
        target = 'folder';
        const prefix = link.path.replace(/\/+$/, '');
        const folderSourceFiles = outlines.filter(o => prefix === '' || o.file.startsWith(prefix + '/'));
        found = folderSourceFiles.length > 0;
        log(TAG, 'folder link source-file check', {
          path: link.path,
          sourceFileCount: folderSourceFiles.length,
          found,
        });
      } else if (link.lines) {
        // It's a line range link
        target = 'lines';
        range = link.lines;
        found = true;
      } else if (link.name) {
        // It's a function link; look it up in the outline
        target = 'function';
        const fileOutline = outlineMap.get(link.path);
        if (fileOutline) {
          // Find the element with exact name match
          // (b782: a nested function `outer.inner` counts too)
          const element = elementsNamed(fileOutline, link.name)[0];
          if (element) {
            range = { start: element.startLine, end: element.endLine };
            found = true;
            log(TAG, 'function found', { name: link.name, range });
          } else {
            found = false;
            log(TAG, 'function not found', { name: link.name, availableNames: fileOutline.elements.map(e => e.name) });
          }
        } else {
          found = false;
          log(TAG, 'no outline for file', { path: link.path });
        }
      } else {
        // It's a plain file link
        target = 'file';
        found = true;
      }

      resolved.push({
        elementId: element.id,
        link,
        exists,
        target,
        range,
        found,
      });
    }
  }

  log(TAG, 'resolved links', { count: resolved.length });
  return resolved;
}

/**
 * Maps each source file to the sorted list of element ids that claim it.
 * - Folder links claim all source files with that prefix
 * - Other links claim their path if it's in sourceFiles
 *
 * Folder-mode callers only (one owner guess per file, no specificity/conflict handling). Claim-mode
 * callers (P6-T8 onward) use `resolveOwnership` from `src/c4/ownership.ts` instead — it resolves
 * per-function ownership with folder/file/function specificity, conflicts, shared, and unassigned.
 */
export function claimedFiles(resolved: ResolvedLink[], sourceFiles: string[]): Map<string, string[]> {
  log(TAG, 'claimedFiles', { linkCount: resolved.length, sourceFileCount: sourceFiles.length });

  const claimMap = new Map<string, Set<string>>();

  // Build the set of source files for quick lookup
  const sourceFileSet = new Set(sourceFiles);

  for (const resolved_link of resolved) {
    const linkPath = resolved_link.link.path;
    if (resolved_link.target === 'folder' && linkPath.endsWith('/')) {
      // Folder link claims all source files with this prefix
      const prefix = linkPath;
      for (const sourceFile of sourceFiles) {
        if (sourceFile.startsWith(prefix)) {
          if (!claimMap.has(sourceFile)) {
            claimMap.set(sourceFile, new Set());
          }
          claimMap.get(sourceFile)!.add(resolved_link.elementId);
        }
      }
      log(TAG, 'folder link claims files', { path: prefix, count: Array.from(claimMap.values()).reduce((sum, set) => sum + set.size, 0) });
    } else if (sourceFileSet.has(linkPath)) {
      // Other links claim their path if it's a source file
      if (!claimMap.has(linkPath)) {
        claimMap.set(linkPath, new Set());
      }
      claimMap.get(linkPath)!.add(resolved_link.elementId);
      log(TAG, 'link claims file', { file: linkPath, elementId: resolved_link.elementId });
    }
  }

  // Convert sets to sorted arrays
  const result = new Map<string, string[]>();
  claimMap.forEach((ids: Set<string>, file: string) => {
    result.set(file, Array.from(ids).sort());
  });

  log(TAG, 'claimedFiles result', { claimedCount: result.size });
  return result;
}
