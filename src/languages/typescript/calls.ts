import Parser from 'tree-sitter';
import { CodeElement, FileCalls, FileOutline, ImportBinding, ImportMock, ImportUse, InstanceBinding, PathLiteral, PathParam, RawCall } from '../../types';
import { log } from '../../log';
import { MODULE_CALLER } from '../../constants';
import { collectNameUses, createOwnerSweep, nodePosition } from '../treesitter';
import type { UseRules } from '../treesitter';
import { shadowedRanges } from './scope';

/** Pseudo caller of calls that sit in no named function or method; defined in Foundation (b592), re-exported here. */
export { MODULE_CALLER };

/** `a`, `a.b`, `this.b`, `a.b.c` as written; null when the callee is anything else (call result, computed access, ...). */
function calleeName(fn: Parser.SyntaxNode | null): string | null {
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type !== 'member_expression') return null;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!prop || prop.type !== 'property_identifier') return null;
  if (obj?.type === 'this') return `this.${prop.text}`;
  const head = calleeName(obj);
  return head === null ? null : `${head}.${prop.text}`;
}

/** b682: the node of the called name, the last segment of `calleeName` (`old` in `a.b.old`); null when that is null. */
function calleeNameNode(fn: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  if (!fn || calleeName(fn) === null) return null;
  return fn.type === 'identifier' ? fn : fn.childForFieldName('property');
}

function stringValue(node: Parser.SyntaxNode | null): string | null {
  return node?.type === 'string' ? node.text.slice(1, -1) : null;
}

const hasTypeKeyword = (n: Parser.SyntaxNode): boolean => n.children.some((c) => c.type === 'type');

/** `require('spec')` with one string argument: the spec; else null. */
function requireSpec(value: Parser.SyntaxNode | null): string | null {
  if (value?.type !== 'call_expression') return null;
  const fn = value.childForFieldName('function');
  const args = value.childForFieldName('arguments')?.namedChildren ?? [];
  return fn?.type === 'identifier' && fn.text === 'require' && args.length === 1 ? stringValue(args[0]) : null;
}

/** Top-level `const x = require('s')` / `const { a, b: c } = require('s')`: like `import * as x` / `import { a, b as c }`. */
function requireBindings(stmt: Parser.SyntaxNode, out: ImportBinding[]): void {
  if (stmt.type !== 'lexical_declaration' && stmt.type !== 'variable_declaration') return;
  for (const d of stmt.namedChildren) {
    const spec = d.type === 'variable_declarator' ? requireSpec(d.childForFieldName('value')) : null;
    const name = spec === null ? null : d.childForFieldName('name');
    if (!spec || !name) continue;
    if (name.type === 'identifier') out.push({ local: name.text, imported: '*', spec });
    if (name.type !== 'object_pattern') continue;
    for (const p of name.namedChildren) {
      if (p.type === 'shorthand_property_identifier_pattern') out.push({ local: p.text, imported: p.text, spec, at: nodePosition(p) });
      const key = p.type === 'pair_pattern' ? p.childForFieldName('key') : null;
      const value = p.type === 'pair_pattern' ? p.childForFieldName('value') : null;
      if (key?.type === 'property_identifier' && value?.type === 'identifier') out.push({ local: value.text, imported: key.text, spec, at: nodePosition(key) });
    }
  }
}

/** Names bound by the top-level `import` statements and `require` declarations (nothing deeper is walked). */
function importBindings(root: Parser.SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const stmt of root.children) {
    requireBindings(stmt, out);
    if (stmt.type !== 'import_statement') continue;
    const spec = stringValue(stmt.childForFieldName('source'));
    const clause = stmt.children.find((c) => c.type === 'import_clause');
    if (!spec || !clause) continue;
    const allTypes = hasTypeKeyword(stmt);   // `import type { A } from ...`
    const add = (local: string, imported: string, typeOnly: boolean, name?: Parser.SyntaxNode): void => {
      out.push({ local, imported, spec, ...(typeOnly && { typeOnly: true as const }), ...(name && { at: nodePosition(name) }) });
    };
    for (const part of clause.children) {
      if (part.type === 'identifier') {
        add(part.text, 'default', allTypes);
      } else if (part.type === 'namespace_import') {
        const id = part.children.find((c) => c.type === 'identifier');
        if (id) add(id.text, '*', allTypes);
      } else if (part.type === 'named_imports') {
        for (const s of part.children) {
          if (s.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name');
          const alias = s.childForFieldName('alias')?.text;
          // `import { type B, c }`; b682: the position of the imported name, none for `import { default as x }`
          if (name) add(alias ?? name.text, name.text, allTypes || hasTypeKeyword(s), name.text === 'default' ? undefined : name);
        }
      }
    }
  }
  return out;
}

