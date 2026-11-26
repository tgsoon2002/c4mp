import * as path from 'path';
import { readC4Structure } from './c4';
import { readJsonStructure } from './json';
import { readMarkdownStructure } from './markdown';
import { STRUCTURE_SEP } from './types';
import type { StructureNode, StructureReader } from './types';
export type { StructureKind, StructureNode, StructureReader, StructureResult } from './types';
export { STRUCTURE_SEP } from './types';
export { readC4Structure, readJsonStructure, readMarkdownStructure };

/** b683: the structure reader of each file extension (add a format here). */
const READERS: Record<string, StructureReader> = { '.json': readJsonStructure, '.md': readMarkdownStructure, '.c4': readC4Structure };
const ASCII_SEP = ' > ';

/** b683: the reader for `file` by its extension (case-insensitive), or null. */
export function structureReaderFor(file: string): StructureReader | null {
  const ext = path.posix.extname(file).toLowerCase();
  return Object.prototype.hasOwnProperty.call(READERS, ext) ? READERS[ext] : null;
}

/** b683: the nodes with full names: the parent chain joined by STRUCTURE_SEP; a repeated sibling name gets `#2`, `#3`. */
export function nameStructure(nodes: StructureNode[], prefix = ''): StructureNode[] {
  const counts = new Map<string, number>();
  return nodes.map((n) => {
    const count = (counts.get(n.name) ?? 0) + 1;
    counts.set(n.name, count);
    const name = prefix + (count > 1 ? `${n.name}#${count}` : n.name);
    const named: StructureNode = { ...n, name };
    if (n.children) named.children = nameStructure(n.children, name + STRUCTURE_SEP);
    return named;
  });
}

/** b683: every node, each parent before its children (file order). */
export function flattenStructure(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap((n) => [n, ...flattenStructure(n.children ?? [])]);
}

const asUnicodeSep = (asked: string): string => asked.split(ASCII_SEP).join(STRUCTURE_SEP);
const lastPart = (name: string): string => name.split(STRUCTURE_SEP).pop() ?? name;

/** b683: the node whose full name is `asked` (ASCII ` > ` read as ` › `), or undefined. `named` = nameStructure output. */
export function findStructureNode(named: StructureNode[], asked: string): StructureNode | undefined {
  const want = asUnicodeSep(asked);
  return flattenStructure(named).find((n) => n.name === want);
}

/** b683: full names whose last part equals the last part of `asked` (not-found candidates), at most 10. */
export function structureCandidates(named: StructureNode[], asked: string): string[] {
  const want = lastPart(asUnicodeSep(asked));
  return flattenStructure(named)
    .map((n) => n.name)
    .filter((name) => lastPart(name) === want)
    .slice(0, 10);
}
