import { TEST_NAME_SEP } from '../src/languages/typescript/tests';
import {
  STRUCTURE_SEP,
  findStructureNode,
  flattenStructure,
  nameStructure,
  readC4Structure,
  readJsonStructure,
  readMarkdownStructure,
  structureCandidates,
  structureReaderFor,
} from '../src/structure';
import type { StructureResult } from '../src/structure';

/** "<start>-<end> <kind> <full name>" for every node, parents first. */
const rows = (r: StructureResult): string[] =>
  flattenStructure(nameStructure(r.nodes)).map((n) => `${n.startLine}-${n.endLine} ${n.kind} ${n.name}`);

const JSON_SAMPLE = [
  '{',
  '  "name": "shop",',
  '  "scripts": {',
  '    "build": "tsc",',
  '    "test": "jest"',
  '  },',
  '  "files": [',
  '    "dist",',
  '    { "from": "a", "to": "b" }',
  '  ]',
  '}',
].join('\n');

const MD_SAMPLE = [
  '# Shop',
  '',
  'Intro.',
  '',
  '## Setup',
  '',
  '```sh',
  '# not a heading',
  '```',
  '',
  '### Install ###',
  '',
  'Text',
  '===',
  '',
  '## Use',
].join('\n');

const C4_SAMPLE = [
  'model {',
  "  shop = system 'Shop' {",
  "    api = container 'API' {",
  "      orders = component 'Orders' {",
  "        test 'orders api' {",
  "          case 'c1'",
  '        }',
  '      }',
  '    }',
  '  }',
  '  extend shop.api {',
  "    pay = component 'Pay'",
  '  }',
  '}',
].join('\n');

describe('readJsonStructure', () => {
  it('lists keys nested, object array elements as [i]', () => {
    const r = readJsonStructure(JSON_SAMPLE, 'conf/app.json');
    expect(r.parseError).toBe(false);
    expect(rows(r)).toEqual([
      '2-2 key name',
      '3-6 key scripts',
      '4-4 key scripts › build',
      '5-5 key scripts › test',
      '7-10 key files',
      '9-9 key files › [1]',
      '9-9 key files › [1] › from',
      '9-9 key files › [1] › to',
    ]);
  });

  it('numbers duplicate sibling keys', () => {
    expect(rows(readJsonStructure('{\n  "name": "a",\n  "name": "b"\n}', 'x.json'))).toEqual(['2-2 key name', '3-3 key name#2']);
  });

  it.each<[string, string, boolean, string[] | null]>([
    ['truncated', '{\n  "a": 1,\n  "b": {\n', true, ['2-2 key a', '3-3 key b']],
    ['missing comma', '{ "a": 1 "b": 2 }', true, null],
    ['comment and trailing comma', '{\n  // c\n  "a": 1,\n}\n', false, ['3-3 key a']],
    ['array root', '[\n  { "x": 1 },\n  2,\n  [ { "y": 1 } ]\n]\n', false, ['2-2 key [0]', '2-2 key [0] › x']],
    ['scalar root', '42\n', false, []],
    ['empty', '', false, []],
    ['CRLF', '{\r\n  "a": {\r\n    "b": 1\r\n  }\r\n}\r\n', false, ['2-4 key a', '3-3 key a › b']],
  ])('%s', (_label, text, parseError, expected) => {
    const r = readJsonStructure(text, 'x.json');
    expect(r.parseError).toBe(parseError);
    if (expected) expect(rows(r)).toEqual(expected);
  });
});

describe('readMarkdownStructure', () => {
  it('nests ATX headings, skips fences and setext', () => {
    expect(rows(readMarkdownStructure(MD_SAMPLE))).toEqual([
      '1-16 heading Shop',
      '5-15 heading Shop › Setup',
      '11-15 heading Shop › Setup › Install',
      '16-16 heading Shop › Use',
    ]);
  });

  it('skips front matter, hashtags, empty headings, indented code, tilde fences; closing hashes dropped', () => {
    const text = '---\ntitle: x\n# not\n---\n# A\n#hashtag\n#\n## B\ntext\n## B\n    # indented code\n~~~\n## in tilde\n~~~\n## C ##\n';
    expect(rows(readMarkdownStructure(text))).toEqual([
      '5-15 heading A',
      '8-9 heading A › B',
      '10-14 heading A › B#2',
      '15-15 heading A › C',
    ]);
  });

  it('reads a text without a top heading', () => {
    expect(rows(readMarkdownStructure('intro\n## One\n### Two\n# Top\n'))).toEqual([
      '2-3 heading One',
      '3-3 heading One › Two',
      '4-4 heading Top',
    ]);
  });
});

describe('readC4Structure', () => {
  it('lists elements nested, test blocks as kind test, extend under its parent', () => {
    const r = readC4Structure(C4_SAMPLE, 'plan/shop.c4');
    expect(r.parseError).toBe(false);
    expect(rows(r)).toEqual([
      '2-10 system shop',
      '3-9 container shop › api',
      '4-8 component shop › api › orders',
      '5-7 test shop › api › orders › orders api',
      '12-12 component shop › api › pay',
    ]);
  });

  it('keeps an element extending another file as a top node', () => {
    const r = readC4Structure("model {\n  extend x.y {\n    z = component 'Z'\n  }\n}\n", 'x.c4');
    expect(rows(r)).toEqual(['3-3 component z']);
  });

  it('reports a parse issue and keeps what was read', () => {
    const r = readC4Structure('model {\n  a = component "A" {\n    description "x"\n', 'x.c4');
    expect(r.parseError).toBe(true);
    expect(rows(r)).toEqual(['2-3 component a']);
  });
});

describe('structureReaderFor', () => {
  it.each<[string, unknown]>([
    ['a/b.json', readJsonStructure],
    ['README.MD', readMarkdownStructure],
    ['x.c4', readC4Structure],
    ['x.ts', null],
    ['Makefile', null],
    ['docs/', null],
    ['x.constructor', null],
  ])('%s', (file, expected) => {
    expect(structureReaderFor(file)).toBe(expected);
  });
});

describe('structure lookup', () => {
  const named = nameStructure(readJsonStructure(JSON_SAMPLE, 'x.json').nodes);

  it('finds a node by full name, ASCII > accepted, bare leaf not resolved', () => {
    expect(findStructureNode(named, 'files › [1] › to')?.startLine).toBe(9);
    expect(findStructureNode(named, 'files > [1] > to')?.name).toBe('files › [1] › to');
    expect(findStructureNode(named, 'to')).toBeUndefined();
    expect(findStructureNode(named, 'name#2')).toBeUndefined();
  });

  it('lists candidates by last part', () => {
    expect(structureCandidates(named, 'to')).toEqual(['files › [1] › to']);
    expect(structureCandidates(named, 'x > test')).toEqual(['scripts › test']);
  });

  it('uses the same separator as test-case names', () => {
    expect(STRUCTURE_SEP).toBe(TEST_NAME_SEP);
  });
});
