import Parser from 'tree-sitter';
import type { FileCalls, FileOutline, ImportBinding, InstanceBinding } from '../../types';
import { collectNameUses, createCallsCollector, nodePosition } from '../treesitter';
import type { CalleeHit, CallRules, UseRules } from '../treesitter';
import { getDottedNameSpec, getRelativeImportSpec } from './imports';

// b592 (LG-2): Python calls through the kit's calls collector. Python's scoping: a name bound anywhere in a function,
// lambda or comprehension is local to the whole of it (not to a block).

/** Python's builtin functions and exception classes: a call to one is external (its binding has spec '<builtin>'). */
const BUILTINS: ReadonlySet<string> = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
  'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object',
  'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__',
  'BaseException', 'BaseExceptionGroup', 'Exception', 'ExceptionGroup', 'ArithmeticError', 'AssertionError',
  'AttributeError', 'BlockingIOError', 'BrokenPipeError', 'BufferError', 'ChildProcessError', 'ConnectionAbortedError',
  'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError', 'EOFError', 'EnvironmentError', 'FileExistsError',
  'FileNotFoundError', 'FloatingPointError', 'GeneratorExit', 'IOError', 'ImportError', 'IndentationError', 'IndexError',
  'InterruptedError', 'IsADirectoryError', 'KeyError', 'KeyboardInterrupt', 'LookupError', 'MemoryError',
  'ModuleNotFoundError', 'NameError', 'NotADirectoryError', 'NotImplementedError', 'OSError', 'OverflowError',
  'PermissionError', 'ProcessLookupError', 'RecursionError', 'ReferenceError', 'RuntimeError', 'StopAsyncIteration',
  'StopIteration', 'SyntaxError', 'SystemError', 'SystemExit', 'TabError', 'TimeoutError', 'TypeError',
  'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'UnicodeTranslateError', 'ValueError',
  'ZeroDivisionError', 'Warning', 'UserWarning', 'DeprecationWarning', 'PendingDeprecationWarning', 'RuntimeWarning',
  'SyntaxWarning', 'FutureWarning', 'ImportWarning', 'UnicodeWarning', 'BytesWarning', 'ResourceWarning', 'EncodingWarning',
]);

/** Nodes a name is local to (Python scoping). A class body is not one: its names are not visible in its methods. */
const SCOPE_TYPES = new Set(['function_definition', 'lambda', 'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
/** Target patterns a bound name may sit in (`a, (b, *c) = ...`, `*args`, `**kw`). */
const PATTERN_TYPES = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'list_splat_pattern', 'dictionary_splat_pattern']);
const IMPORT_TYPES = ['import_statement', 'import_from_statement'];
/** A name under one of these is never a value use. */
const NOT_VALUE = new Set([...IMPORT_TYPES, 'future_import_statement', 'global_statement', 'nonlocal_statement']);

/** True when field `field` of `parent` holds `child`. */
const inField = (parent: Parser.SyntaxNode, field: string, child: Parser.SyntaxNode): boolean =>
  parent.childForFieldName(field)?.startIndex === child.startIndex;

/** `f`, `a.b`, `self.m`, `a.b.c` as written; null when the node is anything else (a call result, a subscript, ...). */
function chainName(n: Parser.SyntaxNode | null): string | null {
  if (!n) return null;
  if (n.type === 'identifier') return n.text;
  if (n.type !== 'attribute') return null;
  const attr = n.childForFieldName('attribute');
  if (attr?.type !== 'identifier') return null;
  const head = chainName(n.childForFieldName('object'));
  return head === null ? null : `${head}.${attr.text}`;
}

/** The callee of a `call` node: the name chain, its last name (`at`) and its first name (the receiver rule). */
function calleeOf(call: Parser.SyntaxNode): CalleeHit {
  const fn = call.childForFieldName('function');
  const name = chainName(fn);
  if (!fn || name === null) return { name: null, nameNode: null, head: null };
  let head = fn;
  while (head.type === 'attribute') head = head.childForFieldName('object')!;
  return { name, nameNode: fn.type === 'identifier' ? fn : fn.childForFieldName('attribute'), head };
}

