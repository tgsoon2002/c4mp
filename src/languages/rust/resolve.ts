import * as fs from 'fs';
import * as path from 'path';
import type Parser from 'tree-sitter';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internal, unresolved } from '../resolveKit';

const posix = path.posix;
const ROOT_NAMES = ['lib.rs', 'main.rs'];
const CRATE_DIRS = ['bin', 'examples', 'tests', 'benches'];

/** Crate names declared by the Cargo.toml files found above the source files: name -> repo dir. */
function readCrates(repoRoot: string, files: Set<string>): Map<string, string> {
  const dirs = new Set<string>();
  for (const f of files) {
    for (let d = posix.dirname(f); ; d = posix.dirname(d)) {
      dirs.add(d === '.' ? '' : d);
      if (d === '.' || d === '/') break;
    }
  }
  const crates = new Map<string, string>();
  for (const dir of dirs) {
    let toml: string;
    try {
      toml = fs.readFileSync(path.join(repoRoot, dir, 'Cargo.toml'), 'utf8');
    } catch {
      continue;
    }
    let section = '';
    let pkg: string | undefined;
    let lib: string | undefined;
    for (const raw of toml.split('\n')) {
      const line = raw.trim();
      const head = /^\[([^\]]+)\]/.exec(line);
      if (head) { section = head[1].trim(); continue; }
      const m = /^name\s*=\s*["']([^"']+)["']/.exec(line);
      if (m && section === 'package') pkg = m[1];
      if (m && section === 'lib') lib = m[1];
    }
    const name = (lib ?? pkg)?.replace(/-/g, '_');
    if (name) crates.set(name, dir);
  }
  return crates;
}

// Items in the type namespace: the only local names a `use` path can start with (`use Token::*` of an
// enum, `use inner::X` of an inline module). A fn, const or static is in the value namespace, where an
// extern crate of the same name does not clash, so it is not counted.
const TYPE_ITEMS = new Set(['enum_item', 'struct_item', 'union_item', 'trait_item', 'type_item', 'mod_item']);
// Bodies whose items are associated items (`impl S { type Q = u32; }`), not module items.
const ASSOCIATED_BODIES = new Set(['impl_item', 'trait_item']);

/**
 * Names of the type-namespace items one file declares anywhere (top level, inline modules, fn bodies;
 * not impl or trait members). A `mod x;` without a body is a file module, found through the module tree.
 */
export function declaredTypeNames(tree: Parser.Tree): Set<string> {
  const names = new Set<string>();
  const visit = (node: Parser.SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (TYPE_ITEMS.has(child.type) && (child.type !== 'mod_item' || child.childForFieldName('body'))) {
        const name = child.childForFieldName('name')?.text;
        if (name) names.add(name);
      }
      if (!ASSOCIATED_BODIES.has(child.type)) visit(child);
    }
  };
  visit(tree.rootNode);
  return names;
}

