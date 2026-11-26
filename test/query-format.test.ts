import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import { depsOf } from '../src/query/deps';
import { QueryError } from '../src/query/errors';
import { findElements, outlineFile } from '../src/query/find';
import type { FileOutlineResult, FindResult } from '../src/query/find';
import {
  errorJson,
  formatDeps,
  formatError,
  formatFind,
  formatJson,
  formatOutline,
  formatShow,
  jsonOf,
} from '../src/query/format';
import { showTarget } from '../src/query/show';
import type { ShowResult } from '../src/query/show';

const FIX = path.join(__dirname, 'fixtures');
const owner = { id: 'orders', title: 'Orders', kind: 'component' as const };

describe('format: hand-built results', () => {
  const find: FindResult = {
    results: [
      { path: 'src/a.ts', name: 'createOrder', kind: 'function', startLine: 10, endLine: 23, lineCount: 14, stub: 'todo' as never, owner },
      { path: 'src/a.ts', name: 'x', kind: 'function', startLine: 5, endLine: 5, lineCount: 1, owner },
      { path: 'src/a.ts', name: 'src/a.ts', kind: 'file', owner },
    ],
    total: 7,
    truncated: true,
  };
  const show: ShowResult = {
    path: 'src/a.ts', targetKind: 'element', name: 'f', elementKind: 'function', startLine: 9, endLine: 11,
    totalLines: 50, owner, how: { mode: 'claim', claim: { kind: 'file' as never, link: '../../src/a.ts', path: 'src/a.ts', planFile: 'p.c4', elementId: 'orders' } },
    code: ['a', '  b', 'c'], truncated: true,
  };
  const outline: FileOutlineResult = {
    path: 'src/a.ts', lineCount: 30, parseError: false,
    elements: [{
      name: 'K', kind: 'class', startLine: 1, endLine: 20, lineCount: 20, owner,
      children: [{ name: 'K.m', kind: 'method', startLine: 3, endLine: 8, lineCount: 6, owner }],
    }],
  };

  it.each([
    ['find truncated', () => formatFind(find), [
      'src/a.ts:10-23  function  createOrder  [Orders]  todo',
      'src/a.ts:5  function  x  [Orders]',
      'src/a.ts  file  [Orders]',
      '... truncated, showing 3 of 7; raise --limit (max 100) or narrow the query',
    ]],
    ['find empty', () => formatFind({ results: [], total: 0, truncated: false }), ['no results']],
    ['outline', () => formatOutline(outline), [
      'src/a.ts  30 lines',
      '  1-20  class  K  [Orders]',
      '    3-8  method  K.m  [Orders]',
    ]],
    ['outline flags', () => formatOutline({ path: 'b.md', lineCount: 2, parseError: true, fileOnly: true, elements: [] }), [
      'b.md  2 lines  parse error  file only',
      '  no elements',
    ]],
    ['show truncated', () => formatShow(show), [
      'src/a.ts:9-11  function  f  [Orders]  (claim file src/a.ts)',
      '   9  a',
      '  10    b',
      '  11  c',
      '... truncated, 50 lines in total',
    ]],
    ['show empty range', () => formatShow({ ...show, targetKind: 'file', name: undefined, elementKind: undefined, how: undefined, startLine: 1, endLine: 0, code: [], truncated: false }), [
      'src/a.ts  file  [Orders]',
    ]],
    ['deps', () => formatDeps({
      id: 'web', title: 'Web', level: 'component', resolvedFrom: 'id',
      uses: [{ id: 'api', title: 'Api', weight: 2 }], usedBy: [],
      declared: [{ from: 'web', to: 'api', label: 'calls', source: { file: 'a.c4', line: 3 } }],
      unresolvedDeclared: [{ from: 'web', to: 'zzz', reason: 'endpoint not found in the map' }],
    }), [
      'web  component  Web  (resolved from id)',
      'uses:',
      '  api  Api  x2',
      'used by: none',
      'declared:',
      '  web -> api  "calls"  a.c4:3',
      'unresolved:',
      '  web -> zzz  endpoint not found in the map',
    ]],
    ['error with candidates', () => formatError(new QueryError('ambiguous', 'matches 2', ['a | A | component', 'b | B | component'])), [
      'error: ambiguous: matches 2',
      '  a | A | component',
      '  b | B | component',
    ]],
    ['error plain', () => formatError(new QueryError('out-of-repo', "Target '../x' is outside the repository")), [
      "error: out-of-repo: Target '../x' is outside the repository",
    ]],
  ])('%s', (_name, run, lines) => {
    expect(run()).toBe(lines.join('\n'));
  });

  it('json is exactly the result, on one line, round-trips', () => {
    expect(jsonOf(find)).toBe(find);
    const text = formatJson(find);
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(find)));
  });

  it('errorJson keeps code, message and candidates verbatim', () => {
    const e = new QueryError('not-found', 'no element matches "q"', ['one', 'two']);
    expect(errorJson(e)).toEqual({ error: { code: 'not-found', message: 'no element matches "q"', candidates: ['one', 'two'] } });
    expect(errorJson(new QueryError('invalid', 'bad'))).toEqual({ error: { code: 'invalid', message: 'bad' } });
  });
});

