import * as fs from 'fs';
import * as path from 'path';
import { parseSource } from '../languages/typescript/language';
import { stringValue } from './drizzle-ast';
import type { FileInfo, Node, RelImport, SourceIndex } from './drizzle-ast';

// P23-D3b (b274): one parsed source file of the schema reader, shared by the table files and by the
// files that hold a project's own helper functions. Moved out of drizzle.ts (imports, consts) and
// extended with relative imports and top-level function declarations. Read-only; each file is read and
// parsed once per readDrizzleSchema call (SourceIndex.cache).

const PG = 'drizzle-orm/pg-core';

export function newSourceIndex(repoRoot: string): SourceIndex {
  return { repoRoot, cache: new Map() };
}

/** Read and parse a file once. Throws when it cannot be read or its syntax tree has errors. */
export function loadFile(src: SourceIndex, file: string): FileInfo {
  const hit = src.cache.get(file);
  if (hit) return hit;
  const code = fs.readFileSync(path.join(src.repoRoot, file), 'utf8');
  const { tree } = parseSource(code, file);
  if (tree.rootNode.hasError) throw new Error(`schema: ${file} has syntax errors; cannot read it`);
  const root = tree.rootNode;
  const info: FileInfo = {
    file, tree, root, pg: false, otherDialects: [], imports: new Map(), rel: new Map(),
    consts: readConsts(root), functions: readFunctions(root),
  };
  readImports(root, info);
  src.cache.set(file, info);
  return info;
}

/** Repo-relative file a relative import points at, or null (not relative, outside the repo, not found). */
export function resolveRelative(src: SourceIndex, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (base.startsWith('..') || path.posix.isAbsolute(base)) return null;
  const noJs = base.replace(/\.(m|c)?js$/, '');
  for (const c of [base, `${noJs}.ts`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      if (fs.statSync(path.join(src.repoRoot, c)).isFile()) return c;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function readImports(root: Node, info: FileInfo): void {
  for (const st of root.namedChildren) {
    if (st.type !== 'import_statement') continue;
    const spec = stringValue(st.childForFieldName('source') ?? undefined);
    if (spec === null) continue;
    if (spec === PG) {
      info.pg = true;
      for (const s of namedImports(st)) info.imports.set(s.local, s.imported);
      continue;
    }
    if (spec.startsWith('.')) {
      for (const s of namedImports(st)) info.rel.set(s.local, { spec, imported: s.imported });
      continue;
    }
    const m = /^drizzle-orm\/([a-z]+)-core$/.exec(spec);
    if (m && !info.otherDialects.includes(m[1])) info.otherDialects.push(m[1]);
  }
}

function namedImports(st: Node): { local: string; imported: string }[] {
  const out: { local: string; imported: string }[] = [];
  const stack = [...st.namedChildren];
  while (stack.length) {
    const n = stack.pop() as Node;
    if (n.type === 'import_specifier') {
      const imported = n.childForFieldName('name');
      const alias = n.childForFieldName('alias');
      if (imported) out.push({ local: (alias ?? imported).text, imported: imported.text });
    } else stack.push(...n.namedChildren);
  }
  return out;
}

function readConsts(root: Node): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of topDeclarators(root)) {
    const name = d.childForFieldName('name');
    let v = d.childForFieldName('value');
    if (v && v.type === 'as_expression') v = v.namedChildren[0] ?? null;
    if (!name || !v || v.type !== 'array') continue;
    const items = v.namedChildren.map((c) => stringValue(c));
    if (items.length > 0 && items.every((s): s is string => s !== null)) out.set(name.text, items);
  }
  return out;
}

function readFunctions(root: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const d of topDeclarators(root)) {
    const name = d.childForFieldName('name');
    const v = d.childForFieldName('value');
    if (name && v && (v.type === 'arrow_function' || v.type === 'function_expression' || v.type === 'function')) out.set(name.text, v);
  }
  for (const st of root.namedChildren) {
    const decl = st.type === 'export_statement' ? st.childForFieldName('declaration') : st;
    const name = decl && decl.type === 'function_declaration' ? decl.childForFieldName('name') : null;
    if (decl && name) out.set(name.text, decl);
  }
  return out;
}

export function topDeclarators(root: Node): Node[] {
  const out: Node[] = [];
  for (const st of root.namedChildren) {
    const decl = st.type === 'export_statement' ? st.childForFieldName('declaration') : st;
    if (decl && decl.type === 'lexical_declaration') out.push(...decl.namedChildren.filter((c) => c.type === 'variable_declarator'));
  }
  return out;
}
