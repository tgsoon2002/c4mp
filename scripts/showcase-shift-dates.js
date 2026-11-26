#!/usr/bin/env node
// showcase-shift-dates.js <board.json> [--base YYYY-MM-DD] [--today YYYY-MM-DD]
// Moves every item date (start, due, created, updated, closed) of a board file by (today - base) days, in place, so a
// board written around a fixed base date looks current on the day the showcase page is built.
// Defaults: --base 2027-01-04 (the date the demo board is written around), --today the current UTC day.
// A value that is not YYYY-MM-DD is left as it is. Used by build-showcase.sh on its copy only, never on the repo.
'use strict';
const fs = require('fs');

const DATE_KEYS = ['start', 'due', 'created', 'updated', 'closed'];
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD string as UTC milliseconds, else null. */
function parseDay(text) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text ? null : ms;
}

/** Whole days from one YYYY-MM-DD to another (to - from), or null when either is not a date. */
function daysBetween(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
}

/** `text` moved by `days` days; a value that is not YYYY-MM-DD comes back unchanged. */
function shiftDate(text, days) {
  const ms = parseDay(text);
  return ms === null ? text : new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Moves the date fields of every item of every board in a parsed board file by `days`; returns the same object. */
function shiftBoard(file, days) {
  for (const board of file.boards || []) {
    for (const item of board.items || []) {
      for (const key of DATE_KEYS) {
        if (key in item) item[key] = shiftDate(item[key], days);
      }
    }
  }
  return file;
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  if (!file || file.startsWith('--')) {
    console.error('usage: showcase-shift-dates.js <board.json> [--base YYYY-MM-DD] [--today YYYY-MM-DD]');
    process.exit(2);
  }
  const days = daysBetween(option('--base', '2027-01-04'), option('--today', new Date().toISOString().slice(0, 10)));
  if (days === null) { console.error('showcase-shift-dates: --base and --today must be YYYY-MM-DD'); process.exit(2); }
  const board = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify(shiftBoard(board, days), null, 2)}\n`);
  console.log(`shifted board dates by ${days} days: ${file}`);
}

module.exports = { parseDay, daysBetween, shiftDate, shiftBoard };

if (require.main === module) main();