describe('format: real results', () => {
  const sample = loadQueryContext(path.join(FIX, 'sample'));
  const level4 = loadQueryContext(path.join(FIX, 'level4'));

  it('find rows follow the grammar and every row is one line', () => {
    const r = findElements(sample, { query: 'order', limit: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    const lines = formatFind(r).split('\n');
    expect(lines.slice(0, r.results.length)).toHaveLength(r.results.length);
    for (const l of lines.slice(0, r.results.length)) expect(l).toMatch(/^\S+(:\d+(-\d+)?)?  (function|class|method|type|file)  /);
    if (r.truncated) expect(lines[lines.length - 1]).toMatch(/^\.\.\. truncated, showing 5 of \d+;/);
  });

  it('outline lists every element of a real file', () => {
    const r = outlineFile(sample, 'api/src/services/orderService.ts');
    const text = formatOutline(r);
    expect(text.split('\n')[0]).toBe(`${r.path}  ${r.lineCount} lines`);
    expect(text).toContain('class  OrderService');
    expect(text).toMatch(/\n {4}\d+(-\d+)?  method  OrderService\.create/);
  });

  it('show prints the numbered real source lines', () => {
    const r = showTarget(sample, 'api/src/services/orderService.ts#OrderService.create');
    const lines = formatShow(r).split('\n');
    expect(lines[0]).toContain(`${r.path}:${r.startLine}-${r.endLine}`);
    expect(lines).toHaveLength(1 + r.code.length + 1);
    expect(lines[lines.length - 1]).toBe('tests:     none');   // T26-11: an element's tests follow its code
    expect(lines[1]).toMatch(new RegExp(`^ +${r.startLine}  `));
    expect(lines[1].endsWith(r.code[0])).toBe(true);
  });

  it('show truncation line appears with maxLines', () => {
    const r = showTarget(sample, 'api/src/services/orderService.ts', { maxLines: 2 });
    const lines = formatShow(r).split('\n');
    expect(r.truncated).toBe(true);
    expect(lines[lines.length - 1]).toBe(`... truncated, ${r.totalLines} lines in total`);
  });

  it('deps of a real component lists its edges', () => {
    const r = depsOf(level4, 'billing');
    const text = formatDeps(r);
    expect(text.split('\n')[0]).toBe(`${r.id}  ${r.level}  ${r.title}  (resolved from ${r.resolvedFrom})`);
    for (const e of [...r.uses, ...r.usedBy]) expect(text).toContain(`${e.id}  ${e.title}  x${e.weight}`);
  });

  it('a real QueryError is reported verbatim with candidates', () => {
    let err: unknown;
    try {
      depsOf(sample, 'no-such-thing-zzz');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryError);
    const q = err as QueryError;
    const text = formatError(q);
    expect(text.split('\n')[0]).toBe(`error: ${q.code}: ${q.message}`);
    expect(text.split('\n').slice(1)).toEqual((q.candidates ?? []).map((c) => `  ${c}`));
  });
});
