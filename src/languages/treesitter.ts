import type Parser from 'tree-sitter';
import type {
  CodeElement, ElementKind, FileCalls, FileOutline, ImportBinding, ImportKind, ImportUse, InstanceBinding, NestedElement, RawCall, RawImport,
  ResolveResult, StubKind,
} from '../types';
import { log } from '../log';
import { MODULE_CALLER } from '../constants';

// The one tree-sitter loader, used by every handler (TypeScript and TSX through typescript/language.ts):
// grammar loading, parsing, line count and element building. Jest re-evaluates tree-sitter's JS
// wrapper per test file while its native binding stays cached, which breaks Tree.prototype.rootNode
// on the second load, so the Parser class and each grammar are kept once per process on the core
// `util` module, in the single `__c4pmTreeSitter` slot owned by this module. The native module is
// loaded on the first parse, not on import, so the language registry loads without it
// (scripts/grammar-smoke.js reads the registry and reports a broken tree-sitter itself).
interface TreeSitterShared {
  Parser: typeof Parser;
  grammars: Record<string, { parser: Parser | null; grammar: unknown }>;
}
const processShared = require('util') as { __c4pmTreeSitter?: TreeSitterShared };
const treeSitter = (): TreeSitterShared => (processShared.__c4pmTreeSitter ??= { Parser: require('tree-sitter'), grammars: {} });

/** Loads tree-sitter itself (throws when it is missing or broken), through the shared slot: `c4pm languages` reports it. */
export function loadTreeSitter(): void {
  treeSitter();
}

/**
 * Parse code with the grammar stored under `id`; `loadGrammar` runs once per id and process.
 * `file` is only for the log line.
 */
export function parseWithGrammar(id: string, loadGrammar: () => unknown, code: string, file?: string): Parser.Tree {
  const shared = treeSitter();
  const entry = (shared.grammars[id] ??= { parser: null, grammar: undefined });
  if (!entry.parser) {
    entry.grammar = loadGrammar();
    const created: Parser = new shared.Parser();
    created.setLanguage(entry.grammar as any);
    entry.parser = created;
  }
  const parser = entry.parser as Parser;
  let tree: Parser.Tree;
  try {
    tree = parser.parse(code);
  } catch {
    // large input: retry with a bigger buffer
    tree = parser.parse(code, undefined, { bufferSize: Math.max(1024 * 1024, code.length * 2) });
  }
  log(id, 'parse', { ...(file && { file }), chars: code.length, hasError: tree.rootNode.hasError });
  return tree;
}

/**
 * The number of parse errors in a tree: nodes of type ERROR plus the MISSING nodes the parser inserted.
 * Subtrees without an error are skipped. Used by `defineLanguage`'s `retryMacros` (keeps the parse with fewer
 * errors) and by the edit engine (Phase 32 ED-1, D6: an edit is refused when this count goes up).
 */
export function parseErrorCount(tree: Parser.Tree): number {
  if (!tree.rootNode.hasError) return 0;
  const cursor = tree.walk();
  let count = 0;
  for (;;) {
    if (cursor.nodeType === 'ERROR' || cursor.nodeIsMissing) count++;
    // hasError covers the node and its descendants: descend only where an error is.
    if (cursor.currentNode.hasError && cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return count;
    }
  }
}

/** Resolver for outline-only handlers: they report no imports, so it is never asked. */
export const noResolver = (): ResolveResult => ({ status: 'unresolved' });

/** Number of lines in a file (a trailing newline does not add a line; empty file is 0). */
export function countLines(code: string): number {
  return code === '' ? 0 : code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
}

