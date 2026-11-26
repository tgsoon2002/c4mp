/** b683: one node of a non-code file's structure: a JSON key, a Markdown heading, a .c4 plan element or test block. */
export interface StructureNode {
  /** The reader's local name (`folders`, `[0]`, `Setup`, `structure_readers`); nameStructure turns it into the full chain. */
  name: string;
  kind: StructureKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  children?: StructureNode[];
}
/** 'key' (JSON), 'heading' (Markdown), the plan kind ('component', 'function', ...) or 'test' (.c4). */
export type StructureKind = string;
export interface StructureResult {
  nodes: StructureNode[];
  /** The text did not parse cleanly; `nodes` holds what was read. */
  parseError: boolean;
}
export type StructureReader = (text: string, file: string) => StructureResult;
/** Joins nested names (`folders › src/edit`): the same text as test-case names (TEST_NAME_SEP), pinned by a test. */
export const STRUCTURE_SEP = ' › ';
