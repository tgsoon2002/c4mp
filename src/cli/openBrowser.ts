/**
 * SV7 (b794): open a page in the default browser. A URL that carries the serve token (`#t=`) is never put on the
 * opener's command line (`ps` shows it): it goes into a private launcher file (mode 0600, own temp folder) that
 * redirects to the URL, and the opener gets the file path. The launcher is removed after `keepMs` or by cleanup().
 * Never throws: a failure is one warning line.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[], done: (err: Error | null) => void) => void;
  tmpDir?: string;
  warn?: (line: string) => void;
  keepMs?: number;
}

export interface OpenedBrowser {
  launcher: string | null;
  cleanup(): void;
}

export function openerFor(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  return { cmd: 'xdg-open', args: [target] };
}

function defaultRun(cmd: string, args: string[], done: (err: Error | null) => void): void {
  execFile(cmd, args, err => done(err));
}

function launcherText(target: string): string {
  const literal = JSON.stringify(target).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><meta charset="utf-8"><title>c4mp serve</title><script>location.replace(${literal});</script>`;
}

export function openInBrowser(target: string, opts: OpenBrowserOptions = {}): OpenedBrowser {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const run = opts.run ?? defaultRun;
  const platform = opts.platform ?? process.platform;
  let dir: string | null = null;
  const cleanup = (): void => {
    if (!dir) return;
    const d = dir;
    dir = null;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* cleanup never throws */
    }
  };
  const fail = (e: unknown): OpenedBrowser => {
    cleanup();
    warn('Warning: could not open the browser: ' + (e instanceof Error ? e.message : String(e)));
    return { launcher: null, cleanup };
  };
  try {
    let toOpen = target;
    let launcher: string | null = null;
    if (target.includes('#t=')) {
      dir = fs.mkdtempSync(path.join(opts.tmpDir ?? os.tmpdir(), 'c4mp-open-'));
      launcher = path.join(dir, 'open.html');
      fs.writeFileSync(launcher, launcherText(target), { mode: 0o600 });
      toOpen = launcher;
      const timer = setTimeout(cleanup, opts.keepMs ?? 10000);
      timer.unref();
    }
    const { cmd, args } = openerFor(platform, toOpen);
    run(cmd, args, err => {
      if (err) warn('Warning: could not open the browser: ' + err.message);
    });
    return { launcher, cleanup };
  } catch (e) {
    return fail(e);
  }
}
