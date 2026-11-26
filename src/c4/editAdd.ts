import { locateElement, locateExtendBlocks, locateModelBlock, quoteC4String } from './editMeta';
import { insertChildBlock } from './textEdit';
import { viewOfKind } from '../plan/kinds';
import type { Plan } from '../types';

/** An element id the lexer reads as one undotted ident (plan add, plan rename). */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// b210: a metadata key may be dotted (index.<name>, check.<name>); the lexer reads it as one ident.
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

export interface AddElementSpec {
  id: string;
  kind: string;
  title: string;
  description?: string;
  technology?: string;
  /** Link texts exactly as they go after `link` (already relative to the .c4 file, e.g. from formatLink). */
  links?: string[];
  metadata?: [string, string][];
}

function str(label: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${label} must not contain line breaks`);
  return quoteC4String(value);
}

// A bare link ends at whitespace or a brace (c4.md section 4); anything else risky is quoted.
function linkText(raw: string): string {
  if (raw.length === 0 || /[\r\n]/.test(raw)) throw new Error('link must be non-empty and have no line breaks');
  return /[\s{}'"]/.test(raw) ? quoteC4String(raw) : raw;
}

/**
 * Add a new child element block at the end of the parent's body (parent located by fqn, nested or in an
 * `extend` block). The parent gets a body when it has none. Pure text transformation: every byte outside
 * the insertion stays identical. Body lines follow the order of c4.md section 4: technology, description,
 * link, metadata. Parent not found or text too broken to edit (unterminated string / body): returns the
 * text unchanged with changed:false. Does not check for a duplicate id (the caller checks plan.elements).
 * `parentFqn` null (P20-T9) = a top-level element: the block goes at the end of the file's `model { }` block, same
 * layout rules. Throws only for invalid arguments (id/kind/metadata key not a c4 ident, a value with a line break).
 * `at` (W5, b301; from addTargetOf): insert at the end of the parent's `extend` block number `at.extendIndex` of this
 * text (locateExtendBlocks order) instead of the parent's own body; a missing block: unchanged with changed:false.
 */
export function addElementText(
  fileText: string,
  parentFqn: string | null,
  spec: AddElementSpec,
  at?: { extendIndex: number },
): { text: string; changed: boolean; fqn: string } {
  for (const [label, v] of [['id', spec.id], ['kind', spec.kind]] as const) {
    if (!IDENT_RE.test(v)) throw new Error(`invalid ${label}: ${JSON.stringify(v)}`);
  }
  for (const [k] of spec.metadata ?? []) {
    if (!META_KEY_RE.test(k)) throw new Error(`invalid metadata key: ${JSON.stringify(k)}`);
  }
  const fqn = parentFqn === null ? spec.id : `${parentFqn}.${spec.id}`;
  const unchanged = { text: fileText, changed: false, fqn };

  const title = str('title', spec.title);
  const bodyLines: string[] = [];   // simple body lines, without indent
  if (spec.technology !== undefined) bodyLines.push(`technology ${str('technology', spec.technology)}`);
  if (spec.description !== undefined) bodyLines.push(`description ${str('description', spec.description)}`);
  for (const l of spec.links ?? []) bodyLines.push(`link ${linkText(l)}`);
  const meta = spec.metadata ?? [];
  const metaValues = meta.map(([k, v]) => [k, str(`metadata ${k}`, v)] as const);

  const parent = parentFqn === null ? locateModelBlock(fileText)
    : at !== undefined ? locateExtendBlocks(fileText, parentFqn)[at.extendIndex]
    : locateElement(fileText, parentFqn);
  if (!parent) return unchanged;

  // The child block, every line ends with eol.
  const r = insertChildBlock(fileText, parent, ({ kid, unit, eol }) => {
    const inner = kid + unit;
    const hasBody = bodyLines.length > 0 || metaValues.length > 0;
    let block = `${kid}${spec.id} = ${spec.kind} ${title}`;
    if (!hasBody) return block + eol;
    block += ` {${eol}`;
    for (const l of bodyLines) block += `${inner}${l}${eol}`;
    if (metaValues.length > 0) {
      block += `${inner}metadata {${eol}`;
      for (const [k, v] of metaValues) block += `${inner}${unit}${k} ${v}${eol}`;
      block += `${inner}}${eol}`;
    }
    return block + `${kid}}${eol}`;
  });
  return { ...r, fqn };
}

/**
 * W5 (b301, rule C13 of PHASE_20_WIREFRAMES.md): the plan file, and the `extend <parent>` block in it, a new child of
 * kind `kind` goes into. "Same view" = viewOfKind (code kinds count as 'arch'). Pure; `texts` = the text of every plan
 * file, matching `plan` (lines included).
 * 1. The defining file of the parent, when it holds a sibling of the same view: { file, extendIndex: null }.
 * 2. Else the first other plan file in path order (plan.files) with an `extend <parent>` block holding such a sibling:
 *    { file, extendIndex } (index into locateExtendBlocks(text, parentId)).
 * 3. Else the defining file: { file, extendIndex: null }.
 * Throws for a parent id not in the plan and for a plan file without a text (an inconsistent state, never defaulted).
 */
export function addTargetOf(
  plan: Plan,
  texts: Map<string, string>,
  parentId: string,
  kind: string,
): { file: string; extendIndex: number | null } {
  const parent = plan.elements.find(e => e.id === parentId);
  if (!parent) throw new Error(`addTargetOf: no plan element ${parentId}`);
  const view = viewOfKind(kind);
  const siblings = plan.elements.filter(e => e.parent === parentId && viewOfKind(e.kind) === view);
  const home = parent.source.file;
  if (siblings.some(s => s.source.file === home)) return { file: home, extendIndex: null };
  for (const f of plan.files) {
    if (f === home) continue;
    const text = texts.get(f);
    if (text === undefined) throw new Error(`addTargetOf: no text for plan file ${f}`);
    const inFile = siblings.filter(s => s.source.file === f);
    if (inFile.length === 0) continue;
    const blocks = locateExtendBlocks(text, parentId);
    const i = blocks.findIndex(b => b.openLine !== null && b.closeLine !== null
      && inFile.some(s => b.openLine! <= s.source.line && s.source.line <= b.closeLine!));
    if (i >= 0) return { file: f, extendIndex: i };
  }
  return { file: home, extendIndex: null };
}
