import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { csharpHandler } from '../src/languages/csharp';
import { extractCSharpImports } from '../src/languages/csharp/imports';
import { createCSharpResolver, declaredNamespaces } from '../src/languages/csharp/resolve';
import { runSnapshot } from '../src/pipeline';

const parseCs = (code: string) => csharpHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/csharpshop');
const FILES = ['Shop/Catalog.cs', 'Shop/Checkout.cs', 'Shop/Order.cs', 'Shop/Usings.cs', 'Util/Format.cs', 'Util/Rounding.cs', 'Util/Text.cs'];

function importsOf(code: string) {
  return extractCSharpImports(parseCs(code)).map((i) => [i.spec, i.kind, i.line]);
}

describe('C# import extraction', () => {
  it('reads using, global using, using static, aliases, global:: and usings inside a namespace', () => {
    const code = [
      'global using System.Text;',
      'using System;',
      'using static System.Math;',
      'global using static Shop.Util.Format;',
      'using Json = Newtonsoft.Json.JsonConvert;',
      'using L = System.Collections.Generic.Dictionary<int, string>;',
      'using global::Foo.Bar;',
      '#if DEBUG',
      'using Debug.Only;',
      '#endif',
      'namespace A { using Inner.Ns; }',
    ].join('\n');
    expect(importsOf(code)).toEqual([
      ['System.Text', 'import', 1], ['System', 'import', 2], ['static System.Math', 'import', 3],
      ['static Shop.Util.Format', 'import', 4], ['Json = Newtonsoft.Json.JsonConvert', 'import', 5],
      ['L = System.Collections.Generic.Dictionary<int,string>', 'import', 6], ['global::Foo.Bar', 'import', 7],
      ['Debug.Only', 'import', 9], ['Inner.Ns', 'import', 11],
    ]);
  });

  it('skips using statements, using declarations, comments, strings and extern alias', () => {
    const code = 'extern alias Old;\n// using A.B;\nclass C { void M() { using (var x = F()) { } using var y = F(); var s = "using D.E;"; } }\n';
    expect(importsOf(code)).toEqual([]);
  });

  it('reads the namespaces a file declares: block, nested, file-scoped, inside #if', () => {
    const ns = (code: string) => declaredNamespaces(parseCs(code)).sort();
    expect(ns('namespace A.B { namespace C { } class X { } }\nnamespace D { }\n')).toEqual(['A.B', 'A.B.C', 'D']);
    expect(ns('namespace Shop.Catalog;\nclass Item { }\n')).toEqual(['Shop.Catalog']);
    expect(ns('#if DEBUG\nnamespace Dbg { }\n#endif\nclass Global { }\n')).toEqual(['Dbg']);
    expect(ns('class Global { }\n')).toEqual([]);
  });

  it('does not crash on partial or odd files', () => {
    expect(() => importsOf('using ;\nusing static ;\nusing X = ;\nnamespace { class')).not.toThrow();
    expect(() => declaredNamespaces(parseCs('namespace ;\nnamespace A.{ }\n'))).not.toThrow();
    const resolve = createCSharpResolver(FIX, FILES, csharpHandler.parse);
    for (const spec of ['', 'static', 'X =', 'global::', 'a b c', '<int>']) {
      expect(resolve('Shop/Checkout.cs', spec).status).toBe('unresolved');
    }
  });
});

