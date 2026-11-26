import * as fs from 'fs';
import * as path from 'path';
import { tokenize, Token } from '../src/plan/lexer';

describe('lexer', () => {
  it('tokenizes first 12 tokens of auth.c4 correctly', () => {
    const authC4Path = path.join(__dirname, 'fixtures/phofast/src/api/auth/auth.c4');
    const text = fs.readFileSync(authC4Path, 'utf-8');

    const result = tokenize(text);
    const first12 = result.tokens.slice(0, 12);

    expect(first12).toHaveLength(12);

    // Expected first 12 tokens (skipping comment on line 1)
    expect(first12[0]).toEqual({ type: 'ident', value: 'model', line: 2 });
    expect(first12[1]).toEqual({ type: 'lbrace', value: '{', line: 2 });
    expect(first12[2]).toEqual({ type: 'ident', value: 'extend', line: 3 });
    expect(first12[3]).toEqual({ type: 'ident', value: 'phofast.api', line: 3 });
    expect(first12[4]).toEqual({ type: 'lbrace', value: '{', line: 3 });
    expect(first12[5]).toEqual({ type: 'ident', value: 'auth', line: 4 });
    expect(first12[6]).toEqual({ type: 'equals', value: '=', line: 4 });
    expect(first12[7]).toEqual({ type: 'ident', value: 'component', line: 4 });
    expect(first12[8]).toEqual({ type: 'string', value: 'Auth Service', line: 4 });
    expect(first12[9]).toEqual({ type: 'lbrace', value: '{', line: 4 });
    expect(first12[10]).toEqual({ type: 'ident', value: 'technology', line: 5 });
    expect(first12[11]).toEqual({ type: 'string', value: 'JWT / Passport.js', line: 5 });
  });

  it('tokenizes architecture.c4 with 0 errors and contains arrow token', () => {
    const archC4Path = path.join(__dirname, 'fixtures/phofast/src/architecture.c4');
    const text = fs.readFileSync(archC4Path, 'utf-8');

    const result = tokenize(text);

    expect(result.errors).toHaveLength(0);

    // Find arrow token at the line of "customer -> phofast.web"
    const arrowToken = result.tokens.find(
      t => t.type === 'arrow' && t.line === 22
    );
    expect(arrowToken).toBeDefined();
    expect(arrowToken).toEqual({ type: 'arrow', value: '->', line: 22 });
  });

  it('tokenizes a -> b \'x\' correctly', () => {
    const result = tokenize("a -> b 'x'");
    const tokens = result.tokens.filter(t => t.type !== 'eof');

    expect(tokens).toHaveLength(4);
    expect(tokens[0]).toEqual({ type: 'ident', value: 'a', line: 1 });
    expect(tokens[1]).toEqual({ type: 'arrow', value: '->', line: 1 });
    expect(tokens[2]).toEqual({ type: 'ident', value: 'b', line: 1 });
    expect(tokens[3]).toEqual({ type: 'string', value: 'x', line: 1 });
  });

  it('handles block comments spanning multiple lines', () => {
    const text = `model {
  /* This is a
     block comment
     spanning lines */
  extend phofast.api
}`;

    const result = tokenize(text);
    const nonEofTokens = result.tokens.filter(t => t.type !== 'eof');

    expect(result.errors).toHaveLength(0);

    // Check that line numbers are preserved
    expect(nonEofTokens[0]).toEqual({ type: 'ident', value: 'model', line: 1 });
    expect(nonEofTokens[1]).toEqual({ type: 'lbrace', value: '{', line: 1 });
    expect(nonEofTokens[2]).toEqual({ type: 'ident', value: 'extend', line: 5 });
    expect(nonEofTokens[3]).toEqual({ type: 'ident', value: 'phofast.api', line: 5 });
    expect(nonEofTokens[4]).toEqual({ type: 'rbrace', value: '}', line: 6 });
  });

  it('reports error on unterminated string', () => {
    const result = tokenize("auth = component 'unterminated");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      line: 1,
      message: 'unterminated string'
    });

    // The unterminated string token should still be created
    const stringTokens = result.tokens.filter(t => t.type === 'string');
    expect(stringTokens).toHaveLength(1);
    expect(stringTokens[0]).toEqual({
      type: 'string',
      value: 'unterminated',
      line: 1
    });
  });

  it('tokenizes link ./index.ts#L6-L13 \'Token verify logic\' correctly', () => {
    const result = tokenize("link ./index.ts#L6-L13 'Token verify logic'");
    const nonEofTokens = result.tokens.filter(t => t.type !== 'eof');

    expect(nonEofTokens).toHaveLength(3);
    expect(nonEofTokens[0]).toEqual({ type: 'ident', value: 'link', line: 1 });
    expect(nonEofTokens[1]).toEqual({ type: 'word', value: './index.ts#L6-L13', line: 1 });
    expect(nonEofTokens[2]).toEqual({ type: 'string', value: 'Token verify logic', line: 1 });
  });

  it('ends with eof token', () => {
    const result = tokenize('model { }');
    const lastToken = result.tokens[result.tokens.length - 1];

    expect(lastToken).toEqual({ type: 'eof', value: '', line: 1 });
  });

  it('handles string escapes correctly', () => {
    const result = tokenize("'can\\'t' \"escaped \\\" quote\"");
    const stringTokens = result.tokens.filter(t => t.type === 'string');

    expect(stringTokens).toHaveLength(2);
    expect(stringTokens[0]).toEqual({ type: 'string', value: "can't", line: 1 });
    expect(stringTokens[1]).toEqual({ type: 'string', value: 'escaped " quote', line: 1 });
  });

  it('distinguishes ident from word', () => {
    const result = tokenize('phofast.api ./index.ts#L6-L13');
    const nonEofTokens = result.tokens.filter(t => t.type !== 'eof');

    expect(nonEofTokens).toHaveLength(2);
    expect(nonEofTokens[0]).toEqual({ type: 'ident', value: 'phofast.api', line: 1 });
    expect(nonEofTokens[1]).toEqual({ type: 'word', value: './index.ts#L6-L13', line: 1 });
  });

  it('recognizes ident with dash', () => {
    const result = tokenize('sample_shop.api root-files');
    const nonEofTokens = result.tokens.filter(t => t.type !== 'eof');

    expect(nonEofTokens[0]).toEqual({ type: 'ident', value: 'sample_shop.api', line: 1 });
    expect(nonEofTokens[1]).toEqual({ type: 'ident', value: 'root-files', line: 1 });
  });

  it('tracks line numbers across different token types', () => {
    const text = `model {
  customer -> phofast
  'description'
  extend x
}`;

    const result = tokenize(text);
    const nonEofTokens = result.tokens.filter(t => t.type !== 'eof');

    expect(nonEofTokens[0].line).toBe(1); // model
    expect(nonEofTokens[1].line).toBe(1); // {
    expect(nonEofTokens[2].line).toBe(2); // customer
    expect(nonEofTokens[3].line).toBe(2); // ->
    expect(nonEofTokens[4].line).toBe(2); // phofast
    expect(nonEofTokens[5].line).toBe(3); // 'description'
    expect(nonEofTokens[6].line).toBe(4); // extend
    expect(nonEofTokens[7].line).toBe(4); // x
    expect(nonEofTokens[8].line).toBe(5); // }
  });
});
