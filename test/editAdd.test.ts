import { addElementText, addTargetOf } from '../src/c4/editAdd';
import { parseC4, parsePlanTexts } from '../src/plan/parser';

// P18-T3: add an element block to a .c4 text.
const WITH_BODY = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  "        technology 'TS'",
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/** The edit is one pure insertion: removing the inserted slice gives the original back. */
function isInsertion(orig: string, text: string, ins: string): boolean {
  for (let i = 0; i <= orig.length; i++) if (orig.slice(0, i) + ins + orig.slice(i) === text) return true;
  return false;
}

function check(text: string, fqn: string, parent: string, title: string) {
  const r = parseC4(text, 'x.c4');
  expect(r.issues).toEqual([]);
  const el = r.elements.find(e => e.id === fqn)!;
  expect(el).toBeDefined();
  expect(el.parent).toBe(parent);
  expect(el.title).toBe(title);
  return el;
}

describe('addElementText', () => {
  it('parent with a body: child goes after the last body line, indentation copied', () => {
    const r = addElementText(WITH_BODY, 'app.api.auth', {
      id: 'login', kind: 'function', title: 'login', technology: 'ts', description: 'Logs in',
      links: ['../src/a.ts#login'], metadata: [['uid', 'u1'], ['status', 'planned']],
    });
    expect(r).toMatchObject({ changed: true, fqn: 'app.api.auth.login' });
    expect(isInsertion(WITH_BODY, r.text, [
      "        login = function 'login' {",
      "          technology 'ts'",
      "          description 'Logs in'",
      '          link ../src/a.ts#login',
      '          metadata {',
      "            uid 'u1'",
      "            status 'planned'",
      '          }',
      '        }',
      '',
    ].join('\n'))).toBe(true);
    // ... and it sits right after the technology line of auth, before auth's closing brace
    expect(r.text.indexOf("technology 'TS'")).toBeLessThan(r.text.indexOf('login = function'));
    const el = check(r.text, 'app.api.auth.login', 'app.api.auth', 'login');
    expect(el.technology).toBe('ts');
    expect(el.description).toBe('Logs in');
    expect(el.links[0]).toMatchObject({ name: 'login' });
    expect(el.metadata).toEqual({ uid: 'u1', status: 'planned' });
  });

  it('element with only a title has no body', () => {
    const r = addElementText(WITH_BODY, 'app', { id: 'web', kind: 'container', title: 'Web' });
    expect(isInsertion(WITH_BODY, r.text, "    web = container 'Web'\n")).toBe(true);
    expect(r.text.indexOf('web =')).toBeGreaterThan(r.text.indexOf('auth ='));
    check(r.text, 'app.web', 'app', 'Web');
  });

  it('parent with no body gets one', () => {
    const t = "model {\n  app = system 'App'\n}\n";
    const r = addElementText(t, 'app', { id: 'api', kind: 'container', title: 'Api', metadata: [['uid', 'u']] });
    expect(r.text).toBe("model {\n  app = system 'App' {\n    api = container 'Api' {\n      metadata {\n        uid 'u'\n      }\n    }\n  }\n}\n");
    check(r.text, 'app.api', 'app', 'Api');
  });

  it('parent with only metadata: child after the metadata block', () => {
    const t = "model {\n  app = system 'App' {\n    metadata {\n      status 'planned'\n    }\n  }\n}\n";
    const r = addElementText(t, 'app', { id: 'api', kind: 'container', title: 'Api' });
    expect(r.text).toBe("model {\n  app = system 'App' {\n    metadata {\n      status 'planned'\n    }\n    api = container 'Api'\n  }\n}\n");
    check(r.text, 'app.api', 'app', 'Api');
  });

  it('inline body: block goes on new lines before the brace', () => {
    const t = "model {\n  app = system 'App' { }\n}\n";
    const r = addElementText(t, 'app', { id: 'api', kind: 'container', title: 'Api' });
    check(r.text, 'app.api', 'app', 'Api');
    expect(r.text).toBe("model {\n  app = system 'App' { \n    api = container 'Api'\n  }\n}\n");
  });

  it('CRLF file keeps CRLF in the inserted lines', () => {
    const crlf = WITH_BODY.replace(/\n/g, '\r\n');
    const r = addElementText(crlf, 'app.api', { id: 'x', kind: 'component', title: 'X', technology: 't' });
    const ins = "      x = component 'X' {\r\n        technology 't'\r\n      }\r\n";
    expect(isInsertion(crlf, r.text, ins)).toBe(true);
    expect(r.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    check(r.text, 'app.api.x', 'app.api', 'X');
  });

  it('tab-indented file uses tabs', () => {
    const tabs = "model {\n\tapp = system 'App' {\n\t\tapi = container 'Api' {\n\t\t\ttechnology 'x'\n\t\t}\n\t}\n}\n";
    const r = addElementText(tabs, 'app', { id: 'web', kind: 'container', title: 'Web', technology: 'n' });
    expect(isInsertion(tabs, r.text, "\t\tweb = container 'Web' {\n\t\t\ttechnology 'n'\n\t\t}\n")).toBe(true);
    check(r.text, 'app.web', 'app', 'Web');
  });

  it('quote and backslash in the title and values round-trip', () => {
    const title = "It's a \\ \"test\"";
    const r = addElementText(WITH_BODY, 'app.api', {
      id: 'q', kind: 'component', title, description: "d'\\", metadata: [['owner', "O'Neil\\"]],
    });
    const el = check(r.text, 'app.api.q', 'app.api', title);
    expect(el.description).toBe("d'\\");
    expect(el.metadata.owner).toBe("O'Neil\\");
  });

  it('a link with whitespace or a brace is quoted and parses back', () => {
    const r = addElementText(WITH_BODY, 'app.api', { id: 'l', kind: 'component', title: 'L', links: ['../my dir/a.ts#f', '../b{x}.ts'] });
    const el = check(r.text, 'app.api.l', 'app.api', 'L');
    expect(el.links.map(l => l.raw)).toEqual(['../my dir/a.ts#f', '../b{x}.ts']);
  });

  it('adds into an element defined in an extend block', () => {
    const t = "model {\n  app = system 'App'\n  extend app {\n    api = container 'Api' {\n      a = component 'A'\n    }\n  }\n}\n";
    const r = addElementText(t, 'app.api', { id: 'b', kind: 'component', title: 'B' });
    expect(isInsertion(t, r.text, "      b = component 'B'\n")).toBe(true);
    check(r.text, 'app.api.b', 'app.api', 'B');
  });

  it('unknown parent or broken text: changed false, no throw', () => {
    const spec = { id: 'x', kind: 'component', title: 'X' };
    expect(addElementText(WITH_BODY, 'nope', spec)).toEqual({ text: WITH_BODY, changed: false, fqn: 'nope.x' });
    const broken = "model {\n  app = system 'App {\n}\n";
    expect(addElementText(broken, 'app', spec).changed).toBe(false);
    const unterminatedBody = "model {\n  app = system 'App' {\n";
    expect(addElementText(unterminatedBody, 'app', spec).changed).toBe(false);
  });

  it('invalid arguments throw', () => {
    const ok = { id: 'x', kind: 'component', title: 'X' };
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, id: '1x' })).toThrow(/invalid id/);
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, id: 'a b' })).toThrow(/invalid id/);
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, kind: 'bad kind' })).toThrow(/invalid kind/);
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, title: 'a\nb' })).toThrow(/line breaks/);
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, metadata: [['bad key', 'v']] })).toThrow(/invalid metadata key/);
    expect(() => addElementText(WITH_BODY, 'app', { ...ok, metadata: [['k', 'a\nb']] })).toThrow(/line breaks/);
  });

  // W5 (b301): `at` picks one extend block of the parent; without it the output is today's, byte for byte.
  const EXTENDED = [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      auth = component 'Auth'",
    '    }',
    '  }',
    '  extend app.api {',
    "    login = screen 'Login'",
    '  }',
    '  extend app.api {',
    "    home = screen 'Home'",
    '  }',
    '}',
    '',
  ].join('\n');
  const SPEC = { id: 'cart', kind: 'screen', title: 'Cart' };

  it('without at: the defining body, byte-equal to the call without the argument', () => {
    const r = addElementText(EXTENDED, 'app.api', SPEC);
    expect(r.text).toBe(EXTENDED.replace("      auth = component 'Auth'\n", "      auth = component 'Auth'\n      cart = screen 'Cart'\n"));
    expect(addElementText(EXTENDED, 'app.api', SPEC, undefined)).toEqual(r);
  });

  it('with at: inserts at the end of that extend block; a missing block leaves the text unchanged', () => {
    const first = addElementText(EXTENDED, 'app.api', SPEC, { extendIndex: 0 });
    expect(first.text).toBe(EXTENDED.replace("    login = screen 'Login'\n", "    login = screen 'Login'\n    cart = screen 'Cart'\n"));
    const second = addElementText(EXTENDED, 'app.api', SPEC, { extendIndex: 1 });
    expect(second.text).toBe(EXTENDED.replace("    home = screen 'Home'\n", "    home = screen 'Home'\n    cart = screen 'Cart'\n"));
    check(second.text, 'app.api.cart', 'app.api', 'Cart');
    expect(addElementText(EXTENDED, 'app.api', SPEC, { extendIndex: 2 })).toEqual({ text: EXTENDED, changed: false, fqn: 'app.api.cart' });
  });
});

