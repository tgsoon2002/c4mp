import { fileOnlyOutline } from '../src/languages/files';

describe('fileOnlyOutline', () => {
  it.each([
    ['', 0],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\nc\n', 3],
  ])('counts lines of %j as %i', (code, expected) => {
    expect(fileOnlyOutline('A.java', code).lineCount).toBe(expected);
  });

  it('has no elements, no parse error, and the fileOnly flag', () => {
    expect(fileOnlyOutline('src/A.java', 'x\n')).toEqual({
      file: 'src/A.java',
      lineCount: 1,
      parseError: false,
      elements: [],
      fileOnly: true,
    });
  });
});
