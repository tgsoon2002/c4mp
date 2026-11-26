import { log } from '../log';

export type TokenType = 'ident' | 'string' | 'lbrace' | 'rbrace' | 'arrow' | 'equals' | 'word' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export function tokenize(text: string): {
  tokens: Token[];
  errors: { line: number; message: string }[];
} {
  const tokens: Token[] = [];
  const errors: { line: number; message: string }[] = [];
  let pos = 0;
  let line = 1;

  const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  const isNewline = (ch: string): boolean => ch === '\n';
  const isIdent1 = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isIdent = (ch: string): boolean => /[A-Za-z0-9_-]/.test(ch);
  const isNonSpace = (ch: string): boolean => !isWhitespace(ch);

  while (pos < text.length) {
    const ch = text[pos];

    // Skip whitespace
    if (isWhitespace(ch)) {
      if (isNewline(ch)) {
        line++;
      }
      pos++;
      continue;
    }

    // Handle comments
    if (ch === '/' && pos + 1 < text.length) {
      if (text[pos + 1] === '/') {
        // Line comment: skip to end of line
        while (pos < text.length && !isNewline(text[pos])) {
          pos++;
        }
        continue;
      } else if (text[pos + 1] === '*') {
        // Block comment: skip to */
        pos += 2;
        while (pos + 1 < text.length) {
          if (text[pos] === '*' && text[pos + 1] === '/') {
            pos += 2;
            break;
          }
          if (isNewline(text[pos])) {
            line++;
          }
          pos++;
        }
        // If we reached end of input without closing, leave pos at end
        if (pos === text.length) {
          // Block comment not closed, but we don't error here
        }
        continue;
      }
    }

    // Handle strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const stringStart = pos;
      const stringLine = line;
      pos++; // skip opening quote

      let stringValue = '';
      let closed = false;

      while (pos < text.length) {
        const curr = text[pos];

        if (curr === '\\' && pos + 1 < text.length) {
          const next = text[pos + 1];
          if (next === quote || next === '\\') {
            stringValue += next;
            pos += 2;
          } else {
            stringValue += curr;
            pos++;
          }
        } else if (curr === quote) {
          closed = true;
          pos++;
          break;
        } else if (isNewline(curr)) {
          line++;
          stringValue += curr;
          pos++;
        } else {
          stringValue += curr;
          pos++;
        }
      }

      if (!closed) {
        errors.push({ line: stringLine, message: 'unterminated string' });
        // Create token for the partial string up to end of line
        const eolPos = stringValue.indexOf('\n');
        if (eolPos !== -1) {
          stringValue = stringValue.substring(0, eolPos);
        }
        tokens.push({ type: 'string', value: stringValue, line: stringLine });
      } else {
        tokens.push({ type: 'string', value: stringValue, line: stringLine });
      }
      continue;
    }

    // Handle arrow
    if (ch === '-' && pos + 1 < text.length && text[pos + 1] === '>') {
      tokens.push({ type: 'arrow', value: '->', line });
      pos += 2;
      continue;
    }

    // Handle single char tokens
    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', line });
      pos++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', line });
      pos++;
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: 'equals', value: '=', line });
      pos++;
      continue;
    }

    // Handle ident: [A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*
    // Only if followed by whitespace, {, }, =, quote, or end of input
    if (isIdent1(ch)) {
      const identStart = pos;
      pos++; // consume first char

      // Consume the ident parts separated by dots
      while (pos < text.length) {
        if (isIdent(text[pos])) {
          pos++;
        } else if (text[pos] === '.' && pos + 1 < text.length && isIdent1(text[pos + 1])) {
          pos++; // consume dot
          pos++; // consume first char of next part
          while (pos < text.length && isIdent(text[pos])) {
            pos++;
          }
        } else {
          break;
        }
      }

      // Check if this is truly an ident: the next char must be whitespace, {, }, =, quote, or end
      const nextChar = pos < text.length ? text[pos] : null;
      const isValidIdent = nextChar === null ||
                          isWhitespace(nextChar) ||
                          nextChar === '{' ||
                          nextChar === '}' ||
                          nextChar === '=' ||
                          nextChar === '"' ||
                          nextChar === "'";

      if (isValidIdent) {
        const identValue = text.substring(identStart, pos);
        tokens.push({ type: 'ident', value: identValue, line });
      } else {
        // Not an ident, treat as word
        pos = identStart;
        const wordStart = pos;
        while (pos < text.length && isNonSpace(text[pos]) && text[pos] !== '{' && text[pos] !== '}') {
          pos++;
        }
        const wordValue = text.substring(wordStart, pos);
        tokens.push({ type: 'word', value: wordValue, line });
      }
      continue;
    }

    // Handle word: any other run of non-space characters that isn't { or }
    if (isNonSpace(ch) && ch !== '{' && ch !== '}') {
      const wordStart = pos;
      while (pos < text.length && isNonSpace(text[pos]) && text[pos] !== '{' && text[pos] !== '}') {
        pos++;
      }
      const wordValue = text.substring(wordStart, pos);
      tokens.push({ type: 'word', value: wordValue, line });
      continue;
    }

    // Unexpected character (shouldn't happen)
    pos++;
  }

  tokens.push({ type: 'eof', value: '', line });

  log('lexer', `tokenized ${tokens.length} tokens, ${errors.length} errors`);
  errors.forEach(err => log('lexer', `error at line ${err.line}: ${err.message}`));

  return { tokens, errors };
}
