import { log } from '../log';
import { childIndentation, insertChildBlock, textCursor, type BlockSpans, type TextCursor } from './textEdit';
import type { PlanTest } from '../types';

/**
 * In-place editor for one `key 'value'` entry in an element's `metadata { }` block.
 *
 * Why a separate offset-aware scanner: the real lexer (src/plan/lexer.ts) only records
 * line numbers, not character offsets, and its tokens are asserted with toEqual in
 * tests, so they cannot grow fields. This scanner mirrors the lexer rules exactly
 * (comments, quoted strings with \' and \\ escapes, braces, idents, words) and a
 * test checks token-for-token parity with tokenize(). The structural walk below
 * mirrors parser.ts (model / extend / nested elements / metadata) so element fqns
 * are computed the same way the parser computes them: an element is located by its
 * fqn, never by short name or by line number.
 */

type TType = 'ident' | 'string' | 'lbrace' | 'rbrace' | 'arrow' | 'equals' | 'word' | 'eof';
interface Tok { type: TType; value: string; line: number; start: number; end: number }

// b210: dotted keys (index.<name>) are one ident for the lexer.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

function scan(text: string): { toks: Tok[]; unterminated: boolean } {
  const toks: Tok[] = [];
  let unterminated = false;
  let pos = 0;
  let line = 1;
  const ws = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  const id1 = (c: string) => /[A-Za-z_]/.test(c);
  const idc = (c: string) => /[A-Za-z0-9_-]/.test(c);
  const push = (type: TType, value: string, ln: number, start: number, end: number) =>
    toks.push({ type, value, line: ln, start, end });

  while (pos < text.length) {
    const ch = text[pos];
    if (ws(ch)) { if (ch === '\n') line++; pos++; continue; }

    if (ch === '/' && pos + 1 < text.length) {
      if (text[pos + 1] === '/') {
        while (pos < text.length && text[pos] !== '\n') pos++;
        continue;
      }
      if (text[pos + 1] === '*') {
        pos += 2;
        while (pos + 1 < text.length) {
          if (text[pos] === '*' && text[pos + 1] === '/') { pos += 2; break; }
          if (text[pos] === '\n') line++;
          pos++;
        }
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = pos;
      const startLine = line;
      pos++;
      let value = '';
      let closed = false;
      while (pos < text.length) {
        const c = text[pos];
        if (c === '\\' && pos + 1 < text.length) {
          const n = text[pos + 1];
          if (n === quote || n === '\\') { value += n; pos += 2; } else { value += c; pos++; }
        } else if (c === quote) { closed = true; pos++; break; }
        else { if (c === '\n') line++; value += c; pos++; }
      }
      if (!closed) unterminated = true;
      push('string', value, startLine, start, pos);
      continue;
    }

    if (ch === '-' && text[pos + 1] === '>') { push('arrow', '->', line, pos, pos + 2); pos += 2; continue; }
    if (ch === '{') { push('lbrace', '{', line, pos, pos + 1); pos++; continue; }
    if (ch === '}') { push('rbrace', '}', line, pos, pos + 1); pos++; continue; }
    if (ch === '=') { push('equals', '=', line, pos, pos + 1); pos++; continue; }

    if (id1(ch)) {
      const start = pos;
      pos++;
      while (pos < text.length) {
        if (idc(text[pos])) pos++;
        else if (text[pos] === '.' && pos + 1 < text.length && id1(text[pos + 1])) {
          pos += 2;
          while (pos < text.length && idc(text[pos])) pos++;
        } else break;
      }
      const nx = pos < text.length ? text[pos] : null;
      const ok = nx === null || ws(nx) || nx === '{' || nx === '}' || nx === '=' || nx === '"' || nx === "'";
      if (ok) { push('ident', text.substring(start, pos), line, start, pos); continue; }
      pos = start;
      while (pos < text.length && !ws(text[pos]) && text[pos] !== '{' && text[pos] !== '}') pos++;
      push('word', text.substring(start, pos), line, start, pos);
      continue;
    }

    if (!ws(ch) && ch !== '{' && ch !== '}') {
      const start = pos;
      while (pos < text.length && !ws(text[pos]) && text[pos] !== '{' && text[pos] !== '}') pos++;
      push('word', text.substring(start, pos), line, start, pos);
      continue;
    }
    pos++;
  }
  push('eof', '', line, text.length, text.length);
  return { toks, unterminated };
}

interface MetaEntry { key: Tok; value: Tok | null }
interface MetaBlock { kw: Tok; close: Tok | null; entries: MetaEntry[] }
interface ElemInfo {
  fqn: string;
  idTok: Tok;
  headerEnd: Tok;          // last token of `id = kind 'title' ['desc']`
  open: Tok | null;        // `{` of the body
  close: Tok | null;       // `}` of the body (null if unterminated)
  firstBody: Tok | null;   // first token inside the body
  metas: MetaBlock[];
  titleTok: Tok;           // header title string
  descTok: Tok | null;     // header description string (second string of the header)
  titleLines: BodyLine[];       // body `title 'x'` lines
  descriptionLines: BodyLine[]; // body `description 'x'` lines
  technologyLines: BodyLine[];  // body `technology 'x'` lines
  linkLines: BodyLine[];        // body `link x ['t']` lines
  testLines: TestLine[];        // body `test 'name' { [case 'x'] }` blocks (Phase 26, D16)
}
/** One `test` block: its keyword, name string and last token (the `}`, or the name when the block has no braces). */
interface TestLine { kw: Tok; name: Tok; last: Tok }
/** One simple body line: keyword token and the value token span (for link: first value token .. last token). */
interface BodyLine { kw: Tok; value: Tok; end: number }
/** One `extend <fqn> { }` block: keyword, target, braces and the first token of its body. */
interface ExtendInfo { kw: Tok; target: Tok; open: Tok; close: Tok | null; firstBody: Tok | null }
/** What the walk records besides elements: reference tokens (extend targets, relation ends) and extend blocks, text order. */
interface WalkExtras { refs: RefSpan[]; extendBlocks: ExtendInfo[] }

/**
 * Mirrors parser.ts structure walking; returns every element with its token spans. With `out`, it also records every
 * reference token and every `extend` block. Tokens inside a relation's `{ }` are skipped, as the parser does.
 */
function walk(toks: Tok[], out?: WalkExtras): ElemInfo[] {
  const infos: ElemInfo[] = [];
  const ref = (role: RefSpan['role'], t: Tok) => out?.refs.push({ role, value: t.value, start: t.start, end: t.end, line: t.line });
  let p = 0;
  const cur = () => toks[Math.min(p, toks.length - 1)];
  const next = () => { const t = cur(); if (t.type !== 'eof') p++; return t; };
  const skipLine = () => { const ln = cur().line; while (cur().type !== 'eof' && cur().line === ln) next(); };
  const skipBalanced = () => {
    let d = 1;
    while (cur().type !== 'eof' && d > 0) {
      if (cur().type === 'lbrace') d++;
      else if (cur().type === 'rbrace') d--;
      if (d > 0) next();
    }
    if (d === 0) next();
  };
  const relTail = (): Tok => {
    const target = next(); // target ident (already checked)
    if (cur().type === 'string') next();
    if (cur().type === 'lbrace') skipBalanced();
    return target;
  };

  const addElem = (id: string, idTok: Tok, parent: string | null) => {
    next(); // kind
    if (cur().type !== 'string') { skipLine(); return; }
    const titleTok = next();
    let headerEnd = titleTok;
    let descTok: Tok | null = null;
    if (cur().type === 'string') { descTok = next(); headerEnd = descTok; }
    const fqn = parent ? `${parent}.${id}` : id;
    const info: ElemInfo = {
      fqn, idTok, headerEnd, open: null, close: null, firstBody: null, metas: [],
      titleTok, descTok, titleLines: [], descriptionLines: [], technologyLines: [], linkLines: [], testLines: [],
    };
    infos.push(info);
    if (cur().type === 'lbrace') {
      info.open = next();
      if (cur().type !== 'rbrace' && cur().type !== 'eof') info.firstBody = cur();
      body(fqn, info);
      if (cur().type === 'rbrace') info.close = next();
    }
  };

  const extend = (): void => {
    const kw = next(); // 'extend'
    if (cur().type !== 'ident') { skipLine(); return; }
    const target = next();
    ref('extend', target);
    if (cur().type === 'lbrace') {
      const open = next();
      const block: ExtendInfo = { kw, target, open, close: null, firstBody: cur().type !== 'rbrace' && cur().type !== 'eof' ? cur() : null };
      out?.extendBlocks.push(block);   // pushed before its body: text order
      block.close = top(target.value);
    }
  };

  /** Body of `model { }` or `extend x { }`; returns the closing brace it consumed (null when unterminated). */
  const top = (parent: string | null): Tok | null => {
    while (cur().type !== 'rbrace' && cur().type !== 'eof') {
      if (cur().type !== 'ident') { skipLine(); continue; }
      const kw = cur().value;
      if (kw === 'specification' || kw === 'views') {
        next();
        if (cur().type === 'lbrace') { next(); skipBalanced(); }
        continue;
      }
      if (kw === 'extend') { extend(); continue; }
      const idTok = next();
      if (cur().type === 'equals') {
        next();
        if (cur().type !== 'ident') { skipLine(); continue; }
        addElem(kw, idTok, parent);
      } else if (cur().type === 'arrow') {
        next();
        if (cur().type !== 'ident') { skipLine(); continue; }
        ref('from', idTok);
        ref('to', relTail());
      } else if (cur().line === idTok.line) skipLine(); // b178: a lone word skips only itself, as parser.ts does
    }
    return cur().type === 'rbrace' ? next() : null;
  };

  const body = (fqn: string, info: ElemInfo): void => {
    while (cur().type !== 'rbrace' && cur().type !== 'eof') {
      if (cur().type !== 'ident') {
        if (cur().type === 'arrow') {
          next();
          if (cur().type !== 'ident') { skipLine(); continue; }
          ref('to', relTail());
          continue;
        }
        skipLine();
        continue;
      }
      const kw = cur().value;
      if (kw === 'technology' || kw === 'description' || kw === 'title') {
        const kwTok = next();
        if (cur().type === 'string') {
          const v = next();
          const rec: BodyLine = { kw: kwTok, value: v, end: v.end };
          (kw === 'technology' ? info.technologyLines : kw === 'description' ? info.descriptionLines : info.titleLines).push(rec);
        } else skipLine();
        continue;
      }
      if (kw === 'link') {
        const kwTok = next();
        if (cur().type === 'word' || cur().type === 'ident' || cur().type === 'string') {
          const v = next();
          let end = v.end;
          if (cur().type === 'string') end = next().end;
          info.linkLines.push({ kw: kwTok, value: v, end });
        } else skipLine();
        continue;
      }
      if (kw === 'metadata') {
        const kwTok = next();
        if (cur().type === 'lbrace') {
          next();
          const block: MetaBlock = { kw: kwTok, close: null, entries: [] };
          while (cur().type !== 'rbrace' && cur().type !== 'eof') {
            if (cur().type !== 'ident') { skipLine(); continue; }
            const key = next();
            if (cur().type === 'string') block.entries.push({ key, value: next() });
            else skipLine();
          }
          if (cur().type === 'rbrace') block.close = next();
          info.metas.push(block);
        }
        continue;
      }
      if (kw === 'specification' || kw === 'views') {
        next();
        if (cur().type === 'lbrace') { next(); skipBalanced(); }
        continue;
      }
      if (kw === 'extend') { extend(); continue; }
      // Phase 26 (D16): same recognition as parser.ts parseTest, so a multi-line block never reads `case` as an element.
      if (kw === 'test' && toks[p + 1]?.type === 'string') {
        const kwTok = next();
        const name = next();
        let last = name;
        if (cur().type === 'lbrace') {
          next();
          while (cur().type !== 'rbrace' && cur().type !== 'eof') {
            if (cur().type === 'lbrace') { next(); skipBalanced(); } else next();
          }
          if (cur().type === 'rbrace') last = next();
        }
        info.testLines.push({ kw: kwTok, name, last });
        continue;
      }
      const idTok = next();
      if (cur().type === 'equals') {
        next();
        if (cur().type !== 'ident') { skipLine(); continue; }
        addElem(kw, idTok, fqn);
      } else if (cur().type === 'arrow') {
        next();
        if (cur().type !== 'ident') { skipLine(); continue; }
        ref('from', idTok);
        ref('to', relTail());
      } else if (cur().line === idTok.line) skipLine(); // b178: as in top()
    }
  };

  while (cur().type !== 'eof') {
    if (cur().type !== 'ident') { skipLine(); continue; }
    const kw = cur().value;
    if (kw === 'specification' || kw === 'views') {
      next();
      if (cur().type === 'lbrace') { next(); skipBalanced(); }
      continue;
    }
    if (kw === 'model') {
      next();
      if (cur().type === 'lbrace') { next(); top(null); }
      continue;
    }
    if (kw === 'extend') { extend(); continue; }
    skipLine();
  }
  return infos;
}

/** Quote for the lexer: single quotes, \' and \\ are the only escapes it understands. */
export function quoteC4String(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Why a metadata edit is refused (the text the single edits throw), null when `key` and `value` are fine. `value` null = remove. */
function metaEditError(key: string, value: string | null): string | null {
  if (!KEY_RE.test(key)) return `invalid metadata key: ${JSON.stringify(key)}`;
  if (value !== null && /[\r\n]/.test(value)) return 'metadata value must not contain line breaks';
  return null;
}

/** One text change: replace `del` characters at offset `at` with `ins`. */
export interface Splice { at: number; del: number; ins: string }

/**
 * The splice that sets `key` to `value` in the metadata of `info` (located in `fileText`, `cur` = its textCursor);
 * null = nothing to change. Shared by setElementMetadata and editMetadataBatch (b721).
 */
function planSetSplice(fileText: string, cur: TextCursor, info: ElemInfo, key: string, value: string): Splice | null {
  const quoted = quoteC4String(value);
  const { lineStart, indentOf, startsLine } = cur;
  const splice = (at: number, del: number, ins: string): Splice => ({ at, del, ins });
  const eol = cur.eolAt(info.idTok.start);
  const { baseIndent, unit, kid: kidIndent } = childIndentation(
    cur, info.idTok.start,
    info.firstBody ? { start: info.firstBody.start, line: info.firstBody.line } : null,
    info.open ? info.open.line : null,
  );

  // 1. Existing metadata: replace the winning entry (parser: last one wins), else append.
  const blocks = info.metas;
  if (blocks.length > 0) {
    let hit: MetaEntry | null = null;
    for (const b of blocks) for (const e of b.entries) if (e.key.value === key) hit = e;
    if (hit) {
      if (!hit.value) return null;
      if (hit.value.value === value) return null;
      return splice(hit.value.start, hit.value.end - hit.value.start, quoted);
    }
    const block = blocks[blocks.length - 1];
    if (!block.close) return null;
    const close = block.close;
    if (startsLine(close.start)) {
      const last = block.entries[block.entries.length - 1];
      const entryIndent = last && startsLine(last.key.start)
        ? indentOf(last.key.start)
        : indentOf(block.kw.start) + unit;
      return splice(lineStart(close.start), 0, `${entryIndent}${key} ${quoted}${eol}`);
    }
    const sep = /\s/.test(fileText[close.start - 1] ?? ' ') ? '' : ' ';
    return splice(close.start, 0, `${sep}${key} ${quoted} `);
  }

  // 2. Body without a metadata block.
  if (info.open) {
    if (!info.close) return null;
    const close = info.close;
    if (startsLine(close.start)) {
      const ins = `${kidIndent}metadata {${eol}${kidIndent}${unit}${key} ${quoted}${eol}${kidIndent}}${eol}`;
      return splice(lineStart(close.start), 0, ins);
    }
    const sep = /\s/.test(fileText[close.start - 1] ?? ' ') ? '' : ' ';
    return splice(close.start, 0, `${sep}metadata { ${key} ${quoted} } `);
  }

  // 3. Element without a body: add one after the header.
  const ins = ` {${eol}${baseIndent}${unit}metadata {${eol}${baseIndent}${unit}${unit}${key} ${quoted}${eol}${baseIndent}${unit}}${eol}${baseIndent}}`;
  log('editMeta', 'adding body', { fqn: info.fqn });
  return splice(info.headerEnd.end, 0, ins);
}

/**
 * The splice that deletes `start..end`: the whole line(s) with the line ending when nothing else is on them, else the
 * tokens plus the blanks before them. One helper for removeTestText, planRemoveSplices and removeLinkText.
 */
export function wholeLineSplice(fileText: string, cur: TextCursor, start: number, end: number): Splice {
  const nl = fileText.indexOf('\n', end);
  const rest = fileText.slice(end, nl < 0 ? fileText.length : nl);
  if (cur.startsLine(start) && /^[ \t\r]*$/.test(rest)) {
    const from = cur.lineStart(start);
    return { at: from, del: (nl < 0 ? fileText.length : nl + 1) - from, ins: '' };
  }
  let from = start;
  while (from > 0 && (fileText[from - 1] === ' ' || fileText[from - 1] === '\t')) from--;
  return { at: from, del: end - from, ins: '' };
}
/**
 * The splices (deletions, in text order of the entries) that remove every `key` entry from the metadata of `info`;
 * [] = nothing to change. An emptied block goes as a whole. Shared by removeElementMetadata and editMetadataBatch (b721).
 */
function planRemoveSplices(fileText: string, cur: TextCursor, info: ElemInfo, key: string): Splice[] {
  const spans: Splice[] = [];
  for (const b of info.metas) {
    const hits = b.entries.filter(e => e.key.value === key);
    if (hits.length === 0) continue;
    if (hits.length === b.entries.length) {
      if (!b.close) return [];
      spans.push(wholeLineSplice(fileText, cur, b.kw.start, b.close.end));
    } else {
      for (const e of hits) spans.push(wholeLineSplice(fileText, cur, e.key.start, (e.value ?? e.key).end));
    }
  }
  return spans;
}

/** The splices one metadata edit makes on `info`: set when `value` is a string, remove when null. [] = unchanged. */
function planMetaEdit(fileText: string, cur: TextCursor, info: ElemInfo, key: string, value: string | null): Splice[] {
  if (value === null) return planRemoveSplices(fileText, cur, info, key);
  const s = planSetSplice(fileText, cur, info, key, value);
  return s ? [s] : [];
}

/** Apply splices one by one from the highest offset down (ties keep their order), each on the text the previous left. */
function spliceDescending(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.at - a.at)) out = textCursor(out).splice(s.at, s.ins, s.del).text;
  return out;
}

