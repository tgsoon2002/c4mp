import { parseBoard } from '../src/board/parse';
import { serializeBoard } from '../src/board/serialize';
import { checkBoard } from '../src/board/check';
import { boardDocProblem } from '../src/board/docs';
import { attachBoard } from '../src/board/view';
import { editList, joinDescription, sameDoc } from '../src/board/fields';
import { BOARD_KINDS, BOARD_DESCRIPTION_MAX, BOARD_OUTCOME_MAX } from '../src/constants';
import type { BoardFile, BoardItem, ViewModel } from '../src/types';

// B41: description, docs, outcome, size (all optional) and the kinds decision / question.
const base = { id: 'b1', title: 'T', kind: 'task', status: 'planned' };
const text = (extra: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, boards: [{ id: 'm', name: 'M', items: [{ ...base, ...extra }] }] });
const item = (extra: Partial<BoardItem> = {}): BoardItem => ({ ...base, dependsOn: [], links: [], tags: [], ...extra });
const file = (i: BoardItem): BoardFile => ({ schemaVersion: 1, boards: [{ id: 'm', name: 'M', items: [i] }] });
const rules = (i: BoardItem, fileExists?: (p: string) => boolean) =>
  checkBoard(file(i), null, { today: '2026-10-21', fileExists }).map((f) => `${f.severity}:${f.rule}`);

describe('kinds', () => {
  it('decision and question are kinds', () => {
    expect(BOARD_KINDS).toEqual(expect.arrayContaining(['decision', 'question']));
    expect(rules(item({ kind: 'decision' }))).toEqual([]);
  });
});

describe('parse: new fields', () => {
  it('keeps them as written (description multi-line, untrimmed) with no issues', () => {
    const r = parseBoard(text({ description: 'line1\n  line2\n', outcome: 'abc123', size: 'M', docs: [{ label: 'Plan', path: 'docs/a.md' }, { url: 'https://x.dev/y' }] }));
    expect(r.issues).toEqual([]);
    expect(r.data!.boards[0].items[0]).toMatchObject({
      description: 'line1\n  line2\n', outcome: 'abc123', size: 'M',
      docs: [{ label: 'Plan', path: 'docs/a.md' }, { url: 'https://x.dev/y' }],
    });
  });

  it.each([
    ['description number', { description: 3 }, /items\[0\]\.description: must be a string/],
    ['outcome object', { outcome: {} }, /items\[0\]\.outcome: must be a string/],
    ['size number', { size: 1 }, /items\[0\]\.size: must be a string/],
    ['docs not array', { docs: 'x' }, /items\[0\]\.docs: must be an array/],
    ['doc not object', { docs: ['x'] }, /items\[0\]\.docs\[0\]: doc dropped/],
    ['doc path number', { docs: [{ path: 4 }] }, /items\[0\]\.docs\[0\]\.path: must be a string/],
    ['doc unknown key', { docs: [{ path: 'a', color: 'r' }] }, /items\[0\]\.docs\[0\]: unknown key 'color'/],
  ])('%s -> one issue pointing at the path', (_n, extra, re) => {
    const r = parseBoard(text(extra));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(re);
  });

  it('empty values are absent', () => {
    const it0 = parseBoard(text({ description: '  ', outcome: '', size: ' ', docs: [] })).data!.boards[0].items[0];
    expect(it0.description).toBeUndefined();
    expect(it0.outcome).toBeUndefined();
    expect(it0.size).toBeUndefined();
    expect(it0.docs).toBeUndefined();
  });
});

describe('tolerant parser: unknown item keys', () => {
  it('is a note (not an issue), kept in item.extra, re-written after the known keys, round-trips', () => {
    const t = text({ color: 'red', nested: { a: [1] } });
    const r = parseBoard(t);
    expect(r.issues).toEqual([]);
    expect(r.notes.map((n) => n.message)).toEqual([
      "boards[0].items[0]: unknown key 'color' (kept as written)",
      "boards[0].items[0]: unknown key 'nested' (kept as written)",
    ]);
    const out = serializeBoard(r.data!);
    const o = JSON.parse(out).boards[0].items[0];
    expect(Object.keys(o).slice(-2)).toEqual(['color', 'nested']);
    expect(o.nested).toEqual({ a: [1] });
    expect(serializeBoard(parseBoard(out).data!)).toBe(out);
  });
});

describe('serialize: new fields', () => {
  it('keys go last in the documented order; round trip is stable', () => {
    const i = item({ group: 'g', size: 'L', outcome: 'o', docs: [{ url: 'https://a.b', label: 'L', }, { path: 'p.md' }], description: 'd' });
    const out = serializeBoard(file(i));
    const obj = JSON.parse(out).boards[0].items[0];
    expect(Object.keys(obj)).toEqual(['id', 'title', 'kind', 'status', 'dependsOn', 'links', 'tags', 'group', 'description', 'docs', 'outcome', 'size']);
    expect(Object.keys(obj.docs[0])).toEqual(['label', 'url']);
    expect(serializeBoard(parseBoard(out).data!)).toBe(out);
  });

  it('absent or empty -> no keys; an old file re-serializes byte-identically', () => {
    const old = serializeBoard(file(item({ owner: 'kim', tags: ['a'] })));
    expect(old).not.toMatch(/description|docs|outcome|size/);
    expect(serializeBoard(parseBoard(old).data!)).toBe(old);
    expect(serializeBoard(file(item({ docs: [], description: '' })))).toBe(serializeBoard(file(item())));
  });
});