export function createRustResolver(
  repoRoot: string,
  sourceFiles: string[],
  parse: (code: string, file: string) => Parser.Tree
): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('rust', repoRoot, sourceFiles);
  const files = kit.files;
  const crates = readCrates(repoRoot, files);
  const typeNames = new Map<string, Set<string>>();   // file -> declared type-namespace items, read on first use

  function declaresType(file: string, name: string): boolean {
    let names = typeNames.get(file);
    if (!names) {
      try {
        names = declaredTypeNames(parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'), file));
      } catch {
        names = new Set();
      }
      typeNames.set(file, names);
    }
    return names.has(name);
  }

  const base = (f: string) => posix.basename(f);
  const join = (...p: string[]) => posix.join(...p).replace(/^\.\//, '');

  /** Directory that holds the child modules of a module file (`a/mod.rs`, `lib.rs`: its folder; `a/b.rs`: `a/b`). */
  function moduleDir(file: string): string {
    const dir = posix.dirname(file);
    const name = base(file);
    if (name === 'mod.rs' || ROOT_NAMES.includes(name) || isBinRoot(file)) return dir;
    return join(dir, name.replace(/\.rs$/, ''));
  }

  /** `src/bin/tool.rs`, `tests/it.rs`, `examples/e/main.rs` ... are crate roots of their own. */
  function isBinRoot(file: string): boolean {
    const dir = posix.dirname(file);
    if (CRATE_DIRS.includes(base(dir))) return true;
    return base(file) === 'main.rs' && CRATE_DIRS.includes(base(posix.dirname(dir)));
  }

  function child(file: string, name: string): string | undefined {
    const dir = moduleDir(file);
    return kit.firstExisting([join(dir, name + '.rs'), join(dir, name, 'mod.rs')]);
  }

  function crateRoot(file: string): string | undefined {
    const name = base(file);
    if (name === 'lib.rs' || isBinRoot(file)) return file;
    if (name === 'main.rs' && !files.has(join(posix.dirname(file), 'lib.rs'))) return file;
    for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
      const d = dir === '.' ? '' : dir;
      if (CRATE_DIRS.includes(base(d)) && posix.dirname(file) !== d) {
        // a module of a multi-file bin/test/example: <d>/<name>/main.rs
        const main = join(d, file.slice(d ? d.length + 1 : 0).split('/')[0], 'main.rs');
        if (files.has(main)) return main;
      }
      const root = kit.firstExisting(ROOT_NAMES.map((n) => join(d, n)));
      if (root) return root;
      if (dir === '.' || dir === '/') return undefined;
    }
  }

  function parent(file: string): string | undefined {
    if (ROOT_NAMES.includes(base(file)) || isBinRoot(file)) return undefined;
    // `a/b.rs` and `a/b/mod.rs` both have their parent module in folder `a`: a/mod.rs, a.rs or a/lib.rs
    const up = posix.dirname(moduleDir(file));
    const candidates = [join(up, 'mod.rs'), join(posix.dirname(up), base(up) + '.rs'), join(up, 'lib.rs'), join(up, 'main.rs')];
    return candidates.find((c) => files.has(c) && c !== file);
  }

  /** Follow `segs` from a module file through child modules; stop at the first name that is not a file module (an item or an inline module). */
  function walk(start: string, segs: string[]): ResolveResult {
    let cur = start;
    for (const seg of segs) {
      if (seg === 'self') continue;
      if (seg === 'super') {
        const up = parent(cur);
        if (!up) return unresolved('super above the crate root');
        cur = up;
        continue;
      }
      const next = child(cur, seg);
      if (!next) break;
      cur = next;
    }
    return internal(cur);
  }

  function resolve(fromFile: string, spec: string): ResolveResult {
    if (spec.startsWith('mod ')) {
      const names = spec.slice(4).split('::');
      const name = names.pop() as string;
      const dir = join(moduleDir(fromFile), ...names);
      const target = kit.firstExisting([join(dir, name + '.rs'), join(dir, name, 'mod.rs')]);
      return target ? internal(target) : unresolved('module file not found');
    }
    const segs = spec.split('::');
    const first = segs[0];
    if (first === 'crate') {
      const root = crateRoot(fromFile);
      return root ? walk(root, segs.slice(1)) : unresolved('no crate root');
    }
    if (first === 'self' || first === 'super') return walk(fromFile, segs);
    const externalName = first === '' ? segs[1] : first;
    if (first !== '' && child(fromFile, first)) return walk(fromFile, segs);
    // `use Token::*;` where the file itself declares `enum Token`: a local name, not a crate
    if (first !== '' && declaresType(fromFile, first)) return internal(fromFile);
    const crateDir = crates.get(externalName);
    if (crateDir !== undefined) {
      const lib = join(crateDir, 'src', 'lib.rs');
      return files.has(lib) ? walk(lib, segs.slice(first === '' ? 2 : 1)) : unresolved('crate has no src/lib.rs');
    }
    return external(externalName);
  }

  return kit.resolver(resolve);
}