/** One metadata edit on the element `elementFqn` of `fileText`: the body of setElementMetadata / removeElementMetadata. */
function editElementMetadata(
  fileText: string,
  elementFqn: string,
  key: string,
  value: string | null,
): { text: string; changed: boolean } {
  const err = metaEditError(key, value);
  if (err) throw new Error(err);

  const unchanged = { text: fileText, changed: false };
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return unchanged;

  const info = walk(toks).find(e => e.fqn === elementFqn);
  if (!info) return unchanged;

  const splices = planMetaEdit(fileText, textCursor(fileText), info, key, value);
  if (splices.length === 0) return unchanged;
  return { text: spliceDescending(fileText, splices), changed: true };
}
/**
 * Add or replace ONE `key 'value'` in the metadata block of the element with this fqn.
 * Pure text transformation: every byte outside the edit stays identical.
 * Element not found, or text too broken to edit safely (unterminated string, unclosed
 * block): returns the text unchanged with changed:false; never throws on .c4 text.
 * Throws only for invalid arguments (key not a c4 ident, value containing a line break).
 */
export function setElementMetadata(
  fileText: string,
  elementFqn: string,
  key: string,
  value: string,
): { text: string; changed: boolean } {
  return editElementMetadata(fileText, elementFqn, key, value);
}

