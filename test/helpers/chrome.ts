import * as fs from 'fs';
import { execFileSync } from 'child_process';

// Shared headless-Chrome runner for the real-browser tests.
//
// Why a wrapper: execFileSync's timeout error is created with `err.error = err` (circular), and
// jest-worker JSON.stringify()s a failing suite's error, so a timeout under load surfaced as
// "Converting circular structure to JSON" instead of a readable failure. runChrome rethrows a
// plain Error (no cause, no extra props) so failures stay failures with a clear message.

// b924: one finder (scripts/find-browser.js, also used by scripts/cdp-page.js). These tests use --dump-dom / --screenshot /
// --virtual-time-budget, proven only on env CHROME, Chrome, Chrome for Testing, Chromium and the Playwright shell (dumpDom: true):
// on a Mac with only Brave or Edge they skip. cdp-page.js asks for any kind.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findBrowser } = require('../../scripts/find-browser.js') as { findBrowser(o?: { dumpDom?: boolean }): string | null };   // no option = any kind
/** Path of the browser, or '' when none is installed (so fs.existsSync(CHROME) stays false). */
export const CHROME: string = findBrowser({ dumpDom: true }) ?? '';
export const chromeInstalled = CHROME !== '' && fs.existsSync(CHROME);
/** Any Chrome-like browser (Brave and Edge too) for the tests that only use the DevTools protocol (cdp-page, serve-chrome, media scripts). */
export const CDP_CHROME: string = findBrowser() ?? '';
export const cdpChromeInstalled = CDP_CHROME !== '' && fs.existsSync(CDP_CHROME);

export interface RunChromeOpts {
  /** Binary to run (default: CHROME). Mainly for the helper's own unit test. */
  bin?: string;
  /** Per-attempt timeout in ms (default 60000). */
  timeout?: number;
  /** Retry once when the first attempt hit the timeout (default true). Other errors never retry. */
  retryOnTimeout?: boolean;
}

function attempt(bin: string, args: string[], timeout: number): string {
  return execFileSync(bin, args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout, killSignal: 'SIGKILL',
  });
}

export function runChrome(args: string[], opts: RunChromeOpts = {}): string {
  const bin = opts.bin ?? CHROME;
  const timeout = opts.timeout ?? 60000;
  const retry = opts.retryOnTimeout ?? true;
  const started = Date.now();
  for (let n = 1; ; n++) {
    try {
      return attempt(bin, args, timeout);
    } catch (e: any) {
      const code = e?.code ?? e?.signal ?? (e?.status != null ? `exit ${e.status}` : 'unknown');
      if (code === 'ETIMEDOUT' && retry && n === 1) {
        // eslint-disable-next-line no-console
        console.warn(`chrome timed out after ${timeout}ms (machine loaded?); retrying once`);
        continue;
      }
      const stderr = String(e?.stderr ?? '').split('\n').slice(0, 5).join(' | ').trim();
      const detail = code === 'ETIMEDOUT' ? `timeout (ETIMEDOUT)` : String(code);
      throw new Error(`chrome failed: ${detail} after ${Date.now() - started}ms (${n} attempt${n > 1 ? 's' : ''}): ${stderr || e?.message || 'no output'}`);
    }
  }
}
