import { cmp, didYouMean, levenshtein, optionFlag, splitLines } from '../src/util/text';
import { SET_ALLOWED_KEYS } from '../src/services/planOps';
import { unifiedDiff, renderUnified } from '../src/c4/textDiff';
import { unifiedDeleteDiff } from '../src/c4/removeElement';

describe('cmp', () => {
  it('orders by code unit, not locale', () => {
    expect(cmp('a', 'b')).toBe(-1);
    expect(cmp('b', 'a')).toBe(1);
    expect(cmp('a', 'a')).toBe(0);
    expect(cmp('B', 'a')).toBe(-1);
    expect(['b', 'B', 'a'].sort(cmp)).toEqual(['B', 'a', 'b']);
  });
});

describe('splitLines', () => {
  it.each([
    ['', [], []],
    ['a', ['a'], ['a']],
    ['a\n', ['a\n'], ['a']],
    ['a\nb', ['a\n', 'b'], ['a', 'b']],
    ['a\r\nb\r\n', ['a\r\n', 'b\r\n'], ['a', 'b']],
    ['\n', ['\n'], ['']],
    ['a\n\n', ['a\n', '\n'], ['a', '']],
  ])('%j', (text, keep, strip) => {
    expect(splitLines(text)).toEqual(keep);
    expect(splitLines(text, { keepEol: true }).join('')).toBe(text);
    expect(splitLines(text, { keepEol: false })).toEqual(strip);
  });
});

describe('levenshtein', () => {
  it('kitten/sitting is 3, equal is 0, empty vs abc is 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('didYouMean (b219)', () => {
  const BULK = ['ref', 'title', 'kind', 'status', 'owner', 'parent', 'parentRef', 'dependsOn', 'dependsOnRefs', 'links', 'tags', 'start', 'due', 'group', 'description', 'docs', 'outcome', 'size', 'sprint', 'priority'];
  it.each<[string, readonly string[], string | undefined]>([
    ['tag', BULK, 'tags'],
    ['depends', BULK, 'dependsOn'],
    ['link', BULK, 'links'],
    ['doc', BULK, 'docs'],
    ['parent_ref', BULK, 'parentRef'],
    ['desc', BULK, 'description'],
    ['Tags', BULK, 'tags'],
    ['zzz', BULK, undefined],
    ['state', BULK, undefined],
    ['deps', BULK, undefined],
    ['mystery', BULK, undefined],
    ['stauts', SET_ALLOWED_KEYS, 'status'],
    ['owners', SET_ALLOWED_KEYS, 'owner'],
    ['priorty', SET_ALLOWED_KEYS, 'priority'],
    ['tech', SET_ALLOWED_KEYS, 'technology'],
    ['color', SET_ALLOWED_KEYS, undefined],
    ['uid', SET_ALLOWED_KEYS, undefined],
    ['ab', ['ax', 'ay'], 'ax'],   // a tie: the first choice wins
    ['item', ['items'], 'items'],
  ])('%s -> %s', (input, choices, expected) => {
    expect(didYouMean(input, choices)).toBe(expected);
  });
});

describe('optionFlag (b440)', () => {
  it('turns a Commander key into the flag the user types', () => {
    expect(optionFlag('appendDescriptionFile')).toBe('--append-description-file');
    expect(optionFlag('tags')).toBe('--tags');
  });
});

describe('unifiedDeleteDiff is renderUnified of the same edit script', () => {
  const lines = ['1\n', '2\n', '3\n', '4\n', '5\n', '6\n', '7\n', '8\n', '9\n', '10'];
  it.each([
    [[0]], [[3]], [[9]], [[1, 2]], [[0, 8]], [[0, 9]], [[2, 4, 9]], [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], [[]], [[-1, 99]],
  ])('deleted %j', del => {
    const kept = lines.filter((_, i) => !del.includes(i));
    const out = unifiedDeleteDiff('f.c4', lines, new Set(del));
    if (out === '') { expect(kept.length === lines.length).toBe(true); return; }
    // every deleted line shows as a '-' line; context lines are untouched
    const minus = out.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(minus.length).toBe(del.filter(i => i >= 0 && i < lines.length).length);
    expect(out.startsWith('--- a/f.c4\n+++ b/f.c4\n')).toBe(true);
  });

  it('matches unifiedDiff when the deleted line is unique', () => {
    const del = new Set([4]);
    const kept = lines.filter((_, i) => !del.has(i)).join('');
    expect(unifiedDeleteDiff('f', lines, del)).toBe(unifiedDiff('f', lines.join(''), kept));
  });

  it('marks a missing final newline', () => {
    expect(unifiedDeleteDiff('f', ['a\n', 'b'], new Set([0]))).toBe('--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n-a\n b\n\\ No newline at end of file\n');
  });

  it('delete everything gives +0,0', () => {
    expect(unifiedDeleteDiff('f', ['a\n'], new Set([0]))).toBe('--- a/f\n+++ b/f\n@@ -1,1 +0,0 @@\n-a\n');
  });
});

describe('unifiedDiff', () => {
  it('is empty for equal texts and for no-change ops', () => {
    expect(unifiedDiff('f', 'a\n', 'a\n')).toBe('');
    expect(renderUnified('f', [{ t: ' ', line: 'a\n' }])).toBe('');
  });
  it('shows a CRLF to LF change as a change', () => {
    expect(unifiedDiff('f', 'a\r\n', 'a\n')).toContain('-a\r\n');
  });
});
