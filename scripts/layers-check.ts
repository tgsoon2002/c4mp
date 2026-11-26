// Layer check (LAY-0, b369; Document/Roadmap/PHASE_28_LAYERS.md 0.3 and section 2).
//
// Builds the file import graph of src/ + bin/ with the TypeScript compiler API (multi-line imports, export ... from,
// import type, inline type specifiers, import x = require, require(), import() calls and import('...') types), reads
// the layer table in layers.json and measures:
//   (a) folder SCCs, all imports and value imports (a folder node is src/<dir>, each root file of src/, or bin)
//   (b) upward imports: the source file's layer is lower than the target file's layer
//   (c) file-level SCCs, all imports and value imports
//   (d) same-layer folder cycles: imports inside a cycle of folder nodes that all have the same layer
//   (e) skip-layer imports: value imports from an L4 file into an L1 or L2 file (facade work, LAY-11)
// "Value import" = not effectively type-only. An import is effectively type-only when TypeScript erases it: `import
// type`, `export type ... from`, all named specifiers marked `type`, an import('...') type, or every named binding
// resolves (through re-exports) to an interface or type alias (the definition of Phase28/LAYERS-ANALYSIS.md 1).
//
// Run in Project/: npx ts-node scripts/layers-check.ts [--write-baseline]
// test/layers.test.ts fails when a metric rises above the baseline in layers.json; --write-baseline is for the
// orchestrator (once per merge round).

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export type ImportKind = 'import' | 'export-from' | 'import=' | 'import-type' | 'require' | 'dynamic-import';

export interface ImportEdge {
  from: string;
  to: string;
  line: number;
  kind: ImportKind;
  names: string[];
  /** Effectively type-only: TypeScript erases the import, so it is no runtime edge. */
  typeOnly: boolean;
}

export const SOURCE_DIRS = ['src', 'bin'];

// ---------------------------------------------------------------- reading one file

type ExportEntry = { kind: 'type' | 'value' } | { spec: string; name: string } | { local: string };

interface RawImport {
  spec: string;
  line: number;
  kind: ImportKind;
  names: string[];
  syntaxTypeOnly: boolean;
}