/**
 * Remove EVERY `key ...` entry of the metadata blocks of the element with this fqn (the parser lets the last one
 * win, so a partial removal would bring an older one back). A metadata block left with no entry goes too. Whole lines
 * go with their line ending (CRLF kept as found); entries or blocks sharing a line with other tokens go alone.
 * Element or key not found, or text too broken to edit safely: unchanged, changed:false; never throws on .c4 text.
 * Throws only for an invalid key.
 */
export function removeElementMetadata(
  fileText: string,
  elementFqn: string,
  key: string,
): { text: string; changed: boolean } {
  return editElementMetadata(fileText, elementFqn, key, null);
}

/** One edit of editMetadataBatch: set `key` to `value` on the element with fqn `fqn`, or remove `key` when `value` is null. */
export type MetaEdit = { fqn: string; key: string; value: string | null };

/**
 * Many metadata edits on one file in one pass (b721: `plan ids` and `plan apply-layout` were quadratic, one rescan per
 * element). The result is byte for byte what setElementMetadata / removeElementMetadata applied one by one in `edits`
 * order give: the file is scanned and walked once, each edit plans its splice on the original text with the same code
 * as the single edits, and the splices go in from the last offset to the first.
 * When two edits name the same element, or two splices share an offset or overlap (a child inserted at its parent's
 * close brace, say), the edits of this file are applied one by one with the single edit instead.
 * `results[i]` = edit i changed the text. `errors[i]` = why edit i was refused (the text the single edit throws: bad
 * key, line break in the value), else null; a refused edit changes nothing and the others still apply.
 * Unterminated string or block: the text comes back unchanged, every result false.
 */
