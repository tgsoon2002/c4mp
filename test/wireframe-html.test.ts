import * as fs from 'fs';
import * as path from 'path';
import { privatePlanDir } from './helpers/privateRepo';
import {
  scanWireRefs, scanWireRefSpans, wireframeCssAllows, wireframeRules, WIREFRAME_CSS, WIREFRAME_BASE_CSS, WIREFRAME_KEEP_TAGS, WIREFRAME_KEEP_ATTRS,
} from '../src/c4/wireframeHtml';

describe('scanWireRefs', () => {
  const cases: Array<[string, string, string[]]> = [
    ['double quotes', '<div data-c4="a"></div>', ['a']],
    ['single quotes', "<div data-c4='a'></div>", ['a']],
    ['unquoted', '<div data-c4=a class=x></div>', ['a']],
    ['spaces around =', '<div data-c4 = "a"></div>', ['a']],
    ['upper-case names', '<DIV DATA-C4="a"></DIV>', ['a']],
    ['no value', '<div data-c4></div>', ['']],
    ['document order, repeats kept', '<p data-c4="a"><i data-c4="b"></i><i data-c4="a"></i></p>', ['a', 'b', 'a']],
    ['self-closing', '<br data-c4="a"/><input data-c4="b" />', ['a', 'b']],
    ['> inside a quoted value', '<div title="a>b" data-c4="x"></div>', ['x']],
    ['data-c4 text inside another value', '<div title=\'data-c4="no"\' data-c4="yes"></div>', ['yes']],
    ['first duplicate wins', '<div data-c4="a" data-c4="b"></div>', ['a']],
    ['similar attribute names', '<div data-c4x="a" xdata-c4="b" data-c4-hidden="c"></div>', []],
    ['decimal entity', '<div data-c4="top&#95;bar"></div>', ['top_bar']],
    ['hex entity', '<div data-c4="a&#x2e;b"></div>', ['a.b']],
    ['named entities', '<div data-c4="a&amp;b&lt;&quot;"></div>', ['a&b<"']],
    ['unknown entity stays', '<div data-c4="a&nope;b"></div>', ['a&nope;b']],
    ['comment', '<!-- <div data-c4="a"></div> --><i data-c4="b"></i>', ['b']],
    ['comment with > and -- inside', '<!-- a > b -- c --><i data-c4="b"></i>', ['b']],
    ['empty comments', '<!--><i data-c4="a"></i><!---><i data-c4="b"></i>', ['a', 'b']],
    ['unterminated comment', '<i data-c4="a"></i><!-- <i data-c4="b"></i>', ['a']],
    ['doctype and bogus comment', '<!doctype html><? x data-c4="n" ?><i data-c4="a"></i></ b data-c4="n"><i data-c4="b"></i>', ['a', 'b']],
    ['script content', '<script>var s = \'<div data-c4="a">\';</script><i data-c4="b"></i>', ['b']],
    ['script content with </ in a string', '<script>x = "</p>";</script><i data-c4="b"></i>', ['b']],
    ['style content', '<style>/* <i data-c4="a"> */</style><i data-c4="b"></i>', ['b']],
    ['textarea content', '<textarea><i data-c4="a"></i></textarea><i data-c4="b"></i>', ['b']],
    ['textarea itself counts', '<textarea data-c4="t">x</textarea>', ['t']],
    ['script tag itself counts, upper-case end tag', '<script data-c4="s">x</SCRIPT ><i data-c4="b"></i>', ['s', 'b']],
    ['template content', '<template><i data-c4="a"></i></template><i data-c4="b"></i>', ['b']],
    ['nested template', '<template><template><i data-c4="a"></i></template><i data-c4="b"></i></template><i data-c4="c"></i>', ['c']],
    ['template with attribute', '<template data-c4="t"><i data-c4="a"></i></template>', []],
    ['lone <', '1 < 2 and <3 <i data-c4="a"></i>', ['a']],
    ['tag cut off at the end', '<i data-c4="a"></i><div data-c4="b"', ['a']],
    ['unclosed quote at the end', '<i data-c4="a"></i><div data-c4="b></div>', ['a']],
    ['raw-text element never closed', '<i data-c4="a"></i><script><i data-c4="b"></i>', ['a']],
    ['no html', 'just text', []],
    ['empty', '', []],
  ];
  it.each(cases)('%s', (_name, html, expected) => {
    expect(scanWireRefs(html)).toEqual(expected);
  });

  // MV-2: the spans give the same refs, and each span is the raw value as written (quotes excluded)
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'io-wireframe', 'map_page.html'), 'utf8');
  it.each([...cases.map(([name, html]) => [name, html] as const), ['fixture map_page.html', fixture] as const])('spans: %s', (_name, html) => {
    const spans = scanWireRefSpans(html);
    expect(spans.map(s => s.ref)).toEqual(scanWireRefs(html));
    for (const s of spans) expect(html.slice(s.start, s.end)).toBe(s.raw);
  });

  it.each([
    ['<div data-c4="a&#x2e;b"></div>', { ref: 'a.b', raw: 'a&#x2e;b', start: 14, end: 22 }],
    ['<div data-c4=a class=x></div>', { ref: 'a', raw: 'a', start: 13, end: 14 }],
    ['<div data-c4></div>', { ref: '', raw: '', start: 12, end: 12 }],
  ])('span of %s', (html, span) => {
    expect(scanWireRefSpans(html)).toEqual([span]);
  });
});

