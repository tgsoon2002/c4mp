// Plain calendar-day helpers (Foundation): no knowledge of boards or projects. Moved from board/dates.ts (b492, row Q7)
// so the Query layer reads today's date from Helpers; board/dates.ts re-exports them for the board code.

/** A plain calendar day: 'YYYY-MM-DD' (the date format of board fields). */
export const BOARD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a string that matches YYYY-MM-DD AND is a real calendar day ('2026-02-30' is refused). */
export function isBoardDate(s: unknown): s is string {
  if (typeof s !== 'string' || !BOARD_DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The LOCAL calendar date as YYYY-MM-DD (the user reads their own clock). `now` is injectable for tests. */
export function todayIso(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
