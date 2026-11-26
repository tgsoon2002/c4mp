/**
 * Offset helpers shared by the .c4 text editors (editAdd / editLink / editMeta / editRelate / editSet / planMove).
 * They work on the file text and character offsets only; locating elements is editMeta's job.
 */
import { log } from '../log';

/**
 * Offsets of a block a child can be inserted into: an element (editMeta ElementSpans has these fields), the `model { }`
 * block (P20-T9) or an `extend x { }` block. idStart = first header token (its line gives the base indent), headerEnd =
 * end of the last header token, open/close = the body braces (null: no body, or close null: unterminated),
 * firstBody = the first token inside the body. Lines are 1-based.
 */
export interface BlockSpans {
  idStart: number;
  headerEnd: number;
  open: number | null;
  openLine: number | null;
  close: number | null;
  closeLine: number | null;
  firstBodyStart: number | null;
  firstBodyLine: number | null;
}

export interface TextCursor {
  /** Offset of the first character of the line that holds `off`. */
  lineStart(off: number): number;
  /** Leading spaces/tabs of the line that holds `off`. */
  indentOf(off: number): string;
  /** True when only spaces/tabs sit between the start of the line and `off`. */
  startsLine(off: number): boolean;
  /** Line ending of the first line break at or after `off` ('\r\n' or '\n'), null when there is none. */
  eolAfter(off: number): string | null;
  /** Line ending to use for an edit near `off`: that of its own line, else the file's first break, else LF. */
  eolAt(off: number): string;
  /** Replace `del` characters at `at` with `ins`. */
  splice(at: number, ins: string, del?: number): { text: string; changed: true };
}

export function textCursor(text: string): TextCursor {
  const lineStart = (off: number) => text.lastIndexOf('\n', off - 1) + 1;
  const eolAfter = (off: number): string | null => {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return null;
    return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  };
  return {
    lineStart,
    indentOf: off => /^[ \t]*/.exec(text.slice(lineStart(off)))![0],
    startsLine: off => /^[ \t]*$/.test(text.slice(lineStart(off), off)),
    eolAfter,
    eolAt: off => eolAfter(off) ?? eolAfter(0) ?? '\n',
    splice: (at, ins, del = 0) => ({ text: text.slice(0, at) + ins + text.slice(at + del), changed: true }),
  };
}

/** One indent step for children of an element indented by `baseIndent`: a tab if it uses tabs, else two spaces. */
export const defaultIndentUnit = (baseIndent: string): string => (baseIndent.includes('\t') ? '\t' : '  ');

/**
 * Indent of the children of an element. `firstBody` = the first token inside its body (offset + 1-based line),
 * `openLine` = line of its `{`. When the first body token starts its own line below the `{`, that indent is used
 * (and its extra width over the element's indent is the unit); else base indent + defaultIndentUnit.
 */
export function childIndentation(
  cur: TextCursor,
  idStart: number,
  firstBody: { start: number; line: number } | null,
  openLine: number | null,
): { baseIndent: string; childIndent: string | null; unit: string; kid: string } {
  const baseIndent = cur.indentOf(idStart);
  const childIndent = firstBody !== null && openLine !== null && firstBody.line > openLine && cur.startsLine(firstBody.start)
    ? cur.indentOf(firstBody.start)
    : null;
  const unit = childIndent && childIndent.length > baseIndent.length && childIndent.startsWith(baseIndent)
    ? childIndent.slice(baseIndent.length)
    : defaultIndentUnit(baseIndent);
  return { baseIndent, childIndent, unit, kid: childIndent ?? baseIndent + unit };
}

/**
 * Insert a child block at the END of a located body (an element, `model { }` or `extend x { }`; shared by plan add,
 * relate and move). `make` builds the block from the child indent `kid`, one indent step `unit` and the line ending
 * `eol` of the parent's line; every line of the block it returns starts with its own indent and ends with `eol`.
 * Close brace on its own line: the block goes on the lines before it. Close brace on a line with other tokens: the
 * block goes on new lines before the brace. No body: one is added after the header. Pure: every byte outside the
 * insertion is identical. Unterminated body: the text is returned unchanged with changed:false.
 */
export function insertChildBlock(
  fileText: string,
  at: BlockSpans,
  make: (ind: { kid: string; unit: string; eol: string }) => string,
): { text: string; changed: boolean } {
  if (at.open !== null && at.close === null) return { text: fileText, changed: false };
  const cur = textCursor(fileText);
  const eol = cur.eolAt(at.idStart);
  const { baseIndent, unit, kid } = childIndentation(
    cur, at.idStart,
    at.firstBodyStart !== null && at.firstBodyLine !== null ? { start: at.firstBodyStart, line: at.firstBodyLine } : null,
    at.openLine,
  );
  const block = make({ kid, unit, eol });
  if (at.close !== null) {
    if (cur.startsLine(at.close)) return cur.splice(cur.lineStart(at.close), block);
    log('textEdit', 'inline close brace', { at: at.close });
    return cur.splice(at.close, eol + block + baseIndent);
  }
  log('textEdit', 'adding body', { at: at.headerEnd });
  return cur.splice(at.headerEnd, ` {${eol}${block}${baseIndent}}`);
}
