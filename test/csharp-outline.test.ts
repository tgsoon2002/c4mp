import * as fs from 'fs';
import * as path from 'path';
import { extractCSharpOutline } from '../src/languages/csharp/outline';
import { csharpHandler } from '../src/languages/csharp';
import { loadQueryContext } from '../src/query/context';
import { findElements, outlineFile } from '../src/query/find';
import { showTarget } from '../src/query/show';

const parseCSharp = (code: string) => csharpHandler.parse(code, '');

const repo = path.join(__dirname, 'fixtures/csharpshop');
const order = 'Shop/Order.cs';
const catalog = 'Shop/Catalog.cs';
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');

describe('csharp handler', () => {
  const code = read(order);
  const tree = parseCSharp(code);
  const outline = extractCSharpOutline(tree, order, code);
  const row = (name: string) => outline.elements.find((e) => e.name === name)!;

  it('parses both fixtures without error', () => {
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.parseError).toBe(false);
    expect(parseCSharp(read(catalog)).rootNode.hasError).toBe(false);
  });

  it('lists types and methods with kinds', () => {
    expect(outline.elements.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'type:IPriced',
      'method:IPriced.Price',
      'class:Order',
      'method:Order.Order',
      'method:Order.Price',
      'method:Order.Refund',
      'method:Order.IsFree',
      'class:Money',
      'class:Receipt',
      'type:Status',
      'class:Vat',
      'method:Vat.Of',
    ]);
    expect(row('IPriced')).toMatchObject({ startLine: 5, endLine: 8, lineCount: 4 });
  });

  it('lists a file-scoped namespace file with a nested type', () => {
    const c = read(catalog);
    const o = extractCSharpOutline(parseCSharp(c), catalog, c);
    expect(o.elements.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'class:Item',
      'method:Item.Label',
      'class:Dim',
      'method:Dim.Width',
    ]);
  });

  it('suffixes overloads and a name repeated across namespaces with #2', () => {
    const c = `namespace A { class Q { void Y() {} void Y(int x) {} } }
namespace B { class Q { void Z() {} } }
`;
    const names = extractCSharpOutline(parseCSharp(c), 'Dup.cs', c).elements.map((e) => e.name);
    expect(names).toEqual(['Q', 'Q.Y', 'Q.Y#2', 'Q#2', 'Q.Z']);
  });

  it('lists a C# 12 body-less type (`class Empty;`) that the grammar leaves in an ERROR node', () => {
    const at = (c: string) => extractCSharpOutline(parseCSharp(c), 'Empty.cs', c).elements.map((e) => `${e.kind}:${e.name}:${e.startLine}-${e.endLine}`);
    expect(at('class Empty;\n')).toEqual(['class:Empty:1-1']);
    expect(at('namespace N;\nclass Empty;\nclass Full { void M() {} }\n'))
      .toEqual(['class:Empty:2-2', 'class:Full:3-3', 'method:Full.M:3-3']);
    expect(at('namespace N\n{\n    class Before { void M() {} }\n    internal struct S;\n}\n'))
      .toEqual(['class:Before:3-3', 'method:Before.M:3-3', 'class:S:4-4']);
    expect(at('class Outer\n{\n    void M() {}\n    sealed class Inner : Base;\n}\n'))
      .toEqual(['class:Outer:1-5', 'method:Outer.M:3-3', 'class:Inner:4-4']);
    expect(at('class Point(int X, int Y);\n')).toEqual(['class:Point:1-1']);
  });

  it('walks into #if / #elif / #else blocks and lists every branch (b204)', () => {
    const c = `#if NET8
namespace N;
abstract class Top { void M() {} }
#endif
namespace B {
#if A
  class X { void P() {} }
#elif C
  class X { void P() {} }
#else
  class Y {
#if D
    void Q() {}
    class Inner {}
#endif
  }
#endif
}
`;
    expect(extractCSharpOutline(parseCSharp(c), 'If.cs', c).elements.map((e) => `${e.kind}:${e.name}:${e.startLine}-${e.endLine}`)).toEqual([
      'class:Top:3-3', 'method:Top.M:3-3',
      'class:X:7-7', 'method:X.P:7-7',
      'class:X#2:9-9', 'method:X.P#2:9-9',
      'class:Y:11-16', 'method:Y.Q:13-13', 'class:Inner:14-14',
    ]);
  });

  it('flags only NotImplementedException bodies as stubs', () => {
    expect(row('Order.Refund').stub).toBe('throws');
    expect(row('Order.Price').stub).toBeUndefined();
    expect(row('Order.IsFree').stub).toBeUndefined();
  });

  it('reads its using directive (resolution: csharp-imports.test.ts)', () => {
    expect(csharpHandler.imports(tree)).toEqual([{ spec: 'System', kind: 'import', line: 1 }]);
  });
});

describe('csharp find / outline / show', () => {
  const ctx = loadQueryContext(repo, { cli: { languages: ['csharp'] } });

  it('outlineFile nests methods under their class', () => {
    const out = outlineFile(ctx, order);
    const cls = out.elements.find((e) => e.name === 'Order')!;
    expect(cls.children!.map((c) => c.name)).toEqual(['Order.Order', 'Order.Price', 'Order.Refund', 'Order.IsFree']);
  });

  it('find locates a method and a type', () => {
    expect(findElements(ctx, { query: 'Order.Refund' }).results.map((r) => r.name)).toContain('Order.Refund');
    expect(findElements(ctx, { query: 'Receipt', kind: 'class' }).results[0]).toMatchObject({ name: 'Receipt' });
  });

  it('show returns the element lines', () => {
    expect(JSON.stringify(showTarget(ctx, `${order}#Vat.Of`))).toContain('amount * 0.2m');
  });
});
