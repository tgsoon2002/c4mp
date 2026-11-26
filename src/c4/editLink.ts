import { log } from '../log';
import { locateElement, quoteC4String, wholeLineSplice } from './editMeta';
import { defaultIndentUnit, textCursor } from './textEdit';

/**
 * Add `link <linkText> ['title']` to the body of the element with this fqn. Position: after the last existing
 * `link` line, else after the last `technology`/`description` line, else first in the body (so before
 * `metadata`); an element without a body gets one. `linkText` is the text that goes after `link` (normally from
 * formatLink, relative to the .c4 file); it is quoted when it holds whitespace, a brace or a quote, because a
 * bare link ends at whitespace or a brace (c4.md section 4). Pure: every byte outside the insertion is identical.
 * Element not found or text too broken to edit: unchanged. Throws for an empty link or a line break in a value.
 * Does not check for a duplicate (the caller does).
 */
export function addLinkText(
  fileText: string,
  fqn: string,
  linkText: string,
  title?: string,
): { text: string; changed: boolean } {
  if (linkText.length === 0 || /[\r\n]/.test(linkText)) throw new Error('link must be non-empty and have no line breaks');
  if (title !== undefined && /[\r\n]/.test(title)) throw new Error('link title must not contain line breaks');
  const unchanged = { text: fileText, changed: false };

  const spans = locateElement(fileText, fqn);
  if (!spans) return unchanged;
  if (spans.open !== null && spans.close === null) return unchanged;   // unterminated body

  const line =
    `link ${/[\s{}'"]/.test(linkText) ? quoteC4String(linkText) : linkText}` +
    (title !== undefined ? ` ${quoteC4String(title)}` : '');

  const cur = textCursor(fileText);
  const { lineStart, indentOf, startsLine, splice } = cur;
  const eol = cur.eolAt(spans.idStart);
  const baseIndent = indentOf(spans.idStart);
  const unit = defaultIndentUnit(baseIndent);

  if (spans.open === null) {
    log('editLink', 'adding body', { fqn });
    return splice(spans.headerEnd, ` {${eol}${baseIndent}${unit}${line}${eol}${baseIndent}}`);
  }

  // Insert after the last line of its kind: the last link line, else the last technology/description line.
  const after = (l: { kwStart: number; end: number }) => {
    const nl = fileText.indexOf('\n', l.end);
    const rest = fileText.slice(l.end, nl < 0 ? fileText.length : nl);
    const indent = startsLine(l.kwStart) ? indentOf(l.kwStart) : baseIndent + unit;
    // Only whitespace or a // comment after the line: the new line goes on the next line.
    if (nl >= 0 && /^[ \t]*(\/\/.*)?\r?$/.test(rest)) return splice(nl + 1, `${indent}${line}${eol}`);
    return splice(l.end, `${eol}${indent}${line}`);
  };
  const anchor = (ls: { kwStart: number; end: number }[]) => (ls.length > 0 ? ls.reduce((a, b) => (b.end > a.end ? b : a)) : null);
  const lastLink = anchor(spans.linkLines);
  if (lastLink) return after(lastLink);
  const lastText = anchor([...spans.technologyLines, ...spans.descriptionLines]);
  if (lastText) return after(lastText);

  // Nothing to follow: first in the body.
  const fb = spans.firstBodyStart;
  if (fb !== null && spans.firstBodyLine! > spans.openLine! && startsLine(fb)) {
    return splice(lineStart(fb), `${indentOf(fb)}${line}${eol}`);
  }
  if (fb === null && spans.close !== null && startsLine(spans.close)) {
    return splice(lineStart(spans.close), `${baseIndent}${unit}${line}${eol}`);   // empty multi-line body
  }
  return splice(spans.open + 1, ` ${line}`);   // inline body: `{ ... }`
}

/**
 * Remove the `index`-th body `link` line (text order) of the element with this fqn: the whole line when nothing else
 * is on it, else the tokens plus the blanks before them. The body stays, even when it ends up empty. Pure: every other
 * byte is identical. Element or line not found: unchanged. Sibling of addLinkText.
 */
export function removeLinkText(fileText: string, fqn: string, index: number): { text: string; changed: boolean } {
  const l = locateElement(fileText, fqn)?.linkLines[index];
  if (!l) return { text: fileText, changed: false };
  const cur = textCursor(fileText);
  const s = wholeLineSplice(fileText, cur, l.kwStart, l.end);
  return cur.splice(s.at, s.ins, s.del);
}
