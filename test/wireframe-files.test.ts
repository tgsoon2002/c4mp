import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWireframes, inlineSheets, WIREFRAME_MAX_BYTES } from '../src/c4/wireframeFiles';

// W3 (b299): file loader + sheet inlining. Every case runs on a throw-away repo/plan folder built here.

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-wf-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function plan(files: Record<string, string>, where = 'repo/c4'): { repo: string; dir: string; io: string } {
  const repo = path.join(tmp, 'repo');
  const dir = path.join(tmp, where);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.mkdirSync(repo, { recursive: true });
  return { repo, dir, io: path.join(dir, 'io') };
}
function ok(r: ReturnType<typeof loadWireframes>) {
  if (r.status !== 'ok') throw new Error('expected ok, got ' + r.status);
  return r;
}

describe('loadWireframes', () => {
  it('hit: loads io/<fqn>.html, reports the repo-relative path', () => {
    const p = plan({ 'io/shop.web.home.html': '<div data-c4="header"></div>' });
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home']));
    expect(r.hasIo).toBe(true);
    expect(r.io).toBe('c4/io');
    expect(r.files.get('shop.web.home')).toEqual({
      fqn: 'shop.web.home', file: 'c4/io/shop.web.home.html', html: '<div data-c4="header"></div>', inlined: [], badLinks: [],
      styleAttrs: 0, styleBlocks: 0,
    });
    expect(r.orphans).toEqual([]);
  });

  it('W7: io is the repo-relative io folder on every ok load (no io/, io/ error, outside the repo)', () => {
    const none = plan({ 'a.c4': '' });
    expect(ok(loadWireframes(none.repo, none.dir, [])).io).toBe('c4/io');
    const notDir = plan({ io: 'a file' }, 'repo/c5');
    expect(ok(loadWireframes(notDir.repo, notDir.dir, [])).io).toBe('c5/io');
    const out = plan({ 'io/x.html': 'x' }, 'outside/plan');
    expect(ok(loadWireframes(out.repo, out.dir, [])).io).toBe('../outside/plan/io');
  });

  it('W7: style attributes and <style> blocks of the own text are counted; comments, raw text and inlined sheets are not', () => {
    const p = plan({
      'io/site.css': '.a { display: flex; }',
      'io/shop.web.home.html': [
        '<!-- <div style="x"></div> <style>a{}</style> -->',
        '<link rel="stylesheet" href="site.css">',
        '<style>.b { width: 1px } /* <div style="y"> */</style>',
        '<div class="a" style="height: 2px"><span STYLE=\'width:3px\'></span></div>',
        '<script>var t = \'<div style="z">\';</script>',
        '<textarea><p style="q"></p></textarea>',
      ].join('\n'),
      'io/shop.web.cart.html': '<div class="a" data-style="no"></div>',
    });
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home', 'shop.web.cart']));
    expect(r.files.get('shop.web.home')).toMatchObject({ styleAttrs: 2, styleBlocks: 1, inlined: ['site.css'] });
    expect(r.files.get('shop.web.cart')).toMatchObject({ styleAttrs: 0, styleBlocks: 0 });
  });

  it('missing: a screen without a file is absent; no io/ folder -> hasIo false', () => {
    const p = plan({ 'io/shop.web.home.html': 'x' });
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home', 'shop.web.cart']));
    expect([...r.files.keys()]).toEqual(['shop.web.home']);
    const none = plan({ 'a.c4': '' }, 'repo2/c4');
    const r2 = ok(loadWireframes(none.repo, none.dir, ['shop.web.home']));
    expect(r2).toMatchObject({ hasIo: false, orphans: [] });
    expect(r2.files.size).toBe(0);
  });

  it('orphan: io/*.html naming no screen is listed; css, folders and symlinks are not', () => {
    const p = plan({ 'io/shop.web.home.html': 'x', 'io/gone.screen.html': 'x', 'io/site.css': 'a{}', 'io/notes.txt': 'x', 'io/sub.html/keep': 'x' });
    fs.symlinkSync(path.join(p.io, 'gone.screen.html'), path.join(p.io, 'linked.html'));
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home']));
    expect(r.orphans).toEqual(['c4/io/gone.screen.html']);
  });

  it('symlink: a symlinked wireframe is not read and says why; the other screens still load', () => {
    const p = plan({ 'io/shop.web.cart.html': 'cart' });
    fs.writeFileSync(path.join(tmp, 'secret.html'), 'SECRET');
    fs.symlinkSync(path.join(tmp, 'secret.html'), path.join(p.io, 'shop.web.home.html'));
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home', 'shop.web.cart']));
    const bad = r.files.get('shop.web.home')!;
    expect(bad.html).toBeUndefined();
    expect(bad.error).toMatch(/symbolic link/);
    expect(JSON.stringify(bad)).not.toContain('SECRET');
    expect(r.files.get('shop.web.cart')!.html).toBe('cart');
  });

  it('symlinked io/ folder: nothing is loaded, ioError says why', () => {
    const p = plan({ 'a.c4': '' });
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.writeFileSync(path.join(tmp, 'elsewhere', 'shop.web.home.html'), 'x');
    fs.symlinkSync(path.join(tmp, 'elsewhere'), p.io);
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home']));
    expect(r.ioError).toMatch(/symbolic link/);
    expect(r.files.size).toBe(0);
  });

  it('over 512 KB: an error entry (not a skip); exactly 512 KB loads', () => {
    const p = plan({
      'io/shop.web.big.html': 'x'.repeat(WIREFRAME_MAX_BYTES + 1),
      'io/shop.web.edge.html': 'x'.repeat(WIREFRAME_MAX_BYTES),
    });
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.big', 'shop.web.edge']));
    expect(r.files.get('shop.web.big')).toMatchObject({ error: expect.stringMatching(/over the 512 KB cap/) });
    expect(r.files.get('shop.web.big')!.html).toBeUndefined();
    expect(r.files.get('shop.web.edge')!.html).toHaveLength(WIREFRAME_MAX_BYTES);
  });

  it('inlined result over the cap is an error entry', () => {
    const p = plan({
      'io/s.a.html': '<link rel="stylesheet" href="big.css"><link rel="stylesheet" href="big2.css">',
      'io/big.css': 'a{}' + ' '.repeat(WIREFRAME_MAX_BYTES - 10),
      'io/big2.css': 'b{}' + ' '.repeat(WIREFRAME_MAX_BYTES - 10),
    });
    const e = ok(loadWireframes(p.repo, p.dir, ['s.a'])).files.get('s.a')!;
    expect(e.html).toBeUndefined();
    expect(e.error).toMatch(/over 512 KB/);
  });

  it('dir null -> unsupported', () => {
    expect(loadWireframes('/anywhere', null, ['shop.web.home'])).toEqual({ status: 'unsupported', reason: expect.stringMatching(/no folder/) });
  });

  it('plan folder outside the repo: loads, paths start with ../', () => {
    const p = plan({ 'io/shop.web.home.html': 'x', 'io/old.html': 'x' }, 'outside/plan');
    const r = ok(loadWireframes(p.repo, p.dir, ['shop.web.home']));
    expect(r.files.get('shop.web.home')!.file).toBe('../outside/plan/io/shop.web.home.html');
    expect(r.orphans).toEqual(['../outside/plan/io/old.html']);
  });

  it.each(['../evil', 'a/b', 'a b', '', 'a..b', '1abc', 'a.b.'])('fqn charset: %j gets an error entry and no file is touched', fqn => {
    const p = plan({ 'io/x.html': 'x' });
    const e = ok(loadWireframes(p.repo, p.dir, [fqn])).files.get(fqn)!;
    expect(e.error).toMatch(/characters a wireframe file name cannot hold/);
    expect(e.html).toBeUndefined();
  });

  it('one bad screen never stops the others', () => {
    const p = plan({ 'io/s.good.html': 'ok', 'io/s.big.html': 'x'.repeat(WIREFRAME_MAX_BYTES + 1) });
    const r = ok(loadWireframes(p.repo, p.dir, ['s.big', '../x', 's.good']));
    expect(r.files.get('s.good')!.html).toBe('ok');
    expect(r.files.get('s.big')!.error).toBeDefined();
    expect(r.files.get('../x')!.error).toBeDefined();
  });
});

