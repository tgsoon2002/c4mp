import { readEnv } from './env';

export function log(tag: string, msg: string, data?: unknown): void {
  const debug = readEnv('DEBUG') ?? '';
  if (debug !== '*' && !debug.split(',').includes(tag)) return;
  console.log(data === undefined ? `[${tag}] ${msg}` : `[${tag}] ${msg} ${JSON.stringify(data)}`);
}

// --- timing (C4PM_TIMING=1): where the time went, one table on stderr at exit; off = fn called directly ---

interface TimingRow { label: string; depth: number; ms: number; detail?: string }
const timingRows: TimingRow[] = [];
let timingDepth = 0;
let timingHooked = false;

const timingOn = (): boolean => readEnv('TIMING') === '1';

function printTiming(): void {
  if (timingRows.length === 0) return;
  const names = timingRows.map((r) => '  '.repeat(r.depth) + r.label);
  const width = Math.max(...names.map((n) => n.length));
  const lines = timingRows.map((r, i) => `${names[i].padEnd(width)}  ${(r.ms / 1000).toFixed(2).padStart(7)} s${r.detail ? `  ${r.detail}` : ''}`);
  process.stderr.write(`[timing]\n${lines.join('\n')}\n`);
}

/** Start a timed step; call the returned function when it ends (optional detail, e.g. a count). Inactive = no-op. */
export function timeStart(label: string): (detail?: string) => void {
  if (!timingOn()) return () => {};
  if (!timingHooked) { timingHooked = true; process.on('exit', printTiming); }
  const row: TimingRow = { label, depth: timingDepth, ms: 0 };
  timingRows.push(row);   // pushed at start so a parent prints before its children
  timingDepth++;
  const t0 = process.hrtime.bigint();
  return (detail?: string) => {
    row.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (detail !== undefined) row.detail = detail;
    timingDepth = row.depth;
  };
}

/** Run fn (sync or async); with C4PM_TIMING=1 its time goes in the table. Result and errors pass through untouched. */
export function timed<T>(label: string, fn: () => T, detail?: (result: T) => string): T {
  if (!timingOn()) return fn();
  const end = timeStart(label);
  let out: T;
  try {
    out = fn();
  } catch (err) {
    end();
    throw err;
  }
  if (out instanceof Promise) {
    return out.then(
      (v) => { end(detail?.(v)); return v; },
      (e) => { end(); throw e; },
    ) as T;
  }
  end(detail?.(out));
  return out;
}
