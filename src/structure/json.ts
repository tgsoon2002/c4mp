import * as ts from 'typescript';
import type { StructureNode, StructureResult } from './types';

/** b683: the keys of a JSON (or JSONC) text, nested; an array lists only its object elements, as `[i]` (K Q4b). */
export function readJsonStructure(text: string, file: string): StructureResult {
  const sf = ts.parseJsonText(file, text);
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const childrenOf = (value: ts.Expression | undefined): StructureNode[] => {
    if (value && ts.isObjectLiteralExpression(value)) {
      return value.properties.filter(ts.isPropertyAssignment).map((p) => nodeOf(keyText(p.name, sf), p, p.initializer));
    }
    if (value && ts.isArrayLiteralExpression(value)) {
      return value.elements.flatMap((el, i) => (ts.isObjectLiteralExpression(el) ? [nodeOf(`[${i}]`, el, el)] : []));
    }
    return [];
  };
  const nodeOf = (name: string, at: ts.Node, value: ts.Expression): StructureNode => {
    const children = childrenOf(value);
    return { name, kind: 'key', startLine: lineOf(at.getStart(sf)), endLine: lineOf(at.end), ...(children.length > 0 ? { children } : {}) };
  };
  // parseDiagnostics is set by parseJsonText but not in typescript's public typings; the 'broken JSON' test pins it.
  const diagnostics = (sf as ts.JsonSourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  return { nodes: childrenOf(sf.statements[0]?.expression), parseError: diagnostics.length > 0 };
}

/** A property name's text: the string of `"a"`, else the source text. */
function keyText(name: ts.PropertyName, sf: ts.SourceFile): string {
  return ts.isStringLiteral(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name) ? name.text : name.getText(sf);
}
