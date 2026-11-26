// b916 S5: scripts/showcase-shift-dates.js moves board item dates by whole days. Inline objects only: no test reads Showcase/.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shift = require('../scripts/showcase-shift-dates.js') as {
  daysBetween(from: string, to: string): number | null;
  shiftDate(text: string, days: number): string;
  shiftBoard(file: { boards: { items: Record<string, unknown>[] }[] }, days: number): unknown;
};

describe('scripts/showcase-shift-dates.js', () => {
  it('moves start, due, created, updated and closed by the same number of days', () => {
    const file = { boards: [{ items: [{ id: 'b1', start: '2026-12-28', due: '2027-01-15', created: '2026-11-23', updated: '2026-11-23', closed: '2027-01-02' }] }] };
    shift.shiftBoard(file, 10);
    expect(file.boards[0].items[0]).toEqual({ id: 'b1', start: '2027-01-07', due: '2027-01-25', created: '2026-12-03', updated: '2026-12-03', closed: '2027-01-12' });
  });

  it('leaves an item with no dates unchanged', () => {
    const file = { boards: [{ items: [{ id: 'b2', title: 'No dates' }] }] };
    shift.shiftBoard(file, 10);
    expect(file.boards[0].items[0]).toEqual({ id: 'b2', title: 'No dates' });
  });

  it('leaves a bad date string as it is', () => {
    expect(shift.shiftDate('soon', 10)).toBe('soon');
    expect(shift.shiftDate('2027-02-30', 10)).toBe('2027-02-30');
  });

  it('counts whole days between two dates, negative backwards, null for a bad date', () => {
    expect(shift.daysBetween('2027-01-04', '2026-11-23')).toBe(-42);
    expect(shift.daysBetween('2027-01-04', 'x')).toBeNull();
  });
});