export function editMetadataBatch(
  fileText: string,
  edits: MetaEdit[],
): { text: string; results: boolean[]; errors: (string | null)[] } {
  const errors = edits.map(e => metaEditError(e.key, e.value));
  const results = edits.map(() => false);
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return { text: fileText, results, errors };

  const byFqn = new Map<string, ElemInfo>();
  for (const info of walk(toks)) if (!byFqn.has(info.fqn)) byFqn.set(info.fqn, info); // first one, as find() in the single edit

  const oneByOne = (why: string) => {
    log('editMeta', 'batch applied one by one', { why, edits: edits.length });
    let text = fileText;
    edits.forEach((e, i) => {
      if (errors[i] !== null) return;
      const r = editElementMetadata(text, e.fqn, e.key, e.value);
      results[i] = r.changed;
      text = r.text;
    });
    return { text, results, errors };
  };

  const cur = textCursor(fileText);
  const splices: Splice[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const info = errors[i] === null ? byFqn.get(e.fqn) : undefined;
    if (!info) continue;
    if (seen.has(e.fqn)) return oneByOne('same element twice');
    seen.add(e.fqn);
    const planned = planMetaEdit(fileText, cur, info, e.key, e.value);
    results[i] = planned.length > 0;
    splices.push(...planned);
  }
  if (splices.length === 0) return { text: fileText, results, errors };

  splices.sort((a, b) => a.at - b.at);
  for (let k = 1; k < splices.length; k++) {
    const prev = splices[k - 1];
    if (splices[k].at === prev.at || prev.at + prev.del > splices[k].at) return oneByOne('splices meet');
  }
  const parts: string[] = [];
  let pos = 0;
  for (const s of splices) {
    parts.push(fileText.slice(pos, s.at), s.ins);
    pos = s.at + s.del;
  }
  parts.push(fileText.slice(pos));
  return { text: parts.join(''), results, errors };
}

