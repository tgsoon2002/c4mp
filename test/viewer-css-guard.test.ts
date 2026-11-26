import * as fs from 'fs';
import * as path from 'path';

// Ratchet for the viewer's global-first CSS rule: raw colours and inline style writes may only fall.
// Counts are per file in viewer/. A rise fails (use a token / shared class); a fall asks to lower the baseline.

const viewerDir = path.join(__dirname, '..', 'viewer');
const baselinePath = path.join(__dirname, 'viewer-css-guard.baseline.json');

// The three token blocks: bare :root, the OS-dark one (inside the prefers-color-scheme media block), and data-theme="dark".
// The selector must be exactly one of these followed by '{'; ':root[data-theme="dark"] .seg button' is a normal rule.
const TOKEN_BLOCK = /:root(?::not\(\[data-theme="light"\]\)|\[data-theme="dark"\])?\s*\{[^}]*\}/g;
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/g;

export function countRawColours(css: string): number {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(TOKEN_BLOCK, '');
  return (bare.match(RAW_COLOUR) || []).length;
}

// .style.x = v, .style[k] = v, .style.cssText, and style= in a markup string. setProperty("--x") never matches.
const INLINE_STYLE = /\.style\.\w+\s*=(?!=)|\.style\[(?!\s*["']--)[^\]]+\]\s*=(?!=)|\.style\.cssText|\bstyle\s*=\s*\\?["'`]/g;
const DYNAMIC = /css-guard: dynamic\s*$/;

export function countInlineStyles(js: string): number {
  let n = 0;
  for (const line of js.split('\n')) {
    if (DYNAMIC.test(line)) continue;
    n += (line.match(INLINE_STYLE) || []).length;
  }
  return n;
}

// Structure of one CSS file: one message per problem (empty = fine). A lost '}' makes the browser drop every rule after
// it and nothing else fails, so: no merge-conflict marker line; after comments and quoted strings are blanked (line
// numbers kept), no '}' before its '{' when scanned in order, and no '{' left open at the end.
const MERGE_MARKER = /^(?:<{7}|>{7})(?:\s|$)|^={7}\s*$/;

export function checkCssStructure(css: string): string[] {
  const out: string[] = [];
  css.split('\n').forEach((line, i) => {
    if (MERGE_MARKER.test(line)) out.push(`line ${i + 1}: merge-conflict marker "${line.slice(0, 7)}"`);
  });
  const keepLines = (s: string) => s.replace(/[^\n]/g, '');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, keepLines);
  const open: number[] = [];   // line of each '{' not yet closed
  let line = 1;
  for (const ch of bare) {
    if (ch === '\n') line++;
    else if (ch === '{') open.push(line);
    else if (ch === '}' && !open.pop()) out.push(`line ${line}: '}' closes before any '{'`);
  }
  if (open.length) out.push(`${open.length} '{' never closed (the last opened at line ${open[open.length - 1]})`);
  return out;
}

type Counts = Record<string, number>;
interface Baseline { rawColours: Counts; inlineStyles: Counts }

// Compares current counts to the baseline; returns one message per file that rose or fell.
export function compareToBaseline(kind: string, fix: string, current: Counts, baseline: Counts): string[] {
  const out: string[] = [];
  for (const file of Array.from(new Set([...Object.keys(current), ...Object.keys(baseline)])).sort()) {
    const now = current[file] || 0, was = baseline[file] || 0;
    if (now > was) out.push(`${file}: ${kind} rose from ${was} to ${now}. ${fix}`);
    else if (now < was) out.push(`${file}: ${kind} fell from ${was} to ${now}. Lower the baseline in test/viewer-css-guard.baseline.json (ratchet).`);
  }
  return out;
}

function countAll(ext: string, fn: (s: string) => number): Counts {
  const out: Counts = {};
  for (const f of fs.readdirSync(viewerDir).filter((x) => x.endsWith(ext)).sort()) {
    const n = fn(fs.readFileSync(path.join(viewerDir, f), 'utf8'));
    if (n > 0) out[f] = n;
  }
  return out;
}

describe('counting', () => {
  it.each([
    ['colour in a rule', 'a { color: #fff; }', 1],
    ['rgba and hsl', 'a { background: rgba(0,0,0,.1); border-color: hsl(1,2%,3%); }', 2],
    ['var() only', 'a { color: var(--ink); }', 0],
    ['token blocks skipped', ':root { --a: #fff; }\n@media (x) {\n  :root:not([data-theme="light"]) { --a: #000; }\n}\n:root[data-theme="dark"] { --a: #111; }', 0],
    ['rule on :root descendant counts', ':root[data-theme="dark"] .seg button { color: #123456; }', 1],
    ['colour in a comment ignored', '/* was #fff */ a { color: var(--ink); }', 0],
  ])('countRawColours: %s', (_n, css, want) => expect(countRawColours(css as string)).toBe(want));

  it.each([
    ['property write', "el.style.width = '3px';", 1],
    ['cssText', "el.style.cssText = 'a:b';", 1],
    ['markup string', "h = '<div style=\"top:1px\">';", 1],
    ['bracket write', 'e.style[name] = value;', 1],
    ['custom property exempt', "e.style.setProperty('--x', v);", 0],
    ['custom property bracket write exempt', "d.style['--board-h'] = v;", 0],
    ['dynamic marker exempt', "el.style.left = x + 'px'; // css-guard: dynamic", 0],
    ['comparison is not a write', 'if (el.style.display === "none") {}', 0],
  ])('countInlineStyles: %s', (_n, js, want) => expect(countInlineStyles(js as string)).toBe(want));
});

describe('ratchet messages', () => {
  it('a rise names the fix', () => {
    const msgs = compareToBaseline('raw colours', 'Use a token from viewer/style.css or a shared class.', { 'a.css': 3 }, { 'a.css': 2 });
    expect(msgs).toEqual(['a.css: raw colours rose from 2 to 3. Use a token from viewer/style.css or a shared class.']);
  });
  it('a fall asks to lower the baseline', () => {
    expect(compareToBaseline('raw colours', 'x', { 'a.css': 1 }, { 'a.css': 2 })[0]).toMatch(/Lower the baseline/);
  });
  it('a file missing from the baseline counts as 0', () => {
    expect(compareToBaseline('raw colours', 'x', { 'new.css': 1 }, {})[0]).toMatch(/rose from 0 to 1/);
  });
  it('equal counts pass', () => {
    expect(compareToBaseline('raw colours', 'x', { 'a.css': 2 }, { 'a.css': 2 })).toEqual([]);
  });
});

describe('CSS structure', () => {
  it.each([
    ['balanced rules and media block', 'a { color: red; }\n@media (x) {\n  b { color: blue; }\n}\n', []],
    ['braces in comments and strings ignored', '/* } { */ a::before { content: "}"; }\nb { content: \'{\'; }', []],
    ['a lost }', 'a { color: red;\nb { color: blue; }\n', ["1 '{' never closed (the last opened at line 1)"]],
    ['} before its {', 'a { color: red; } }\nb { color: blue; }', ["line 1: '}' closes before any '{'"]],
    ['merge markers', 'a { x: 1; }\n<<<<<<< HEAD\nb { y: 2; }\n=======\nb { y: 3; }\n>>>>>>> topic\n', [
      'line 2: merge-conflict marker "<<<<<<<"', 'line 4: merge-conflict marker "======="', 'line 6: merge-conflict marker ">>>>>>>"',
    ]],
  ])('checkCssStructure: %s', (_n, css, want) => expect(checkCssStructure(css as string)).toEqual(want));

  it.each(fs.readdirSync(viewerDir).filter((x) => x.endsWith('.css')).sort())('viewer/%s has balanced braces and no merge markers', (f) => {
    expect(checkCssStructure(fs.readFileSync(path.join(viewerDir, f), 'utf8'))).toEqual([]);
  });
});

describe('viewer files against the baseline', () => {
  const baseline: Baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  it('raw colours in viewer/*.css', () => {
    const msgs = compareToBaseline('raw colours', 'Use a token from viewer/style.css (var(--...)) or a shared class instead of a raw colour.', countAll('.css', countRawColours), baseline.rawColours);
    expect(msgs).toEqual([]);
  });
  it('inline style writes in viewer/*.js', () => {
    const msgs = compareToBaseline('inline style writes', 'Use a shared class from viewer/style.css instead; for computed geometry end the line with the comment "css-guard: dynamic".', countAll('.js', countInlineStyles), baseline.inlineStyles);
    expect(msgs).toEqual([]);
  });
});
