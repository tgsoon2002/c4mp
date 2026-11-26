import * as path from 'path';
import { parseC4, parsePlan } from '../src/plan/parser';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures/phofast');

describe('c4parser', () => {
  it('parses PhoFast fixture correctly', () => {
    const files = [
      'src/architecture.c4',
      'src/api/auth/auth.c4',
      'src/api/menu/menu.c4',
      'src/api/orders/orders.c4',
      'src/api/payments/payments.c4',
      'src/api/notify/notify.c4',
      'src/web/pages/pages.c4',
    ];

    const plan = parsePlan(FIXTURE_ROOT, files);

    // Should have 15 elements
    expect(plan.elements).toHaveLength(15);

    // Should have 5 relations
    expect(plan.relations).toHaveLength(5);

    // Should have 0 issues
    expect(plan.issues).toHaveLength(0);

    // Check specific elements
    const customer = plan.elements.find(e => e.id === 'customer');
    expect(customer).toBeDefined();
    expect(customer?.kind).toBe('person');
    expect(customer?.title).toBe('Customer');

    const auth = plan.elements.find(e => e.id === 'phofast.api.auth');
    expect(auth).toBeDefined();
    expect(auth?.kind).toBe('component');
    expect(auth?.title).toBe('Auth Service');
    expect(auth?.technology).toBe('JWT / Passport.js');
    expect(auth?.description).toBe('Handles login tokens');
    expect(auth?.metadata.status).toBe('done');
    expect(auth?.links).toHaveLength(1);
    expect(auth?.links[0].raw).toBe('./index.ts#L6-L13');
  });

  it('recovers from broken elements without throwing', () => {
    const text = 'model { x = component \'X\' {';
    const result = parseC4(text, 'test.c4');

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeGreaterThan(0); // Should still parse the element
  });

  it('handles multiple links in an element', () => {
    const text = `
model {
  a = system 'A' {
    link ./path1 'first'
    link ./path2 'second'
  }
}
    `;
    const result = parseC4(text, 'test.c4');

    expect(result.issues).toHaveLength(0);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].links).toHaveLength(2);
    expect(result.elements[0].links[0].raw).toBe('./path1');
    expect(result.elements[0].links[1].raw).toBe('./path2');
  });

  it('handles nested extend declarations', () => {
    const text = `
model {
  extend a.b {
    c = component 'C' {
      technology 'Tech'
    }
  }
}
    `;
    const result = parseC4(text, 'test.c4');

    expect(result.issues).toHaveLength(0);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].id).toBe('a.b.c');
    expect(result.elements[0].parent).toBe('a.b');
  });

  it('handles implicit relations in element body', () => {
    const text = `
model {
  a = system 'A' {
    -> b
  }
}
    `;
    const result = parseC4(text, 'test.c4');

    expect(result.issues).toHaveLength(0);
    expect(result.elements).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].from).toBe('a');
    expect(result.relations[0].to).toBe('b');
  });
});

