import { locateElement, locateExtendBlocks, locateRefs } from '../src/c4/editMeta';
import { parseC4 } from '../src/plan/parser';

// P18-T1: locateElement exposes token spans of one element.
const TEXT = [
  'model {',
  "  app = system 'App' 'header desc' {",
  "    title 'Body title'",
  "    description 'Body desc'",
  "    technology 'Node'",
  '    link ../src/a.ts#fn \'Link title\'',
  '    link ../src/b/',
  '    metadata {',
  "      status 'planned'",
  "      owner 'K'",
  '    }',
  '    metadata {',
  "      sprint 'S1'",
  '    }',
  "    api = container 'Api' {",
  "      technology 'inner'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

describe('locateElement', () => {
  const s = locateElement(TEXT, 'app')!;
  const at = (a: { start: number; end: number }) => TEXT.slice(a.start, a.end);

  it('points at header, body braces and first body token', () => {
    expect(s).not.toBeNull();
    expect(TEXT.slice(s.idStart, s.idStart + 3)).toBe('app');
    expect(s.idLine).toBe(2);
    expect(at(s.title)).toBe("'App'");
    expect(at(s.headerDescription!)).toBe("'header desc'");
    expect(TEXT.slice(s.headerEnd - 13, s.headerEnd)).toBe("'header desc'");
    expect(TEXT[s.open!]).toBe('{');
    expect(TEXT[s.close!]).toBe('}');
    expect(s.openLine).toBe(2);
    expect(TEXT.slice(s.firstBodyStart!, s.firstBodyStart! + 5)).toBe('title');
    expect(s.firstBodyLine).toBe(3);
    // the closing brace is the one of `app`, not of the nested container
    expect(TEXT.slice(s.close!).startsWith('}\n}')).toBe(true);
  });

  it('points at body lines, links and both metadata blocks', () => {
    expect(s.titleLines.map(l => at(l.value))).toEqual(["'Body title'"]);
    expect(s.descriptionLines.map(l => at(l.value))).toEqual(["'Body desc'"]);
    expect(s.technologyLines.map(l => at(l.value))).toEqual(["'Node'"]);
    expect(s.linkLines.map(l => TEXT.slice(l.kwStart, l.end))).toEqual(["link ../src/a.ts#fn 'Link title'", 'link ../src/b/']);
    expect(s.linkLines[0].kwLine).toBe(6);
    expect(s.metas).toHaveLength(2);
    expect(s.metas[0].entries.map(e => [e.key, TEXT.slice(e.valueStart!, e.valueEnd!)])).toEqual([
      ['status', "'planned'"],
      ['owner', "'K'"],
    ]);
    expect(TEXT[s.metas[0].closeStart!]).toBe('}');
    expect(s.metas[1].entries[0].key).toBe('sprint');
  });

  it('locates a nested child by fqn with its own lines', () => {
    const c = locateElement(TEXT, 'app.api')!;
    expect(c.technologyLines.map(l => TEXT.slice(l.value.start, l.value.end))).toEqual(["'inner'"]);
    expect(c.headerDescription).toBeNull();
    expect(c.metas).toEqual([]);
  });

  it('element without a body has null braces', () => {
    const t = "model {\n  a = system 'A'\n}\n";
    const e = locateElement(t, 'a')!;
    expect(e.open).toBeNull();
    expect(e.close).toBeNull();
    expect(e.firstBodyStart).toBeNull();
    expect(t.slice(e.headerEnd - 3, e.headerEnd)).toBe("'A'");
  });

  it('returns null for an unknown fqn and for an unterminated string', () => {
    expect(locateElement(TEXT, 'nope')).toBeNull();
    expect(locateElement("model {\n  a = system 'A\n}\n", 'a')).toBeNull();
  });
});

// b405 MV-1: reference tokens (relation ends, extend targets) with offsets; strings, comments and relation bodies are not refs.
describe('locateRefs / locateExtendBlocks', () => {
  const REFS = [
    'model {',
    "  s = system 'S' {",
    "    a = component 'A' {",
    "      description 's.b in a string'",
    '      -> s.b // s.c in a comment',
    "      x -> y 'bare' {",
    '        z -> w',
    '      }',
    '    }',
    "    b = component 'B'",
    '  }',
    '  /* s.a -> s.c */',
    "  s.a -> s.b 'top'",
    '  extend s.a {',
    "    k = component 'K'",
    '  }',
    '}',
    'extend s.b {',
    '  s.b -> s.a',
    '}',
    'extend s.b {',
    '}',
  ].join('\n');
  const refs = locateRefs(REFS)!;

  it('lists every relation end and extend target in text order, with offsets', () => {
    expect(refs.map(r => `${r.role} ${r.value} @${r.line}`)).toEqual([
      'to s.b @5', 'from x @6', 'to y @6', 'from s.a @13', 'to s.b @13', 'extend s.a @14', 'extend s.b @18', 'from s.b @19', 'to s.a @19', 'extend s.b @21',
    ]);
    for (const r of refs) expect(REFS.slice(r.start, r.end)).toBe(r.value);
  });

  it('matches the parser: same relation ends in the same order', () => {
    const rels = parseC4(REFS, 'x.c4').relations;
    expect(refs.filter(r => r.role === 'to').map(r => r.value)).toEqual(rels.map(r => r.to));
    // a written `from` token is the parser's from; the short form `-> x` has none (its source is the enclosing element)
    expect(refs.filter(r => r.role === 'from').map(r => r.value)).toEqual(rels.filter(r => r.source.line !== 5).map(r => r.from));
  });

  it('locates every extend block of one fqn with its braces and first body token', () => {
    const blocks = locateExtendBlocks(REFS, 's.b');
    expect(blocks.map(b => [b.openLine, b.closeLine, b.firstBodyLine])).toEqual([[18, 20, 19], [21, 22, null]]);
    expect(blocks.map(b => REFS.slice(b.idStart, b.headerEnd))).toEqual(['extend s.b', 'extend s.b']);
    expect(blocks.every(b => REFS[b.close!] === '}')).toBe(true);
  });

  it('returns null / [] for a text with an unterminated string', () => {
    const broken = "model {\n  a = system 'A\n}\n";
    expect(locateRefs(broken)).toBeNull();
    expect(locateExtendBlocks(broken, 'a')).toEqual([]);
  });
});

// b178: the edit walker reads a stray word at a line end as the parser does (the `}` after it is not eaten).
describe('stray word (b178)', () => {
  const text = ['model {', "  sys = system 'S' {", "    web = container 'Web'", '    stray', '  }', "  other = system 'O'", '}', ''].join('\n');
  it('matches the parser: the sibling after the stray word stays at top level', () => {
    expect(parseC4(text, 'x.c4').elements.map(e => e.id)).toEqual(['sys', 'sys.web', 'other']);
    expect(locateElement(text, 'other')).not.toBeNull();
    expect(locateElement(text, 'sys.other')).toBeNull();
  });
});