// W5 (b301, C13): which file (and extend block) a new child goes into.
describe('addTargetOf', () => {
  const A = [
    'model {',
    "  app = system 'App' {",
    "    api = container 'Api' {",
    "      auth = component 'Auth'",
    '    }',
    "    web = container 'Web'",
    '  }',
    '}',
    '',
  ].join('\n');
  const B = [
    'model {',
    '  extend app.api {',
    "    db = store 'Db'",
    '  }',
    '  extend app.api {',
    "    login = screen 'Login'",
    '  }',
    '}',
    '',
  ].join('\n');
  const C = "model {\n  extend app.api {\n    home = screen 'Home'\n  }\n  extend app.web {\n    ui = component 'Ui'\n  }\n}\n";
  const texts = new Map([['a.c4', A], ['b.c4', B], ['c.c4', C]]);
  const plan = parsePlanTexts('/repo', texts);

  it('rule 1: the defining file holds a sibling of the same view', () => {
    expect(addTargetOf(plan, texts, 'app.api', 'component')).toEqual({ file: 'a.c4', extendIndex: null });
    // code kinds are not in the kind table: viewOfKind gives arch, as today
    expect(addTargetOf(plan, texts, 'app.api', 'function')).toEqual({ file: 'a.c4', extendIndex: null });
  });

  it('rule 2: the first file in path order, and the extend block in it, that holds a sibling of the same view', () => {
    expect(addTargetOf(plan, texts, 'app.api', 'screen')).toEqual({ file: 'b.c4', extendIndex: 1 });
    expect(addTargetOf(plan, texts, 'app.api', 'flow')).toEqual({ file: 'b.c4', extendIndex: 1 });   // flows are IO (viewOfKind)
    expect(addTargetOf(plan, texts, 'app.api', 'store')).toEqual({ file: 'b.c4', extendIndex: 0 });
    expect(addTargetOf(plan, texts, 'app.web', 'component')).toEqual({ file: 'c.c4', extendIndex: 0 });   // index among app.web's blocks
  });

  it('rule 3: no sibling of the same view anywhere: the defining file', () => {
    expect(addTargetOf(plan, texts, 'app.web', 'screen')).toEqual({ file: 'a.c4', extendIndex: null });
    expect(addTargetOf(plan, texts, 'app', 'container')).toEqual({ file: 'a.c4', extendIndex: null });
  });

  it('an unterminated extend block is skipped', () => {
    const open = "model {\n  extend app.api {\n    login = screen 'Login'\n";
    const t = new Map([['a.c4', A], ['b.c4', open], ['c.c4', C]]);
    expect(addTargetOf(parsePlanTexts('/repo', t), t, 'app.api', 'screen')).toEqual({ file: 'c.c4', extendIndex: 0 });
    const only = new Map([['a.c4', A], ['b.c4', open]]);
    expect(addTargetOf(parsePlanTexts('/repo', only), only, 'app.api', 'screen')).toEqual({ file: 'a.c4', extendIndex: null });
  });

  it('a parent not in the plan or a plan file without a text throws', () => {
    expect(() => addTargetOf(plan, texts, 'app.nope', 'screen')).toThrow(/no plan element app\.nope/);
    expect(() => addTargetOf(plan, new Map([['a.c4', A], ['b.c4', B]]), 'app.web', 'screen')).toThrow(/no text for plan file c\.c4/);
  });
});