/** Exposed for the lexer-parity test. */
export const _scanForTest = scan;

/** b456: the offset-carrying scanner (token-for-token parity with tokenize), for rewrites by token position (c4/planUpgrade.ts). */
export const scanPlanTokens = scan;
export type PlanToken = Tok;

/** Character offsets [start, end) of one token in the file text (a string token includes its quotes). */
export interface Span { start: number; end: number }
/** A simple body line (`title|description|technology 'x'` or `link x ['t']`). */
export interface BodyLineSpans {
  kwStart: number;
  kwLine: number;      // 1-based line of the keyword
  value: Span;         // the value token (for `link`: the link token)
  end: number;         // end offset of the last token of the line
}
export interface ElementSpans {
  fqn: string;
  idStart: number;
  idLine: number;
  headerEnd: number;                 // end offset of the last header token (title or header description)
  title: Span;                       // header title string
  headerDescription: Span | null;    // second string of the header, if any
  open: number | null;               // offset of the body `{`
  openLine: number | null;
  close: number | null;              // offset of the body `}` (null: no body or unterminated)
  closeLine: number | null;
  firstBodyStart: number | null;     // offset of the first token inside the body
  firstBodyLine: number | null;
  metas: {
    kwStart: number;
    closeStart: number | null;
    entries: { key: string; keyStart: number; valueStart: number | null; valueEnd: number | null }[];
  }[];
  titleLines: BodyLineSpans[];
  descriptionLines: BodyLineSpans[];
  technologyLines: BodyLineSpans[];
  linkLines: BodyLineSpans[];
  /** `test` blocks (Phase 26): name, offsets [start, end) from the keyword to the last token, first and last line. */
  tests: { name: string; start: number; end: number; line: number; endLine: number }[];
}

