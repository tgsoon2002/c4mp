import fs from 'fs';
import path from 'path';

// Phase 30 b901 (slice 5): the live light of c4pm serve. Reads viewer/style.css and viewer/index.html as text.
const VIEWER = path.join(__dirname, '..', 'viewer');
const css = fs.readFileSync(path.join(VIEWER, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(VIEWER, 'index.html'), 'utf8');

// The text of the block that opens at `start` (index of its "{") up to the matching "}".
function blockAt(text: string, braceIdx: number): string {
  let depth = 0;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(braceIdx, i + 1);
  }
  throw new Error('unbalanced css block');
}

function blockOf(selector: string): string {
  const at = css.indexOf(selector);
  expect(at).toBeGreaterThanOrEqual(0);
  return blockAt(css, css.indexOf('{', at));
}

// The rule whose selector list is exactly `selector` (line start), up to its closing brace.
function ruleOf(selector: string): string {
  const m = new RegExp('^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm').exec(css);
  expect(m).not.toBeNull();
  return blockAt(css, (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length - 1);
}

describe('b901 live light: style tokens and rules', () => {
  const themeBlocks: Array<[string, string]> = [
    ['light :root', blockOf(':root {')],
    ['prefers-color-scheme dark', blockOf('@media (prefers-color-scheme: dark)')],
    ['data-theme dark', blockOf(':root[data-theme="dark"] {')],
  ];

  it.each(themeBlocks)('%s defines the four colour tokens', (_name, block) => {
    for (const token of ['--live-ok', '--live-busy', '--live-bad', '--live-strength']) {
      expect(block).toContain(token + ':');
    }
  });

  it(':root defines --live-glow and --live-dot on one line', () => {
    const rootBlock = themeBlocks[0][1];
    expect(rootBlock.split('\n').some((l) => l.includes('--live-glow:') && l.includes('--live-dot:'))).toBe(true);
  });

  it('the #header[data-live] rule is an inset box-shadow with no z-index; ::after takes no pointer events', () => {
    const rule = ruleOf('#header[data-live]');
    expect(rule).toContain('box-shadow: inset');
    expect(rule).not.toContain('z-index');
    expect(ruleOf('#header[data-live]::after')).toContain('pointer-events: none');
  });

  it('updating/new map to --live-busy, failed/stopped to --live-bad', () => {
    expect(ruleOf('#header[data-live="updating"], #header[data-live="new"]')).toContain('--live-c: var(--live-busy)');
    expect(ruleOf('#header[data-live="failed"], #header[data-live="stopped"]')).toContain('--live-c: var(--live-bad)');
  });
});

describe('b901 live light: badge slot in index.html', () => {
  it('#live-badge sits inside <header id="header"> with role=status, aria-live=polite, hidden', () => {
    const open = html.indexOf('<header id="header"');
    const close = html.indexOf('</header>');
    expect(open).toBeGreaterThanOrEqual(0);
    const header = html.slice(open, close);
    const tag = /<span id="live-badge"[^>]*>/.exec(header);
    expect(tag).not.toBeNull();
    expect(tag![0]).toContain('role="status"');
    expect(tag![0]).toContain('aria-live="polite"');
    expect(/\shidden[\s>]/.test(tag![0])).toBe(true);
    expect(html.match(/id="live-badge"/g)).toHaveLength(1);
  });

  it('adds no URL: style.css has none, index.html only the credit link', () => {
    expect(css).not.toMatch(/https?:\/\//);
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
    expect(urls.length).toBeLessThanOrEqual(1);
  });
});
