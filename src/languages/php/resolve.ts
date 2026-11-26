import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../log';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internal, unresolved } from '../resolveKit';

/** One PSR-4 rule: namespace prefix ('Shop\\', '' for all) to repo-relative folders. */
interface Psr4Rule { prefix: string; dirs: string[]; }
/**
 * composer.json of one folder: its folder (repo-relative, '' for the root), its PSR-4 rules (longest
 * prefix first) and its `require` / `require-dev` package names by namespace key (see `namespaceKey`).
 */
interface ComposerInfo { dir: string; rules: Psr4Rule[]; packages: Map<string, string>; }

/**
 * Comparable form of a two-part name: lower case, `-`, `_` and `.` dropped, parts joined by `\`.
 * Package 'slim/http-cache' and namespace 'Slim\HttpCache' give the same key (the composer convention).
 */
const namespaceKey = (vendor: string, name: string): string =>
  `${vendor}\\${name}`.toLowerCase().replace(/[-_.]/g, '');

const NAMESPACE_RE = /^[A-Za-z_\x80-￿][\w\x80-￿]*(\\[A-Za-z_\x80-￿][\w\x80-￿]*)*$/;

/** Read `autoload` and `autoload-dev` psr-4 of the composer.json `file` in `dir` (repo-relative); null if there is none or it is unreadable. */
function readComposer(file: string, dir: string): ComposerInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // no composer.json in this folder
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    log('php-resolve', 'composer-unreadable', { file: path.posix.join(dir, 'composer.json'), error: String(err) });
    return null;
  }
  const rules: Psr4Rule[] = [];
  for (const section of [json?.autoload, json?.['autoload-dev']]) {
    const psr4 = section?.['psr-4'];
    if (!psr4 || typeof psr4 !== 'object') continue;
    for (const [prefix, target] of Object.entries(psr4)) {
      const dirs = (Array.isArray(target) ? target : [target]).filter((t): t is string => typeof t === 'string')
        .map((t) => path.posix.normalize(path.posix.join(dir, t)).replace(/^\.$/, '').replace(/\/$/, ''));
      if (dirs.length) rules.push({ prefix, dirs });
    }
  }
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  const packages = new Map<string, string>();
  for (const section of [json?.require, json?.['require-dev']]) {
    if (!section || typeof section !== 'object') continue;
    for (const name of Object.keys(section)) {
      const parts = name.split('/');   // 'php' and 'ext-json' have no vendor: not packages
      if (parts.length === 2 && parts[0] && parts[1]) packages.set(namespaceKey(parts[0], parts[1]), name);
    }
  }
  log('php-resolve', 'composer', { dir, rules: rules.length, packages: packages.size });
  return { dir, rules, packages };
}

/**
 * PHP resolver. A namespace name ('Shop\\Models\\Order', from `use`) goes through the PSR-4 map of the
 * nearest composer.json above the file; a name mapped by PSR-4 whose file is missing is external when
 * its first two parts name a `require` / `require-dev` package of that composer.json (pkg = the package
 * name), else unresolved. A path ('a.php', './b.php', from require/include) is taken
 * relative to the including file, then to the repo root. Anything else (dynamic) is unresolved.
 */
export function createPhpResolver(
  repoRoot: string,
  sourceFiles: string[]
): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('php', repoRoot, sourceFiles);

  function resolvePath(fromFile: string, spec: string): ResolveResult {
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) return unresolved('absolute path');
    const fromDir = path.posix.dirname(fromFile);
    const candidates = [path.posix.normalize(path.posix.join(fromDir, spec))];
    if (!spec.startsWith('./') && !spec.startsWith('../')) candidates.push(path.posix.normalize(spec)); // include_path / working folder
    const target = kit.firstExisting(candidates);
    return target ? internal(target) : unresolved('file not found');
  }

  function resolveNamespace(fromFile: string, spec: string): ResolveResult {
    const composer = kit.findUp(fromFile, 'composer.json', readComposer);
    if (!composer) return unresolved('no composer.json');
    let mapped = false;
    for (const rule of composer.rules) {
      if (!spec.startsWith(rule.prefix)) continue;
      mapped = true;
      const rest = spec.slice(rule.prefix.length).replace(/\\/g, '/');
      const target = kit.firstExisting(rule.dirs.map((dir) => path.posix.join(dir, rest + '.php')));
      if (target) return internal(target);
    }
    if (mapped) {
      // Slim\Http\X under the project's own Slim\ prefix: the separate package slim/http (required, not in the repo)
      const [vendor, name] = spec.split('\\');
      const pkg = name !== undefined ? composer.packages.get(namespaceKey(vendor, name)) : undefined;
      return pkg ? external(pkg) : unresolved('mapped by PSR-4 but file not found');
    }
    return external(spec.split('\\')[0]);
  }

  return kit.resolver((fromFile: string, spec: string): ResolveResult => {
    // A namespace never holds '/' or '.', a literal require path nearly always does.
    if (NAMESPACE_RE.test(spec)) return resolveNamespace(fromFile, spec);
    if (/[$()]|\s\.\s/.test(spec)) return unresolved('dynamic');
    return resolvePath(fromFile, spec);
  });
}
