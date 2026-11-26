import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext, openQueryBase } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { outlineFile } from '../src/query/find';
import { formatOutline, formatShow } from '../src/query/format';
import { showTarget } from '../src/query/show';

// b683 slice 3: outline / show answer .json, .md and .c4 files from their structure readers, without the scan.

const APP_JSON = [
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
  '',
].join('\n');

const GUIDE_MD = [
  '# Shop', '', 'Intro.', '', '## Setup', '', '```sh', '# not a heading', '```', '', '### Install ###', '', 'Text', '===', '', '## Use', '',
].join('\n');

const SHOP_C4 = [
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
  '',
].join('\n');

const UNASSIGNED = { id: 'unassigned', title: 'Unassigned', kind: 'unassigned' };

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-structure-'));
  for (const [rel, text] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text);
  }
  return fs.realpathSync(dir);
}

function catchQueryError(fn: () => unknown): QueryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QueryError);
    return err as QueryError;
  }
  throw new Error('expected QueryError');
}

const noScanOf = (base: ReturnType<typeof openQueryBase>): ReturnType<typeof openQueryBase> => ({
  ...base,
  full: (): never => {
    throw new Error('the scan must not run');
  },
});

describe('b683: outline / show of .json, .md and .c4 files', () => {
  let root: string;
  let noScan: ReturnType<typeof openQueryBase>;

  beforeAll(() => {
    root = tempRepo({ 'conf/app.json': APP_JSON, 'doc/guide.md': GUIDE_MD, 'src/a.ts': 'export function f() { return 1; }\n' });
    fs.mkdirSync(path.join(root, 'conf/dir.json'));
    noScan = noScanOf(openQueryBase(root));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('outline of a .json file: keys, nested keys, [i] for object elements', () => {
    const r = outlineFile(noScan, 'conf/app.json');
    expect(r).toEqual({ path: 'conf/app.json', lineCount: 11, parseError: false, elements: expect.any(Array) });
    expect(r.elements.map((e) => [e.name, e.kind, e.startLine, e.endLine])).toEqual([
      ['name', 'key', 2, 2], ['scripts', 'key', 3, 6], ['files', 'key', 7, 10],
    ]);
    expect(r.elements[1]).toEqual({
      name: 'scripts', kind: 'key', startLine: 3, endLine: 6, lineCount: 4, owner: UNASSIGNED,
      children: [
        { name: 'scripts › build', kind: 'key', startLine: 4, endLine: 4, lineCount: 1, owner: UNASSIGNED },
        { name: 'scripts › test', kind: 'key', startLine: 5, endLine: 5, lineCount: 1, owner: UNASSIGNED },
      ],
    });
    expect(r.elements[2].children?.map((c) => c.name)).toEqual(['files › [1]']);
  });

  it('outline text of a .md file; a .c4 file shows plan kinds, tests and extend nesting', () => {
    expect(formatOutline(outlineFile(noScan, 'doc/guide.md'))).toBe([
      'doc/guide.md  16 lines',
      '  1-16  heading  Shop  [Unassigned]',
      '    5-15  heading  Shop › Setup  [Unassigned]',
      '      11-15  heading  Shop › Setup › Install  [Unassigned]',
      '    16  heading  Shop › Use  [Unassigned]',
    ].join('\n'));
    const dir = tempRepo({ 'plan/shop.c4': SHOP_C4 });
    try {
      const text = formatOutline(outlineFile(noScanOf(openQueryBase(dir)), 'plan/shop.c4'));
      expect(text).toBe([
        'plan/shop.c4  14 lines',
        '  2-10  system  shop  [Unassigned]',
        '    3-9  container  shop › api  [Unassigned]',
        '      4-8  component  shop › api › orders  [Unassigned]',
        '        5-7  test  shop › api › orders › orders api  [Unassigned]',
        '      12  component  shop › api › pay  [Unassigned]',
      ].join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['conf/app.json#scripts › test', 'conf/app.json#scripts > test'])('show %s', (target) => {
    const r = showTarget(noScan, target);
    expect(r).toEqual({
      path: 'conf/app.json', targetKind: 'element', name: 'scripts › test', elementKind: 'key', startLine: 5, endLine: 5, totalLines: 11,
      owner: UNASSIGNED, code: ['    "test": "jest"'], truncated: false,
    });
    expect(formatShow(r)).toBe('conf/app.json:5  key  scripts › test  [Unassigned]\n  5      "test": "jest"');
  });

  it('show: whole file, a range, maxLines, a heading section', () => {
    const whole = showTarget(noScan, 'conf/app.json');
    expect([whole.targetKind, whole.startLine, whole.endLine, whole.name]).toEqual(['file', 1, 11, undefined]);
    const range = showTarget(noScan, 'conf/app.json#L3-L4');
    expect([range.targetKind, range.code]).toEqual(['range', ['  "scripts": {', '    "build": "tsc",']]);
    const cut = showTarget(noScan, 'conf/app.json#scripts', { maxLines: 2 });
    expect([cut.code.length, cut.truncated]).toEqual([2, true]);
    const h = showTarget(noScan, 'doc/guide.md#Shop › Setup › Install');
    expect([h.startLine, h.endLine, h.elementKind]).toEqual([11, 15, 'heading']);
  });

  it('refusals', () => {
    const bare = catchQueryError(() => showTarget(noScan, 'conf/app.json#test'));
    expect([bare.code, bare.message, bare.candidates]).toEqual([
      'not-found', "No key, heading or plan element 'test' in 'conf/app.json'", ['scripts › test'],
    ]);
    for (const run of [() => showTarget(noScan, 'conf/nope.json'), () => outlineFile(noScan, 'conf/nope.json'), () => showTarget(noScan, 'conf/dir.json')]) {
      expect(catchQueryError(run).code).toBe('not-found');
    }
    expect(catchQueryError(() => showTarget(noScan, 'conf/nope.json')).message).toBe("File 'conf/nope.json' does not exist");
    expect(catchQueryError(() => showTarget(noScan, '../x.json')).code).toBe('out-of-repo');
    expect(catchQueryError(() => showTarget(noScan, 'conf/app.json#L0')).code).toBe('invalid');
    const past = catchQueryError(() => showTarget(noScan, 'conf/app.json#L20'));
    expect([past.code, past.message]).toEqual(['invalid', "Range starts at line 20 but 'conf/app.json' has 11 lines"]);
  });

  it('same answer with and without the scan', () => {
    const ctx = loadQueryContext(root);
    expect(outlineFile(ctx, 'doc/guide.md')).toEqual(outlineFile(noScan, 'doc/guide.md'));
    expect(showTarget(ctx, 'conf/app.json#name')).toEqual(showTarget(noScan, 'conf/app.json#name'));
  });

  it('a source file still scans', () => {
    expect(() => showTarget(noScan, 'src/a.ts')).toThrow('the scan must not run');
    expect(() => outlineFile(noScan, 'src/a.ts')).toThrow('the scan must not run');
  });

  it('a plan file outside the repo is read; another file outside is refused', () => {
    const top = tempRepo({
      'Project/src/a.ts': 'export function f() { return 1; }\n',
      'arch/plan/plan.c4': `specification {\n  element system\n  element container\n  element component\n}\n${SHOP_C4}`,
      'arch/plan/notes.json': '{}\n',
    });
    try {
      const base = noScanOf(openQueryBase(path.join(top, 'Project'), { cli: { architectureDir: '../arch/plan' } }));
      const plan = base.planView().plan!;
      expect(plan.files).toEqual(['../arch/plan/plan.c4']);
      const outline = outlineFile(base, '../arch/plan/plan.c4');
      expect(outline.elements[0].name).toBe('shop');
      const orders = plan.elements.find((e) => e.id === 'shop.api.orders')!;
      const shown = showTarget(base, '../arch/plan/plan.c4#shop › api › orders');
      expect([shown.elementKind, shown.startLine, shown.endLine]).toEqual(['component', orders.source.line, orders.source.endLine]);
      expect(catchQueryError(() => showTarget(base, '../arch/plan/notes.json')).code).toBe('out-of-repo');
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  });
});
