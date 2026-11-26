import { addLinkText, removeLinkText } from '../src/c4/editLink';
import { parseC4 } from '../src/plan/parser';
import { parseLink } from '../src/plan/links';

// P18-T5: add a link line to a .c4 text.
const wrap = (body: string) => `model {\n  app = system 'App' {\n    comp = component 'Comp' {\n${body}    }\n  }\n}\n`;

const links = (text: string) => {
  const r = parseC4(text, 'plan/a.c4');
  expect(r.issues).toEqual([]);
  return r.elements.find(e => e.id === 'app.comp')!.links;
};

describe('addLinkText', () => {
  it('after the last existing link line', () => {
    const t = wrap("      technology 'x'\n      link ../src/a.ts\n      link ../src/b.ts 'B'\n      metadata {\n        status 'planned'\n      }\n");
    const r = addLinkText(t, 'app.comp', '../src/c.ts#fn');
    expect(r.changed).toBe(true);
    expect(r.text).toBe(t.replace("link ../src/b.ts 'B'\n", "link ../src/b.ts 'B'\n      link ../src/c.ts#fn\n"));
    const l = links(r.text);
    expect(l.map(x => x.raw)).toEqual(['../src/a.ts', '../src/b.ts', '../src/c.ts#fn']);
    expect(l[2]).toEqual(parseLink('../src/c.ts#fn', 'plan/a.c4'));
  });

  it('no link: after technology/description lines, before metadata', () => {
    const t = wrap("      description 'd'\n      technology 'x'\n      metadata {\n        status 'planned'\n      }\n");
    const r = addLinkText(t, 'app.comp', '../src/a.ts');
    expect(r.text).toBe(t.replace("technology 'x'\n", "technology 'x'\n      link ../src/a.ts\n"));
    expect(links(r.text)).toHaveLength(1);
  });

  it('only metadata in the body: the link goes before metadata', () => {
    const t = wrap("      metadata {\n        status 'planned'\n      }\n");
    const r = addLinkText(t, 'app.comp', '../src/a.ts');
    expect(r.text).toBe(wrap("      link ../src/a.ts\n      metadata {\n        status 'planned'\n      }\n"));
    expect(links(r.text)).toHaveLength(1);
  });

  it('no body: one is added; empty and inline bodies work', () => {
    const t = "model {\n  app = system 'App' {\n    comp = component 'Comp'\n  }\n}\n";
    const r = addLinkText(t, 'app.comp', '../src/a.ts');
    expect(r.text).toBe("model {\n  app = system 'App' {\n    comp = component 'Comp' {\n      link ../src/a.ts\n    }\n  }\n}\n");
    expect(links(r.text)).toHaveLength(1);
    expect(links(addLinkText(wrap(''), 'app.comp', '../src/a.ts').text)).toHaveLength(1);
    const inline = "model {\n  app = system 'App' {\n    comp = component 'Comp' { metadata { k 'v' } }\n  }\n}\n";
    expect(links(addLinkText(inline, 'app.comp', '../src/a.ts').text)).toHaveLength(1);
  });

  it('link line followed by the closing brace on the same line stays inside the body', () => {
    const t = "model {\n  app = system 'App' {\n    comp = component 'Comp' { link ../src/a.ts }\n  }\n}\n";
    const r = addLinkText(t, 'app.comp', '../src/b.ts');
    expect(links(r.text).map(x => x.raw)).toEqual(['../src/a.ts', '../src/b.ts']);
  });

  it('trailing comment after the last link keeps its line', () => {
    const t = wrap('      link ../src/a.ts // keep\n');
    const r = addLinkText(t, 'app.comp', '../src/b.ts');
    expect(r.text).toBe(wrap('      link ../src/a.ts // keep\n      link ../src/b.ts\n'));
  });

  it('a path with a space is written quoted and parses back; a title with a quote round-trips', () => {
    const r = addLinkText(wrap(''), 'app.comp', '../my dir/a b.ts#fn', "It's");
    expect(r.text).toContain("link '../my dir/a b.ts#fn' 'It\\'s'");
    const l = links(r.text)[0];
    expect(l.raw).toBe('../my dir/a b.ts#fn');
    expect(l.title).toBe("It's");
    expect(l.name).toBe('fn');
  });

  it('CRLF text keeps CRLF', () => {
    const t = wrap('      link ../src/a.ts\n').replace(/\n/g, '\r\n');
    const r = addLinkText(t, 'app.comp', '../src/b.ts');
    expect(r.text).toBe(wrap('      link ../src/a.ts\n      link ../src/b.ts\n').replace(/\n/g, '\r\n'));
  });

  it('unknown element or broken text: unchanged; empty link and line breaks throw', () => {
    const t = wrap('');
    expect(addLinkText(t, 'nope', '../a.ts')).toEqual({ text: t, changed: false });
    expect(addLinkText("model {\n  app = system 'A\n}\n", 'app', '../a.ts').changed).toBe(false);
    expect(() => addLinkText(t, 'app.comp', '')).toThrow();
    expect(() => addLinkText(t, 'app.comp', '../a.ts', 'a\nb')).toThrow(/line breaks/);
  });
});

describe('removeLinkText', () => {
  const body = "      link ../src/a.ts\n      link ../src/b.ts 'B'\n      link ../src/c.ts\n      metadata {\n        status 'planned'\n      }\n";
  it.each([
    [0, "      link ../src/a.ts\n"],
    [1, "      link ../src/b.ts 'B'\n"],
    [2, "      link ../src/c.ts\n"],
  ])('removes link line %i whole, the rest byte-identical', (i, line) => {
    const t = wrap(body);
    const r = removeLinkText(t, 'app.comp', i);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(t.replace(line, ''));
    expect(links(r.text)).toHaveLength(2);
  });

  it('a trailing comment stays; an inline body stays valid; CRLF is kept', () => {
    const c = wrap("      link ../src/a.ts // why\n");
    expect(removeLinkText(c, 'app.comp', 0).text).toBe(wrap(' // why\n'));
    const inline = "model {\n  app = system 'App' {\n    comp = component 'Comp' { link ../src/a.ts }\n  }\n}\n";
    const r = removeLinkText(inline, 'app.comp', 0);
    expect(links(r.text)).toEqual([]);
    const crlf = wrap(body).replace(/\n/g, '\r\n');
    expect(removeLinkText(crlf, 'app.comp', 1).text).toBe(crlf.replace("      link ../src/b.ts 'B'\r\n", ''));
  });

  it('unknown element or index: unchanged; inverse of addLinkText', () => {
    const t = wrap(body);
    expect(removeLinkText(t, 'app.nope', 0)).toEqual({ text: t, changed: false });
    expect(removeLinkText(t, 'app.comp', 9)).toEqual({ text: t, changed: false });
    const base = wrap("      metadata {\n        status 'planned'\n      }\n");
    expect(removeLinkText(addLinkText(base, 'app.comp', '../src/x.ts').text, 'app.comp', 0).text).toBe(base);
  });
});
