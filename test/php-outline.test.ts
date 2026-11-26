import * as fs from 'fs';
import * as path from 'path';
import { extractPhpOutline } from '../src/languages/php/outline';
import { phpHandler } from '../src/languages/php';
import { getHandlers, handlerFor } from '../src/languages';
import { loadQueryContext } from '../src/query/context';
import { findElements, outlineFile } from '../src/query/find';
import { showTarget } from '../src/query/show';

const parsePhp = (code: string) => phpHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/phpshop');

function outlineOf(rel: string) {
  const code = fs.readFileSync(path.join(FIX, rel), 'utf-8');
  const tree = parsePhp(code);
  return { tree, outline: extractPhpOutline(tree, rel, code) };
}

describe('PHP outline', () => {
  it('namespace file: function, class, trait, interface, enum, methods, stubs; parses clean', () => {
    const { tree, outline } = outlineOf('src/Models/Order.php');
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.parseError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['Payable', 'type', 8, 11],
      ['Loggable', 'class', 13, 19],
      ['Loggable.log', 'method', 15, 18],
      ['Status', 'type', 21, 30],
      ['Order', 'class', 32, 54],
      ['Order.__construct', 'method', 36, 38],
      ['Order.pay', 'method', 40, 43],
      ['Order.free', 'method', 45, 48],
      ['Order.refund', 'method', 50, 53],
      ['make_order', 'function', 56, 59],
    ]);
    expect(outline.elements.find((e) => e.name === 'Order.refund')!.stub).toBe('throws');
    expect(outline.elements.filter((e) => e.stub).length).toBe(1);
  });

  it('HTML + PHP file: PHP blocks are indexed, HTML is not, no parse error', () => {
    const { tree, outline } = outlineOf('views/list.php');
    expect(tree.rootNode.hasError).toBe(false);
    expect(outline.elements.map((e) => [e.name, e.kind])).toEqual([
      ['render_row', 'function'],
      ['ListView', 'class'],
      ['ListView.title', 'method'],
    ]);
  });

  it('handler reads the use lines; handler selected by --lang php for .php and .phtml', () => {
    const { tree } = outlineOf('src/Models/Order.php');
    expect(phpHandler.imports(tree).map((i) => i.spec)).toEqual(['Shop\\Contracts\\Priced', 'Shop\\Util\\Money']);
    const handlers = getHandlers(['php']);
    expect(handlerFor('a/b.php', handlers)?.id).toBe('php');
    expect(handlerFor('a/b.phtml', handlers)?.id).toBe('php');
  });
});

describe('PHP find / show / outline', () => {
  const ctx = loadQueryContext(FIX, { cli: { languages: ['php'] } });

  it('scan reports no parse errors and lists every file', () => {
    expect(ctx.snapshot.files.map((f) => f.file).sort()).toEqual(['public/index.php', 'src/Models/Order.php', 'src/Util/Money.php', 'tests/OrderTest.php', 'views/list.php']);
    expect(ctx.snapshot.files.every((f) => !f.parseError)).toBe(true);
  });

  it('find and outline see class methods', () => {
    const rows = findElements(ctx, { query: 'Order.pay' }).results;
    expect(rows[0]).toMatchObject({ path: 'src/Models/Order.php', name: 'Order.pay', kind: 'method', startLine: 40 });
    const order = outlineFile(ctx, 'src/Models/Order.php').elements.find((e) => e.name === 'Order')!;
    expect(order.children!.map((c) => c.name)).toContain('Order.refund');
  });

  it('show returns the method source', () => {
    const r = showTarget(ctx, 'src/Models/Order.php#Order.pay');
    expect(r.startLine).toBe(40);
    expect(r.code.join('\n')).toContain('return $amount >= $this->total;');
  });
});
