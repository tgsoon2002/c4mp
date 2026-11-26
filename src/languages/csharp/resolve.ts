import * as fs from 'fs';
import * as path from 'path';
import type Parser from 'tree-sitter';
import { log } from '../../log';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internalAll, unresolved } from '../resolveKit';

// Namespaces from a tree-sitter pass over every scanned .cs file (not a regex): the grammar already
// skips comments, strings and verbatim/raw strings, and gives block, nested and file-scoped
// namespaces the same way the outline reads them. Each .cs is parsed once more, in createResolver.

/** Preprocessor blocks (`#if` / `#elif` / `#else`) may hold namespaces too. */
const PREPROC = /^preproc_/;

/** Namespaces one file declares, full names ('Shop', 'Shop.Tax'): block (nested ones joined), file-scoped. */
export function declaredNamespaces(tree: Parser.Tree): string[] {
  const found = new Set<string>();
  function visit(parent: Parser.SyntaxNode, prefix: string): void {
    for (const node of parent.namedChildren) {
      if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
        const name = node.childForFieldName('name')?.text.replace(/\s+/g, '');
        if (!name) continue;
        const full = prefix ? `${prefix}.${name}` : name;
        found.add(full);
        // A file-scoped namespace node ends at its `;` (its declarations are siblings), and C# allows no
        // block namespace next to it, so only a block namespace's body can hold more namespaces.
        const body = node.type === 'namespace_declaration' ? node.childForFieldName('body') : null;
        if (body) visit(body, full);
      } else if (PREPROC.test(node.type)) {
        visit(node, prefix);
      }
    }
  }
  visit(tree.rootNode, '');
  return [...found];
}

/** NuGet package names of one .csproj (`<PackageReference Include="...">`), XML comments ignored. */
function packageReferences(xml: string): string[] {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const names: string[] = [];
  const re = /<PackageReference\b[^>]*?\bInclude\s*=\s*["']([^"']+)["']/g;
  for (let m = re.exec(text); m; m = re.exec(text)) names.push(m[1].trim());
  return names;
}

/** Every .csproj in a folder that holds a scanned file or is above one (repo root included): their package names. */
function readPackages(repoRoot: string, sourceFiles: string[], dirOf: (f: string) => string): string[] {
  const dirs = new Set<string>();
  for (const file of sourceFiles) {
    for (let dir = dirOf(file); !dirs.has(dir); dir = dirOf(dir)) {
      dirs.add(dir);
      if (dir === '') break;
    }
  }
  const packages = new Set<string>();
  for (const dir of [...dirs].sort()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, dir)).filter((e) => e.endsWith('.csproj')).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.posix.join(dir, entry);
      try {
        const names = packageReferences(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
        names.forEach((n) => packages.add(n));
        log('csharp-resolve', 'csproj', { file, packages: names.length });
      } catch (err) {
        log('csharp-resolve', 'csproj-unreadable', { file, error: String(err) });
      }
    }
  }
  return [...packages];
}

/** The namespace or type name a spec names: right-hand side of an alias, no `static`, `global::` or generic arguments. */
function nameOf(spec: string): { name: string; typeAllowed: boolean } {
  let name = spec;
  let typeAllowed = false;
  const alias = /^[^=]+=\s*(.+)$/.exec(name);
  if (alias) { name = alias[1]; typeAllowed = true; }
  else if (name.startsWith('static ')) { name = name.slice(7); typeAllowed = true; }
  name = name.replace(/^global::/, '');
  // generic arguments, innermost first: List<Dictionary<int,string>> -> List
  for (let prev = ''; prev !== name;) { prev = name; name = name.replace(/<[^<>]*>/g, ''); }
  return { name: name.trim(), typeAllowed };
}

const BCL_ROOTS = ['System', 'Microsoft'];

/**
 * C# resolver. `using A.B` points at every scanned file that declares namespace A.B (one edge per file;
 * the importing file itself only when it is the only one). `using static A.B.Type` and alias targets
 * drop trailing segments until a declared namespace matches. Not declared: System.* and Microsoft.*
 * are external (pkg = first segment), a name under a NuGet `PackageReference` of any scanned .csproj
 * is external (pkg = the package name), a parent of declared namespaces with no file of its own is
 * unresolved 'namespace-has-no-files', anything else unresolved 'unknown-namespace'.
 * Not modelled: ImplicitUsings and `<Using Include>` in a .csproj, and `global using` lines do not
 * add edges to other files (each using gives edges from the file that holds it); .csproj files above
 * the scanned folder are not read; `<ProjectReference>` is not read (no container-to-container edge yet).
 */
export function createCSharpResolver(
  repoRoot: string,
  sourceFiles: string[],
  parse: (code: string, file: string) => Parser.Tree
): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('csharp', repoRoot, sourceFiles);
  const csFiles = sourceFiles.filter((f) => f.endsWith('.cs'));

  const filesOf = new Map<string, string[]>();   // namespace -> files declaring it, sorted
  for (const file of csFiles) {
    let code: string;
    try {
      code = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const ns of declaredNamespaces(parse(code, file))) {
      if (!filesOf.has(ns)) filesOf.set(ns, []);
      filesOf.get(ns)!.push(file);
    }
  }
  const parents = new Set<string>();   // every proper dotted prefix of a declared namespace
  for (const ns of filesOf.keys()) {
    for (let i = ns.indexOf('.'); i > 0; i = ns.indexOf('.', i + 1)) parents.add(ns.slice(0, i));
  }
  // longest package first, matched case-insensitively on whole segments
  const packages = readPackages(repoRoot, csFiles, kit.dirOf).sort((a, b) => b.length - a.length);
  log('csharp-resolve', 'namespaces', { namespaces: filesOf.size, packages: packages.length });

  function declared(fromFile: string, ns: string): ResolveResult {
    const files = filesOf.get(ns)!;
    const others = files.filter((f) => f !== fromFile);
    return internalAll(others.length > 0 ? others : files);
  }

  return kit.resolver((fromFile: string, spec: string): ResolveResult => {
    const { name, typeAllowed } = nameOf(spec);
    if (!/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(name)) return unresolved('unknown-namespace');
    if (filesOf.has(name)) return declared(fromFile, name);
    if (typeAllowed) {
      for (let i = name.lastIndexOf('.'); i > 0; i = name.lastIndexOf('.', i - 1)) {
        if (filesOf.has(name.slice(0, i))) return declared(fromFile, name.slice(0, i));
      }
    }
    const root = name.split('.')[0];
    if (BCL_ROOTS.includes(root)) return external(root);
    const lower = name.toLowerCase();
    const pkg = packages.find((p) => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + '.'));
    if (pkg) return external(pkg);
    if (parents.has(name)) return unresolved('namespace-has-no-files');
    return unresolved('unknown-namespace');
  });
}