interface FileFacts {
  imports: RawImport[];
  exports: Map<string, ExportEntry>;
  starSpecs: string[];
  declKinds: Map<string, 'type' | 'value'>;
  importBindings: Map<string, { spec: string; name: string }>;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function declare(facts: FileFacts, name: string, kind: 'type' | 'value', exported: boolean): void {
  // A name declared both as a type and as a value (interface + const) keeps its value: the import is not erased.
  if (facts.declKinds.get(name) !== 'value') facts.declKinds.set(name, kind);
  if (exported) facts.exports.set(name, { kind: facts.declKinds.get(name)! });
}

function readFacts(file: string, text: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const facts: FileFacts = { imports: [], exports: new Map(), starSpecs: [], declKinds: new Map(), importBindings: new Map() };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const specName = (el: ts.ImportSpecifier | ts.ExportSpecifier) => (el.propertyName ?? el.name).text;

  for (const st of sf.statements) {
    const exported = hasExportModifier(st);
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) declare(facts, st.name.text, 'type', exported);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
      declare(facts, st.name.text, 'value', exported);
    } else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) declare(facts, st.name.text, 'value', exported);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) declare(facts, d.name.text, 'value', exported);
    } else if (ts.isExportAssignment(st)) facts.exports.set('default', { kind: 'value' });
    else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const entry: ExportEntry = st.isTypeOnly || el.isTypeOnly ? { kind: 'type' }
          : st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? { spec: st.moduleSpecifier.text, name: specName(el) }
            : { local: specName(el) };
        facts.exports.set(el.name.text, entry);
      }
    } else if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      facts.starSpecs.push(st.moduleSpecifier.text);
    } else if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
      && ts.isStringLiteral(st.moduleSpecifier)) {
      for (const el of st.importClause.namedBindings.elements) {
        facts.importBindings.set(el.name.text, { spec: st.moduleSpecifier.text, name: specName(el) });
      }
    }
  }

  const add = (spec: string, node: ts.Node, kind: ImportKind, syntaxTypeOnly: boolean, names: string[]) =>
    facts.imports.push({ spec, line: lineOf(node), kind, names, syntaxTypeOnly });

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const ic = node.importClause;
      const names: string[] = [];
      let typeOnly = !!ic?.isTypeOnly;
      if (!ic) names.push('(side-effect)');
      else {
        if (ic.name) names.push('default:' + ic.name.text);
        const nb = ic.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.push('* as ' + nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) names.push((el.isTypeOnly ? 'type ' : '') + specName(el));
          if (!ic.name && nb.elements.length > 0 && nb.elements.every(el => el.isTypeOnly)) typeOnly = true;
        }
      }
      add(node.moduleSpecifier.text, node, 'import', typeOnly, names);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      let typeOnly = node.isTypeOnly;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push((el.isTypeOnly ? 'type ' : '') + specName(el));
        if (node.exportClause.elements.length > 0 && node.exportClause.elements.every(el => el.isTypeOnly)) typeOnly = true;
      } else names.push('*');
      add(node.moduleSpecifier.text, node, 'export-from', typeOnly, names);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, node, 'import=', node.isTypeOnly, [node.name.text]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, node, 'import-type', true, [node.qualifier ? node.qualifier.getText(sf) : '*']);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamic) add(node.arguments[0].text, node, isRequire ? 'require' : 'dynamic-import', false, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

// ---------------------------------------------------------------- the graph

/** Resolves a relative specifier to a source file; null for packages and non-source files (e.g. ../package.json). */
function resolveSpec(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const candidates = [base + '.ts', base + '/index.ts', base];
  if (base.endsWith('.js')) candidates.unshift(base.slice(0, -3) + '.ts');
  for (const c of candidates) if (files.has(c)) return c;
  const ext = path.posix.extname(base);
  if (ext && ext !== '.ts' && ext !== '.js') return null;
  throw new Error(`layers-check: ${from}: cannot resolve '${spec}'`);
}

/** Builds the import edges of a set of sources (path relative to the project dir, '/' separators -> text). */
export function buildImportGraph(sources: Map<string, string>): ImportEdge[] {
  const files = new Set(sources.keys());
  const facts = new Map<string, FileFacts>();
  for (const [file, text] of sources) facts.set(file, readFacts(file, text));

  const kindOf = (file: string, name: string, seen: Set<string>): 'type' | 'value' => {
    const key = file + '#' + name;
    const f = facts.get(file);
    if (!f || seen.has(key)) return 'value';
    seen.add(key);
    const follow = (spec: string, n: string) => {
      const to = resolveSpec(file, spec, files);
      return to ? kindOf(to, n, seen) : 'value';
    };
    const entry = f.exports.get(name);
    if (entry && 'kind' in entry) return entry.kind;
    if (entry && 'spec' in entry) return follow(entry.spec, entry.name);
    if (entry && 'local' in entry) {
      const decl = f.declKinds.get(entry.local);
      if (decl) return decl;
      const binding = f.importBindings.get(entry.local);
      return binding ? follow(binding.spec, binding.name) : 'value';
    }
    for (const spec of f.starSpecs) {
      const to = resolveSpec(file, spec, files);
      if (to && facts.get(to) && exportsName(to, name, new Set())) return kindOf(to, name, seen);
    }
    // Not found as an export: unknown, so it counts as a runtime edge (conservative).
    return 'value';
  };
  const exportsName = (file: string, name: string, seen: Set<string>): boolean => {
    const f = facts.get(file);
    if (!f || seen.has(file)) return false;
    seen.add(file);
    if (f.exports.has(name)) return true;
    return f.starSpecs.some(spec => {
      const to = resolveSpec(file, spec, files);
      return !!to && exportsName(to, name, seen);
    });
  };

  const edges: ImportEdge[] = [];
  for (const [file, f] of facts) {
    for (const imp of f.imports) {
      const to = resolveSpec(file, imp.spec, files);
      if (!to) continue;
      edges.push({ from: file, to, line: imp.line, kind: imp.kind, names: imp.names, typeOnly: effectiveTypeOnly(imp, to) });
    }
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.to.localeCompare(b.to));

  function effectiveTypeOnly(imp: RawImport, to: string): boolean {
    if (imp.syntaxTypeOnly) return true;
    if (imp.kind === 'require' || imp.kind === 'dynamic-import') return false;
    const named = imp.names.filter(n => !n.startsWith('default:') && !n.startsWith('* as ') && n !== '*' && n !== '(side-effect)');
    if (named.length !== imp.names.length || named.length === 0) return false;
    return named.every(n => n.startsWith('type ') || kindOf(to, n, new Set()) === 'type');
  }
}

/** Reads every .ts file (not .d.ts) under src/ and bin/ of a project dir. */
export function readSources(projectDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        out.set(path.relative(projectDir, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8'));
      }
    }
  };
  for (const d of SOURCE_DIRS) if (fs.existsSync(path.join(projectDir, d))) walk(path.join(projectDir, d));
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** Tarjan: the strongly connected components with more than one node, largest first. */
export function stronglyConnected(nodes: string[], pairs: Array<[string, string]>): string[][] {
  const adj = new Map<string, string[]>();
  for (const [a, b] of pairs) if (a !== b) (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const connect = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const n of [...nodes].sort()) if (!index.has(n)) connect(n);
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------- the layer table

export interface Baseline {
  folderSccAll: number[];
  folderSccValue: number[];
  fileSccAll: number[];
  fileSccValue: number[];
  upward: number;
  sameLayerCycle: number;
  skipLayer: number;
}

export interface LayerTable {
  folders: Record<string, string>;
  files: Record<string, string>;
  baseline: Baseline;
}

export interface LayerHit {
  layer: number;
  /** The table entry that gave the layer, e.g. "folder src/c4" or "file src/types.ts". */
  rule: string;
}

function parseLayer(value: string, where: string): number {
  const m = /^L([0-4])$/.exec(value);
  if (!m) throw new Error(`layers.json: ${where} has layer '${value}', expected L0..L4`);
  return Number(m[1]);
}

/** A file rule wins; else the most specific folder rule; undefined when no rule covers the file. */
function findLayer(file: string, table: LayerTable): LayerHit | undefined {
  if (table.files[file] !== undefined) return { layer: parseLayer(table.files[file], file), rule: `file ${file}` };
  const folder = Object.keys(table.folders)
    .filter(d => file.startsWith(d + '/'))
    .sort((a, b) => b.length - a.length)[0];
  return folder === undefined ? undefined : { layer: parseLayer(table.folders[folder], folder), rule: `folder ${folder}` };
}

/** The layer of a file. No rule is an error that names the file (never a default layer). */
export function layerOf(file: string, table: LayerTable): LayerHit {
  const hit = findLayer(file, table);
  if (!hit) throw new Error(`layers.json: no layer for ${file}`);
  return hit;
}

/** The folder node of a file: src/<dir> for files in a src subfolder, the file itself for a root file of src/, else the top dir. */
export function nodeOf(file: string): string {
  const parts = file.split('/');
  if (parts[0] === 'src') return parts.length > 2 ? `src/${parts[1]}` : file;
  return parts[0];
}

function nodeLayer(node: string, table: LayerTable): LayerHit {
  if (node.endsWith('.ts')) return layerOf(node, table);
  if (table.folders[node] === undefined) throw new Error(`layers.json: folder ${node} has no layer`);
  return { layer: parseLayer(table.folders[node], node), rule: `folder ${node}` };
}

// ---------------------------------------------------------------- metrics

export interface Finding {
  edge: ImportEdge;
  rule: string;
}

export interface Scc {
  members: string[];
  /** Import statements between two different members. */
  imports: ImportEdge[];
}

export interface Metrics {
  files: number;
  imports: number;
  typeOnlyImports: number;
  folderSccAll: Scc[];
  folderSccValue: Scc[];
  fileSccAll: Scc[];
  fileSccValue: Scc[];
  upward: Finding[];
  sameLayerCycle: Finding[];
  skipLayer: Finding[];
}

function sccsOver(files: string[], edges: ImportEdge[], node: (f: string) => string): Scc[] {
  const nodes = Array.from(new Set(files.map(node)));
  const comps = stronglyConnected(nodes, edges.map(e => [node(e.from), node(e.to)] as [string, string]));
  return comps.map(members => {
    const set = new Set(members);
    const imports = edges.filter(e => node(e.from) !== node(e.to) && set.has(node(e.from)) && set.has(node(e.to)));
    return { members, imports };
  });
}

const L = (n: number) => `L${n}`;

export function measure(files: string[], edges: ImportEdge[], table: LayerTable): Metrics {
  const missing = files.filter(f => !findLayer(f, table));
  if (missing.length) throw new Error(`layers.json: no layer for ${missing.length} file(s): ${missing.join(', ')}`);
  for (const n of new Set(files.map(nodeOf))) nodeLayer(n, table);

  const layer = new Map(files.map(f => [f, layerOf(f, table)]));
  const value = edges.filter(e => !e.typeOnly);
  const describe = (e: ImportEdge) => {
    const a = layer.get(e.from)!, b = layer.get(e.to)!;
    return `${L(a.layer)} (${a.rule}) -> ${L(b.layer)} (${b.rule})`;
  };

  const upward = edges
    .filter(e => layer.get(e.from)!.layer < layer.get(e.to)!.layer)
    .map(e => ({ edge: e, rule: `upward: ${describe(e)}; a layer imports only its own or lower layers` }));

  const skipLayer = value
    .filter(e => layer.get(e.from)!.layer === 4 && [1, 2].includes(layer.get(e.to)!.layer))
    .map(e => ({ edge: e, rule: `skip-layer: ${describe(e)}; entry points go through L3 services (LAY-11)` }));

  const nl = (f: string) => nodeLayer(nodeOf(f), table).layer;
  const sameLayerEdges = edges.filter(e => nodeOf(e.from) !== nodeOf(e.to) && nl(e.from) === nl(e.to));
  const sameLayerCycle = sccsOver(files, sameLayerEdges, nodeOf).flatMap(scc => {
    const rule = `same-layer cycle in ${L(nl(scc.imports[0].from))}: ${scc.members.join(', ')}`;
    return scc.imports.map(edge => ({ edge, rule }));
  });

  return {
    files: files.length,
    imports: edges.length,
    typeOnlyImports: edges.length - value.length,
    folderSccAll: sccsOver(files, edges, nodeOf),
    folderSccValue: sccsOver(files, value, nodeOf),
    fileSccAll: sccsOver(files, edges, f => f),
    fileSccValue: sccsOver(files, value, f => f),
    upward,
    sameLayerCycle,
    skipLayer,
  };
}

export function summarize(m: Metrics): Baseline {
  const sizes = (s: Scc[]) => s.map(c => c.members.length);
  return {
    folderSccAll: sizes(m.folderSccAll),
    folderSccValue: sizes(m.folderSccValue),
    fileSccAll: sizes(m.fileSccAll),
    fileSccValue: sizes(m.fileSccValue),
    upward: m.upward.length,
    sameLayerCycle: m.sameLayerCycle.length,
    skipLayer: m.skipLayer.length,
  };
}

// ---------------------------------------------------------------- report and ratchet

const at = (e: ImportEdge) => `${e.from}:${e.line}`;
const edgeLine = (e: ImportEdge) => `${at(e)} -> ${e.to} {${e.names.join(', ')}}${e.typeOnly ? ' (type)' : ''}`;

function sccLines(sccs: Scc[], node: (f: string) => string): string[] {
  return sccs.flatMap(scc => {
    const byPair = new Map<string, ImportEdge[]>();
    for (const e of scc.imports) {
      const key = `${node(e.from)} -> ${node(e.to)}`;
      (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(e);
    }
    return [
      `  SCC of ${scc.members.length}: ${scc.members.join(', ')}`,
      ...[...byPair].map(([pair, es]) => `    ${pair}: ${es.map(e => at(e) + (e.typeOnly ? ' (type)' : '')).join(', ')}`),
    ];
  });
}

const findingLines = (fs: Finding[]) => fs.map(f => `  ${edgeLine(f.edge)}  [${f.rule}]`);

interface MetricSpec {
  key: keyof Baseline;
  title: string;
  value: (m: Metrics) => number;
  lines: (m: Metrics) => string[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const METRICS: MetricSpec[] = [
  { key: 'folderSccAll', title: '(a) folder SCCs, all imports', value: m => sum(summarize(m).folderSccAll), lines: m => sccLines(m.folderSccAll, nodeOf) },
  { key: 'folderSccValue', title: '(a) folder SCCs, value imports', value: m => sum(summarize(m).folderSccValue), lines: m => sccLines(m.folderSccValue, nodeOf) },
  { key: 'upward', title: '(b) upward imports', value: m => m.upward.length, lines: m => findingLines(m.upward) },
  { key: 'fileSccAll', title: '(c) file SCCs, all imports', value: m => sum(summarize(m).fileSccAll), lines: m => sccLines(m.fileSccAll, f => f) },
  { key: 'fileSccValue', title: '(c) file SCCs, value imports', value: m => sum(summarize(m).fileSccValue), lines: m => sccLines(m.fileSccValue, f => f) },
  { key: 'sameLayerCycle', title: '(d) same-layer folder cycle imports', value: m => m.sameLayerCycle.length, lines: m => findingLines(m.sameLayerCycle) },
  { key: 'skipLayer', title: '(e) skip-layer imports L4 -> L1/L2 (value)', value: m => m.skipLayer.length, lines: m => findingLines(m.skipLayer) },
];

const shown = (v: number | number[]) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));

export function formatReport(m: Metrics): string {
  const s = summarize(m);
  const out = [`layers-check: ${m.files} files, ${m.imports} internal import statements (${m.typeOnlyImports} type-only)`];
  for (const spec of METRICS) {
    out.push('', `${spec.title}: ${shown(s[spec.key])}`, ...spec.lines(m));
  }
  return out.join('\n');
}

/**
 * Compares to the baseline. SCC metrics compare the number of nodes inside cycles (sum of sizes); the others the count.
 * A rise message names every current import of that metric with file:line and the rule; a fall only asks to lower it.
 */
export function ratchet(m: Metrics, baseline: Baseline): { rises: string[]; falls: string[] } {
  const rises: string[] = [];
  const falls: string[] = [];
  const now = summarize(m);
  for (const spec of METRICS) {
    const was = baseline[spec.key];
    if (was === undefined) throw new Error(`layers.json: baseline has no '${spec.key}'`);
    const before = Array.isArray(was) ? sum(was) : was;
    const after = spec.value(m);
    const label = `${spec.title}: ${shown(now[spec.key])}, baseline ${shown(was)}`;
    if (after > before) rises.push([`${label}: ROSE. Current list:`, ...spec.lines(m)].join('\n'));
    else if (after < before) falls.push(`${label}: fell; the orchestrator lowers the baseline in layers.json`);
  }
  return { rises, falls };
}

export interface CheckResult {
  table: LayerTable;
  metrics: Metrics;
}

export function loadTable(projectDir: string): LayerTable {
  return JSON.parse(fs.readFileSync(path.join(projectDir, 'layers.json'), 'utf8')) as LayerTable;
}

export function runLayersCheck(projectDir: string): CheckResult {
  const table = loadTable(projectDir);
  const sources = readSources(projectDir);
  const metrics = measure([...sources.keys()], buildImportGraph(sources), table);
  return { table, metrics };
}

if (require.main === module) {
  const projectDir = path.resolve(__dirname, '..');
  const { table, metrics } = runLayersCheck(projectDir);
  console.log(formatReport(metrics));
  if (process.argv.includes('--write-baseline')) {
    const file = path.join(projectDir, 'layers.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.baseline = summarize(metrics);
    // Number arrays (SCC sizes) on one line: [5, 5, 3].
    const text = JSON.stringify(json, null, 2).replace(/\[[\d,\s]*\]/g, m => `[${m.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ')}]`);
    fs.writeFileSync(file, text + '\n');
    console.log('\nbaseline written to layers.json');
  } else {
    const { rises, falls } = ratchet(metrics, table.baseline);
    console.log('');
    for (const f of falls) console.log(f);
    for (const r of rises) console.log(r);
    console.log(rises.length ? `\n${rises.length} metric(s) rose above the baseline` : 'no metric above the baseline');
    if (rises.length) process.exitCode = 1;
  }
}
