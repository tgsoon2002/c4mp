import * as fs from 'fs';
import * as path from 'path';
import { Container } from '../types';
import { IGNORE_DIRS, MANIFESTS, FILE_ONLY_MANIFESTS, MANIFEST_SUFFIXES } from '../constants';
import { LANGUAGE_MANIFESTS, withLanguageIgnores } from '../languages/registry';
import { isAnchorExportDir } from '../paths';
import { log } from '../log';
import { createIgnoreMatcher } from '../ignoreMatch';
import { toId, toDisplayName } from '../names';

export interface FindContainersOptions {
  ignore?: string[];
  /** Also recognise composer.json, Gemfile and *.csproj (set when file-only listing is on). */
  extraManifests?: boolean;
  /** Selected language ids: their manifests (LANGUAGE_MANIFESTS) and default ignores count. */
  languages?: string[];
  /**
   * Phase 26 (T26-14b, D9): the role-test files among `files` (the scan's test set, pipeline `testFiles`). A manifest
   * folder whose files are all tests (a test project) is not a container, and test files alone never need the
   * '(loose files)' fallback container. Absent = no test files.
   */
  testFiles?: readonly string[];
}

// Manifests beyond MANIFESTS: file names and suffixes -> tech label.
interface ExtraManifests {
  files: Record<string, string>;
  suffixes: Record<string, string>;
}

// FILE_ONLY_MANIFESTS and MANIFEST_SUFFIXES when `fileOnly`, plus those of each selected language.
function extraManifestsFor(fileOnly: boolean, languages: string[] = []): ExtraManifests {
  const result: ExtraManifests = { files: {}, suffixes: {} };
  if (fileOnly) {
    Object.assign(result.files, FILE_ONLY_MANIFESTS);
    Object.assign(result.suffixes, MANIFEST_SUFFIXES);
  }
  for (const lang of languages) {
    Object.assign(result.files, LANGUAGE_MANIFESTS[lang]?.files);
    Object.assign(result.suffixes, LANGUAGE_MANIFESTS[lang]?.suffixes);
  }
  return result;
}

// Manifest file name of `dir`, or null. MANIFESTS first (key order); then `extra.files`, then the
// first sorted name ending in an `extra.suffixes` key.
// `names` = the directory's entry names when the caller already read them (saves a read).
function detectManifest(dir: string, extra: ExtraManifests, names?: string[]): string | null {
  for (const manifestFile of Object.keys(MANIFESTS)) {
    if (fs.existsSync(path.join(dir, manifestFile))) return manifestFile;
  }
  for (const manifestFile of Object.keys(extra.files)) {
    if (fs.existsSync(path.join(dir, manifestFile))) return manifestFile;
  }
  const suffixes = Object.keys(extra.suffixes);
  if (suffixes.length === 0) return null;
  let list = names;
  if (!list) {
    try {
      list = fs.readdirSync(dir);
    } catch {
      return null;
    }
  }
  return [...list].sort().find(n => suffixes.some(s => n.endsWith(s))) ?? null;
}

// Tech label for a manifest file name found by detectManifest.
function techForManifest(file: string, extra: ExtraManifests): string {
  if (MANIFESTS[file]) return MANIFESTS[file];
  if (extra.files[file]) return extra.files[file];
  const suffix = Object.keys(extra.suffixes).find(s => file.endsWith(s));
  return suffix ? extra.suffixes[suffix] : 'Unknown';
}