/** Sort by startLine, then by name (the order every handler returns). */
export function sortElements(elements: CodeElement[]): void {
  elements.sort((a, b) => a.startLine !== b.startLine ? a.startLine - b.startLine : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** b782: how a language finds the functions declared inside a function body (createOutlineBuilder's finish). */
export interface NestedRules {
  /** Node types that open a function body (TypeScript FUNCTION_NODES; Python function_definition, lambda). */
  scopes: string[];
  /** Node types never walked into (class declarations: their methods are not the enclosing function's). */
  skip: string[];
  /** The function name a node declares inside a body (`function f`, `const f = () => ...`, Python `def f`), else null. */
  nameOf(node: Parser.SyntaxNode): string | null;
  /** Stub kind of such a declaration (default: none). */
  stub?(node: Parser.SyntaxNode): StubKind | null;
}

/** b782: `name`, or `name#s` with the smallest s >= 2 not in `taken`; does not add to `taken`. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let s = 2;
  while (taken.has(`${name}#${s}`)) s++;
  return `${name}#${s}`;
}

/**
 * b782: the functions declared inside the bodies of the outline functions and methods, named `parent.name`, unique in the
 * file (a clash with an element name or an earlier nested name gets `#2`, `#3`). Only names met after entering a scope
 * node count: an element's own function node is not nested.
 */
function collectNested(elements: CodeElement[], nodes: Map<CodeElement, Parser.SyntaxNode>, rules: NestedRules, logTag: string, file: string): NestedElement[] {
  const scopes = new Set(rules.scopes);
  const skip = new Set(rules.skip);
  const taken = new Set(elements.map((e) => e.name));
  const out: NestedElement[] = [];
  const walk = (node: Parser.SyntaxNode, inside: boolean, parent: string, outer: string): void => {
    for (const child of node.namedChildren) {
      if (skip.has(child.type)) continue;
      const own = inside ? rules.nameOf(child) : null;
      if (own) {
        const name = uniqueName(`${parent}.${own}`, taken);
        taken.add(name);
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;
        const stub = rules.stub?.(child) ?? null;
        out.push({ name, kind: 'function', startLine, endLine, lineCount: endLine - startLine + 1, ...(stub && { stub }), parent, outer });
        log(logTag, 'nested', { file, name, start: startLine, end: endLine, ...(stub && { stub }) });
        walk(child, scopes.has(child.type), name, outer);
        continue;
      }
      walk(child, inside || scopes.has(child.type), parent, outer);
    }
  };
  for (const e of elements) {
    const node = nodes.get(e);
    if (!node || (e.kind !== 'function' && e.kind !== 'method')) continue;
    walk(node, scopes.has(node.type), e.name, e.name);
  }
  sortElements(out);
  return out;
}

/**
 * Make element names unique in one (sorted) file: a later repeat of a name gets `#2`, `#3`, ... (the
 * convention of compare/diff.ts), because `file#name` is the element id downstream. Covers overloads,
 * the same method in two impl blocks and the same name in two modules or namespaces.
 */
function suffixDuplicateNames(elements: CodeElement[], logTag: string, file: string): void {
  const taken = new Set<string>();
  for (const e of elements) {
    const renamed = uniqueName(e.name, taken);
    if (renamed !== e.name) {
      log(logTag, 'rename', { file, name: e.name, to: renamed, line: e.startLine, reason: 'name already used in this file' });
      e.name = renamed;
    }
    taken.add(e.name);
  }
}

/**
 * Collects elements for one file, the one place every handler builds CodeElements and counts lines;
 * `finish` returns the sorted FileOutline with unique names (later repeats get `#2`, `#3`).
 * A name is stored on one line: each whitespace run becomes one space (a C++ template specialization
 * written over several lines, `fmt<\n  S, Char>` -> `fmt< S, Char>`), before repeats are suffixed.
 * `elements` is the list so far, in add order, for a handler rule that drops some before `finish`
 * (TypeScript type names). With `nested` rules, `finish` also lists the functions declared inside function bodies (b782).
 */
export function createOutlineBuilder(logTag: string, tree: Parser.Tree, file: string, code: string) {
  const elements: CodeElement[] = [];
  const nodes = new Map<CodeElement, Parser.SyntaxNode>();
  const builder = {
    elements,
    /** Add an element by its 1-based inclusive line range. */
    addLines(rawName: string, kind: ElementKind, startLine: number, endLine: number, stub?: StubKind | null): void {
      const name = rawName.replace(/\s+/g, ' ');
      const elem: CodeElement = { name, kind, startLine, endLine, lineCount: endLine - startLine + 1 };
      if (stub) elem.stub = stub;
      elements.push(elem);
      log(logTag, 'element', { file, name, kind, start: startLine, end: endLine, ...(stub && { stub }) });
    },
    /** Add an element spanning a node's lines. */
    add(name: string, kind: ElementKind, node: Parser.SyntaxNode, stub?: StubKind | null): void {
      builder.addLines(name, kind, node.startPosition.row + 1, node.endPosition.row + 1, stub);
      nodes.set(elements[elements.length - 1], node);
    },
    finish(nested?: NestedRules): FileOutline {
      sortElements(elements);
      suffixDuplicateNames(elements, logTag, file);
      const inner = nested ? collectNested(elements, nodes, nested, logTag, file) : [];
      log(logTag, 'result', { file, elements: elements.length, nested: inner.length });
      return { file, lineCount: countLines(code), parseError: tree.rootNode.hasError, elements, ...(inner.length > 0 && { nested: inner }) };
    },
  };
  return builder;
}

/**
 * b782/b787: the elements of `outline` named exactly `name`, else its nested functions of that name (duplicates kept).
 * A nested name never repeats an element name (collectNested), so one list at most has hits. The one exact-name
 * lookup of show, resolve-link, check and edit.
 */
export function elementsNamed(outline: Pick<FileOutline, 'elements' | 'nested'>, name: string): CodeElement[] {
  const hits = outline.elements.filter((e) => e.name === name);
  return hits.length > 0 ? hits : (outline.nested ?? []).filter((e) => e.name === name);
}

/** One import a rule found: `kind` defaults to 'import', `line` to the first line of the matched node. */
export interface ImportHit {
  spec: string;
  kind?: ImportKind;
  line?: number;
}

/**
 * How one node type gives imports. `hits` returns the node's imports, or null when the node is not an
 * import after all (it is then walked like any other node). After a match the walk does not enter the
 * node, unless `descend` is set.
 */
export interface ImportRule {
  hits(node: Parser.SyntaxNode): ImportHit[] | null;
  descend?: boolean;
}

/**
 * The imports of one file: walks the tree, applies the rule of each node type, drops empty specs and
 * repeats (same spec, kind and line), sorts by line then spec, and logs under `logTag`. The language
 * gives only its node-type rules.
 */
export function collectImports(tree: Parser.Tree, rules: Record<string, ImportRule>, logTag: string): RawImport[] {
  const found = new Map<string, RawImport>();
  function visit(node: Parser.SyntaxNode): void {
    const rule = rules[node.type];
    const hits = rule?.hits(node);
    if (rule && hits) {
      const nodeLine = node.startPosition.row + 1;
      for (const hit of hits) {
        if (!hit.spec) continue;
        const imp: RawImport = { spec: hit.spec, kind: hit.kind ?? 'import', line: hit.line ?? nodeLine };
        const key = `${imp.spec}|${imp.kind}|${imp.line}`;
        if (found.has(key)) continue;
        found.set(key, imp);
        log(logTag, 'record', imp);
      }
      if (!rule.descend) return;
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(tree.rootNode);
  const result = Array.from(found.values()).sort((a, b) =>
    a.line !== b.line ? a.line - b.line : a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0);
  log(logTag, 'result', { count: result.length });
  return result;
}

// -- Calls kit (b592): the owner sweep, the value-use walk and the calls collector every calls reader shares.

/** b682: 1-based line and column of a node's start; the column counts UTF-16 code units (an index into the JS line). */
export function nodePosition(n: Parser.SyntaxNode): { line: number; column: number } {
  return { line: n.startPosition.row + 1, column: n.startPosition.column + 1 };
}

/**
 * The owners of a file's calls by line: the outline's functions, methods and test cases open at a line, outermost first,
 * so the last one is the nearest named owner (none open: MODULE_CALLER). Lines must be asked in ascending order (a walk
 * in document order); the stack returned is the sweep's own array, read it before the next `at`.
 */
export function createOwnerSweep(outline: FileOutline): { at(line: number): CodeElement[] } {
  const owners = outline.elements
    .filter((e) => e.kind === 'function' || e.kind === 'method' || e.kind === 'test')
    .sort((a, b) => a.startLine - b.startLine);   // outline order is already this; the sweep needs it
  let next = 0;
  const open: CodeElement[] = [];
  return {
    at(line: number): CodeElement[] {
      while (open.length > 0 && open[open.length - 1].endLine < line) open.pop();
      while (next < owners.length && owners[next].startLine <= line) {
        while (open.length > 0 && open[open.length - 1].endLine < owners[next].startLine) open.pop();
        open.push(owners[next]);
        next++;
      }
      while (open.length > 0 && open[open.length - 1].endLine < line) open.pop();
      return open;
    },
  };
}

/** How a language reads value uses of names (collectNameUses). */
export interface UseRules {
  /** Node types of a name. */
  identifiers: string[];
  /** Byte ranges where a name of `names` is a local one (declared again in an inner scope), by name. */
  shadowed(root: Parser.SyntaxNode, names: Set<string>): Map<string, [number, number][]>;
  /** True when the name node declares or binds the name, or is no value by its place (a keyword argument's name). */
  declares(id: Parser.SyntaxNode): boolean;
  /** Ancestor node types under which a name is never a value use (type positions, import statements). */
  notValue: ReadonlySet<string>;
  /** The member access that extends `chain` by one name (`ns.a` -> `ns.a.b`), else null. */
  extend(chain: Parser.SyntaxNode): Parser.SyntaxNode | null;
  /** The chain written like RawCall.callee (`ns.a.b`); null: the name's own text. */
  chainName(chain: Parser.SyntaxNode): string | null;
  /** True when `chain` is the callee of a call: a call site (RawCall), not a use. */
  isCallee(chain: Parser.SyntaxNode): boolean;
}

/**
 * Value uses of the given names outside callee position (`expect(fn)`, `{ fn }`, `ns.member` passed on), each written as
 * the longest member chain the name heads, at the name's position. A callee is a call site, not a use; declarations,
 * bindings and the language's non-value places are never uses; a name declared again in an inner scope is the local one
 * there. Shared by the TypeScript reader (imported and own names) and every calls collector (b592).
 */
export function collectNameUses(root: Parser.SyntaxNode, names: Set<string>, rules: UseRules): ImportUse[] {
  if (names.size === 0) return [];
  const shadowed = rules.shadowed(root, names);
  const out: ImportUse[] = [];
  for (const id of root.descendantsOfType(rules.identifiers)) {
    if (!names.has(id.text)) continue;
    if ((shadowed.get(id.text) ?? []).some(([s, e]) => s <= id.startIndex && id.startIndex < e)) continue;
    if (rules.declares(id)) continue;
    let ctx: Parser.SyntaxNode | null = id.parent;
    while (ctx && !rules.notValue.has(ctx.type)) ctx = ctx.parent;
    if (ctx) continue;
    let chain = id;
    for (let p = rules.extend(chain); p; p = rules.extend(chain)) chain = p;
    if (rules.isCallee(chain)) continue;
    out.push({ name: rules.chainName(chain) ?? id.text, ...nodePosition(id) });
  }
  return out;
}

/** The spec of a builtin's binding: no import record has it, so the pipeline leaves the binding external. */
const BUILTIN_SPEC = '<builtin>';

/** A callee as a language reads it (CallRules.callee). */
export interface CalleeHit {
  /** The dotted name chain as written (`f`, `a.b`, `self.m`); null when the callee is not a name chain. */
  name: string | null;
  /** The called name's node, the chain's last name (RawCall.at); null with a null name. */
  nameNode: Parser.SyntaxNode | null;
  /** The chain's first name node (`self` in `self.m`), asked by the receiver rule; null with a null name. */
  head: Parser.SyntaxNode | null;
}

/** How a language gives its calls (createCallsCollector). */
export interface CallRules {
  /** Node types of a call. */
  calls: string[];
  callee(call: Parser.SyntaxNode): CalleeHit;
  /** True when name node `head` is the own receiver of the method it sits in (Python `self`, `cls`): written `this`. */
  receiver(head: Parser.SyntaxNode): boolean;
  /** Node types that may bind a variable to a new instance (`x = C(...)`). */
  instanceNodes: string[];
  /** The instance a node binds, else null. */
  instance(node: Parser.SyntaxNode): InstanceBinding | null;
  /** The names the file's import statements bind, specs written exactly as the language's imports write them. */
  bindings(root: Parser.SyntaxNode): ImportBinding[];
  /** Builtin names: a called one that no import binds and the file does not define gets an external binding. */
  builtins: ReadonlySet<string>;
  /** Value uses of `names` (collectNameUses with the language's UseRules). */
  uses(root: Parser.SyntaxNode, names: Set<string>): ImportUse[];
}

/**
 * The calls of one file for the call graph (b592), from the language's rules: one RawCall per call node, owned by the
 * nearest enclosing function, method or test case of the outline (createOwnerSweep), else MODULE_CALLER; a chain headed
 * by the method's own receiver is written `this.x`. Also the import bindings plus an external binding per called
 * builtin, the instances (`x = C(...)`; null on conflict: a name two classes claim is left out), and the value uses of
 * the imported names (`uses`) and of the file's own top-level functions and classes (`ownUses`), each set when there
 * are some. The judge (callGraph/callResolve.ts) reads the result like the TypeScript reader's.
 */
export function createCallsCollector(tree: Parser.Tree, outline: FileOutline, rules: CallRules, logTag: string): FileCalls {
  const root = tree.rootNode;
  const sweep = createOwnerSweep(outline);
  const callTypes = new Set(rules.calls);
  const calls: RawCall[] = [];
  const seenClass = new Map<string, string | null>();   // variable -> class; null when two classes claim the name
  for (const n of root.descendantsOfType([...rules.calls, ...rules.instanceNodes])) {
    if (!callTypes.has(n.type)) {
      const inst = rules.instance(n);
      if (inst) {
        const prev = seenClass.get(inst.name);
        seenClass.set(inst.name, prev === undefined || prev === inst.className ? inst.className : null);
      }
      continue;
    }
    const { name, nameNode, head } = rules.callee(n);
    const line = n.startPosition.row + 1;
    const open = sweep.at(line);
    const callee = name !== null && head && name.length > head.text.length && rules.receiver(head) ? `this${name.slice(head.text.length)}` : name;
    calls.push({ caller: open.length > 0 ? open[open.length - 1].name : MODULE_CALLER, line, callee, ...(nameNode && { at: nodePosition(nameNode) }) });
  }

  const instances: InstanceBinding[] = [];
  for (const [name, className] of seenClass) if (className !== null) instances.push({ name, className });
  const bindings = rules.bindings(root);
  const ownNames = outline.elements.filter((e) => (e.kind === 'function' || e.kind === 'class') && !e.name.includes('.')).map((e) => e.name);
  const uses = rules.uses(root, new Set(bindings.map((b) => b.local)));
  const ownUses = rules.uses(root, new Set(ownNames));
  const taken = new Set([...bindings.map((b) => b.local), ...ownNames]);
  for (const c of calls) {
    const headName = c.callee === null ? null : c.callee.split('.')[0];
    if (headName === null || taken.has(headName) || !rules.builtins.has(headName)) continue;
    taken.add(headName);
    bindings.push({ local: headName, imported: headName, spec: BUILTIN_SPEC, external: true });
  }
  log(logTag, 'calls', { file: outline.file, calls: calls.length, bindings: bindings.length, instances: instances.length, uses: uses.length, ownUses: ownUses.length });
  return {
    file: outline.file, bindings, instances, calls,
    ...(uses.length > 0 && { uses }),
    ...(ownUses.length > 0 && { ownUses }),
  };
}
