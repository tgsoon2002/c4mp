import { isBoardDate, todayIso } from '../src/board/dates';

describe('isBoardDate', () => {
  it.each([
    ['2026-10-21', true],
    ['2024-02-29', true],
    ['2026-13-40', false],
    ['2026-02-30', false],
    ['2026-02-29', false],
    ['Oct 5', false],
    ['', false],
    ['20261021', false],
    ['2026-10-21 ', false],
    [20261021, false],
    [null, false],
    [undefined, false],
  ])('%p -> %p', (input, expected) => {
    expect(isBoardDate(input)).toBe(expected);
  });
});

describe('todayIso', () => {
  it('uses the local calendar date, zero padded', () => {
    expect(todayIso(new Date(2026, 9, 1))).toBe('2026-10-01');
    expect(todayIso(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('defaults to now and is a valid board date', () => {
    expect(isBoardDate(todayIso())).toBe(true);
  });
});
