import { plusOne } from './helpers';

const chromeIt = process.env.CHROME ? it : it.skip;
const ltsDescribe = process.env.LTS ? describe : describe.skip;
const later = chromeIt;

beforeAll(() => plusOne(0));

describe('outer', () => {
  beforeEach(() => plusOne(1));
  afterEach(() => plusOne(2));

  it('adds', () => {
    expect(plusOne(1)).toBe(2);
  });
  it('adds', () => {
    expect(plusOne(2)).toBe(3);
  });

  describe('inner', () => {
    afterAll(() => plusOne(3));
    test.only('works', () => {});
    it.each([[1, 2], [2, 3]])('maps %i to %i', (a, b) => {
      expect(plusOne(a)).toBe(b);
    });
    it.each`
      a    | b
      ${1} | ${2}
    `('table $a', ({ a, b }) => expect(plusOne(a)).toBe(b));
    it.todo('to write');
  });

  describe.each([['x'], ['y']])('per %s', (k) => {
    it(`handles ${k}`, () => {});
  });

  chromeIt('opens a page', async () => {});
  later('alias of an alias', () => {});
});

ltsDescribe('lts only', () => {
  it('replays', () => {});
});

for (const n of [1, 2]) {
  test(`loop ${n}`, () => {});
}

const pick = (items: number[], test: (n: number, i: number) => boolean) => items.filter((n, i) => test(n, i));
test('it\'s escaped\tonce', () => {
  expect(pick([1], (n) => n > 0)).toEqual([1]);
});
