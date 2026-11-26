import Parser from 'tree-sitter';
import { FileOutline, StubKind } from '../../types';
import { log } from '../../log';
import { createOutlineBuilder, type NestedRules } from '../treesitter';
import { pythonStubKind } from './stubs';

/**
 * True when a decorated_definition carries `@overload` or `@<module>.overload` (typing, typing_extensions):
 * a type-only signature stub. It is not an element, like a TypeScript overload signature, so the real
 * implementation keeps the plain name instead of getting `#N`.
 */
function isOverloadStub(decorated: Parser.SyntaxNode): boolean {
  return decorated.namedChildren.some((d) => {
    if (d.type !== 'decorator') return false;
    const expr = d.namedChild(0);
    if (expr?.type === 'identifier') return expr.text === 'overload';
    return expr?.type === 'attribute' && expr.childForFieldName('attribute')?.text === 'overload';
  });
}

/** b782: the function a statement declares inside a function body: `def f`, or a decorated `def f` (its decorators included). */
export function pythonNestedName(node: Parser.SyntaxNode): string | null {
  const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
  return def?.type === 'function_definition' ? def.childForFieldName('name')?.text || null : null;
}

/** b782: nested functions of Python; a class inside a body is not walked (its methods are not the function's). */
const PYTHON_NESTED: NestedRules = {
  scopes: ['function_definition', 'lambda'],
  skip: ['class_definition'],
  nameOf: pythonNestedName,
  stub: (n) => pythonStubKind(n.type === 'decorated_definition' ? n.childForFieldName('definition') ?? n : n),
};

export function extractPythonOutline(tree: Parser.Tree, file: string, code: string): FileOutline {
  const out = createOutlineBuilder('python-outline', tree, file, code);

  /** Skip (and log) an @overload stub; true when skipped. */
  function skipOverload(decorated: Parser.SyntaxNode): boolean {
    if (!isOverloadStub(decorated)) return false;
    log('python-outline', 'skip', { file, type: decorated.type, line: decorated.startPosition.row + 1, reason: '@overload signature stub' });
    return true;
  }

  function addNamed(node: Parser.SyntaxNode, kind: 'function' | 'class' | 'method', field: string, prefix?: string, stub?: StubKind | null): void {
    const n = node.childForFieldName(field);
    if (n?.text) out.add(prefix ? `${prefix}.${n.text}` : n.text, kind, node, stub);
  }

  function processClassBody(classNode: Parser.SyntaxNode, className: string): void {
    const body = classNode.childForFieldName('body');
    if (!body) return;

    for (const child of body.children) {
      let node = child;

      // Handle decorated methods
      if (child.type === 'decorated_definition') {
        const definition = child.childForFieldName('definition');
        if (definition && definition.type === 'function_definition' && !skipOverload(child)) {
          const methodName = definition.childForFieldName('name');
          if (methodName?.text) {
            // __init__ never gets a stub
            if (methodName.text === '__init__') {
              out.add(`${className}.${methodName.text}`, 'method', child);
            } else {
              const stub = pythonStubKind(definition);
              out.add(`${className}.${methodName.text}`, 'method', child, stub);
            }
          }
        }
        continue;
      }

      // Handle regular methods (function_definition inside class)
      if (child.type === 'function_definition') {
        const methodName = child.childForFieldName('name');
        if (methodName?.text) {
          // __init__ never gets a stub
          if (methodName.text === '__init__') {
            out.add(`${className}.${methodName.text}`, 'method', child);
          } else {
            const stub = pythonStubKind(child);
            out.add(`${className}.${methodName.text}`, 'method', child, stub);
          }
        }
        continue;
      }
    }
  }

  // Process top-level definitions
  for (const child of tree.rootNode.children) {
    let node = child;

    // Handle decorated definitions at module level
    if (child.type === 'decorated_definition') {
      const definition = child.childForFieldName('definition');
      if (!definition) {
        log('python-outline', 'skip', { file, type: child.type, line: child.startPosition.row + 1, reason: 'decorated without definition' });
        continue;
      }

      if (definition.type === 'class_definition') {
        const className = definition.childForFieldName('name');
        if (className?.text) {
          // Add the class (use decorated_definition's line range)
          out.add(className.text, 'class', child);
          // Process class body for methods
          processClassBody(definition, className.text);
        }
        continue;
      }

      if (definition.type === 'function_definition') {
        if (skipOverload(child)) continue;
        const stub = pythonStubKind(definition);
        addNamed(definition, 'function', 'name', undefined, stub);
        continue;
      }
    }

    // Handle regular class definitions
    if (node.type === 'class_definition') {
      const className = node.childForFieldName('name');
      if (className?.text) {
        out.add(className.text, 'class', node);
        processClassBody(node, className.text);
      }
      continue;
    }

    // Handle regular function definitions
    if (node.type === 'function_definition') {
      const stub = pythonStubKind(node);
      addNamed(node, 'function', 'name', undefined, stub);
      continue;
    }

    // Log skipped types for debugging
    if (['import_statement', 'import_from_statement', 'assignment', 'expression_statement', 'comment'].includes(node.type)) {
      // These are expected at module level, don't log them
      continue;
    }

    log('python-outline', 'skip', { file, type: node.type, line: node.startPosition.row + 1, reason: 'not a function or class' });
  }

  return out.finish(PYTHON_NESTED);
}
