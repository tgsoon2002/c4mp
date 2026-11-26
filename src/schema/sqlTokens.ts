// P23 (b212 D3): SQL tokenizer and statement splitter for the sql-migrations reader. Pure, no dependency.
// Handles: -- and nested block comments, 'strings' (with '' and E'\'' escapes), "quoted", `quoted` and [bracket]
// identifiers, $tag$ ... $tag$ dollar-quoted bodies (one string token), and ';' inside CREATE FUNCTION /
// PROCEDURE / TRIGGER ... BEGIN ... END blocks. An unterminated string or comment runs to the end of the file
// (the statement then falls out as unsupported; nothing throws).

/** w = bare word, q = quoted identifier, s = string or dollar body, n = number, p = one punctuation char. */
export interface Tok {
  k: 'w' | 'q' | 's' | 'n' | 'p';
  /** Text: a word as written, a quoted identifier or string without its quotes. */
  v: string;
  /** Upper-case word for keyword tests; '' for every kind but w. */
  up: string;
  /** 1-based line of the first character. */
  line: number;
  /** Offsets in the file text (end exclusive); slice the text for the source form. */
  start: number;
  end: number;
}

export interface Statement {
  toks: Tok[];
  line: number;
  endLine: number;
}

const isWordStart = (c: string): boolean => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string): boolean => /[\w$\u0080-￿]/.test(c);

export function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const push = (k: Tok['k'], v: string, start: number, startLine: number): void => {
    toks.push({ k, v, up: k === 'w' ? v.toUpperCase() : '', line: startLine, start, end: i });
  };
  const countLines = (from: number, to: number): void => {
    for (let j = from; j < to; j++) if (text[j] === '\n') line++;
  };
  /** Quoted run starting at i (the opening quote); a doubled closing quote is a literal one. Returns the content. */
  const quoted = (close: string, backslash: boolean): string => {
    let out = '';
    i++;
    while (i < n) {
      const c = text[i];
      if (backslash && c === '\\' && i + 1 < n) { out += text[i + 1]; i += 2; continue; }
      if (c === close) {
        if (text[i + 1] === close) { out += close; i += 2; continue; }
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && text[i + 1] === '-') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      const from = i;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; } else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      countLines(from, i);
      continue;
    }
    const start = i;
    const startLine = line;
    if (c === "'") {
      // E'...' : the E is a separate word token just before; fold it in and honour backslash escapes.
      const prev = toks[toks.length - 1];
      const escE = prev !== undefined && prev.k === 'w' && prev.up === 'E' && prev.end === start;
      if (escE) toks.pop();
      const v = quoted("'", escE);
      countLines(start, i);
      push('s', v, escE ? prev.start : start, startLine);
      continue;
    }
    if (c === '"' || c === '`') {
      const v = quoted(c, false);
      countLines(start, i);
      push('q', v, start, startLine);
      continue;
    }
    if (c === '[' && !(start > 0 && /[\w\])]/.test(text[start - 1]))) {
      const m = /^\[([A-Za-z_][^\][\n]*)\]/.exec(text.slice(i, i + 200));
      if (m) { i += m[0].length; push('q', m[1], start, startLine); continue; }
    }
    if (c === '$' && !(start > 0 && isWordChar(text[start - 1]))) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const v = text.slice(i + tag.length, close < 0 ? n : close);
        i = close < 0 ? n : close + tag.length;
        countLines(start, i);
        push('s', v, start, startLine);
        continue;
      }
    }
    if (isWordStart(c)) {
      while (i < n && isWordChar(text[i])) i++;
      push('w', text.slice(start, i), start, startLine);
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9.]/.test(text[i])) i++;
      push('n', text.slice(start, i), start, startLine);
      continue;
    }
    i++;
    push('p', c, start, startLine);
  }
  return toks;
}

const ROUTINE = new Set(['FUNCTION', 'PROCEDURE', 'TRIGGER']);

/** Split tokens at top-level ';'. A CREATE FUNCTION/PROCEDURE/TRIGGER with a BEGIN ... END body keeps its inner ';'. */
export function splitStatements(toks: Tok[]): Statement[] {
  const out: Statement[] = [];
  let cur: Tok[] = [];
  let routine: boolean | null = null;
  let depth = 0;
  const flush = (): void => {
    if (cur.length > 0) out.push({ toks: cur, line: cur[0].line, endLine: cur[cur.length - 1].line });
    cur = [];
    routine = null;
    depth = 0;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'p' && t.v === ';' && depth === 0) { flush(); continue; }
    cur.push(t);
    if (routine === null && cur[0].up === 'CREATE' && t.k === 'w' && ROUTINE.has(t.up)) routine = true;
    else if (routine === null && cur.length >= 8) routine = false;
    if (routine === true && t.k === 'w') {
      if (t.up === 'BEGIN' || t.up === 'CASE') depth++;
      else if (t.up === 'END') {
        const nx = toks[i + 1];
        if (!(nx && nx.k === 'w' && ['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(nx.up))) depth = Math.max(0, depth - 1);
      }
    }
  }
  flush();
  return out;
}
