import { splitLines } from '../util/text';
import type { StructureNode, StructureResult } from './types';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES = /(^|[ \t]+)#+$/;

interface Heading {
  level: number;
  name: string;
  line: number;
}

/**
 * b683: the ATX headings of a Markdown text, nested by level. Not read: fenced code, a leading `---` front matter,
 * setext headings, headings with no text. A heading's lines run to the line before the next heading of the same or a
 * higher level, else to the last line.
 */
export function readMarkdownStructure(text: string): StructureResult {
  const lines = splitLines(text, { keepEol: false });
  let i = 0;
  if (lines[0] === '---') {
    const close = lines.findIndex((l, idx) => idx > 0 && (l === '---' || l === '...'));
    if (close > 0) i = close + 1;
  }
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      const c = FENCE_CLOSE.exec(line);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      fence = f[1];
      continue;
    }
    const m = ATX.exec(line);
    if (!m) continue;
    const name = (m[2] ?? '').replace(CLOSING_HASHES, '').trim();
    if (name !== '') headings.push({ level: m[1].length, name, line: i + 1 });
  }
  const nodes: StructureNode[] = [];
  const stack: { level: number; node: StructureNode }[] = [];
  headings.forEach((h, idx) => {
    const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
    const node: StructureNode = { name: h.name, kind: 'heading', startLine: h.line, endLine: next ? next.line - 1 : lines.length };
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node);
    else nodes.push(node);
    stack.push({ level: h.level, node });
  });
  return { nodes, parseError: false };
}
