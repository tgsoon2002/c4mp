import { createHash } from 'crypto';
import { textStamp } from '../src/util/stamp';

// Phase 30 SV5 (b792): the "changed since read" stamp of the plan and the board (src/util/stamp.ts).

describe('textStamp', () => {
  it('is the sha1 hex of the pairs sorted by name, each "name NUL text NUL"; a null text is "NUL missing"', () => {
    const expected = createHash('sha1').update('a.c4\0one\0b.c4\0\0missing\0').digest('hex');
    expect(textStamp([['b.c4', null], ['a.c4', 'one']])).toBe(expected);
  });

  it('does not depend on the order of the pairs; a Map of texts works as it is', () => {
    const texts = new Map([['x.c4', 'X'], ['a.c4', 'A']]);
    expect(textStamp(texts)).toBe(textStamp([['a.c4', 'A'], ['x.c4', 'X']]));
  });

  it.each([
    ['a text change', [['a', 'x']], [['a', 'y']]],
    ['a missing text and an empty one', [['board', null]], [['board', '']]],
    ['the boundary between name and text', [['a', 'bc']], [['ab', 'c']]],
    ['one more file', [['a', 'x']], [['a', 'x'], ['b', 'x']]],
  ] as [string, [string, string | null][], [string, string | null][]][])('changes with %s', (_label, one, two) => {
    expect(textStamp(one)).not.toBe(textStamp(two));
  });
});