const lineSpans = (ls: BodyLine[]): BodyLineSpans[] =>
  ls.map(l => ({ kwStart: l.kw.start, kwLine: l.kw.line, value: { start: l.value.start, end: l.value.end }, end: l.end }));

/**
 * Token spans of the element with this fqn, for editors that insert or replace text (same scanner and
 * structural walk as setElementMetadata). null for an unknown fqn or a text with an unterminated string.
 */
export function locateElement(fileText: string, fqn: string): ElementSpans | null {
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return null;
  const info = walk(toks).find(e => e.fqn === fqn);
  if (!info) return null;
  return {
    fqn: info.fqn,
    idStart: info.idTok.start,
    idLine: info.idTok.line,
    headerEnd: info.headerEnd.end,
    title: { start: info.titleTok.start, end: info.titleTok.end },
    headerDescription: info.descTok ? { start: info.descTok.start, end: info.descTok.end } : null,
    open: info.open ? info.open.start : null,
    openLine: info.open ? info.open.line : null,
    close: info.close ? info.close.start : null,
    closeLine: info.close ? info.close.line : null,
    firstBodyStart: info.firstBody ? info.firstBody.start : null,
    firstBodyLine: info.firstBody ? info.firstBody.line : null,
    metas: info.metas.map(m => ({
      kwStart: m.kw.start,
      closeStart: m.close ? m.close.start : null,
      entries: m.entries.map(e => ({
        key: e.key.value,
        keyStart: e.key.start,
        valueStart: e.value ? e.value.start : null,
        valueEnd: e.value ? e.value.end : null,
      })),
    })),
    titleLines: lineSpans(info.titleLines),
    descriptionLines: lineSpans(info.descriptionLines),
    technologyLines: lineSpans(info.technologyLines),
    linkLines: lineSpans(info.linkLines),
    tests: info.testLines.map(t => ({ name: t.name.value, start: t.kw.start, end: t.last.end, line: t.kw.line, endLine: t.last.line })),
  };
}

