import { parseC4 } from '../plan/parser';
import type { StructureNode, StructureResult } from './types';

/**
 * b683: the elements of one .c4 text through the plan's own parser (parseC4): local ids as names, nested by parent when
 * the parent is in the same text, test blocks as kind 'test'; siblings by start line. parseError: any parse issue.
 */
export function readC4Structure(text: string, file: string): StructureResult {
  const { elements, issues } = parseC4(text, file);
  const byId = new Map<string, StructureNode>();
  const top: StructureNode[] = [];
  for (const e of elements) {
    const name = e.parent && e.id.startsWith(e.parent + '.') ? e.id.slice(e.parent.length + 1) : e.id;
    const node: StructureNode = { name, kind: e.kind, startLine: e.source.line, endLine: e.source.endLine ?? e.source.line };
    const tests = (e.tests ?? []).map(
      (t): StructureNode => ({ name: t.name, kind: 'test', startLine: t.source.line, endLine: t.source.endLine ?? t.source.line }),
    );
    if (tests.length > 0) node.children = tests;
    byId.set(e.id, node);
    const parent = e.parent ? byId.get(e.parent) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else top.push(node);
  }
  sortByStart(top);
  return { nodes: top, parseError: issues.length > 0 };
}

function sortByStart(nodes: StructureNode[]): void {
  nodes.sort((a, b) => a.startLine - b.startLine);
  for (const n of nodes) if (n.children) sortByStart(n.children);
}
