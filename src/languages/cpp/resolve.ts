import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../log';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internal, unresolved } from '../resolveKit';
import type { ResolverKit } from '../resolveKit';

// Used when there is no compile_commands.json (or it lists no usable -I): the usual include roots.
const DEFAULT_INCLUDE_DIRS = ['', 'src', 'include'];
const INCLUDE_FLAGS = ['-I', '-isystem', '-iquote', '-idirafter'];

/** Split a compile command line on spaces, keeping "quoted parts" together. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Include directories (repo-relative, '' = repo root) named by include flags in compile_commands.json; null when no readable file exists. */
export function readCompileCommandsIncludeDirs(repoRoot: string): string[] | null {
  for (const rel of ['compile_commands.json', 'build/compile_commands.json']) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) continue;
    let entries: any;
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      log('cpp-resolve', 'compile-commands-unreadable', { file: rel, error: String(err) });
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const dirs: string[] = [];
    for (const entry of entries) {
      const args: string[] = Array.isArray(entry?.arguments)
        ? entry.arguments.map(String)
        : typeof entry?.command === 'string' ? splitCommand(entry.command) : [];
      const baseDir = typeof entry?.directory === 'string' ? entry.directory : repoRoot;
      for (let i = 0; i < args.length; i++) {
        // "-I dir", "-Idir", "-isystem dir" (the separate-argument form for the others)
        const flag = INCLUDE_FLAGS.find((f) => args[i] === f || (f === '-I' && args[i].startsWith('-I')));
        if (!flag) continue;
        const value = args[i] === flag ? args[++i] : args[i].slice(flag.length);
        if (!value) continue;
        const abs = path.resolve(baseDir, value);
        const relDir = path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
        if (relDir.startsWith('..') || path.isAbsolute(relDir)) continue; // outside the repo: system or third-party
        if (!dirs.includes(relDir)) dirs.push(relDir);
      }
    }
    log('cpp-resolve', 'compile-commands', { file: rel, dirs: dirs.length });
    return dirs;
  }
  return null;
}

const CMAKE_FILE = 'CMakeLists.txt';
// Words of target_include_directories / include_directories that are not folders.
const CMAKE_KEYWORDS = new Set(['SYSTEM', 'BEFORE', 'AFTER', 'PUBLIC', 'PRIVATE', 'INTERFACE']);

/**
 * Include directories (repo-relative, '' = repo root) of the `include_directories(...)` and
 * `target_include_directories(<target> ...)` calls in one CMakeLists.txt whose folder is `cmakeDir`.
 * Only literal folders count, relative to that folder: `.`, `gen`, `"a dir"`, `${CMAKE_CURRENT_SOURCE_DIR}/x`
 * (also `${CMAKE_CURRENT_LIST_DIR}`) and `$<BUILD_INTERFACE:x>`. Any other variable or generator expression,
 * absolute paths and folders outside the repo are skipped. Comments are ignored; no CMake is evaluated
 * (an if() branch counts like any other line).
 */
export function cmakeIncludeDirs(text: string, cmakeDir: string): string[] {
  const code = text.replace(/"(?:[^"\\]|\\.)*"|#\[(=*)\[[\s\S]*?\]\1\]|#[^\n]*/g, (m) => (m.startsWith('"') ? m : ''));
  const dirs: string[] = [];
  const call = /\b(target_)?include_directories\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = call.exec(code))) {
    const args = [...m[2].matchAll(/"([^"]*)"|([^\s"]+)/g)].map((a) => a[1] ?? a[2]);
    for (let arg of m[1] ? args.slice(1) : args) {
      if (CMAKE_KEYWORDS.has(arg)) continue;
      arg = arg.replace(/^\$<BUILD_INTERFACE:(.*)>$/, '$1').replace(/\$\{CMAKE_CURRENT_(?:SOURCE|LIST)_DIR\}/g, '.');
      if (arg.includes('$') || path.posix.isAbsolute(arg)) continue;
      const dir = path.posix.normalize(path.posix.join(cmakeDir || '.', arg));
      if (dir === '..' || dir.startsWith('../')) continue;
      const rel = dir === '.' ? '' : dir;
      if (!dirs.includes(rel)) dirs.push(rel);
    }
  }
  return dirs;
}

/**
 * Include directories of every CMakeLists.txt in the folders of the source files and the folders above
 * them, in folder order.
 */
function readCMakeIncludeDirs(kit: ResolverKit): string[] {
  const folders = new Set<string>();
  for (const file of kit.files) {
    for (let dir = kit.dirOf(file); !folders.has(dir); dir = kit.dirOf(dir)) {
      folders.add(dir);
      if (dir === '') break;
    }
  }
  const dirs: string[] = [];
  let cmakeFiles = 0;
  for (const folder of [...folders].sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(kit.repoRoot, folder, CMAKE_FILE), 'utf-8');
    } catch {
      continue;
    }
    cmakeFiles++;
    for (const dir of cmakeIncludeDirs(text, folder)) if (!dirs.includes(dir)) dirs.push(dir);
  }
  if (cmakeFiles > 0) log('cpp-resolve', 'cmake', { files: cmakeFiles, dirs: dirs.length });
  return dirs;
}

/**
 * True when a quoted include such as "absl/strings/str_cat.h" looks like a library outside the repo: it
 * has a first folder, no repo file ends with that path, and no repo folder has the first folder's name.
 */
function isOutsideLibrary(header: string, files: Set<string>, folderNames: () => Set<string>): boolean {
  const first = header.split('/')[0];
  if (!header.includes('/') || first === '.' || first === '..') return false;
  for (const file of files) if (file === header || file.endsWith(`/${header}`)) return false;
  return !folderNames().has(first);
}

export function createCppResolver(
  repoRoot: string,
  sourceFiles: string[]
): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('cpp', repoRoot, sourceFiles);
  const fromCommands = readCompileCommandsIncludeDirs(repoRoot);
  // compile_commands.json is the build itself; without it, the usual roots and then the CMake dirs.
  const includeDirs = fromCommands && fromCommands.length > 0
    ? fromCommands
    : [...new Set([...DEFAULT_INCLUDE_DIRS, ...readCMakeIncludeDirs(kit)])];
  let names: Set<string> | null = null;   // every folder name in the repo, built on first use
  const folderNames = (): Set<string> =>
    (names ??= new Set([...kit.files].flatMap((f) => kit.dirOf(f).split('/').filter(Boolean))));

  return kit.resolver((fromFile: string, spec: string): ResolveResult => {
    const isSystem = spec.startsWith('<') && spec.endsWith('>');
    const header = isSystem ? spec.slice(1, -1) : spec;

    // "x.h": the including file's folder first. <x.h>: include dirs only.
    const searchDirs = isSystem ? includeDirs : [kit.dirOf(fromFile), ...includeDirs];
    const target = kit.firstExisting(searchDirs.map((dir) => path.posix.normalize(dir ? `${dir}/${header}` : header)));
    if (target) return internal(target);

    // <vector>, <sys/types.h>, <boost/asio.hpp>: the first folder, or the bare name
    if (isSystem) return external(header.split('/')[0]);
    // "absl/types/any.h" found nowhere in the repo: the same, a library that is not checked in
    if (isOutsideLibrary(header, kit.files, folderNames)) return external(header.split('/')[0]);
    return unresolved('header not found');
  });
}