/** Calls that replace a module for a test (Phase 26 D5): their first argument is the module specifier. */
const MOCK_CALLEES = new Set(['jest.mock', 'jest.doMock', 'jest.unstable_mockModule', 'vi.mock', 'vi.doMock']);
const FUNCTION_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
/** An identifier under one of these is a type or the import itself, never a value use. */
const NOT_VALUE_CONTEXT = new Set(['type_query', 'nested_type_identifier', 'import_statement']);

const startLineOf = (n: Parser.SyntaxNode): number => n.startPosition.row + 1;
const spansElement = (n: Parser.SyntaxNode, el: CodeElement): boolean =>
  startLineOf(n) === el.startLine && n.endPosition.row + 1 === el.endLine;

/**
 * True when call `n` is the `it('x', () => ...)` that declares test case `el` on the case's first line: it passes a
 * function spanning the case (itself, or as the callee of `it.each(t)('x', fn)`) and sits in no such function.
 * The declaring call is not inside the case; the calls in its callback are.
 */
function declaresCase(n: Parser.SyntaxNode, el: CodeElement): boolean {
  if (startLineOf(n) !== el.startLine) return false;
  for (let p = n.parent; p; p = p.parent) if (FUNCTION_TYPES.has(p.type) && spansElement(p, el)) return false;
  for (let c: Parser.SyntaxNode | null = n; c?.type === 'call_expression'; ) {
    const args = c.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.some((a) => FUNCTION_TYPES.has(a.type) && spansElement(a, el))) return true;
    const outer: Parser.SyntaxNode | null = c.parent;
    c = outer?.type === 'call_expression' && outer.childForFieldName('function')?.startIndex === c.startIndex ? outer : null;
  }
  return false;
}

/** The name a `require` declaration binds (`x` or a pattern name of `const { a: x } = require(...)`): not a use. */
function bindsRequire(id: Parser.SyntaxNode): boolean {
  let n = id;
  while (n.parent && (n.parent.type === 'object_pattern' || n.parent.type === 'pair_pattern')) n = n.parent;
  const d = n.parent;
  return d?.type === 'variable_declarator' && d.childForFieldName('name')?.startIndex === n.startIndex && requireSpec(d.childForFieldName('value')) !== null;
}

/** b682: nodes whose `name` field declares a name, and `export { a as b }` (field `alias`): the identifier there is no use. */
const DECLARING_FIELD = new Map([
  ['function_declaration', 'name'], ['generator_function_declaration', 'name'], ['function_signature', 'name'],
  ['function_expression', 'name'], ['class_declaration', 'name'], ['class', 'name'], ['variable_declarator', 'name'],
  ['export_specifier', 'alias'],
]);
const declaresName = (id: Parser.SyntaxNode): boolean => {
  const field = id.parent ? DECLARING_FIELD.get(id.parent.type) : undefined;
  return field !== undefined && id.parent!.childForFieldName(field)?.startIndex === id.startIndex;
};

/** b592: how TypeScript reads value uses (the kit's collectNameUses walk). */
const TS_USE_RULES: UseRules = {
  identifiers: ['identifier', 'shorthand_property_identifier'],
  // A top-level declaration (an own name) or a `require` declaration (an import) is the binding itself, not a shadow.
  shadowed: (root, names) => shadowedRanges(root, (name, scope, decl) => names.has(name) && scope.type !== 'program'
    && !(decl.type === 'variable_declarator' && requireSpec(decl.childForFieldName('value')) !== null)),
  declares: (id) => bindsRequire(id) || declaresName(id),
  notValue: NOT_VALUE_CONTEXT,
  // `ns.a.b`: the longest member chain the name heads
  extend: (chain) => {
    const p = chain.parent;
    return p?.type === 'member_expression' && p.childForFieldName('object')?.startIndex === chain.startIndex
      && p.childForFieldName('property')?.type === 'property_identifier' ? p : null;
  },
  chainName: calleeName,
  isCallee: (chain) => chain.parent?.type === 'call_expression' && chain.parent.childForFieldName('function')?.startIndex === chain.startIndex,
};