describe('check: new fields', () => {
  it.each<[string, Partial<BoardItem>, string[]]>([
    ['good size', { size: 'XL' }, []],
    ['bad size', { size: 'XXL' }, ['warning:board-invalid-field']],
    ['lower-case size is bad', { size: 'm' }, ['warning:board-invalid-field']],
    ['description at limit', { description: 'x'.repeat(BOARD_DESCRIPTION_MAX) }, []],
    ['description over limit', { description: 'x'.repeat(BOARD_DESCRIPTION_MAX + 1) }, ['warning:board-invalid-field']],
    ['outcome over limit', { outcome: 'x'.repeat(BOARD_OUTCOME_MAX + 1) }, ['warning:board-invalid-field']],
    ['doc with both', { docs: [{ path: 'a.md', url: 'https://a.b' }] }, ['warning:board-invalid-field']],
    ['doc with neither', { docs: [{ label: 'x' }] }, ['warning:board-invalid-field']],
    ['absolute path', { docs: [{ path: '/etc/passwd' }] }, ['warning:board-invalid-field']],
    ['dotdot path', { docs: [{ path: 'a/../../b' }] }, ['warning:board-invalid-field']],
    ['ftp url', { docs: [{ url: 'ftp://a.b/x' }] }, ['warning:board-invalid-field']],
    ['javascript url', { docs: [{ url: 'javascript:alert(1)' }] }, ['warning:board-invalid-field']],
    ['good docs, no fileExists given', { docs: [{ path: 'docs/a.md' }, { url: 'http://a.b' }] }, []],
  ])('%s', (_n, extra, expected) => {
    expect(rules(item(extra))).toEqual(expected);
  });

  it('board-doc-missing is info and only when fileExists says no', () => {
    const i = item({ docs: [{ path: 'docs/here.md' }, { path: 'docs/gone.md' }, { url: 'https://a.b' }] });
    expect(rules(i, (p) => p === 'docs/here.md')).toEqual(['info:board-doc-missing']);
    expect(rules(i, () => true)).toEqual([]);
  });

  it('boardDocProblem accepts plain relative paths and https', () => {
    expect(boardDocProblem({ path: 'Document/a b.md' })).toBeNull();
    expect(boardDocProblem({ url: 'https://example.com/x?y=1' })).toBeNull();
  });
});

describe('view: new fields reach ViewBoardItem', () => {
  it('copies fields and docs (docs is a copy)', () => {
    const data = file(item({ description: 'd', outcome: 'o', size: 'S', docs: [{ path: 'a.md' }] }));
    const m = { root: { id: 'system', kind: 'system', name: 'S', detail: '', weight: 1, children: [] } } as unknown as ViewModel;
    const out = attachBoard(m, data, []).board!.boards[0].items[0];
    expect(out).toMatchObject({ description: 'd', outcome: 'o', size: 'S', docs: [{ path: 'a.md' }] });
    out.docs![0].path = 'changed';
    expect(data.boards[0].items[0].docs![0].path).toBe('a.md');
    const plain = attachBoard(m, file(item()), []).board!.boards[0].items[0];
    expect('docs' in plain).toBe(false);
  });
});

describe('joinDescription (b440)', () => {
  it.each<[string | undefined, string, 'append' | 'prepend', string]>([
    [undefined, 'new', 'append', 'new'],
    ['  \n', 'new', 'prepend', 'new'],
    ['old', 'new', 'append', 'old\n\nnew'],
    ['old', 'new', 'prepend', 'new\n\nold'],
    ['old\n\n', '\n\nnew\n', 'append', 'old\n\nnew'],
    ['a\nb', 'c', 'append', 'a\nb\n\nc'],
  ])('%j + %j (%s) -> %j', (old, added, mode, expected) => {
    expect(joinDescription(old, added, mode)).toBe(expected);
  });
});

describe('editList (b441)', () => {
  it('adds new values once, keeps existing ones and their order', () => {
    expect(editList(['a', 'b'], ['b', 'c', 'c'], [])).toEqual({ list: ['a', 'b', 'c'], missing: [], clash: [] });
  });
  it('removes present values; an absent one is listed as missing', () => {
    expect(editList(['a', 'b', 'c'], [], ['b', 'zz'])).toEqual({ list: ['a', 'c'], missing: ['zz'], clash: [] });
  });
  it('a value both added and removed is a clash', () => {
    expect(editList(['a'], ['x'], ['x']).clash).toEqual(['x']);
  });
  it('a custom same matches documents by path, the label ignored', () => {
    const r = editList([{ label: 'Spec', path: 'docs/a.md' }, { url: 'https://x.y' }], [{ path: 'docs/a.md' }], [{ label: 'Other', url: 'https://x.y' }], sameDoc);
    expect(r).toEqual({ list: [{ label: 'Spec', path: 'docs/a.md' }], missing: [], clash: [] });
  });
  it('does not change its inputs', () => {
    const cur = ['a', 'b'];
    const add = ['c'];
    const rem = ['a'];
    editList(cur, add, rem);
    expect([cur, add, rem]).toEqual([['a', 'b'], ['c'], ['a']]);
  });
});
