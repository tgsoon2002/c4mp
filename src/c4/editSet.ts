import { log } from '../log';
import { defaultIndentUnit, textCursor } from './textEdit';
import { locateElement, quoteC4String, setElementMetadata, type BodyLineSpans, type Span } from './editMeta';

/** Keys written by other commands only: `uid` by ids/add, `layout` by apply-layout. */
const FORBIDDEN_KEYS = new Set(['uid', 'layout']);
/** Keys stored as a header/body string, not in the metadata block. */
const BODY_KEYS = new Set(['title', 'description', 'technology']);

export interface SetField { key: string; value: string }

// Value of a quoted token as the lexer reads it: \<quote> and \\ are the only escapes.
function unquote(token: string): string {
  const q = token[0];
  let out = '';
  for (let i = 1; i < token.length - 1; i++) {
    const c = token[i];
    const n = token[i + 1];
    if (c === '\\' && i + 1 < token.length - 1 && (n === q || n === '\\')) { out += n; i++; } else out += c;
  }
  return out;
}

/** Set one title / description / technology on the element. Text unchanged when nothing needs to change. */
function setBodyField(fileText: string, fqn: string, key: string, value: string): { text: string; changed: boolean } {
  const unchanged = { text: fileText, changed: false };
  const spans = locateElement(fileText, fqn);
  if (!spans) return unchanged;
  const quoted = quoteC4String(value);

  // The parser reads the header first, then body lines in order, so the LAST body line wins over the header.
  const lines: BodyLineSpans[] = key === 'title' ? spans.titleLines : key === 'description' ? spans.descriptionLines : spans.technologyLines;
  let target: Span | null = null;
  if (lines.length > 0) target = lines[lines.length - 1].value;
  else if (key === 'title') target = spans.title;
  else if (key === 'description') target = spans.headerDescription;

  if (target) {
    if (unquote(fileText.slice(target.start, target.end)) === value) return unchanged;
    return { text: fileText.slice(0, target.start) + quoted + fileText.slice(target.end), changed: true };
  }

  // No such string yet: insert a body line `key 'value'`.
  const cur = textCursor(fileText);
  const { lineStart, indentOf, startsLine, splice } = cur;
  const eol = cur.eolAt(spans.idStart);
  const baseIndent = indentOf(spans.idStart);
  const unit = defaultIndentUnit(baseIndent);
  const line = `${key} ${quoted}`;

  if (spans.open !== null) {
    if (spans.close === null) return unchanged;   // unterminated body
    const fb = spans.firstBodyStart;
    if (fb !== null && spans.firstBodyLine! > spans.openLine! && startsLine(fb)) {
      return splice(lineStart(fb), `${indentOf(fb)}${line}${eol}`);   // first line of the body, same indent
    }
    if (fb === null && startsLine(spans.close)) {
      return splice(lineStart(spans.close), `${baseIndent}${unit}${line}${eol}`);   // empty multi-line body
    }
    return splice(spans.open + 1, ` ${line}`);   // inline body: `{ ... }`
  }
  log('editSet', 'adding body', { fqn });
  return splice(spans.headerEnd, ` {${eol}${baseIndent}${unit}${line}${eol}${baseIndent}}`);
}

/**
 * Set several fields of the element with this fqn. Metadata keys go through setElementMetadata (quoted value,
 * block created when absent); `title`, `description`, `technology` edit the string in place or add a body line.
 * Pure: every byte outside the edits stays identical. Element not found or text too broken to edit: unchanged.
 * Throws for `uid` / `layout` (`forbidden key`), a metadata key that is not a c4 ident, a value with a line break.
 * The allow-list of keys and the value rules (status/priority/sprint) live in the CLI layer.
 */
export function setFieldsText(
  fileText: string,
  fqn: string,
  fields: SetField[],
): { text: string; changed: boolean; results: { key: string; changed: boolean }[] } {
  for (const f of fields) {
    if (FORBIDDEN_KEYS.has(f.key)) throw new Error(`forbidden key: ${f.key}`);
    if (/[\r\n]/.test(f.value)) throw new Error(`${f.key} value must not contain line breaks`);
  }
  let text = fileText;
  const results: { key: string; changed: boolean }[] = [];
  for (const f of fields) {
    const r = BODY_KEYS.has(f.key) ? setBodyField(text, fqn, f.key, f.value) : setElementMetadata(text, fqn, f.key, f.value);
    text = r.text;
    results.push({ key: f.key, changed: r.changed });
  }
  return { text, changed: text !== fileText, results };
}