/**
 * Value uses of the given names outside callee position (Phase 26 for imports -> FileCalls.uses; b682 also for the
 * file's own top-level names -> FileCalls.ownUses): `expect(fn)`, `new Foo()`, `{ fn }`, `export { fn }`, `ns.member`
 * passed on. A callee is a call site (RawCall), not a use; type positions and declarations are never uses; a name
 * declared again in an inner scope is the local one there.
 */
function nameUses(root: Parser.SyntaxNode, names: Set<string>): ImportUse[] {
  return collectNameUses(root, names, TS_USE_RULES);
}

/** A string that may name a file: one line, with a `/` or ending in a file extension (T26-8). */
const PATH_LIKE = (v: string): boolean => v.length > 0 && v.length <= 260 && !v.includes('\n') && (v.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(v));
/** A string under one of these is a module specifier or a type, never a path read at run time. */
const SPEC_PARENTS = new Set(['import_statement', 'export_statement', 'import_require_clause', 'literal_type']);

/** True when string `n` is a module specifier: an import/export source, or the argument of `require`, `import()` or a mock. */
function isModuleSpec(n: Parser.SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  if (SPEC_PARENTS.has(p.type)) return true;
  const fn = p.type === 'arguments' && p.parent?.type === 'call_expression' ? p.parent.childForFieldName('function') : null;
  if (!fn) return false;
  if (fn.type === 'import') return true;
  const callee = calleeName(fn);
  return callee === 'require' || (callee !== null && MOCK_CALLEES.has(callee));
}

// T26-8b (D22): a path string is file reach only when it goes into a file/path/process call or a helper that does.
/** Modules whose every function takes or returns paths (`node:` prefix removed). */
const FS_MODULES = new Set(['fs', 'fs/promises', 'fs-extra', 'graceful-fs']);
/** Path and process functions that take paths. */
const PATH_FNS = new Set(['join', 'resolve']);
const PROCESS_FNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** An expression under one of these still flows into the enclosing argument or variable (`a + '/x'`, `[cli, arg]`,
 *  `${root}/${rel}`). */
const PASS_THROUGH = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression',
  'binary_expression', 'array', 'spread_element', 'await_expression', 'template_substitution', 'template_string']);
export const FUNCTION_NODES = ['function_declaration', 'generator_function_declaration', 'arrow_function', 'function_expression',
  'function', 'generator_function', 'method_definition'];

/**
 * The file, path or process call `callee` names, as `<module>.<function>` (`fs.readFileSync`, `fs/promises.readFile`,
 * `path.join`, `child_process.spawnSync`, `require.resolve`), else null. A bound name goes by its import's module
 * (`import { readFileSync } from 'node:fs'`); an unbound head `fs` / `path` / `child_process` by its name (a nested
 * `const fs = require('fs')`).
 */
function fileCallOf(callee: string | null, bindings: Map<string, ImportBinding>): string | null {
  if (callee === null) return null;
  if (callee === 'require.resolve') return callee;
  const [head, ...rest] = callee.split('.');
  const b = bindings.get(head);
  const mod = b ? b.spec.replace(/^node:/, '') : head;
  const chain = b && b.imported !== '*' && b.imported !== 'default' ? [b.imported, ...rest] : rest;
  const last = chain[chain.length - 1];
  if (last === undefined) return null;
  const takesPath = FS_MODULES.has(mod) || (mod === 'path' && PATH_FNS.has(last)) || (mod === 'child_process' && PROCESS_FNS.has(last));
  return takesPath ? `${mod}.${chain.join('.')}` : null;
}

type Destination = { call: Parser.SyntaxNode; index: number } | { variable: Parser.SyntaxNode } | null;

/** Where expression `n` goes: argument `index` of a call, or the value of a `const x = ...` it initialises, else null. */
function destinationOf(n: Parser.SyntaxNode): Destination {
  let c = n;
  while (c.parent && PASS_THROUGH.has(c.parent.type)) c = c.parent;
  const p = c.parent;
  if (p?.type === 'arguments' && p.parent?.type === 'call_expression') {
    return { call: p.parent, index: p.namedChildren.filter((a) => a.type !== 'comment').findIndex((a) => a.startIndex === c.startIndex) };
  }
  const name = p?.type === 'variable_declarator' && p.childForFieldName('value')?.startIndex === c.startIndex ? p.childForFieldName('name') : null;
  return name?.type === 'identifier' ? { variable: name } : null;
}

