import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadQueryContext, openQueryBase } from '../src/query/context';
import { searchContent, SEARCH_MAX_FILE_BYTES } from '../src/query/search';
import { formatSearch } from '../src/query/format';
import { QueryError } from '../src/query/errors';
import { buildTools } from '../src/mcp/tools';
import { CLI_JS } from './helpers/runCli';

// P8-search: content search on a small fixture repo (ts function, html, css, binary, big file, ignored folders).
let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-search-'));
  const put = (rel: string, content: string | Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  put('pay.ts', `export class Pay {
  charge(n: number) {
    if (n < 0) throw new Error('Payment declined');
    return n;
  }
}
// payment declined elsewhere
`);
  put('page.html', '<p>Payment declined</p>\n<p>ok</p>\n');
  put('style.css', '.err::after { content: "Payment declined"; }\n');
  put('blob.html', Buffer.concat([Buffer.from('Payment declined'), Buffer.from([0, 1, 2])]));
  put('big.txt', 'Payment declined\n' + 'x'.repeat(SEARCH_MAX_FILE_BYTES));
  put('node_modules/dep/index.js', "console.log('Payment declined');\n");
  put('dist/out.js', "console.log('Payment declined');\n");
  put('skipme/a.html', 'Payment declined\n');
  put('.c4pmrc.json', JSON.stringify({ ignore: ['skipme'] }));
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const search = (opts: Partial<Parameters<typeof searchContent>[1]> & { query: string }) =>
  searchContent(loadQueryContext(repo), opts);

describe('searchContent', () => {
  it('finds literal text in ts, html and css, sorted by file then line, with counts', () => {
    const r = search({ query: 'Payment declined' });
    expect(r.results.map((h) => `${h.file}:${h.line}`)).toEqual(['page.html:1', 'pay.ts:3', 'pay.ts:7', 'style.css:1']);
    expect(r.total).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.filesSearched).toBe(4); // pay.ts, page.html, style.css and .c4pmrc.json
    expect(r.filesSkipped).toEqual({ binary: 1, tooBig: 1 });
    expect(r.results[0].text).toBe('<p>Payment declined</p>');
  });

  it('names the enclosing method and an owner; null function outside a function or without a handler', () => {
    const r = search({ query: 'Payment declined' });
    const by = (f: string, l: number) => r.results.find((h) => h.file === f && h.line === l)!;
    expect(by('pay.ts', 3).function).toBe('Pay.charge');
    expect(by('pay.ts', 3).owner).toEqual(expect.any(String));
    expect(by('pay.ts', 7).function).toBeNull();
    expect(by('page.html', 1)).toMatchObject({ function: null, owner: null });
  });

  it('is case-insensitive by default and case-sensitive with caseSensitive', () => {
    expect(search({ query: 'PAYMENT DECLINED' }).total).toBe(4);
    expect(search({ query: 'payment declined', caseSensitive: true }).results.map((h) => h.line)).toEqual([7]);
  });

  it('regex, ext filter, max + truncated, context', () => {
    expect(search({ query: 'Pay\\w+ dec', regex: true }).total).toBe(4);
    expect(search({ query: 'Payment declined', ext: ['html'] }).results.map((h) => h.file)).toEqual(['page.html']);
    const cut = search({ query: 'Payment declined', max: 2 });
    expect(cut.results).toHaveLength(2);
    expect(cut).toMatchObject({ total: 4, truncated: true });
    const ctx = search({ query: 'Payment declined', ext: ['.ts'], max: 1, context: 1 });
    expect(ctx.results[0].before).toEqual(['charge(n: number) {']);
    expect(ctx.results[0].after).toEqual(['return n;']);
  });

  it('refuses an empty query, a bad regex and a bad max', () => {
    for (const o of [{ query: ' ' }, { query: '(', regex: true }, { query: 'a', max: 0 }, { query: 'a', context: 99 }]) {
      expect(() => search(o)).toThrow(QueryError);
    }
  });

  it('text output groups hits by file and ends with the counts', () => {
    const text = formatSearch(search({ query: 'Payment declined' }));
    expect(text.split('\n')[0]).toBe('page.html');
    expect(text).toContain('(Pay.charge)');
    expect(text.split('\n').pop()).toBe('4 hits in 4 files searched, 2 skipped (1 binary, 1 too big)');
  });

  it('b680: a search with no hit gives the same result without the scan (full() never called)', () => {
    const base = { ...openQueryBase(repo), full: (): never => { throw new Error('the scan must not run'); } };
    for (const o of [{ query: 'zzzz-no-hit' }, { query: 'zz+-nothing', regex: true, context: 2 }, { query: 'Payment declined', ext: ['.py'] }]) {
      expect(searchContent(base, o)).toEqual(searchContent(loadQueryContext(repo), o));
    }
  });

  it('b680: with hits the scan runs once, and each hit still has its function and owner', () => {
    const opened = openQueryBase(repo);
    expect(opened.full()).toBe(opened.full());   // openQueryBase memo: one scan per base
    let calls = 0;
    const base = { ...opened, full: () => { calls++; return opened.full(); } };
    const r = searchContent(base, { query: 'Payment declined' });
    expect(calls).toBe(1);
    expect(r).toEqual(search({ query: 'Payment declined' }));
    expect(r.results.find((h) => h.file === 'pay.ts' && h.line === 3)).toMatchObject({ function: 'Pay.charge', owner: expect.any(String) });
  });
});

describe('CLI --json and MCP return the same object', () => {
  it('search', async () => {
    const cli = spawnSync(process.execPath, [CLI_JS, 'search', 'payment declined', '--repo', repo, '--json', '--context', '1', '--max', '3'], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const tool = buildTools(repo, {}).find((t) => t.name === 'search')!;
    const res = (await tool.handler({ query: 'payment declined', context: 1, max: 3 })) as { content: { text: string }[] };
    expect(res.content[0].text).toBe(cli.stdout.trimEnd());
    expect(JSON.parse(cli.stdout).truncated).toBe(true);
  });
});