export function findContainers(repoRoot: string, files: string[], opts?: FindContainersOptions): Container[] {
  const ignoreMatcher = createIgnoreMatcher(withLanguageIgnores(opts?.ignore, opts?.languages));
  const extra = extraManifestsFor(opts?.extraManifests ?? false, opts?.languages);

  // Recursively find all directories with manifest files (excluding root)
  const dirsWithManifests = new Map<string, string>(); // dir -> manifest file

  function scanDir(dir: string, isRoot: boolean = false): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check for manifest files in this directory (but not root).
    // Root note: a root-level Gemfile / *.csproj therefore creates NO container in a repo that
    // has subfolder containers; it only gives the single root container its tech and manifest.
    if (!isRoot) {
      const manifestFile = detectManifest(dir, extra, entries.map(e => e.name));
      if (manifestFile) {
        const relDir = pathToRelative(repoRoot, dir);
        dirsWithManifests.set(dir, manifestFile);
        log('containers', 'manifest', { dir: relDir, manifest: manifestFile });
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      // Skip dot-directories
      if (entry.name.startsWith('.')) continue;
      // Skip symlinks
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);
        const relDir = pathToRelative(repoRoot, fullPath);
        const skipDir = IGNORE_DIRS.includes(entry.name) || isAnchorExportDir(fullPath);
        if (skipDir) {
          log('containers', 'skip dir', { dir: relDir });
          continue;
        }
        // Skip if directory matches an ignore pattern (prefix, path or glob)
        if (ignoreMatcher.matches(relDir)) {
          log('containers', 'skip dir', { dir: relDir, reason: 'ignore pattern' });
          continue;
        }

        // Recurse into subdirectory
        scanDir(fullPath, false);
      }
    }
  }

  scanDir(repoRoot, true);
  const tests = new Set(opts?.testFiles ?? []);
  dropTestOnlyManifests(repoRoot, dirsWithManifests, files, tests);

  // Check for manifest in root
  const rootManifest: string | null = detectManifest(repoRoot, extra);
  const rootTech: string = rootManifest ? techForManifest(rootManifest, extra) : 'Unknown';

  // If no subdirectory containers found, create a single root container
  if (dirsWithManifests.size === 0) {
    let rootName = path.basename(repoRoot);

    // Try to get name from root package.json
    if (rootManifest === 'package.json') {
      try {
        const pkgPath = path.join(repoRoot, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (typeof pkg.name === 'string') {
          rootName = pkg.name;
        }
      } catch {
        // Use basename
      }
    }

    const rootId = toId(rootName);
    let rootTechFinal = rootTech;

    // Check for tsconfig.json if manifest is package.json
    if (rootManifest === 'package.json' && fs.existsSync(path.join(repoRoot, 'tsconfig.json'))) {
      rootTechFinal = 'Node.js / TypeScript';
    }

    const result: Container = {
      id: rootId,
      name: toDisplayName(rootName),
      path: '.',
      tech: rootTechFinal,
      manifest: rootManifest,
    };
    log('containers', 'result', { id: result.id, path: result.path, tech: result.tech });
    return [result];
  }

  // Create containers from directories with manifests
  const containers: Container[] = [];

  for (const [dirPath, manifestFile] of dirsWithManifests) {
    const relDir = pathToRelative(repoRoot, dirPath);
    const basename = path.basename(dirPath);
    let id = toId(relDir);
    const name = toDisplayName(basename);
    let tech = techForManifest(manifestFile, extra);

    // Check for tsconfig.json if manifest is package.json
    if (manifestFile === 'package.json' && fs.existsSync(path.join(dirPath, 'tsconfig.json'))) {
      tech = 'Node.js / TypeScript';
    }

    containers.push({
      id,
      name,
      path: relDir,
      tech,
      manifest: manifestFile,
    });
  }

  // Check if some files aren't covered by any container (test files do not count: a fallback holding only tests
  // would be a test container)
  let needsFallback = false;

  for (const file of files) {
    if (tests.has(file)) continue;
    let covered = false;

    for (const container of containers) {
      const containerPath = container.path === '.' ? '' : container.path;
      if (containerPath === '' || file.startsWith(containerPath + '/')) {
        covered = true;
        break;
      }
    }

    if (!covered) {
      needsFallback = true;
      break;
    }
  }

  // Add fallback _root if needed
  if (needsFallback) {
    const fallbackName = `${toDisplayName(path.basename(repoRoot))} (loose files)`;
    containers.push({
      id: '_root',
      name: fallbackName,
      path: '.',
      tech: rootTech,
      manifest: rootManifest,
    });
    log('containers', 'fallback container', { id: '_root', name: fallbackName });
  }

  // Sort by id
  containers.sort((a, b) => a.id.localeCompare(b.id));

  for (const container of containers) {
    log('containers', 'result', { id: container.id, path: container.path, tech: container.tech });
  }

  return containers;
}

/**
 * Phase 26 (T26-14b, D9): removes from `dirsWithManifests` every manifest folder whose files are all tests: each file
 * belongs to the deepest manifest folder above it (as groupComponents assigns files), and a folder that gets at least
 * one test file and no other file is a test project (e.g. a C# test project, a gtest folder with its own CMakeLists).
 * Its files fall to the folder above. A manifest folder with no scanned file stays (nothing says it is a test).
 */
function dropTestOnlyManifests(repoRoot: string, dirsWithManifests: Map<string, string>, files: string[], tests: Set<string>): void {
  if (tests.size === 0) return;
  const relDirs = [...dirsWithManifests.keys()].map((abs) => ({ abs, prefix: pathToRelative(repoRoot, abs) + '/' }));
  const hasTest = new Set<string>();
  const hasSource = new Set<string>();
  for (const file of files) {
    let owner: { abs: string; prefix: string } | null = null;
    for (const d of relDirs) {
      if (file.startsWith(d.prefix) && (!owner || d.prefix.length > owner.prefix.length)) owner = d;
    }
    if (owner) (tests.has(file) ? hasTest : hasSource).add(owner.abs);
  }
  for (const abs of hasTest) {
    if (hasSource.has(abs)) continue;
    dirsWithManifests.delete(abs);
    log('containers', 'skip test-only manifest', { dir: pathToRelative(repoRoot, abs) });
  }
}

function pathToRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
