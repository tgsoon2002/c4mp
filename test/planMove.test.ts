import * as fs from 'fs';
import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { planMove, planRenameEl, type MoveResult } from '../src/c4/planMove';
import type { Plan } from '../src/types';

// b405 MV-1 (Document/Roadmap/PLAN_MOVE.md 7.1): the pure move / rename engine.

type Files = Record<string, string>;
type Ok = Extract<MoveResult, { ok: true }>;

const fixture = (rel: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf-8');
const LAYERS: Files = { 'c4/plan.c4': fixture('layers-claim/c4/plan.c4') };
const SHOP: Files = { 'c4/shop.c4': fixture('io-shop/c4/shop.c4') };

// Inline plan in three files: `a` has uid metadata and children declared in an extend block of another file, `d` has
// no body, a third file holds a relation naming `a`, strings and comments name `a` too.
const SPLIT: Files = {
  'a.c4': [
    'model {',
    "  s = system 'S' {",
    "    c = container 'C' {",
    '      // the a component',
    "      a = component 'A' {",
    "        description 's.c.a stays a string'",
    '        metadata {',
    "          uid 'u-1'",
    '        }',
    '        -> s.c.b',
    '      }',
    "      b = component 'B'",
    "      a -> b 'bare ends'",
    '    }',
    "    d = container 'D'",
    '  }',
    '}',
    '',
  ].join('\n'),
  'b.c4': ['extend s.c.a {', "  x = component 'X'", '}', ''].join('\n'),
  'c.c4': ['model {', "  s.d -> s.c.a 'uses' // s.c.a in a comment", '}', ''].join('\n'),
};

// Source file with CRLF and tabs, a multi-line string (its inner break is CRLF too); target file with LF, spaces,
// and a parent whose `}` shares its line with a child.
const EOL: Files = {
  'a.c4': "model {\r\n\ts = system 'S' {\r\n\t\tc = container 'C' {\r\n\t\t\ta = component 'A' {\r\n\t\t\t\tdescription 'one\r\n  two'\r\n\t\t\t}\r\n\t\t}\r\n\t}\r\n}\r\n",
  'b.c4': "model {\n  t = system 'T' {\n    k = container 'K' { e = component 'E' }\n  }\n}\n",
};

const planOf = (files: Files): { texts: Map<string, string>; plan: Plan } => {
  const texts = new Map(Object.entries(files));
  return { texts, plan: parsePlanTexts('/repo', texts) };
};
const ok = (r: MoveResult): Ok => {
  if (!r.ok) throw new Error(`refused: ${r.problems.join('; ')}`);
  return r;
};
const move = (files: Files, roots: string[], parent: string) => {
  const { texts, plan } = planOf(files);
  return { before: plan, r: planMove(texts, plan, { roots, parent }) };
};
const rename = (files: Files, fqn: string, newId: string) => {
  const { texts, plan } = planOf(files);
  return { before: plan, r: planRenameEl(texts, plan, { fqn, newId }) };
};

/** Section 5.3: every mapped element exists once at its new fqn with the same fields; relations equal after mapping. */
function expectFollows(before: Plan, r: Ok, bare?: [string, string]): Plan {
  const after = parsePlanTexts('/repo', r.newTexts);
  expect(after.issues).toEqual(before.issues);
  expect(after.elements).toHaveLength(before.elements.length);
  const now = (id: string) => r.fqnMap.map.get(id) ?? r.fqnMap.rewrite(id) ?? (bare && id === bare[0] ? bare[1] : id);
  for (const e of before.elements) {
    const hits = after.elements.filter(a => a.id === now(e.id));
    expect(hits).toHaveLength(1);
    expect({ kind: hits[0].kind, title: hits[0].title, metadata: hits[0].metadata, links: hits[0].links.map(l => l.raw) })
      .toEqual({ kind: e.kind, title: e.title, metadata: e.metadata, links: e.links.map(l => l.raw) });
  }
  for (const old of r.fqnMap.map.keys()) expect(after.elements.some(a => a.id === old)).toBe(false);
  const rels = (p: Plan, f: (s: string) => string) => p.relations.map(x => `${f(x.from)} -> ${f(x.to)}`).sort();
  expect(rels(after, s => s)).toEqual(rels(before, now));
  return after;
}

const at = (p: Plan, id: string) => p.elements.find(e => e.id === id)!;

describe('planMove: moves', () => {
  test.each([
    {
      name: 'layer to layer: block at the end of the new layer, both relation ends rewritten',
      files: LAYERS, roots: ['shop.api.logic.orders'], parent: 'shop.api.data',
      contains: [[
        "      data = layer 'Data' {",
        "        store = component 'Store' {",
        "          link ../api/src/store.ts#savePrice 'Price storage'",
        '        }',
        "        orders = component 'Orders' {",
        "          link ../api/src/orders.ts#placeOrder 'Order entry'",
        '        }',
        '      }',
      ], [
        "  shop.api.data.orders -> shop.api.data.store 'stores prices'",
        "  shop.web.pages -> shop.api.data.orders 'places orders'",
      ]],
      rewritten: [{ file: 'c4/plan.c4', count: 2 }],
    },
    {
      name: 'into a container from a layer: indent from the first child of the container',
      files: LAYERS, roots: ['shop.api.data.store'], parent: 'shop.web',
      contains: [[
        "      pages = component 'Pages' {",
        "        link ../web/src/page.ts#renderPage 'Page renderer'",
        '      }',
        "      store = component 'Store' {",
        "        link ../api/src/store.ts#savePrice 'Price storage'",
        '      }',
        '    }',
      ]],
      rewritten: [{ file: 'c4/plan.c4', count: 1 }],
    },
    {
      name: 'layer with children: descendants and both relation ends follow',
      files: LAYERS, roots: ['shop.api.logic'], parent: 'shop.web',
      contains: [[
        "  shop.web.logic.orders -> shop.api.data.store 'stores prices'",
        "  shop.web.pages -> shop.web.logic.orders 'places orders'",
      ]],
      rewritten: [{ file: 'c4/plan.c4', count: 2 }],
    },
    {
      name: 'extend children, third-file relation, short form, parent without body: all follow; strings, comments and bare ends stay',
      files: SPLIT, roots: ['s.c.a'], parent: 's.d',
      contains: [[
        "    d = container 'D' {",
        "      a = component 'A' {",
        "        description 's.c.a stays a string'",
        '        metadata {',
        "          uid 'u-1'",
        '        }',
        '        -> s.c.b',
        '      }',
        '    }',
      ], ['      // the a component', "      b = component 'B'", "      a -> b 'bare ends'"],
      ['extend s.d.a {'], ["  s.d -> s.d.a 'uses' // s.c.a in a comment"]],
      rewritten: [{ file: 'b.c4', count: 1 }, { file: 'c.c4', count: 1 }],
    },
    {
      name: 'tabs, CRLF and a multi-line string into an inline `}` of another file: string bytes kept, target line ends',
      files: EOL, roots: ['s.c.a'], parent: 't.k',
      contains: [[
        "    k = container 'K' { e = component 'E' ",
        "      a = component 'A' {",
        "      \tdescription 'one\r\n  two'",
        '      }',
        '    }',
      ], ["\t\tc = container 'C' {\r\n\t\t}\r\n"]],
      rewritten: [],
    },
  ])('$name', ({ files, roots, parent, contains, rewritten }) => {
    const { before, r } = move(files, roots, parent);
    const res = ok(r);
    expectFollows(before, res);
    const all = [...res.newTexts.values()].join('\u0000');
    for (const lines of contains) expect(all).toContain(lines.join('\n'));
    expect(res.rewritten).toEqual(rewritten);
    expect(res.roots.map(x => x.to)).toEqual(roots.map(x => `${parent}.${x.slice(x.lastIndexOf('.') + 1)}`));
  });

  it('several roots from two files land under one parent in argument order, in one edit', () => {
    const files: Files = {
      'a.c4': ['model {', "  s = system 'S' {", "    c = container 'C' {", "      a1 = component 'A1'", "      a2 = component 'A2'", '    }',
        "    d = container 'D' {", "      old = component 'Old'", '    }', '  }', '}', ''].join('\n'),
      'b.c4': ['extend s.c {', "  b1 = component 'B1'", '}', ''].join('\n'),
    };
    const { before, r } = move(files, ['s.c.b1', 's.c.a2', 's.c.a1'], 's.d');
    const res = ok(r);
    const after = expectFollows(before, res);
    const lines = ['s.d.old', 's.d.b1', 's.d.a2', 's.d.a1'].map(id => at(after, id).source);
    expect(lines.every(s => s.file === 'a.c4')).toBe(true);
    expect(lines.map(s => s.line)).toEqual([...lines.map(s => s.line)].sort((x, y) => x - y));
    expect(res.roots.map(x => x.toFile)).toEqual(['a.c4', 'a.c4', 'a.c4']);
    expect(res.notes).toEqual([expect.objectContaining({ kind: 'empty-extend', file: 'b.c4', line: 1 })]);
  });

  it('rule L: lands in the last block of the parent in the root\'s own file, not in the declaration elsewhere', () => {
    const files: Files = {
      'a.c4': ['model {', "  s = system 'S' {", "    p = container 'P'", "    q = container 'Q'", '  }', '}', ''].join('\n'),
      'b.c4': ['extend s.p {', "  x = component 'X'", '}', 'extend s.q {', "  y = component 'Y'", '}', ''].join('\n'),
    };
    const { before, r } = move(files, ['s.q.y'], 's.p');
    const res = ok(r);
    expectFollows(before, res);
    expect(res.newTexts.get('a.c4')).toBe(files['a.c4']);
    expect(res.newTexts.get('b.c4')).toBe(['extend s.p {', "  x = component 'X'", "  y = component 'Y'", '}', 'extend s.q {', '}', ''].join('\n'));
  });

  it('same parent: the block goes to the end with a note; already last is no change', () => {
    const { before, r } = move(LAYERS, ['shop.web'], 'shop');
    const res = ok(r);
    expect(res.fqnMap.map.size).toBe(0);
    expect(res.notes.map(n => n.text)).toEqual(['shop.web is already the last child of shop: no change']);
    expect(res.newTexts).toEqual(planOf(LAYERS).texts);
    const first = ok(move(LAYERS, ['shop.api'], 'shop').r);
    const after = expectFollows(before, first);
    expect(at(after, 'shop.api').source.line).toBeGreaterThan(at(after, 'shop.web').source.line);
    expect(first.notes.map(n => n.text)).toEqual(['shop.api already under shop: moved to the end']);
  });

  it('notes: comment above stays (new line), layout kept, local id shared in the container', () => {
    const files: Files = {
      'a.c4': ['model {', "  s = system 'S' {", "    c = container 'C' {", "      l1 = layer 'L1' {", '        // about x', "        x = component 'X' {",
        "          metadata {", "            layout '1,2'", '          }', '        }', '      }', "      l2 = layer 'L2' {", "        x = component 'Other X'", '      }',
        "      l3 = layer 'L3'", '    }', '  }', '}', ''].join('\n'),
    };
    const res = ok(move(files, ['s.c.l1.x'], 's.c.l3').r);
    const text = res.newTexts.get('a.c4')!.split('\n');
    const kinds = Object.fromEntries(res.notes.map(n => [n.kind, n]));
    expect(text[kinds['comment-above'].line - 1]).toBe('        // about x');
    expect(kinds['layout-kept']).toMatchObject({ file: 'a.c4', line: text.indexOf("        x = component 'X' {") + 1 });
    expect(kinds['local-id-shared'].text).toContain('s.c.l3.x shares its id');
    expect(kinds['local-id-shared'].text).toContain('s.c.l2.x');
  });
});

describe('planRenameEl', () => {
  test.each([
    { name: 'component in a layer', files: LAYERS, fqn: 'shop.api.logic.orders', newId: 'ordering', count: 2, mapped: 1 },
    { name: 'screen with its parts', files: SHOP, fqn: 'shop.web.home', newId: 'start', count: 1, mapped: 11 },
  ])('$name: id token, descendants and references', ({ files, fqn, newId, count, mapped }) => {
    const { before, r } = rename(files, fqn, newId);
    const res = ok(r);
    expectFollows(before, res);
    const to = `${fqn.slice(0, fqn.lastIndexOf('.'))}.${newId}`;
    expect(res.roots).toEqual([{ from: fqn, to, fromFile: Object.keys(files)[0], toFile: Object.keys(files)[0] }]);
    expect(res.fqnMap.map.size).toBe(mapped);
    expect(res.rewritten).toEqual([{ file: Object.keys(files)[0], count }]);
  });

  test.each([
    { name: 'unique id: bare ends rewritten', extra: '', bareLine: "      a -> bb 'bare ends'", notes: [] as string[] },
    { name: 'shared id: bare ends kept and listed', extra: "    e = container 'E' { b = component 'B2' }", bareLine: "      a -> b 'bare ends'",
      notes: ["bare reference 'b' at a.c4:13 not rewritten: 2 elements have the id 'b'"] },
  ])('short forms, $name', ({ extra, bareLine, notes }) => {
    const files = { ...SPLIT, 'a.c4': SPLIT['a.c4'].replace("    d = container 'D'", `    d = container 'D'\n${extra}`) };
    const { before, r } = rename(files, 's.c.b', 'bb');
    const res = ok(r);
    expectFollows(before, res, notes.length === 0 ? ['b', 'bb'] : undefined);
    const text = res.newTexts.get('a.c4')!;
    expect(text).toContain('        -> s.c.bb\n');
    expect(text).toContain(`${bareLine}\n`);
    expect(res.notes.map(n => n.text)).toEqual(notes);
  });

  it('a move leaves bare ends as written (the local id does not change)', () => {
    const res = ok(move(SPLIT, ['s.c.b'], 's.d').r);
    expect(res.newTexts.get('a.c4')).toContain("      a -> b 'bare ends'\n");
    expect(res.newTexts.get('a.c4')).toContain('        -> s.d.b\n');
  });

  it('same id: no change', () => {
    const res = ok(rename(LAYERS, 'shop.web', 'web').r);
    expect(res.newTexts).toEqual(planOf(LAYERS).texts);
    expect(res.fqnMap.map.size).toBe(0);
  });
});

describe('refusals (5.1): every problem listed, nothing changed', () => {
  const KINDS: Files = {
    'k.c4': ['model {', "  s = system 'S' {", "    c = container 'C' {", "      a = component 'A' {", "        f = function 'F'", "        m = method 'M'", '      }',
      "      w = flow 'W'", "      a2 = component 'A2'", '    }', "    d = container 'D' {", "      a = component 'Other A'", '    }',
      "    e = container 'E' { k = component 'K' }", "    e2 = container 'E2'", '  }', "  t = system 'T'", "  t = system 'T again'", '}', ''].join('\n'),
    'sub/x.c4': ['extend s.c {', "  linked = component 'L' {", '    link ../src/a.ts', '  }', '}', ''].join('\n'),
  };
  test.each([
    { name: 'parent kind', roots: ['s.c.a'], parent: 's.c.a2', problem: "a component goes under a container or subregion, but 's.c.a2' is a component" },
    { name: 'kind without a rule (flow)', roots: ['s.c.w'], parent: 's.d', problem: 'a flow has no parent rule, so s.c.w cannot be moved' },
    { name: 'method (no rule)', roots: ['s.c.a.m'], parent: 's.c.a2', problem: 'a method has no parent rule' },
    { name: 'top-level kind', roots: ['s'], parent: 's.d', problem: 'a system is a top-level element and has no parent; use plan rename' },
    { name: 'planned code goes under a component only', roots: ['s.c.a.f'], parent: 's.d', problem: "a function goes under a component, but 's.d' is a container" },
    { name: 'missing parent', roots: ['s.c.a'], parent: 's.nope', problem: 'unknown parent s.nope' },
    { name: 'into its own descendant', roots: ['s.c'], parent: 's.c.a', problem: 'cannot move s.c into itself or its descendant s.c.a' },
    { name: 'root inside another root', roots: ['s.c', 's.c.a'], parent: 's.d', problem: 's.c.a is inside s.c, which also moves' },
    { name: 'new fqn taken', roots: ['s.c.a'], parent: 's.d', problem: "s.d.a already exists (component 'Other A')" },
    { name: 'two roots, one new fqn', roots: ['s.c.a', 's.d.a'], parent: 's.e2', problem: 's.c.a and s.d.a would both become s.e2.a' },
    { name: 'duplicate fqn', roots: ['t'], parent: 's', problem: 't is declared twice; fix duplicate-fqn first' },
    { name: 'block shares a line', roots: ['s.e.k'], parent: 's.e2', problem: 's.e.k: block shares a line with other text' },
    { name: 'relative links across folders', roots: ['s.c.linked'], parent: 's.e2', problem: '1 links of s.c.linked are relative to sub; move within the same folder' },
  ])('$name', ({ roots, parent, problem }) => {
    const { r } = move(KINDS, roots, parent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('\n')).toContain(problem);
  });

  it('lists all problems of one request together, unterminated text included', () => {
    const { r } = move({ ...KINDS, 'z.c4': "model {\n  q = system 'Q\n}\n" }, ['s.c.w', 's.e.k'], 's.c.a2');
    expect(r).toEqual({ ok: false, problems: [
      'cannot edit z.c4: unterminated string',
      'a flow has no parent rule, so s.c.w cannot be moved',
      "a component goes under a container or subregion, but 's.c.a2' is a component",
      's.e.k: block shares a line with other text',
    ] });
  });

  test.each([
    { name: 'invalid id', fqn: 's.c.a', newId: '9x', problem: "invalid id '9x'" },
    { name: 'body keyword', fqn: 's.c.a', newId: 'title', problem: "'title' is a keyword in an element body" },
    { name: 'extend keyword at the top of an extend block', fqn: 's.c.linked', newId: 'views', problem: "'views' is a keyword in a model or extend block" },
    { name: 'taken', fqn: 's.c.a', newId: 'a2', problem: "s.c.a2 already exists (component 'A2')" },
    { name: 'dotted id token', files: { 'd.c4': "model {\n  s = system 'S' {\n    c.x = container 'X'\n  }\n}\n" }, fqn: 's.c.x', newId: 'y', problem: "its id is written as 'c.x'" },
  ])('rename: $name', ({ files, fqn, newId, problem }) => {
    const { r } = rename(files ?? KINDS, fqn, newId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('\n')).toContain(problem);
  });

  it('rename allows a body keyword at the top of an extend block (PS-3.16 is per place)', () => {
    expect(ok(rename(KINDS, 's.c.linked', 'title').r).roots[0].to).toBe('s.c.title');
  });
});