/** The name node of one parameter (`x`, `x=1`, `x: int`, `x: int = 1`, `*args`, `**kw`); null for `/` and `*`. */
function parameterName(p: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (p.type === 'identifier') return p;
  if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') return p.childForFieldName('name');
  if (p.type === 'typed_parameter' || PATTERN_TYPES.has(p.type)) {
    const inner = p.namedChildren.find((c) => c.type === 'identifier' || PATTERN_TYPES.has(c.type));
    return inner ? parameterName(inner) : null;
  }
  return null;
}

/** True when function node `fn` is a method of a top-level class (the outline lists those as `Class.method`) and not
 *  a `@staticmethod`: its first parameter is then the receiver (`self`, or `cls` of a classmethod). */
function hasReceiver(fn: Parser.SyntaxNode): boolean {
  const decorated = fn.parent?.type === 'decorated_definition' ? fn.parent : null;
  if (decorated?.namedChildren.some((d) => d.type === 'decorator' && d.namedChild(0)?.type === 'identifier' && d.namedChild(0)!.text === 'staticmethod')) return false;
  const holder = decorated ?? fn;
  const cls = holder.parent?.type === 'block' ? holder.parent.parent : null;
  if (cls?.type !== 'class_definition') return false;
  const clsHolder = cls.parent?.type === 'decorated_definition' ? cls.parent : cls;
  return clsHolder.parent?.type === 'module';
}

/**
 * The receiver rule: the nearest function or lambda around `head` that has a parameter of that name decides; the head is
 * the receiver when that is the first parameter (a plain or typed name) of a method with a receiver. A closure in a
 * method without its own parameter of the name therefore keeps the method's `self`.
 */
function isReceiver(head: Parser.SyntaxNode): boolean {
  for (let p = head.parent; p; p = p.parent) {
    if (p.type !== 'function_definition' && p.type !== 'lambda') continue;
    const params = (p.childForFieldName('parameters')?.namedChildren ?? []).filter((c) => c.type !== 'comment');
    if (!params.some((c) => parameterName(c)?.text === head.text)) continue;
    const first = params[0];
    const plain = first.type === 'identifier' || (first.type === 'typed_parameter' && first.namedChild(0)?.type === 'identifier');
    return p.type === 'function_definition' && plain && parameterName(first)?.text === head.text && hasReceiver(p);
  }
  return false;
}

/** True when name node `id` is bound here: an assignment, `for` or `with ... as` / `except ... as` target, a walrus
 *  name, a parameter, a `def` or `class` name. */
function bindsName(id: Parser.SyntaxNode): boolean {
  let n = id;
  while (n.parent && PATTERN_TYPES.has(n.parent.type)) n = n.parent;
  const p = n.parent;
  if (!p) return false;
  switch (p.type) {
    case 'assignment': case 'augmented_assignment': case 'for_statement': case 'for_in_clause': return inField(p, 'left', n);
    case 'named_expression': case 'function_definition': case 'class_definition':
    case 'default_parameter': case 'typed_default_parameter': return inField(p, 'name', n);
    case 'as_pattern_target': case 'parameters': case 'lambda_parameters': case 'typed_parameter': return true;
    default: return false;
  }
}

/** One name an import statement binds: the local name node, the imported name ('*' for a module) and the spec. */
interface ImportedName { local: Parser.SyntaxNode; imported: string; spec: string; name?: Parser.SyntaxNode }

/**
 * The names an import statement binds, specs as imports.ts writes them: `import a.b` -> local a, spec a.b;
 * `import m as x` -> local x; `from m import f as g` -> local g, imported f; `from . import x` -> imported '*', spec .x;
 * `from m import *` -> none.
 */
function importedNames(stmt: Parser.SyntaxNode): ImportedName[] {
  const out: ImportedName[] = [];
  const names = stmt.childrenForFieldName('name');
  if (stmt.type === 'import_statement') {
    for (const n of names) {
      const dotted = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
      const local = n.type === 'aliased_import' ? n.childForFieldName('alias') : n.namedChild(0);
      if (dotted?.type === 'dotted_name' && local) out.push({ local, imported: '*', spec: getDottedNameSpec(dotted) });
    }
    return out;
  }
  const mod = stmt.childForFieldName('module_name');
  const spec = mod?.type === 'dotted_name' ? getDottedNameSpec(mod) : mod?.type === 'relative_import' ? getRelativeImportSpec(mod) : '';
  if (!spec) return out;
  for (const n of names) {
    const dotted = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
    const local = n.type === 'aliased_import' ? n.childForFieldName('alias') : n.namedChild(0);
    if (dotted?.type !== 'dotted_name' || !local) continue;
    const imported = getDottedNameSpec(dotted);
    // `from . import x`: the module x itself (imports.ts writes the spec '.x')
    if (/^\.+$/.test(spec)) out.push({ local, imported: '*', spec: spec + imported });
    else out.push({ local, imported, spec, name: dotted.namedChild(0) ?? dotted });
  }
  return out;
}

