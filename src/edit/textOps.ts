import { EditError } from './errors';
import { splitLines } from '../util/text';

// Phase 32 (ED-1): line edits on a file's text. Lines are 1-based and inclusive, as in CodeElement. Pure.
// The file keeps its line ending (`\r\n` when its first line ends so, else `\n`; each untouched line keeps its own)
// and its final newline (present or not). The new text goes in as given, with no re-indenting; one trailing newline
// of it is dropped (it ends its last line), and '' is no line at all.

/** The line ending of a file: that of its first line; `\n` when it has none. */
function eolOf(code: string): string {
  const i = code.indexOf('\n');
  return i > 0 && code[i - 1] === '\r' ? '\r\n' : '\n';
}

/** The lines of `text`, without their line endings. */
function linesOfText(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

/** Replace `deleteCount` lines from line index `at` (0-based) with the lines of `text`. */
function splice(code: string, at: number, deleteCount: number, text: string): string {
  const eol = eolOf(code);
  const finalNewline = code === '' || code.endsWith('\n');
  const parts = splitLines(code, { keepEol: true });
  const body = parts.map((p) => p.replace(/\r?\n$/, ''));
  const ends = parts.map((p, i) => p.slice(body[i].length));
  const added = linesOfText(text);
  body.splice(at, deleteCount, ...added);
  ends.splice(at, deleteCount, ...added.map(() => eol));
  if (body.length === 0) return '';
  for (let i = 0; i < ends.length - 1; i++) if (ends[i] === '') ends[i] = eol;   // a former last line, no longer last
  const last = ends.length - 1;
  ends[last] = finalNewline ? ends[last] || eol : '';
  return body.map((b, i) => b + ends[i]).join('');
}

function lineCount(code: string): number {
  return splitLines(code, { keepEol: true }).length;
}

function checkRange(code: string, start: number, end: number): void {
  const n = lineCount(code);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > n) {
    throw new EditError('invalid', `Lines ${start}-${end} are not inside the file (1-${n})`);
  }
}

function checkLine(code: string, line: number, min: number, max: number): void {
  if (!Number.isInteger(line) || line < min || line > max) {
    throw new EditError('invalid', `Line ${line} is not inside the file (${min}-${max})`);
  }
}

/** Lines `start`..`end` replaced by `text`. */
export function replaceLines(code: string, start: number, end: number, text: string): string {
  checkRange(code, start, end);
  return splice(code, start - 1, end - start + 1, text);
}

/** `text` inserted above line `line` (1 .. lines+1; lines+1 = at the end). */
export function insertBefore(code: string, line: number, text: string): string {
  checkLine(code, line, 1, lineCount(code) + 1);
  return splice(code, line - 1, 0, text);
}

/** `text` inserted below line `line` (0 .. lines; 0 = at the top). */
export function insertAfter(code: string, line: number, text: string): string {
  checkLine(code, line, 0, lineCount(code));
  return splice(code, line, 0, text);
}

/** Lines `start`..`end` removed. */
export function removeLines(code: string, start: number, end: number): string {
  checkRange(code, start, end);
  return splice(code, start - 1, end - start + 1, '');
}
