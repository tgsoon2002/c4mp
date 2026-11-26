import { setFieldsText } from '../src/c4/editSet';
import { parseC4 } from '../src/plan/parser';

// P18-T4: set metadata, title, description, technology in a .c4 text.
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    web = container 'Web' {",
  "      technology 'Node'",
  '      metadata {',
  "        status 'planned'",
  "        layout '1,2,3,4'",
  '      }',
  '    }',
  "    api = container 'Api' 'header desc' {",
  "      description 'body desc'",
  '    }',
  "    bare = container 'Bare'",
  "    plain = container 'Plain' 'only header' {",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const el = (text: string, fqn: string) => {
  const r = parseC4(text, 'x.c4');
  expect(r.issues).toEqual([]);
  return r.elements.find(e => e.id === fqn)!;
};

describe('setFieldsText', () => {
  it('replaces an existing metadata value and changes nothing else', () => {
    const r = setFieldsText(PLAN, 'app.web', [{ key: 'status', value: 'done' }]);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(PLAN.replace("status 'planned'", "status 'done'"));
    expect(r.results).toEqual([{ key: 'status', changed: true }]);
  });

  it('adds keys to elements with metadata, with a body but no metadata, and with no body', () => {
    const r = setFieldsText(PLAN, 'app.web', [{ key: 'owner', value: 'K' }]);
    expect(el(r.text, 'app.web').metadata).toEqual({ status: 'planned', layout: '1,2,3,4', owner: 'K' });
    const r2 = setFieldsText(PLAN, 'app.api', [{ key: 'owner', value: 'K' }]);
    expect(el(r2.text, 'app.api').metadata).toEqual({ owner: 'K' });
    const r3 = setFieldsText(PLAN, 'app.bare', [{ key: 'owner', value: 'K' }]);
    expect(el(r3.text, 'app.bare').metadata).toEqual({ owner: 'K' });
  });

  it('same value: changed false, text identical', () => {
    const r = setFieldsText(PLAN, 'app.web', [{ key: 'status', value: 'planned' }, { key: 'technology', value: 'Node' }]);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(PLAN);
    expect(r.results.map(x => x.changed)).toEqual([false, false]);
  });

  it('quote and backslash round-trip for metadata and body strings', () => {
    const v = "O'Neil \\ \"x\"";
    const r = setFieldsText(PLAN, 'app.web', [
      { key: 'owner', value: v }, { key: 'title', value: v }, { key: 'technology', value: v }, { key: 'description', value: v },
    ]);
    const e = el(r.text, 'app.web');
    expect([e.metadata.owner, e.title, e.technology, e.description]).toEqual([v, v, v, v]);
    // setting the same awkward value again is a no change (the unquote logic reads it back)
    expect(setFieldsText(r.text, 'app.web', [{ key: 'title', value: v }, { key: 'technology', value: v }]).changed).toBe(false);
  });

  it('title: replaces the header title, or the last body title when there is one', () => {
    const r = setFieldsText(PLAN, 'app.web', [{ key: 'title', value: 'Web 2' }]);
    expect(r.text).toBe(PLAN.replace("container 'Web'", "container 'Web 2'"));
    expect(el(r.text, 'app.web').title).toBe('Web 2');
    const withBodyTitle = PLAN.replace("      technology 'Node'", "      title 'Body title'\n      technology 'Node'");
    expect(el(withBodyTitle, 'app.web').title).toBe('Body title');   // body title wins over the header
    const r2 = setFieldsText(withBodyTitle, 'app.web', [{ key: 'title', value: 'New' }]);
    expect(el(r2.text, 'app.web').title).toBe('New');
    expect(r2.text).toContain("container 'Web'");   // header untouched
  });

  it('description: the BODY line wins over the header string (parser order), so the body line is the one replaced', () => {
    const both = el(PLAN, 'app.api');
    expect(both.description).toBe('body desc');
    const r = setFieldsText(PLAN, 'app.api', [{ key: 'description', value: 'new' }]);
    expect(r.text).toBe(PLAN.replace("description 'body desc'", "description 'new'"));
    expect(r.text).toContain("'header desc'");
    expect(el(r.text, 'app.api').description).toBe('new');
  });

  it('description: header-only string is replaced in the header; none at all inserts a body line', () => {
    const r = setFieldsText(PLAN, 'app.plain', [{ key: 'description', value: 'changed' }]);
    expect(r.text).toBe(PLAN.replace("'only header'", "'changed'"));
    expect(el(r.text, 'app.plain').description).toBe('changed');
    const r2 = setFieldsText(PLAN, 'app.web', [{ key: 'description', value: 'added' }]);
    expect(r2.text).toBe(PLAN.replace("      technology 'Node'", "      description 'added'\n      technology 'Node'"));
    const r3 = setFieldsText(PLAN, 'app.bare', [{ key: 'technology', value: 'Go' }]);
    expect(r3.text).toBe(PLAN.replace("bare = container 'Bare'", "bare = container 'Bare' {\n      technology 'Go'\n    }"));
    expect(el(r3.text, 'app.bare').technology).toBe('Go');
  });

  it('empty multi-line body and inline body get the line', () => {
    const r = setFieldsText(PLAN, 'app.plain', [{ key: 'technology', value: 'Go' }]);
    expect(el(r.text, 'app.plain').technology).toBe('Go');
    const inline = "model {\n  a = system 'A' { metadata { k 'v' } }\n}\n";
    const r2 = setFieldsText(inline, 'a', [{ key: 'technology', value: 'Go' }]);
    expect(el(r2.text, 'a').technology).toBe('Go');
    expect(el(r2.text, 'a').metadata).toEqual({ k: 'v' });
  });

  it('uid and layout are forbidden, bad keys and line breaks throw', () => {
    expect(() => setFieldsText(PLAN, 'app.web', [{ key: 'uid', value: 'x' }])).toThrow(/forbidden key: uid/);
    expect(() => setFieldsText(PLAN, 'app.web', [{ key: 'layout', value: 'x' }])).toThrow(/forbidden key: layout/);
    expect(() => setFieldsText(PLAN, 'app.web', [{ key: 'bad key', value: 'x' }])).toThrow(/invalid metadata key/);
    expect(() => setFieldsText(PLAN, 'app.web', [{ key: 'title', value: 'a\nb' }])).toThrow(/line breaks/);
  });

  it('layout and uid lines stay byte-identical; unknown element or broken text is unchanged', () => {
    const r = setFieldsText(PLAN, 'app.web', [{ key: 'owner', value: 'K' }, { key: 'title', value: 'W' }]);
    expect(r.text).toContain("        layout '1,2,3,4'\n");
    expect(setFieldsText(PLAN, 'nope', [{ key: 'owner', value: 'K' }]).changed).toBe(false);
    const broken = "model {\n  a = system 'A\n}\n";
    expect(setFieldsText(broken, 'a', [{ key: 'title', value: 'B' }]).text).toBe(broken);
  });

  it('CRLF text keeps CRLF in inserted lines', () => {
    const crlf = PLAN.replace(/\n/g, '\r\n');
    const r = setFieldsText(crlf, 'app.web', [{ key: 'description', value: 'd' }, { key: 'owner', value: 'K' }]);
    expect(r.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(el(r.text, 'app.web').description).toBe('d');
  });
});