// Private plan only: the public tree has no ../.c4mp, so the block skips there (b963).
(privatePlanDir() ? describe : describe.skip)("C4PM's own wireframes", () => {
  const dir = path.join(privatePlanDir() ?? '', 'io');
  // distinct refs (a ref on two elements counts once); elements = every data-c4 occurrence outside comments
  const expected: Array<[string, number, number]> = [
    ['c4mp.c4mp.map_page', 45, 46],
    ['c4mp.c4mp.io_view', 5, 5],
    ['c4mp.c4mp.own_window', 5, 5],
  ];
  it.each(expected)('%s', (fqn, distinct, elements) => {
    const refs = scanWireRefs(fs.readFileSync(path.join(dir, fqn + '.html'), 'utf8'));
    expect(refs).toHaveLength(elements);
    expect(new Set(refs).size).toBe(distinct);
  });
});

describe('rule table', () => {
  it.each([
    'display', 'flex', 'flex-direction', 'align-items', 'justify-content', 'place-items', 'order', 'gap', 'row-gap', 'column-gap',
    'grid', 'grid-area', 'grid-template-columns', 'width', 'height', 'min-width', 'max-height', 'padding', 'padding-left', 'margin',
    'margin-inline', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'inset-inline', 'box-sizing', 'aspect-ratio', 'z-index',
    'GRID-AREA', ' width ',
  ])('keeps %s', p => expect(wireframeCssAllows(p)).toBe(true));

  it.each([
    'color', 'background', 'background-color', 'font-size', 'border', 'border-radius', 'transform', 'animation', 'opacity',
    'overflow', 'float', 'content', '--x', '--width', '-webkit-box-flex', 'tops', 'orders', 'widths', '',
  ])('rejects %s', p => expect(wireframeCssAllows(p)).toBe(false));

  it('wireframeRules is the injected shape and copies the lists', () => {
    const r = wireframeRules();
    expect(r).toEqual({ css: [...WIREFRAME_CSS], base: WIREFRAME_BASE_CSS, keepTags: [...WIREFRAME_KEEP_TAGS], keepAttrs: [...WIREFRAME_KEEP_ATTRS] });
    r.css.push('x');
    expect(WIREFRAME_CSS).not.toContain('x');
  });

  it('keeps no scripting or embedding tag, and the attributes of C7 only', () => {
    for (const t of ['script', 'iframe', 'object', 'embed', 'link', 'img', 'video', 'audio', 'canvas', 'svg', 'meta', 'base', 'form', 'style']) {
      expect(WIREFRAME_KEEP_TAGS).not.toContain(t);
    }
    expect(new Set(WIREFRAME_KEEP_ATTRS)).toEqual(new Set(['class', 'id', 'style', 'data-c4', 'hidden']));
  });

  it('base style has the H10 declarations', () => {
    for (const d of ['box-sizing:border-box', 'margin:0', 'padding:0', 'border:0', 'font:12px', 'appearance:none']) expect(WIREFRAME_BASE_CSS).toContain(d);
  });
});
