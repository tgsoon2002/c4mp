import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { phpHandler } from '../src/languages/php';
import { extractPhpImports } from '../src/languages/php/imports';
import { createPhpResolver } from '../src/languages/php/resolve';

const parsePhp = (code: string) => phpHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/phpshop');
const FILES = ['public/index.php', 'src/Models/Order.php', 'src/Util/Money.php', 'views/list.php'];

function importsOf(code: string) {
  return extractPhpImports(parsePhp(code)).map((i) => [i.spec, i.kind, i.line]);
}

describe('PHP import extraction', () => {
  it('reads use forms', () => {
    const code = '<?php\nuse Foo\\Bar;\nuse Foo\\Bar as Baz, Qux\\Z;\nuse function Foo\\f;\nuse const Foo\\C;\nuse \\Root\\Cls;\nuse Foo\\{A, B\\C as D, function g};\n';
    expect(importsOf(code)).toEqual([
      ['Foo\\Bar', 'import', 2], ['Foo\\Bar', 'import', 3], ['Qux\\Z', 'import', 3],
      ['Foo\\f', 'import', 4], ['Foo\\C', 'import', 5], ['Root\\Cls', 'import', 6],
      ['Foo\\A', 'import', 7], ['Foo\\B\\C', 'import', 7], ['Foo\\g', 'import', 7],
    ]);
  });

  it('reads require/include: literal paths, __DIR__ forms, dynamic as source text', () => {
    const code = [
      '<?php',
      "require 'a.php';",
      "require_once __DIR__ . '/b.php';",
      "include(dirname(__FILE__) . '/c.php');",
      'include_once "d/e.php";',
      "require dirname(__DIR__) . '/f.php';",
      'require $x;',
      'include "p/{$y}.php";',
      "require __DIR__ . $z;",
    ].join('\n');
    expect(importsOf(code)).toEqual([
      ['a.php', 'require', 2], ['./b.php', 'require', 3], ['./c.php', 'require', 4], ['d/e.php', 'require', 5],
      ['./../f.php', 'require', 6], ['$x', 'require', 7], ['"p/{$y}.php"', 'require', 8], ['__DIR__ . $z', 'require', 9],
    ]);
  });

  it('reads a file with no imports', () => {
    expect(importsOf('<?php\nclass A {}\n')).toEqual([]);
  });
});

describe('PHP import resolution on phpshop', () => {
  const resolve = createPhpResolver(FIX, FILES);
  const rows: Array<[string, string, string, string | undefined]> = [];
  for (const file of FILES) {
    const tree = parsePhp(fs.readFileSync(path.join(FIX, file), 'utf-8'));
    for (const imp of extractPhpImports(tree)) {
      const r = resolve(file, imp.spec);
      rows.push([file, imp.spec, r.status, r.target ?? r.pkg]);
    }
  }

  it('resolves PSR-4 names, relative requires; marks the rest', () => {
    expect(rows).toEqual([
      ['public/index.php', './../src/Models/Order.php', 'internal', 'src/Models/Order.php'],
      ['public/index.php', './../views/list.php', 'internal', 'views/list.php'],
      ['public/index.php', 'missing.php', 'unresolved', undefined],
      ['public/index.php', '$page . ".php"', 'unresolved', undefined],
      ['public/index.php', '"pages/{$page}.php"', 'unresolved', undefined],
      ['public/index.php', './../vendor/autoload.php', 'unresolved', undefined],
      ['src/Models/Order.php', 'Shop\\Contracts\\Priced', 'unresolved', undefined],
      ['src/Models/Order.php', 'Shop\\Util\\Money', 'internal', 'src/Util/Money.php'],
      ['src/Util/Money.php', 'Psr\\Log\\LoggerInterface', 'external', 'Psr'],
      // under the own Shop\ prefix but no file: require-dev shop/http-kit is namespace Shop\HttpKit by convention
      ['src/Util/Money.php', 'Shop\\HttpKit\\Client', 'external', 'shop/http-kit'],
      ['src/Util/Money.php', 'Shop\\Models\\Order', 'internal', 'src/Models/Order.php'],
      ['src/Util/Money.php', 'Shop\\Models\\Status', 'unresolved', undefined],
      ['src/Util/Money.php', 'Shop\\Models\\make_order', 'unresolved', undefined],
    ]);
  });
});

describe('PHP resolver: composer.json forms', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-php-'));
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('composer.json', JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/', 'App\\Admin\\': ['admin/', 'admin2/'], '': 'lib/' } } }));
    write('pkg/composer.json', '{ not json');
    write('app/A.php', '');
    write('admin2/Panel.php', '');
    write('lib/Plain.php', '');
    write('app/Admin/Panel.php', '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('longest prefix wins, array dirs, empty prefix, names with no mapping are external', () => {
    const files = ['x.php', 'app/A.php', 'admin2/Panel.php', 'lib/Plain.php', 'app/Admin/Panel.php'];
    const resolve = createPhpResolver(root, files);
    expect(resolve('x.php', 'App\\A')).toEqual({ status: 'internal', target: 'app/A.php' });
    expect(resolve('x.php', 'App\\Admin\\Panel')).toEqual({ status: 'internal', target: 'admin2/Panel.php' });
    expect(resolve('x.php', 'Plain')).toEqual({ status: 'internal', target: 'lib/Plain.php' });
    expect(resolve('x.php', 'Nope')).toEqual({ status: 'unresolved', reason: 'mapped by PSR-4 but file not found' });
  });

  it('a malformed composer.json counts as none; no composer.json at all is unresolved', () => {
    const resolve = createPhpResolver(root, ['pkg/y.php']);
    // pkg/composer.json is unreadable, so the root one is used
    expect(resolve('pkg/y.php', 'Vendor\\Lib\\X')).toEqual({ status: 'unresolved', reason: 'mapped by PSR-4 but file not found' }); // '' prefix maps it: lib/Vendor/Lib/X.php missing
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-php-bare-'));
    try {
      expect(createPhpResolver(bare, ['a.php'])('a.php', 'Foo\\Bar')).toEqual({ status: 'unresolved', reason: 'no composer.json' });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
