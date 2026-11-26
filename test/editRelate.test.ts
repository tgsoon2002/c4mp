import { addRelationText } from '../src/c4/editRelate';
import { parseC4 } from '../src/plan/parser';

// P18-T6: add a relation line to a .c4 text.
const BASE = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  "        technology 'TS'",
  '      }',
  "      orders = component 'Orders'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const rels = (text: string) => {
  const r = parseC4(text, 'plan/a.c4');
  expect(r.issues).toEqual([]);
  return r.relations;
};

describe('addRelationText', () => {
  it('appends after the body lines, with and without a label', () => {
    const r = addRelationText(BASE, 'app.api.auth', 'app.api.orders', 'uses');
    expect(r.changed).toBe(true);
    expect(r.text).toBe(BASE.replace("        technology 'TS'\n", "        technology 'TS'\n        -> app.api.orders 'uses'\n"));
    expect(rels(r.text)).toEqual([
      { from: 'app.api.auth', to: 'app.api.orders', label: 'uses', source: { file: 'plan/a.c4', line: 6 } },
    ]);
    const r2 = addRelationText(BASE, 'app.api.auth', 'app.api.orders');
    expect(rels(r2.text).map(x => [x.from, x.to, x.label])).toEqual([['app.api.auth', 'app.api.orders', null]]);
  });

  it('element without a body gets one', () => {
    const r = addRelationText(BASE, 'app.api.orders', 'app.api.auth', 'calls');
    expect(r.text).toBe(BASE.replace("orders = component 'Orders'", "orders = component 'Orders' {\n        -> app.api.auth 'calls'\n      }"));
    expect(rels(r.text).map(x => [x.from, x.to, x.label])).toEqual([['app.api.orders', 'app.api.auth', 'calls']]);
  });

  it('element that has a nested child: the relation goes after the child block', () => {
    const r = addRelationText(BASE, 'app.api', 'app', 'part of');
    expect(r.text.indexOf('-> app')).toBeGreaterThan(r.text.indexOf("orders = component 'Orders'"));
    expect(r.text).toBe(BASE.replace("      orders = component 'Orders'\n", "      orders = component 'Orders'\n      -> app 'part of'\n"));
    expect(rels(r.text).map(x => [x.from, x.to])).toEqual([['app.api', 'app']]);
  });

  it('label with quote and backslash round-trips', () => {
    const r = addRelationText(BASE, 'app.api.auth', 'app.api.orders', "it's \\ ok");
    expect(rels(r.text)[0].label).toBe("it's \\ ok");
  });

  it('inline body and CRLF file', () => {
    const inline = "model {\n  a = system 'A' { technology 'x' }\n  b = system 'B'\n}\n";
    expect(rels(addRelationText(inline, 'a', 'b', 'x').text).map(x => [x.from, x.to])).toEqual([['a', 'b']]);
    const crlf = BASE.replace(/\n/g, '\r\n');
    const r = addRelationText(crlf, 'app.api.auth', 'app.api.orders');
    expect(r.text).toBe(BASE.replace("        technology 'TS'\n", "        technology 'TS'\n        -> app.api.orders\n").replace(/\n/g, '\r\n'));
  });

  it('relation added next to existing relations: all stay', () => {
    const t = BASE.replace(/\}\n$/, "  app.api.orders -> app.api.auth 'old'\n}\n");
    expect(rels(t)).toHaveLength(1);
    const r = addRelationText(t, 'app.api.auth', 'app.api.orders');
    expect(rels(r.text).map(x => [x.from, x.to, x.label])).toEqual([
      ['app.api.auth', 'app.api.orders', null],
      ['app.api.orders', 'app.api.auth', 'old'],
    ]);
  });

  it('unknown element or broken text: unchanged; bad target and line breaks throw', () => {
    expect(addRelationText(BASE, 'nope', 'app')).toEqual({ text: BASE, changed: false });
    expect(addRelationText("model {\n  a = system 'A\n}\n", 'a', 'b').changed).toBe(false);
    expect(() => addRelationText(BASE, 'app', 'bad target')).toThrow(/invalid relation target/);
    expect(() => addRelationText(BASE, 'app', '1x')).toThrow(/invalid relation target/);
    expect(() => addRelationText(BASE, 'app', 'b', 'a\nb')).toThrow(/line breaks/);
  });
});