describe('c4parser unquoted metadata value (P14-T37)', () => {
  it('reports an unquoted value with key and line, and does not store it', () => {
    const text = [
      'model {',                       // 1
      "  x = component 'X' {",         // 2
      '    metadata {',                // 3
      '      status done',             // 4
      "      owner 'kien'",            // 5
      '    }',                         // 6
      '  }',                           // 7
      '}',                             // 8
    ].join('\n');
    const r = parseC4(text, 'x.c4');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toContain('metadata value must be quoted (key status)');
    expect(r.issues[0].line).toBe(4);
    expect(r.issues[0].file).toBe('x.c4');
    const x = r.elements.find(e => e.id === 'x')!;
    expect(x.metadata.status).toBeUndefined();
    expect(x.metadata.owner).toBe('kien');
  });

  it('quoted value gives no issue', () => {
    const text = "model {\n  x = component 'X' {\n    metadata {\n      status 'done'\n    }\n  }\n}\n";
    const r = parseC4(text, 'x.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.elements.find(e => e.id === 'x')!.metadata.status).toBe('done');
  });

  it('phofast fixture plan files produce no issue', () => {
    const files = [
      'src/architecture.c4',
      'src/api/auth/auth.c4',
      'src/api/menu/menu.c4',
      'src/api/orders/orders.c4',
      'src/api/payments/payments.c4',
      'src/api/notify/notify.c4',
      'src/web/pages/pages.c4',
    ];
    expect(parsePlan(FIXTURE_ROOT, files).issues).toHaveLength(0);
  });
});

describe('c4parser relation with a body (P14-T46)', () => {
  const wrap = (inner: string) => `model {\n  s = system 'S' {\n    a = container 'A'\n    b = container 'B'\n  }\n${inner}\n}\n`;

  it('(a) body then plain relation -> 2 relations', () => {
    const r = parseC4(wrap("  s.a -> s.b 'x' {\n    style dashed\n  }\n  s.a -> s.b 'y'"), 't.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.relations.map(x => x.label)).toEqual(['x', 'y']);
  });

  it('(b) two relations with bodies in a row -> 2', () => {
    const r = parseC4(wrap("  s.a -> s.b 'x' { style dashed }\n  s.a -> s.b 'y' { style dotted }"), 't.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.relations).toHaveLength(2);
  });

  it('(c) body on the last line before the closing brace -> 1', () => {
    const r = parseC4(wrap("  s.a -> s.b 'x' {\n    style dashed\n  }"), 't.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.relations).toHaveLength(1);
  });

  it('(d) nested braces inside the body keep this and the next relation', () => {
    const r = parseC4(wrap("  s.a -> s.b 'x' {\n    style { line dashed }\n  }\n  s.a -> s.b 'y'"), 't.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.relations.map(x => x.label)).toEqual(['x', 'y']);
  });

  it('(e) body followed by an element -> relation and element both parsed', () => {
    const r = parseC4(wrap("  s.a -> s.b 'x' {\n    style dashed\n  }\n  t = system 'T'"), 't.c4');
    expect(r.issues).toHaveLength(0);
    expect(r.relations).toHaveLength(1);
    expect(r.elements.some(e => e.id === 't')).toBe(true);
  });

  it('(f) implicit and explicit relations with bodies inside an element body -> 2 each', () => {
    const r1 = parseC4("model {\n  a = system 'A' {\n    -> b 'x' { style dashed }\n    -> c\n  }\n  b = system 'B'\n  c = system 'C'\n}\n", 't.c4');
    expect(r1.issues).toHaveLength(0);
    expect(r1.relations).toHaveLength(2);
    const r2 = parseC4("model {\n  a = system 'A' {\n    a -> b 'x' { style dashed }\n    a -> c\n  }\n  b = system 'B'\n  c = system 'C'\n}\n", 't.c4');
    expect(r2.issues).toHaveLength(0);
    expect(r2.relations).toHaveLength(2);
  });
});

describe('c4parser endLine (P13-T2b)', () => {
  it('sets source.endLine to the closing-brace line; equals line for one-line elements', () => {
    const text = [
      'model {',                       // 1
      "  a = system 'A' {",            // 2
      "    b = container 'B' {",       // 3
      "      c = component 'C'",       // 4  one-line, no body
      "      d = component 'D' { }",   // 5  one-line body
      '    }',                         // 6
      '  }',                           // 7
      '}',                             // 8
    ].join('\n');
    const r = parseC4(text, 'x.c4');
    expect(r.issues).toHaveLength(0);
    const pos = (id: string) => r.elements.find(e => e.id === id)!.source;
    expect(pos('a')).toEqual({ file: 'x.c4', line: 2, endLine: 7 });
    expect(pos('a.b')).toEqual({ file: 'x.c4', line: 3, endLine: 6 });
    expect(pos('a.b.c')).toEqual({ file: 'x.c4', line: 4, endLine: 4 });
    expect(pos('a.b.d')).toEqual({ file: 'x.c4', line: 5, endLine: 5 });
  });

  it('unterminated body still gets an endLine >= line', () => {
    const r = parseC4("model {\n  x = component 'X' {\n    technology 'T'\n", 'x.c4');
    const x = r.elements.find(e => e.id === 'x')!;
    expect(x.source.endLine).toBeGreaterThanOrEqual(x.source.line);
  });
});

// b178 (PS-3.18): a lone word on its line gives a parse issue and no longer swallows the next line.
describe('stray word (b178, PS-3.18)', () => {
  const MSG = "stray word 'stray': expected = or -> after it";
  it.each([
    {
      name: 'top level: the next element is kept',
      lines: ['model {', '  stray', "  web = container 'Web'", "  api = container 'Api'", '}'],
      ids: ['web', 'api'],
      parents: [null, null],
      issues: [{ line: 2, message: MSG }],
    },
    {
      name: 'in a body: the next element is kept',
      lines: ['model {', "  sys = system 'S' {", '    stray', "    web = container 'Web'", "    api = container 'Api'", '  }', '}'],
      ids: ['sys', 'sys.web', 'sys.api'],
      parents: [null, 'sys', 'sys'],
      issues: [{ line: 3, message: MSG }],
    },
    {
      name: 'right before }: the brace closes the block, the sibling keeps parent null',
      lines: ['model {', "  sys = system 'S' {", "    web = container 'Web'", '    stray', '  }', "  other = system 'O'", '}'],
      ids: ['sys', 'sys.web', 'other'],
      parents: [null, 'sys', null],
      issues: [{ line: 4, message: MSG }],
    },
    {
      name: 'a word with more tokens on its line: line skipped, no issue (tolerant reading, unchanged)',
      lines: ['model {', "  sys = system 'S' {", '    oops foo', "    web = container 'Web'", '  }', '}'],
      ids: ['sys', 'sys.web'],
      parents: [null, 'sys'],
      issues: [],
    },
  ])('$name', ({ lines, ids, parents, issues }) => {
    const r = parseC4(lines.join('\n') + '\n', 'x.c4');
    expect(r.elements.map(e => e.id)).toEqual(ids);
    expect(r.elements.map(e => e.parent)).toEqual(parents);
    expect(r.issues.map(i => ({ line: i.line, message: i.message }))).toEqual(issues);
  });
});
