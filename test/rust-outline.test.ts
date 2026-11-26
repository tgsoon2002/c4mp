import * as fs from 'fs';
import * as path from 'path';
import { rustHandler } from '../src/languages/rust';
import { extractRustOutline } from '../src/languages/rust/outline';
import { loadQueryContext } from '../src/query/context';
import { findElements, outlineFile } from '../src/query/find';
import { showTarget } from '../src/query/show';

const parseRust = (code: string) => rustHandler.parse(code, '');

const repo = path.join(__dirname, 'fixtures/rustshop');
const file = 'src/shop.rs';
const code = fs.readFileSync(path.join(repo, file), 'utf8');

describe('rust handler', () => {
  const tree = parseRust(code);
  const outline = extractRustOutline(tree, file, code);
  const row = (name: string) => outline.elements.find((e) => e.name === name)!;

  it('parses the fixture without error', () => {
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.parseError).toBe(false);
    expect(outline.lineCount).toBe(55);
  });

  it('lists types, functions and impl/trait methods with kinds and ranges', () => {
    expect(outline.elements.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'class:Order',
      'type:Status',
      'type:Priced',
      'method:Priced.price',
      'method:Priced.is_free',
      'method:Order.new',
      'method:Order.refund',
      'method:Order.price',
      'method:Order.fmt',
      'function:make_order',
      'function:vat',
      'function:exempt',
    ]);
    expect(row('Order')).toEqual({ name: 'Order', kind: 'class', startLine: 3, endLine: 6, lineCount: 4 });
    expect(row('Order.new')).toMatchObject({ startLine: 22, endLine: 24, lineCount: 3 });
  });

  it('flags todo!() and unimplemented!() bodies as stubs only', () => {
    expect(row('Order.refund').stub).toBe('todo');
    expect(row('exempt').stub).toBe('todo');
    expect(row('vat').stub).toBeUndefined();
    expect(row('Priced.is_free').stub).toBeUndefined();
  });

  it('yields its one use declaration as an import', () => {
    expect(rustHandler.imports(tree)).toEqual([{ spec: 'std::fmt', kind: 'import', line: 1 }]);
  });

  it('suffixes a name repeated across modules or impl blocks with #2', () => {
    const dup = `mod a { pub fn new() {} }
mod b { pub fn new() {} }
struct X;
impl A for X { fn f(&self) {} }
impl B for X { fn f(&self) {} }
`;
    const names = extractRustOutline(parseRust(dup), 'dup.rs', dup).elements.map((e) => e.name);
    expect(names).toEqual(['new', 'new#2', 'X', 'X.f', 'X.f#2']);
  });
});

describe('rust find / outline / show', () => {
  const ctx = loadQueryContext(repo, { cli: { languages: ['rust'] } });

  it('outlineFile nests methods under their type', () => {
    const out = outlineFile(ctx, file);
    const order = out.elements.find((e) => e.name === 'Order')!;
    expect(order.children!.map((c) => c.name)).toEqual(['Order.new', 'Order.refund', 'Order.price', 'Order.fmt']);
  });

  it('find locates a method and a function', () => {
    expect(findElements(ctx, { query: 'Order.refund' }).results.map((r) => r.name)).toContain('Order.refund');
    expect(findElements(ctx, { query: 'make_order', kind: 'function' }).results[0]).toMatchObject({ name: 'make_order' });
  });

  it('show returns the element lines', () => {
    const r = showTarget(ctx, `${file}#make_order`);
    expect(JSON.stringify(r)).toContain('Order::new(id)');
  });
});
