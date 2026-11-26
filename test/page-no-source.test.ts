// b914 / b61 slice 1: the page-build option noSource (no function or method source, no absolute repo path).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView, pageData, renderDataHtml, renderViewHtml, withoutSource } from '../src/page/html';
import { buildPageModel } from '../src/page/html';
import { forEachNode, viewRoots } from '../src/view/tree';
import type { ViewModel, ViewNode } from '../src/types';

const DATA_SCRIPT = /window\.C4PM_DATA = ([^\n]*);(?:<\/script>)?\n/;
const SECRET_LINE = '  const secretBodyLine = "do-not-share-this-line-9f3a";';

let tmp: string;
let model: ViewModel;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nosource-')));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), [
    'export function plain() {',
    SECRET_LINE,
    '  return secretBodyLine;',
    '}',
    'export class Box {',
    '  open() {',
    '    const inner = "method-body-line-77c1 </script> end";',
    '    return inner;',
    '  }',
    '}',
    '',
  ].join('\n'));
  ({ model } = buildPageModel({ repo: tmp }));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const nodesOf = (m: ViewModel): ViewNode[] => {
  const all: ViewNode[] = [];
  for (const [, root] of viewRoots(m)) forEachNode(root, (n) => { all.push(n); });
  return all;
};
const dataOf = (html: string): ViewModel => JSON.parse(html.match(DATA_SCRIPT)![1]);

describe('noSource (b914 / b61)', () => {
  it('the fixture has source on function and method nodes (so the other tests mean something)', () => {
    const withCode = nodesOf(model).filter((n) => n.code && n.code.length > 0);
    expect(withCode.some((n) => n.code!.join('\n').includes('secretBodyLine'))).toBe(true);
    expect(withCode.some((n) => n.code!.join('\n').includes('method-body-line-77c1'))).toBe(true);
  });

  it('withoutSource: no node of any view tree has code, nothing else changes, plan text stays, repoPath is empty', () => {
    const data = JSON.parse(JSON.stringify(pageData(model))) as ViewModel;
    const expected = JSON.parse(JSON.stringify(data)) as ViewModel;
    nodesOf(expected).forEach((n) => { delete n.code; });
    expected.repoPath = '';

    expect(withoutSource(data)).toBe(data);
    expect(nodesOf(data).some((n) => 'code' in n)).toBe(false);
    expect(data).toEqual(expected);
    expect(data.files).toEqual(model.files);   // files[].lines (plan text) are kept
  });

  it('renderViewHtml(model) is byte-equal to renderDataHtml of the page data (the default path)', () => {
    expect(renderViewHtml(model)).toBe(renderDataHtml(JSON.stringify(pageData(model))));
  });

  it('renderViewHtml(model, { noSource }): no code, no source line, no absolute path, still two scripts and no URL', () => {
    const html = renderViewHtml(model, { noSource: true });
    const data = dataOf(html);
    expect(nodesOf(data).some((n) => 'code' in n)).toBe(false);
    expect(html).not.toContain('do-not-share-this-line-9f3a');
    expect(html).not.toContain('method-body-line-77c1');
    expect(html).not.toContain(tmp);                       // the repo root appears nowhere
    expect(html).not.toMatch(/"repoPath":"\//);
    expect(data.repoPath).toBe('');
    expect(data.title).toBe(model.title);
    expect((html.match(/<script/g) ?? []).length).toBe(2);
    // no URL added by the option: the same http(s) literals as the complete page (the template's own, e.g. an svg namespace)
    expect(html.match(/https?:\/\/[^"' )]*/g)).toEqual(renderViewHtml(model).match(/https?:\/\/[^"' )]*/g));
  });

  it('the complete page keeps the source and the repo path', () => {
    const html = renderViewHtml(model);
    expect(html).toContain('do-not-share-this-line-9f3a');
    expect(dataOf(html).repoPath).toBe(tmp);
  });

  it('buildView(..., { noSource }).model still has code (the option affects the html only)', () => {
    const built = buildView({ repo: tmp }, { noSource: true });
    expect(nodesOf(built.model).some((n) => n.code && n.code.length > 0)).toBe(true);
    expect(built.model.repoPath).toBe(tmp);
    expect(built.html).not.toContain('do-not-share-this-line-9f3a');
  });

  it('a </script> in a source line: gone with noSource, escaped without it', () => {
    const full = renderViewHtml(model);
    expect(full).toContain('method-body-line-77c1');
    expect(full.match(DATA_SCRIPT)![1]).not.toMatch(/<[/!]/);
    const lean = renderViewHtml(model, { noSource: true });
    expect(lean).not.toContain('method-body-line-77c1');
    expect(lean.match(DATA_SCRIPT)![1]).not.toMatch(/<[/!]/);
  });
});
