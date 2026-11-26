import { splitTags, splitTagsRaw, isValidTag } from '../src/tags';

describe('splitTags', () => {
  it.each<[string | undefined, string[]]>([
    [undefined, []],
    ['', []],
    ['billing, api', ['billing', 'api']],
    ['  Billing ,API,, billing ', ['billing', 'api']],
    [',,,', []],
    ['a,b,a', ['a', 'b']],
  ])('%j -> %j', (raw, expected) => {
    expect(splitTags(raw)).toEqual(expected);
  });

  it('splitTagsRaw keeps case so the format check can see it', () => {
    expect(splitTagsRaw(' Billing, api ,Billing')).toEqual(['Billing', 'api']);
  });
});

describe('isValidTag', () => {
  it.each<[string, boolean]>([
    ['billing', true], ['api-v2', true], ['3d', true], ['a', true],
    ['', false], ['-a', false], ['Billing', false], ['a b', false], ['a_b', false], ['a.b', false],
  ])('%j -> %s', (t, ok) => {
    expect(isValidTag(t)).toBe(ok);
  });
});
