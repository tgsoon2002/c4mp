// Runs one c4pm command with measure.js preloaded and returns time, peak memory,
// CPU, exit code, signal and timeout. Shared by run.ts (synthetic) and real.ts.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface StepRun {
  ok: boolean; exit: number | null; signal: string | null; timedOut: boolean; wallMs: number;
  maxRssMb: number | null; cpuMs: number | null; stderrTail: string; stdout: string;
}

export function runStep(cli: string, args: string[], heapMb: string | undefined, timeoutS: number, work: string, cwd?: string): StepRun {
  const measure = path.join(work, 'measure.json');
  fs.rmSync(measure, { force: true });
  const nodeArgs = ['-r', path.join(__dirname, 'measure.js')];
  if (heapMb) nodeArgs.push(`--max-old-space-size=${heapMb}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...nodeArgs, cli, ...args], {
    env: { ...process.env, STRESS_MEASURE_OUT: measure }, timeout: timeoutS * 1000,
    maxBuffer: 1 << 30, cwd, encoding: 'utf8', killSignal: 'SIGKILL',
  });
  const wallMs = Date.now() - t0;
  let m: { maxRssKb?: number; userMs?: number; sysMs?: number } = {};
  try { m = JSON.parse(fs.readFileSync(measure, 'utf8')); } catch { /* killed before exit */ }
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const stderr = (r.stderr || '') + (r.error && !timedOut ? String(r.error) : '');
  return {
    ok: r.status === 0 && !timedOut, exit: r.status, signal: r.signal, timedOut, wallMs,
    maxRssMb: m.maxRssKb != null ? Math.round(m.maxRssKb / 1024) : null,
    cpuMs: m.userMs != null ? Math.round((m.userMs ?? 0) + (m.sysMs ?? 0)) : null,
    // Keep the cause ("FATAL ERROR: ... heap out of memory", "error: ...") as well as the tail; a native stack trace fills the tail.
    stderrTail: [...new Set([...stderr.split('\n').filter((l) => /error|fatal|heap|abort/i.test(l)).slice(0, 3),
      ...stderr.split('\n').filter(Boolean).slice(-5)])].join('\n'),
    stdout: r.stdout || '',
  };
}