/**
 * The one-line text of a `test` block (D16, A6: writers emit one line): `test 'name' {}` (to write) or
 * `test 'name' { case '<id>' }` (hand link). Throws for a name or case with a line break.
 */
export function testBlockText(test: Pick<PlanTest, 'name' | 'case'>): string {
  for (const v of [test.name, test.case ?? '']) if (/[\r\n]/.test(v)) throw new Error('a test name or case must not contain line breaks');
  return test.case === null ? `test ${quoteC4String(test.name)} {}` : `test ${quoteC4String(test.name)} { case ${quoteC4String(test.case)} }`;
}

/**
 * Add a one-line `test` block at the end of the body of the element with this fqn (insertChildBlock: same indent rules
 * as plan add; a body is added when the element has none). Pure. Element not found or text not editable: unchanged.
 */
export function addTestText(fileText: string, parentFqn: string, test: Pick<PlanTest, 'name' | 'case'>): { text: string; changed: boolean } {
  const line = testBlockText(test);
  const at = locateElement(fileText, parentFqn);
  if (!at) return { text: fileText, changed: false };
  return insertChildBlock(fileText, at, ({ kid, eol }) => `${kid}${line}${eol}`);
}

/**
 * Remove the first `test` block named `name` from the element with this fqn. A block alone on its lines goes with its
 * lines (line break included); a block sharing a line with other tokens goes with the blanks before it. Pure.
 * Element or block not found, or text not editable: unchanged.
 */
