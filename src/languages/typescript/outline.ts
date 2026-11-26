import Parser from 'tree-sitter';
import { ElementKind, FileOutline, StubKind } from '../../types';
import { log } from '../../log';
import { createOutlineBuilder } from '../treesitter';
import type { NestedRules } from '../treesitter';
import { stubKind } from './stubs';
import { FUNCTION_NODES } from './calls';

/** Values that make a declarator a function: `const f = () => ...`, `= function () {...}`. */
const FUNCTION_VALUES = ['function_expression', 'function', 'arrow_function'];

/** b782: the function a statement declares inside a function body: `function f`, `function* f`, `const f = () => ...`. */
export function tsNestedName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
    return node.childForFieldName('name')?.text || null;
  }
  if (node.type !== 'variable_declarator') return null;
  const n = node.childForFieldName('name');
  const v = node.childForFieldName('value');
  return n?.type === 'identifier' && v && FUNCTION_VALUES.includes(v.type) ? n.text : null;
}

function tsNestedStub(n: Parser.SyntaxNode): StubKind | null {
  return stubKind(n.type === 'variable_declarator' ? n.childForFieldName('value') ?? n : n);
}

/** b782: nested functions of TypeScript / JavaScript; a class inside a body is not walked. */
const TS_NESTED: NestedRules = {
  scopes: FUNCTION_NODES,
  skip: ['class_declaration', 'abstract_class_declaration', 'class'],
  nameOf: tsNestedName,
  stub: tsNestedStub,
};

