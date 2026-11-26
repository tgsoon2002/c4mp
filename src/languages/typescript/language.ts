import path from 'path';
import type Parser from 'tree-sitter';
import { parseWithGrammar } from '../treesitter';

// TypeScript and TSX parsing: picks the grammar by extension, then goes through the one tree-sitter
// loader (languages/treesitter.ts), which keeps the Parser class and grammars once per process.

export type GrammarName = 'typescript' | 'tsx';

/**
 * Determine the grammar for a file based on its extension.
 * .ts .mts .cts → typescript; everything else → tsx
 */
export function grammarFor(filePath: string): GrammarName {
  const ext = path.extname(filePath).toLowerCase();
  if (['.ts', '.mts', '.cts'].includes(ext)) {
    return 'typescript';
  }
  return 'tsx';
}

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'instanceof', 'yield', 'await']);

/**
 * `w?.82:1` is a ternary with a decimal: JS reads `?.` as optional chaining only when no digit follows,
 * but the tree-sitter-typescript grammar reports a parse error. This returns a same-length copy where
 * each `?.` followed by a digit becomes `? ` (`?_` when the digits go on with a `.`; offsets and line numbers unchanged), leaving strings,
 * template literals (the ${} bodies are code and are fixed), comments and regex literals alone.
 * Returns `code` itself when nothing needed fixing.
 */
export function fixOptionalChainDigit(code: string): string {
  if (!/\?\.[0-9]/.test(code)) return code;
  const out = code.split('');
  const n = code.length;
  let changed = false;
  let prev = '';          // last significant character of code
  let word = '';          // identifier that just ended at prev, for keyword-before-regex
  let braces = 0;
  const templateBraces: number[] = []; // brace depth at each open `${`
  let i = 0;

  // Scans template text from `from` (just after ` or }) up to the closing ` or an opening ${; returns the next index.
  const scanTemplate = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = code[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { prev = '`'; word = ''; return j + 1; }
      if (c === '$' && code[j + 1] === '{') { templateBraces.push(braces); prev = '{'; word = ''; return j + 2; }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
      i++; prev = c; word = ''; continue;
    }
    if (c === '`') { i = scanTemplate(i + 1); continue; }
    if (c === '/' && (REGEX_PREV.has(prev) || REGEX_KEYWORDS.has(word))) {
      i++;
      let inClass = false;
      while (i < n && code[i] !== '\n' && (inClass || code[i] !== '/')) {
        if (code[i] === '\\') i++;
        else if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        i++;
      }
      i++; prev = '/'; word = '';
      while (i < n && /[a-z]/i.test(code[i])) i++; // flags
      continue;
    }
    if (c === '?' && d === '.' && /[0-9]/.test(code[i + 2] ?? '') && prev !== '?') {
      // `x?.5.toFixed()`: `? 5.toFixed()` would lex as `5.` + name, so the dot becomes `_` (the name `_5`).
      let k = i + 2;
      while (k < n && /[0-9]/.test(code[k])) k++;
      out[i + 1] = code[k] === '.' ? '_' : ' ';
      changed = true;
    }
    if (c === '{') braces++;
    if (c === '}') {
      if (templateBraces.length > 0 && templateBraces[templateBraces.length - 1] === braces) {
        templateBraces.pop();
        i = scanTemplate(i + 1);
        continue;
      }
      braces--;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      word = code.slice(i, j);
      prev = code[j - 1];
      i = j;
      continue;
    }
    word = '';
    prev = c;
    i++;
  }
  return changed ? out.join('') : code;
}

/**
 * Parse source code and return the tree and grammar used.
 * The grammar package is required statically so a bundler can find it.
 * A first parse with errors is retried once on fixOptionalChainDigit(code); the fixed tree is kept only
 * when it is clean, otherwise the tree of the original source is returned (parseError stays true).
 */
export function parseSource(code: string, filePath: string): { tree: Parser.Tree; grammar: GrammarName } {
  const grammar = grammarFor(filePath);
  const load = () => require('tree-sitter-typescript')[grammar];
  const tree = parseWithGrammar(grammar, load, code, filePath);
  if (!tree.rootNode.hasError) return { tree, grammar };
  const fixed = fixOptionalChainDigit(code);
  if (fixed === code) return { tree, grammar };
  const retry = parseWithGrammar(grammar, load, fixed, filePath);
  return { tree: retry.rootNode.hasError ? tree : retry, grammar };
}