export function removeTestText(fileText: string, fqn: string, name: string): { text: string; changed: boolean } {
  const t = locateElement(fileText, fqn)?.tests.find(x => x.name === name);
  if (!t) return { text: fileText, changed: false };
  const cur = textCursor(fileText);
  const s = wholeLineSplice(fileText, cur, t.start, t.end);
  return cur.splice(s.at, s.ins, s.del);
}

/** The part of ElementSpans an insert needs (defined next to insertChildBlock); `model { }` and `extend x { }` have these too. */
export type { BlockSpans };

/**
 * Spans of the first top-level `model { }` block, so a top-level element (system, person, external) can be inserted
 * like a child of an element. null when the file has no model block or an unterminated string.
 */
export function locateModelBlock(fileText: string): BlockSpans | null {
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return null;
  let depth = 0;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (t.type === 'lbrace') depth++;
    else if (t.type === 'rbrace') depth--;
    else if (depth === 0 && t.type === 'ident' && t.value === 'model' && toks[i + 1].type === 'lbrace') {
      const open = toks[i + 1];
      let d = 1;
      let j = i + 2;
      for (; j < toks.length && d > 0; j++) {
        if (toks[j].type === 'lbrace') d++;
        else if (toks[j].type === 'rbrace') d--;
      }
      const close = d === 0 ? toks[j - 1] : null;
      const first = toks[i + 2];
      const hasBody = first.type !== 'eof' && first !== close;
      return {
        idStart: t.start, headerEnd: t.end, open: open.start, openLine: open.line,
        close: close ? close.start : null, closeLine: close ? close.line : null,
        firstBodyStart: hasBody ? first.start : null, firstBodyLine: hasBody ? first.line : null,
      };
    }
  }
  return null;
}

/**
 * One reference token of a .c4 text: an `extend` target, or a relation end as written (`from` = the id before `->`,
 * absent for the short form `-> x` in a body; `to` = the target). Offsets [start, end) cover the token only.
 */
export interface RefSpan { role: 'extend' | 'from' | 'to'; value: string; start: number; end: number; line: number }

/**
 * Every reference token of one .c4 text, in text order (same scanner and walk as locateElement). Strings and comments
 * are never tokens, so they are never listed; tokens inside a relation's `{ }` are skipped as the parser skips them.
 * null for a text with an unterminated string.
 */
export function locateRefs(fileText: string): RefSpan[] | null {
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return null;
  const out: WalkExtras = { refs: [], extendBlocks: [] };
  walk(toks, out);
  return out.refs;
}

/**
 * Spans of every `extend <fqn> { }` block of one .c4 text, in text order (idStart = the `extend` keyword, headerEnd =
 * end of the target). [] for none, and for a text with an unterminated string.
 */
export function locateExtendBlocks(fileText: string, fqn: string): BlockSpans[] {
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return [];
  const out: WalkExtras = { refs: [], extendBlocks: [] };
  walk(toks, out);
  return out.extendBlocks.filter(b => b.target.value === fqn).map(b => ({
    idStart: b.kw.start, headerEnd: b.target.end, open: b.open.start, openLine: b.open.line,
    close: b.close ? b.close.start : null, closeLine: b.close ? b.close.line : null,
    firstBodyStart: b.firstBody ? b.firstBody.start : null, firstBodyLine: b.firstBody ? b.firstBody.line : null,
  }));
}

/**
 * 1-based numbers of the lines that START inside a string token (the lines after the first of a multi-line string).
 * A re-indenting editor leaves those lines, and the line break before each, byte-equal. null = unterminated string.
 */
export function linesInsideStrings(fileText: string): Set<number> | null {
  const { toks, unterminated } = scan(fileText);
  if (unterminated) return null;
  const lines = new Set<number>();
  for (const t of toks) {
    if (t.type !== 'string') continue;
    const breaks = (fileText.slice(t.start, t.end).match(/\n/g) ?? []).length;
    for (let i = 1; i <= breaks; i++) lines.add(t.line + i);
  }
  return lines;
}