export function extractOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('outline', tree, file, code);
  const elements = out.elements;

  function addNamed(node: Parser.SyntaxNode, kind: ElementKind, field: string, prefix?: string, stub?: StubKind | null): void {
    const n = node.childForFieldName(field);
    if (n?.text) out.add(prefix ? `${prefix}.${n.text}` : n.text, kind, node, stub);
  }

  // The statements of an immediately-invoked function wrapper `(function(){...})()`, `(() => {...})()`,
  // `(function(){...}())`, `!function(){...}()` or `(function(){...}).call(this)`; null when node is not one.
  function iifeStatements(node: Parser.SyntaxNode): Parser.SyntaxNode[] | null {
    if (node.type !== 'expression_statement') return null;
    let n: Parser.SyntaxNode | null = node.namedChild(0);
    while (n && (n.type === 'parenthesized_expression' || n.type === 'unary_expression')) {
      n = n.type === 'unary_expression' ? n.childForFieldName('argument') : n.namedChild(0);
    }
    if (n?.type !== 'call_expression') return null;
    let fn: Parser.SyntaxNode | null = n.childForFieldName('function');
    if (fn?.type === 'member_expression') fn = fn.childForFieldName('object');   // `.call(this)` / `.apply(...)`
    while (fn?.type === 'parenthesized_expression') fn = fn.namedChild(0);
    if (!fn || !FUNCTION_VALUES.includes(fn.type)) return null;
    const body = fn.childForFieldName('body');
    return body?.type === 'statement_block' ? body.children : null;
  }

  // `a.b.c = function/arrow` as a statement: the dotted name without a leading `module.exports` / `exports`
  // and without a `prototype` part (`Foo.prototype.bar` -> `Foo.bar`), plus the function node; null otherwise.
  // Only plain identifier chains count (no `a[b]`, no `this`, no calls).
  function assignedFunction(node: Parser.SyntaxNode): { name: string; fn: Parser.SyntaxNode } | null {
    if (node.type !== 'expression_statement') return null;
    const asg = node.namedChild(0);
    if (asg?.type !== 'assignment_expression') return null;
    const right = asg.childForFieldName('right');
    if (!right || !FUNCTION_VALUES.includes(right.type)) return null;
    const parts: string[] = [];
    let l: Parser.SyntaxNode | null = asg.childForFieldName('left');
    while (l?.type === 'member_expression') {
      const prop = l.childForFieldName('property');
      if (prop?.type !== 'property_identifier') return null;
      parts.unshift(prop.text);
      l = l.childForFieldName('object');
    }
    if (l?.type !== 'identifier' || !parts.length) return null;
    parts.unshift(l.text);
    if (parts[0] === 'module' && parts[1] === 'exports') parts.splice(0, 2);
    else if (parts[0] === 'exports') parts.splice(0, 1);
    const named = parts.filter(x => x !== 'prototype');
    return named.length ? { name: named.join('.'), fn: right } : null;
  }

  function visit(nodes: Parser.SyntaxNode[]): void {
    for (const child of nodes) {
      let node = child;
      if (child.type === 'export_statement') {
        const decl = child.childForFieldName('declaration');
        if (!decl) {
          log('outline', 'skip', { file, type: child.type, line: child.startPosition.row + 1, reason: 'export without declaration' });
          continue;
        }
        node = decl;
      }

      if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
        const stub = stubKind(node);
        addNamed(node, 'function', 'name', undefined, stub);
        continue;
      }

      if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
        const n = node.childForFieldName('name');
        if (n?.text) {
          const cls = n.text;
          out.add(cls, 'class', node);
          const body = node.childForFieldName('body');
          if (body) {
            for (const m of body.children) {
              if (m.type === 'method_definition') {
                const methodName = m.childForFieldName('name');
                // Skip stub for constructors
                if (methodName?.text !== 'constructor') {
                  const stub = stubKind(m);
                  addNamed(m, 'method', 'name', cls, stub);
                } else {
                  addNamed(m, 'method', 'name', cls);
                }
              }
            }
          }
        }
        continue;
      }

      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (const d of node.children) {
          if (d.type === 'variable_declarator') {
            const n = d.childForFieldName('name');
            const v = d.childForFieldName('value');
            if (!n || n.type !== 'identifier' || !n.text) continue;
            const varName = n.text;
            if (v?.type === 'arrow_function' || v?.type === 'function_expression') {
              const stub = stubKind(v);
              out.add(varName, 'function', d, stub);
            } else if (v?.type === 'object') {
              for (const o of v.children) {
                if (o.type === 'method_definition') {
                  const stub = stubKind(o);
                  addNamed(o, 'method', 'name', varName, stub);
                } else if (o.type === 'pair') {
                  const k = o.childForFieldName('key');
                  const pv = o.childForFieldName('value');
                  if (k?.text && pv?.type && (pv.type === 'arrow_function' || pv.type === 'function_expression')) {
                    const stub = stubKind(pv);
                    out.add(`${varName}.${k.text}`, 'method', o, stub);
                  }
                }
              }
            } else if (v) {
              log('outline', 'skip', { file, type: d.type, line: d.startPosition.row + 1, reason: `value is ${v.type}, not a function or object-with-methods` });
            }
          }
        }
        continue;
      }

      // interface, type alias and enum are all kind 'type' (the one plan kind for them, PLANNED_CODE_KINDS)
      if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration' || node.type === 'enum_declaration') {
        addNamed(node, 'type', 'name');
        continue;
      }

      const assigned = assignedFunction(node);
      if (assigned) {
        out.add(assigned.name, assigned.name.includes('.') ? 'method' : 'function', node, stubKind(assigned.fn));
        continue;
      }

      const inner = iifeStatements(node);
      if (inner) {
        visit(inner);
        continue;
      }

      if (node.type === 'namespace_declaration') {
        log('outline', 'skip', { file, type: node.type, line: node.startPosition.row + 1, reason: 'not a function, class or type' });
      }
    }
  }

  visit(tree.rootNode.children);

  // A type sharing its name with a function or class (declaration merging) or with an earlier type
  // is dropped: element names stay unique per file because `file#name` is the element id downstream.
  const taken = new Set<string>();
  for (const e of elements) if (e.kind !== 'type') taken.add(e.name);
  for (let i = 0; i < elements.length; ) {
    const e = elements[i];
    if (e.kind === 'type' && taken.has(e.name)) {
      log('outline', 'skip', { file, name: e.name, line: e.startLine, reason: 'type name already used in this file' });
      elements.splice(i, 1);
    } else {
      if (e.kind === 'type') taken.add(e.name);
      i++;
    }
  }

  return out.finish(TS_NESTED);
}