/** The calls expression `n` is an argument of, directly or through the one variable it initialises (read in the
 *  variable's block; a redeclared name is not told apart). */
function sinkCalls(n: Parser.SyntaxNode): { call: Parser.SyntaxNode; index: number }[] {
  const d = destinationOf(n);
  if (!d) return [];
  if ('call' in d) return [d];
  let scope = d.variable.parent;
  while (scope && scope.type !== 'statement_block' && scope.type !== 'program') scope = scope.parent;
  const out: { call: Parser.SyntaxNode; index: number }[] = [];
  for (const id of scope?.descendantsOfType('identifier') ?? []) {
    if (id.text !== d.variable.text || id.startIndex === d.variable.startIndex) continue;
    const u = destinationOf(id);
    if (u && 'call' in u) out.push(u);
  }
  return out;
}

/** The first file/path/process call among `sinks`, else null. */
function fileSink(sinks: { call: Parser.SyntaxNode }[], bindings: Map<string, ImportBinding>): string | null {
  for (const s of sinks) {
    const call = fileCallOf(calleeName(s.call.childForFieldName('function')), bindings);
    if (call) return call;
  }
  return null;
}

/**
 * Phase 26 (T26-8, D6): string literals that may name a repo file (`'viewer/panel.js'`, `'../viewer/panel.js'`), plain
 * strings and template strings without `${}`. Module specifiers are left out (the import pass owns them). Whether a
 * value is a scanned path is decided by the reader (c4/testAttach.ts), never guessed here.
 * T26-8b (D22): each carries where it goes: the file/path/process call (`call`), else the other calls it is passed to
 * (`args`, candidate test helpers). A literal with neither is a data string.
 */
function pathLiterals(root: Parser.SyntaxNode, bindings: Map<string, ImportBinding>): PathLiteral[] {
  const out: PathLiteral[] = [];
  for (const n of root.descendantsOfType(['string', 'template_string'])) {
    if (n.type === 'template_string' && n.namedChildren.some((c) => c.type === 'template_substitution')) continue;
    const value = n.text.slice(1, -1);
    if (!PATH_LIKE(value) || isModuleSpec(n)) continue;
    const sinks = sinkCalls(n);
    const call = fileSink(sinks, bindings);
    const args = call ? [] : sinks.flatMap(({ call: c, index }) => {
      const callee = calleeName(c.childForFieldName('function'));
      return callee === null ? [] : [{ callee, line: startLineOf(c), index }];
    });
    out.push({ value, line: startLineOf(n), ...(call && { call }), ...(args.length > 0 && { args }) });
  }
  return out;
}

/** Simple parameter names of function node `fn` by position (null for a destructured or `this` parameter). */
function paramNames(fn: Parser.SyntaxNode): (Parser.SyntaxNode | null)[] {
  const single = fn.childForFieldName('parameter');
  if (single) return [single.type === 'identifier' ? single : null];
  return (fn.childForFieldName('parameters')?.namedChildren ?? []).filter((p) => p.type !== 'comment').map((p) => {
    const id = p.type === 'required_parameter' || p.type === 'optional_parameter' ? p.childForFieldName('pattern')
      : p.type === 'assignment_pattern' ? p.childForFieldName('left') : p;
    return id?.type === 'identifier' ? id : null;
  });
}

/**
 * Phase 26 (T26-8b): parameters of the outline's functions and methods that go into a file/path/process call in the
 * body, directly or through one local variable (`const full = path.join(root, rel)`). A test helper `read(rel)` then
 * makes `read('src/x.ts')` file reach. One level: a parameter passed on to another helper is not followed.
 */