describe('sheet inlining (H11)', () => {
  it('<link> inside io/ is inlined as <style>, in file order, and the link is gone', () => {
    const p = plan({
      'io/s.a.html': '<link rel="stylesheet" href="site.css">\n<link href=\'sub/more.css\' rel=StyleSheet />\n<div data-c4="x"></div>',
      'io/site.css': '.a{display:flex}',
      'io/sub/more.css': '.b{gap:4px}',
    });
    const e = ok(loadWireframes(p.repo, p.dir, ['s.a'])).files.get('s.a')!;
    expect(e.inlined).toEqual(['site.css', 'sub/more.css']);
    expect(e.badLinks).toEqual([]);
    expect(e.html).toBe('<style>/* site.css */\n.a{display:flex}\n</style>\n<style>/* sub/more.css */\n.b{gap:4px}\n</style>\n<div data-c4="x"></div>');
    expect(e.html).not.toMatch(/<link/i);
  });

  it('a link in an HTML comment is left alone', () => {
    const p = plan({ 'io/s.a.html': '<!-- <link rel="stylesheet" href="site.css"> -->', 'io/site.css': 'a{}' });
    const e = ok(loadWireframes(p.repo, p.dir, ['s.a'])).files.get('s.a')!;
    expect(e.html).toBe('<!-- <link rel="stylesheet" href="site.css"> -->');
    expect(e.inlined).toEqual([]);
  });

  describe('outside io/ or otherwise bad: dropped and reported, the screen still loads', () => {
    const cases: [string, string, string][] = [
      ['dotdot', '<link rel="stylesheet" href="../architecture.c4">', 'outside io/'],
      ['dotdot css', '<link rel="stylesheet" href="../x.css">', 'outside io/'],
      ['nested dotdot', '<link rel="stylesheet" href="sub/../../x.css">', 'outside io/'],
      ['absolute', '<link rel="stylesheet" href="/etc/x.css">', 'absolute'],
      ['url', '<link rel="stylesheet" href="https://x.test/a.css">', 'URL'],
      ['protocol-relative', '<link rel="stylesheet" href="//x.test/a.css">', 'URL'],
      ['data url', '<link rel="stylesheet" href="data:text/css,a{}">', 'URL'],
      ['backslash', '<link rel="stylesheet" href="sub\\a.css">', 'backslash'],
      ['query', '<link rel="stylesheet" href="site.css?v=1">', 'query'],
      ['not css', '<link rel="stylesheet" href="notes.txt">', 'not a .css'],
      ['missing file', '<link rel="stylesheet" href="nope.css">', 'does not exist'],
      ['no href', '<link rel="stylesheet">', 'no href'],
      ['not a stylesheet', '<link rel="icon" href="site.css">', 'rel is not'],
      ['no rel', '<link href="site.css">', 'rel is not'],
    ];
    it.each(cases)('%s', (_n, link, reason) => {
      const p = plan({ 'io/s.a.html': link + '<div data-c4="x"></div>', 'io/site.css': 'a{}', 'io/notes.txt': 'a{}', 'x.css': 'a{}' });
      const e = ok(loadWireframes(p.repo, p.dir, ['s.a'])).files.get('s.a')!;
      expect(e.error).toBeUndefined();
      expect(e.html).toBe('<div data-c4="x"></div>');
      expect(e.inlined).toEqual([]);
      expect(e.badLinks).toHaveLength(1);
      expect(e.badLinks[0].reason).toContain(reason);
    });
  });

  it('symlinked sheet, sheet in a symlinked folder, over-cap sheet and a sheet holding </style are dropped with a reason', () => {
    const p = plan({
      'io/s.a.html': '<link rel="stylesheet" href="ln.css"><link rel="stylesheet" href="dir/in.css"><link rel="stylesheet" href="big.css"><link rel="stylesheet" href="bad.css">',
      'io/big.css': 'a'.repeat(WIREFRAME_MAX_BYTES + 1),
      'io/bad.css': 'a{}</STYLE><script>x</script>',
    });
    fs.mkdirSync(path.join(tmp, 'outside'));
    fs.writeFileSync(path.join(tmp, 'outside', 'in.css'), 'a{}');
    fs.writeFileSync(path.join(tmp, 'outside', 'ln.css'), 'a{}');
    fs.symlinkSync(path.join(tmp, 'outside', 'ln.css'), path.join(p.io, 'ln.css'));
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(p.io, 'dir'));
    const e = ok(loadWireframes(p.repo, p.dir, ['s.a'])).files.get('s.a')!;
    expect(e.html).toBe('');
    expect(e.badLinks.map(b => b.reason)).toEqual([
      expect.stringMatching(/outside io/), expect.stringMatching(/outside io/), expect.stringMatching(/over the 512 KB cap/), expect.stringContaining('</style'),
    ]);
  });

  it('inlineSheets handles attribute forms: unquoted, extra attributes, a ">" inside a quoted value', () => {
    const p = plan({ 'io/site.css': 'a{}' });
    const r = inlineSheets(p.io, '<LINK data-x="a>b" rel=stylesheet href=site.css media=all>');
    expect(r.inlined).toEqual(['site.css']);
    expect(r.html).toBe('<style>/* site.css */\na{}\n</style>');
  });
});
