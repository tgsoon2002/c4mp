import * as fs from 'fs';
import * as path from 'path';
import { swiftHandler } from '../src/languages/swift';
import { extractSwiftOutline } from '../src/languages/swift/outline';
import { loadQueryContext } from '../src/query/context';
import { findElements, outlineFile } from '../src/query/find';
import { showTarget } from '../src/query/show';

const parseSwift = (code: string) => swiftHandler.parse(code, '');

const repo = path.join(__dirname, 'fixtures/swiftshop');
const file = 'Sources/Shop/Shop.swift';
const code = fs.readFileSync(path.join(repo, file), 'utf8');

describe('swift handler', () => {
  const tree = parseSwift(code);
  const outline = extractSwiftOutline(tree, file, code);
  const row = (name: string) => outline.elements.find((e) => e.name === name)!;

  it('parses the fixture without error', () => {
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.parseError).toBe(false);
    expect(outline.lineCount).toBe(70);
  });

  it('lists types, functions, methods and initializers with kinds and ranges', () => {
    expect(outline.elements.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'class:Order',
      'method:Order.init',
      'method:Order.refund',
      'type:Status',
      'method:Status.next',
      'type:Priced',
      'method:Priced.price',
      'method:Priced.init',
      'method:Order.price',
      'method:Order.init#2',
      'class:Cart',
      'method:Cart.add',
      'class:Line',
      'method:Line.describe',
      'class:Counter',
      'method:Counter.tick',
      'function:makeOrder',
    ]);
    expect(row('Order')).toEqual({ name: 'Order', kind: 'class', startLine: 3, endLine: 15, lineCount: 13 });
    expect(row('Order.refund')).toMatchObject({ startLine: 12, endLine: 14, lineCount: 3 });
    expect(row('makeOrder')).toMatchObject({ startLine: 67, endLine: 69 });
  });

  it('lists extension members under the extended type (last name of A.B), not the extension itself', () => {
    const money = 'Sources/Shop/Util/Money.swift';
    const src = fs.readFileSync(path.join(repo, money), 'utf8');
    const out = extractSwiftOutline(parseSwift(src), money, src);
    expect(out.elements.map((e) => `${e.kind}:${e.name}`)).toEqual(['method:Line.cents', 'function:vat']);
  });
});

describe('swift find / outline / show', () => {
  const ctx = loadQueryContext(repo, { cli: { languages: ['swift'] } });

  it('outlineFile nests methods under their type, extension members included', () => {
    const out = outlineFile(ctx, file);
    const order = out.elements.find((e) => e.name === 'Order')!;
    expect(order.children!.map((c) => c.name)).toEqual(['Order.init', 'Order.refund', 'Order.price', 'Order.init#2']);
  });

  it('find locates a method and a function', () => {
    expect(findElements(ctx, { query: 'Counter.tick' }).results.map((r) => r.name)).toContain('Counter.tick');
    expect(findElements(ctx, { query: 'makeOrder', kind: 'function' }).results[0]).toMatchObject({ name: 'makeOrder' });
  });

  it('show returns the element lines', () => {
    const r = showTarget(ctx, `${file}#makeOrder`);
    expect(JSON.stringify(r)).toContain('Order(id: id)');
  });
});
