import { locateElement, quoteC4String } from './editMeta';
import { insertChildBlock } from './textEdit';

// A dotted fqn the lexer reads as one ident: segments of [A-Za-z_][A-Za-z0-9_-]*.
const FQN_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/**
 * Add the relation `-> <toFqn> ['label']` at the end of the body of the element `fromFqn` (the parser reads it as
 * a relation from that element, c4.md section 4). It goes after the existing body lines and nested children,
 * before the closing brace; an element without a body gets one. Pure: every byte outside the insertion is identical.
 * Element not found or text too broken to edit: unchanged. Throws for a `toFqn` that is not a dotted id or a
 * label with a line break. Does not check that the target exists or that the relation is new (the caller does).
 */
export function addRelationText(
  fileText: string,
  fromFqn: string,
  toFqn: string,
  label?: string,
): { text: string; changed: boolean } {
  if (!FQN_RE.test(toFqn)) throw new Error(`invalid relation target: ${JSON.stringify(toFqn)}`);
  if (label !== undefined && /[\r\n]/.test(label)) throw new Error('relation label must not contain line breaks');
  const unchanged = { text: fileText, changed: false };

  const spans = locateElement(fileText, fromFqn);
  if (!spans) return unchanged;

  const line = `-> ${toFqn}${label !== undefined ? ` ${quoteC4String(label)}` : ''}`;
  return insertChildBlock(fileText, spans, ({ kid, eol }) => `${kid}${line}${eol}`);
}
