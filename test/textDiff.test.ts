import { unifiedDiff } from '../src/c4/textDiff';

// P18-T2: generic unified diff. Data driven: [name, old, new, expected].
const lines = (...l: string[]) => l.join('\n') + '\n';

const CASES: [string, string, string, string][] = [
  ['no change', lines('a', 'b'), lines('a', 'b'), ''],
  [
    'insert',
    lines('a', 'b', 'c'),
    lines('a', 'x', 'b', 'c'),
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n',
  ],
  [
    'replace',
    lines('a', 'b', 'c'),
    lines('a', 'B', 'c'),
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
  ],
  [
    'delete',
    lines('a', 'b', 'c'),
    lines('a', 'c'),
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,3 +1,2 @@\n a\n-b\n c\n',
  ],
  [
    'two far changes give two hunks',
    lines('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'),
    lines('1', 'two', '3', '4', '5', '6', '7', '8', '9', '10', '11', 'twelve'),
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n 4\n 5\n@@ -9,4 +9,4 @@\n 9\n 10\n 11\n-12\n+twelve\n',
  ],
  [
    'CRLF text keeps the line endings in the diff',
    'a\r\nb\r\nc\r\n',
    'a\r\nB\r\nc\r\n',
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n',
  ],
  [
    'line ending change is a change',
    'a\nb\n',
    'a\r\nb\n',
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,2 +1,2 @@\n-a\n+a\r\n b\n',
  ],
  [
    'no newline at end of file',
    'a\nb',
    'a\nb\nc',
    '--- a/f.c4\n+++ b/f.c4\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n',
  ],
  ['from empty', '', lines('a'), '--- a/f.c4\n+++ b/f.c4\n@@ -0,0 +1,1 @@\n+a\n'],
];

describe('unifiedDiff', () => {
  it.each(CASES)('%s', (_name, a, b, expected) => {
    expect(unifiedDiff('f.c4', a, b)).toBe(expected);
  });

  it('applying the +/context lines of every hunk rebuilds the new text', () => {
    const a = lines(...Array.from({ length: 40 }, (_, i) => `line${i}`));
    const b = lines(...Array.from({ length: 40 }, (_, i) => (i === 3 ? 'changed' : i === 20 ? 'x\ny' : `line${i}`)));
    const diff = unifiedDiff('f.c4', a, b);
    const body = diff.split(/(?<=\n)/).filter(l => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@'));
    expect(body.filter(l => l[0] === '+').map(l => l.slice(1)).join('')).toBe('changed\nx\ny\n');
    expect(body.filter(l => l[0] === '-').map(l => l.slice(1)).join('')).toBe('line3\nline20\n');
  });
});