function pathParams(root: Parser.SyntaxNode, outline: FileOutline, bindings: Map<string, ImportBinding>): PathParam[] {
  const fileCallLines = root.descendantsOfType('call_expression')
    .filter((c) => fileCallOf(calleeName(c.childForFieldName('function')), bindings) !== null).map(startLineOf);
  if (fileCallLines.length === 0) return [];
  const fns = root.descendantsOfType(FUNCTION_NODES);
  const out: PathParam[] = [];
  for (const el of outline.elements) {
    if ((el.kind !== 'function' && el.kind !== 'method') || !fileCallLines.some((l) => l >= el.startLine && l <= el.endLine)) continue;
    const fn = fns.find((n) => startLineOf(n) >= el.startLine && n.endPosition.row + 1 === el.endLine);
    const body = fn?.childForFieldName('body');
    if (!fn || !body) continue;
    paramNames(fn).forEach((param, index) => {
      if (!param) return;
      for (const id of body.descendantsOfType('identifier')) {
        const call = id.text === param.text ? fileSink(sinkCalls(id), bindings) : null;
        if (call) { out.push({ fn: el.name, index, call }); return; }
      }
    });
  }
  return out;
}

/**
 * Call sites of one file (TypeScript / JavaScript). One pass over the tree's call expressions and variable
 * declarators; the owner of a call is found by sweeping the outline's elements by line (the kit's createOwnerSweep), so a call inside an
 * anonymous callback belongs to the nearest enclosing named function, method or test case (Phase 26: the
 * `it`/`test` callback of a test file), else to MODULE_CALLER (in a test file: describe bodies and hooks too).
 * `require(...)`, `import(...)` and `super(...)` are not calls here (the import pass owns them).
 * Also the value uses of imported names (`uses`), the mocked module specifiers (`mocks`) and the string literals that
 * may name a file (`pathLiterals`), each set when there are some.
 */
export function extractCalls(tree: Parser.Tree, outline: FileOutline): FileCalls {
  const root = tree.rootNode;
  const sweep = createOwnerSweep(outline);

  const calls: RawCall[] = [];
  const mocks: ImportMock[] = [];
  const seenClass = new Map<string, string | null>();   // variable -> class; null when two classes claim the name

  for (const n of root.descendantsOfType(['call_expression', 'variable_declarator'])) {
    if (n.type === 'variable_declarator') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      const ctor = value?.type === 'new_expression' ? value.childForFieldName('constructor') : null;
      if (name?.type === 'identifier' && ctor?.type === 'identifier') {
        const prev = seenClass.get(name.text);
        seenClass.set(name.text, prev === undefined || prev === ctor.text ? ctor.text : null);
      }
      continue;
    }
    const fn = n.childForFieldName('function');
    if (!fn || fn.type === 'import' || fn.type === 'super' || (fn.type === 'identifier' && fn.text === 'require')) continue;

    const line = n.startPosition.row + 1;
    const open = sweep.at(line);
    let top = open.length - 1;
    if (top >= 0 && open[top].kind === 'test' && declaresCase(n, open[top])) top--;
    const callee = calleeName(fn);
    const nameNode = calleeNameNode(fn);
    calls.push({ caller: top >= 0 ? open[top].name : MODULE_CALLER, line, callee, ...(nameNode && { at: nodePosition(nameNode) }) });
    const spec = callee !== null && MOCK_CALLEES.has(callee) ? stringValue(n.childForFieldName('arguments')?.namedChild(0) ?? null) : null;
    if (spec) mocks.push({ spec, line });
  }

  const instances: InstanceBinding[] = [];
  for (const [name, className] of seenClass) if (className !== null) instances.push({ name, className });
  const bindings = importBindings(root);
  const uses = nameUses(root, new Set(bindings.map((b) => b.local)));
  const ownNames = outline.elements.filter((e) => (e.kind === 'function' || e.kind === 'class') && !e.name.includes('.')).map((e) => e.name);
  const ownUses = nameUses(root, new Set(ownNames));
  const bound = new Map(bindings.map((b) => [b.local, b]));
  const literals = pathLiterals(root, bound);
  const params = pathParams(root, outline, bound);
  const result: FileCalls = {
    file: outline.file, bindings, instances, calls,
    ...(uses.length > 0 && { uses }),
    ...(ownUses.length > 0 && { ownUses }),
    ...(mocks.length > 0 && { mocks }),
    ...(literals.length > 0 && { pathLiterals: literals }),
    ...(params.length > 0 && { pathParams: params }),
  };
  log('calls', 'result', { file: outline.file, calls: calls.length, uses: uses.length, ownUses: ownUses.length, mocks: mocks.length, pathLiterals: literals.length, pathParams: params.length });
  return result;
}