describe('C# import resolution on csharpshop', () => {
  const resolve = createCSharpResolver(FIX, FILES, csharpHandler.parse);
  const rows: Array<[string, string, string, string | string[] | undefined]> = [];
  for (const file of FILES) {
    for (const imp of extractCSharpImports(parseCs(fs.readFileSync(path.join(FIX, file), 'utf-8')))) {
      const r = resolve(file, imp.spec);
      rows.push([file, imp.spec, r.status, r.targets ?? r.target ?? r.pkg ?? r.reason]);
    }
  }

  it('resolves namespaces to every declaring file; BCL and NuGet are external; the rest has a reason', () => {
    expect(rows).toEqual([
      ['Shop/Checkout.cs', 'System.Linq', 'external', 'System'],
      ['Shop/Checkout.cs', 'Shop.Util', 'internal', ['Util/Format.cs', 'Util/Rounding.cs']],
      ['Shop/Checkout.cs', 'static Shop.Util.Format', 'internal', ['Util/Format.cs', 'Util/Rounding.cs']],
      ['Shop/Checkout.cs', 'Json = Newtonsoft.Json.JsonConvert', 'external', 'Newtonsoft.Json'],
      ['Shop/Checkout.cs', 'Ints = System.Collections.Generic.List<int>', 'external', 'System'],
      ['Shop/Checkout.cs', 'Tools', 'unresolved', 'namespace-has-no-files'],
      ['Shop/Checkout.cs', 'Missing.Thing', 'unresolved', 'unknown-namespace'],
      ['Shop/Checkout.cs', 'Shop.Catalog', 'internal', 'Shop/Catalog.cs'],
      ['Shop/Order.cs', 'System', 'external', 'System'],
      ['Shop/Usings.cs', 'Shop.Catalog', 'internal', 'Shop/Catalog.cs'],
    ]);
  });

  it('a plain using never drops segments; the importing file is a target only when it is the only one', () => {
    expect(resolve('Shop/Checkout.cs', 'Shop.Util.Format')).toEqual({ status: 'unresolved', reason: 'unknown-namespace' });
    expect(resolve('Util/Format.cs', 'Shop.Util')).toEqual({ status: 'internal', target: 'Util/Rounding.cs' });
    expect(resolve('Shop/Catalog.cs', 'Shop.Catalog')).toEqual({ status: 'internal', target: 'Shop/Catalog.cs' });
    expect(resolve('Shop/Order.cs', 'Shop.Tax')).toEqual({ status: 'internal', target: 'Shop/Order.cs' });
  });

  it('gives one import record and one file edge per target in the snapshot', () => {
    const snapshot = runSnapshot({ repo: FIX, write: false, quiet: true, config: { languages: ['csharp'] } });
    const from = (file: string) => snapshot.fileEdges.filter((e) => e.from === file).map((e) => e.to);
    expect(from('Shop/Checkout.cs')).toEqual(['Shop/Catalog.cs', 'Util/Format.cs', 'Util/Rounding.cs']);
    expect(from('Shop/Usings.cs')).toEqual(['Shop/Catalog.cs']);
    expect(snapshot.externals.map((e) => e.pkg)).toEqual(['Newtonsoft.Json', 'System']);
    expect(snapshot.stats.unresolvedImports).toBe(2);
  });
});

describe('C# resolver: .csproj packages', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-cs-'));
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('Root.csproj', '<Project><ItemGroup><PackageReference Include="xunit" Version="2" /></ItemGroup></Project>');
    write('app/App.csproj', "<Project><PackageReference Version='1' Include='Serilog.Sinks.File'/><PackageReference Include=\"Serilog\"/></Project>");
    write('app/Broken.csproj', '<Project><PackageReference Include=');
    write('app/A.cs', 'namespace App { }');
    write('other/B.cs', 'namespace Other { }');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches the longest package name on whole segments, ignoring case; reads .csproj files above the sources', () => {
    const resolve = createCSharpResolver(root, ['app/A.cs', 'other/B.cs'], csharpHandler.parse);
    expect(resolve('app/A.cs', 'Xunit.Abstractions')).toEqual({ status: 'external', pkg: 'xunit' });
    expect(resolve('app/A.cs', 'Serilog.Sinks.File.Internal')).toEqual({ status: 'external', pkg: 'Serilog.Sinks.File' });
    expect(resolve('app/A.cs', 'Serilog.Core')).toEqual({ status: 'external', pkg: 'Serilog' });
    expect(resolve('app/A.cs', 'SerilogX')).toEqual({ status: 'unresolved', reason: 'unknown-namespace' });
    expect(resolve('other/B.cs', 'Microsoft.Extensions.Logging')).toEqual({ status: 'external', pkg: 'Microsoft' });
    expect(resolve('other/B.cs', 'App')).toEqual({ status: 'internal', target: 'app/A.cs' });
  });
});