/** The top-level import statements' bindings (nothing deeper is read, like the TypeScript reader). */
function importBindings(root: Parser.SyntaxNode): ImportBinding[] {
  return root.children.filter((s) => IMPORT_TYPES.includes(s.type)).flatMap(importedNames)
    .map(({ local, imported, spec, name }) => ({ local: local.text, imported, spec, ...(name && { at: nodePosition(name) }) }));
}

/** Byte ranges where a name of `names` is local to a function, lambda or comprehension that binds it (not declared
 *  `global` / `nonlocal` there). A top-level binding is the name itself, never a shadow. */
function localRanges(root: Parser.SyntaxNode, names: Set<string>): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  const add = (id: Parser.SyntaxNode, from: Parser.SyntaxNode): void => {
    if (!names.has(id.text)) return;
    let scope = from.parent;
    while (scope && !SCOPE_TYPES.has(scope.type)) scope = scope.parent;
    if (!scope) return;
    const freed = scope.descendantsOfType(['global_statement', 'nonlocal_statement']).some((s) => s.namedChildren.some((c) => c.text === id.text));
    if (!freed) out.set(id.text, [...(out.get(id.text) ?? []), [scope.startIndex, scope.endIndex]]);
  };
  for (const id of root.descendantsOfType('identifier')) {
    if (!names.has(id.text) || !bindsName(id)) continue;
    // a def or class name is bound in the scope around the definition; any other name in the scope it sits in
    const def = id.parent!.type === 'function_definition' || id.parent!.type === 'class_definition' ? id.parent! : id;
    add(id, def);
  }
  for (const stmt of root.descendantsOfType(IMPORT_TYPES)) for (const n of importedNames(stmt)) add(n.local, stmt);
  return out;
}

const USE_RULES: UseRules = {
  identifiers: ['identifier'],
  shadowed: localRanges,
  // a binding, a keyword argument's name (`f(key=1)`) and a member name (`x.name`) are no value uses
  declares: (id) => bindsName(id)
    || (id.parent?.type === 'keyword_argument' && inField(id.parent, 'name', id))
    || (id.parent?.type === 'attribute' && inField(id.parent, 'attribute', id)),
  notValue: NOT_VALUE,
  extend: (chain) => {
    const p = chain.parent;
    return p?.type === 'attribute' && inField(p, 'object', chain) && p.childForFieldName('attribute')?.type === 'identifier' ? p : null;
  },
  chainName,
  isCallee: (chain) => chain.parent?.type === 'call' && inField(chain.parent, 'function', chain),
};

/** `x = C(...)` with a plain name on both sides: x is an instance of C (C may be a function: the judge then finds no
 *  method and leaves the call unresolved). */
function instanceOf(n: Parser.SyntaxNode): InstanceBinding | null {
  const left = n.childForFieldName('left');
  const right = n.childForFieldName('right');
  const ctor = right?.type === 'call' ? right.childForFieldName('function') : null;
  return left?.type === 'identifier' && ctor?.type === 'identifier' ? { name: left.text, className: ctor.text } : null;
}

const CALL_RULES: CallRules = {
  calls: ['call'],
  callee: calleeOf,
  receiver: isReceiver,
  instanceNodes: ['assignment'],
  instance: instanceOf,
  bindings: importBindings,
  builtins: BUILTINS,
  uses: (root, names) => collectNameUses(root, names, USE_RULES),
};

/**
 * Call sites of one Python file (b592) through the kit's calls collector: `f()`, `m.f()`, `self.m()` (written
 * `this.m`), `C.m()`, `x.m()` after `x = C()`; a call that is no name chain (`super().m()`, `obj[i]()`, `f()()`) has a
 * null callee. Also the import bindings, external bindings of the called builtins, and the value uses of imported and
 * own names. Owner: the nearest function, method or test case of the outline, else MODULE_CALLER.
 */
export function extractPythonCalls(tree: Parser.Tree, outline: FileOutline): FileCalls {
  return createCallsCollector(tree, outline, CALL_RULES, 'python-calls');
}
