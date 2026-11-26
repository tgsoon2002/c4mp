import path from 'path';
import fs from 'fs';
import { grammarFor, parseSource, fixOptionalChainDigit } from '../src/languages/typescript/language';
import { extractOutline } from '../src/languages/typescript/outline';

const fixtureDir = path.join(__dirname, 'fixtures/sample');

describe('language', () => {
  it('determines grammar: .jsx → tsx', () => {
    const grammar = grammarFor('component.jsx');
    expect(grammar).toBe('tsx');
  });

  it('determines grammar: .cts → typescript', () => {
    const grammar = grammarFor('file.cts');
    expect(grammar).toBe('typescript');
  });

  it('parses fixture Cart.jsx without error', () => {
    const filePath = path.join(fixtureDir, 'web/src/components/Cart.jsx');
    const code = fs.readFileSync(filePath, 'utf8');
    const { tree, grammar } = parseSource(code, filePath);

    expect(grammar).toBe('tsx');
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.toString()).toMatch(/^\(program/);
  });

  it('parses ~200 KB source without throwing', () => {
    // Generate a ~200 KB TypeScript source
    const lines: string[] = [];
    lines.push('// Generated test file');

    // Add enough content to reach ~200 KB
    for (let i = 0; i < 3000; i++) {
      lines.push(`export function func${i}(param: string): string {
  const result = "some value";
  return result;
}`);
    }

    const code = lines.join('\n');
    expect(code.length).toBeGreaterThan(200000);

    // Should not throw and should parse successfully
    const { tree } = parseSource(code, 'generated.ts');
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('detects parse errors in broken code', () => {
    const brokenCode = 'function (';
    const { tree } = parseSource(brokenCode, 'broken.jsx');

    expect(tree.rootNode.hasError).toBe(true);
  });
});

describe('b225: ternary with a decimal (w?.82:1)', () => {
  const outlineOf = (code: string, file: string) => {
    const { tree } = parseSource(code, file);
    return extractOutline(tree, file, code);
  };

  it.each(['a.js', 'a.ts'])('reads w?.82:1 as clean code in %s', (file) => {
    const o = outlineOf('export const f=w=>w?.82:1;', file);
    expect(o.parseError).toBe(false);
    expect(o.lineCount).toBe(1);
    expect(o.elements.map((e) => e.name)).toContain('f');
  });

  it.each([
    'export const f=w=>w ? .82 : 1;',
    'export const f=w=>w?0.82:1;',
    'const a=x?.5:1;',
    'const a=x?.5.toFixed():1;',
    'const f=(w:number)=>w?.82:1;',
    'const a=b?.c; const d=b?.[0]; const e=b?.(1);',
  ])('parses clean: %s', (code) => {
    expect(outlineOf(code, 'a.ts').parseError).toBe(false);
  });

  it.each([
    ['ternary', 'w?.82:1', 'w? 82:1'],
    ['member chain', 'x?.5.toFixed():1', 'x?_5.toFixed():1'],
    ['inside a template ${}', 'const t=`a${w?.82:1}`;', 'const t=`a${w? 82:1}`;'],
    ['after a regex', 'const r=/a/; w?.82:1', 'const r=/a/; w? 82:1'],
  ])('fixOptionalChainDigit rewrites %s, same length', (_n, src, want) => {
    const fixed = fixOptionalChainDigit(src);
    expect(fixed).toBe(want);
    expect(fixed.length).toBe(src.length);
  });

  it.each([
    'const s="w?.82:1";',
    "const s='w?.82:1';",
    'const t=`a?.5`;',
    '// a?.5',
    '/* a?.5 */',
    'const r=/a?.5/;',
    'const r=/[/]a?.5/;',
    'const a=b?.c; const d=b?.[0]; const e=b?.(1);',
    'const a=b??.5;',
  ])('fixOptionalChainDigit leaves untouched: %s', (src) => {
    expect(fixOptionalChainDigit(src)).toBe(src);
  });

  it('keeps line numbers after the fix', () => {
    const code = 'const a = 1;\nconst b = 2;\nconst f = w => w?.82:1;\n\nfunction later() { return 1; }\n';
    const o = outlineOf(code, 'a.js');
    expect(o.parseError).toBe(false);
    expect(o.elements.find((e) => e.name === 'later')?.startLine).toBe(5);
  });

  it('a really broken file stays a parse error', () => {
    expect(outlineOf('const a = ;', 'a.ts').parseError).toBe(true);
  });

  it('a broken file that also holds ?.digit keeps parseError', () => {
    expect(outlineOf('const a = ; const b=w?.82:1;', 'a.ts').parseError).toBe(true);
  });
});
