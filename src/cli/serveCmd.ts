// Phase 30 SV7 (b794): `c4mp serve`. Builds the live model, listens on 127.0.0.1, opens the browser and keeps the page current.
import * as http from 'http';
import * as path from 'path';
import type { Command } from 'commander';
import { createLiveModel } from '../page/liveModel';
import type { LiveBuildReport } from '../page/liveModel';
import { exportPageData } from '../page/viewExport';
import { createServeServer, serveLinkUrl } from '../serve/server';
import { newToken } from '../serve/security';
import { servePortFor, serveKeyFor, rememberedServeKey } from '../serve/identity';
import { userFile, SERVE_KEYS_FILE, SETTINGS_FILE } from '../util/userFiles';
import { openInBrowser } from './openBrowser';
import { addExamples, addRepo, addScanOptions, wholeNumberOpt } from '../cliHelp';
import { cmdError, emitError } from './common';
import type { PlanEditDeps, Opts } from './common';
import type { C4pmConfig } from '../types';

export interface ServeRunOptions {
  /** undefined = the repo's kept port (servePortFor); 0 = any free port. */
  port?: number;
  /** b920: make a new link key for this repo (default: the remembered one). */
  newKey?: boolean;
  /** Test seam: the file the link keys are kept in; null = not remembered. Default ~/.c4mp/serve-keys.json (userFile). */
  keyFile?: string | null;
  debounceMs: number;
  open: boolean;
  from?: string | null;
  store?: string;
  sprint?: string | null;
  /** Default console.log. */
  out?: (line: string) => void;
  /** Default console.error. */
  err?: (line: string) => void;
  /** Test seam. */
  opener?: typeof openInBrowser;
}

export interface ServeRun {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const DESC =
  'Serve the live map page on this computer (127.0.0.1) until Ctrl+C. Builds the page data, opens the browser and refreshes the page when code, plan, board or s-items change; the link carries a key. The port and the link key stay the same for a repo (--port, --new-key change them). The page saves layout, board and settings edits through the same checks as the plan and board commands; writes the page file only when you press Export';
const EXAMPLES = ['c4mp serve --repo .', 'c4mp serve --repo . --port 4174 --no-open', 'c4mp serve --repo . --from prev', 'c4mp serve --repo . --new-key', 'c4mp serve --repo . --link'];

/** One line about a finished build, or null when the terminal needs nothing (same / skipped). */
function buildLine(r: LiveBuildReport, first: boolean): { stream: 'out' | 'err'; text: string } | null {
  if (first && r.outcome !== 'failed') return { stream: 'out', text: `built in ${r.ms} ms` };
  if (r.outcome === 'new') {
    const shown = r.files.slice(0, 3).join(', ');
    const more = r.files.length > 3 ? `, +${r.files.length - 3} more` : '';
    return { stream: 'out', text: `updated (generation ${r.generation}, ${r.ms} ms): ${shown}${more}` };
  }
  if (r.outcome === 'failed') return { stream: 'err', text: `refresh failed: ${r.error} (the page keeps the last good data)` };
  return null;
}

export async function startServe(repoRoot: string, cli: Partial<C4pmConfig>, opts: ServeRunOptions): Promise<ServeRun> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  out('building the page data ...');
  let first = true;
  const live = createLiveModel(repoRoot, cli, {
    from: opts.from,
    store: opts.store,
    sprint: opts.sprint,
    debounceMs: opts.debounceMs,
    onBuild: r => {
      const line = buildLine(r, first);
      first = false;
      if (line) (line.stream === 'out' ? out : err)(line.text);
    },
  });
  const port = opts.port ?? servePortFor(repoRoot);
  let token: string;
  try {
    token = serveKeyFor(repoRoot, { fresh: !!opts.newKey, file: opts.keyFile === undefined ? userFile(SERVE_KEYS_FILE) : opts.keyFile });
  } catch (e) {
    token = newToken();
    err(`warning: the link key could not be remembered (${e instanceof Error ? e.message : String(e)}); this run uses a new key`);
  }
  const server = createServeServer({
    live,
    token,
    port,
    exportPage: (dataJson, o) => exportPageData(repoRoot, cli, dataJson, o),
    repo: { root: repoRoot, cli },
    settingsFile: userFile(SETTINGS_FILE),
  });
  let listening: { url: string; port: number };
  try {
    listening = await server.listen();
  } catch (e) {
    live.stop();
    if (opts.port === undefined && e instanceof Error && e.message.endsWith('is in use')) {
      throw new Error(
        `port ${port} is in use. It is the port c4mp serve keeps for this repo: is c4mp serve already running for it? Stop that one, or pass --port <n> (0 = any free port)`,
      );
    }
    throw e;
  }
  out('c4mp serve: ' + listening.url);
  out('Press Ctrl+C to stop');
  const opened = opts.open ? (opts.opener ?? openInBrowser)(listening.url) : null;
  let stopping: Promise<void> | null = null;
  return {
    url: listening.url,
    port: listening.port,
    stop(): Promise<void> {
      if (!stopping) {
        opened?.cleanup();
        stopping = server.close();
      }
      return stopping;
    },
  };
}

/** b939: true when a c4mp serve answers api/boot on 127.0.0.1:<port> with this key (a short check: any error, a refusal or no answer within timeoutMs is false). */
export function serverAnswers(port: number, key: string, timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    const req = http.get({ agent: false, host: '127.0.0.1', port, path: '/api/boot', headers: { 'X-C4PM-Token': key }, timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode === 200 ? 'running' : 'another server answers on this port (not this link\'s key)');
    });
    // The port accepted the connection but gave no answer in time: a serve rebuilding its page on its main thread.
    req.on('timeout', () => { req.destroy(); resolve('running, busy (rebuilding?)'); });
    req.on('error', () => resolve('not running'));
  });
}

/**
 * b939: the lines of `c4mp serve --link`: this repo's link (the kept port or `port`, the remembered key) and `running` / `not running`,
 * without starting a server. No remembered key: one line, nothing is made or written.
 */
export async function serveLink(repoRoot: string, opts: { port?: number; keyFile: string | null; timeoutMs?: number }): Promise<string[]> {
  const key = rememberedServeKey(repoRoot, opts.keyFile);
  if (key === null) return ['no link yet: run c4mp serve once'];
  const port = opts.port ?? servePortFor(repoRoot);
  const state = await serverAnswers(port, key, opts.timeoutMs ?? 3000);
  return [serveLinkUrl(port, key), state];
}

export function registerServeCommand(program: Command, deps: PlanEditDeps): void {
  addExamples(
    addScanOptions(
      addRepo(program.command('serve').description(DESC))
        .option(
          '--port <n>',
          'port on 127.0.0.1 (default: the same port for this repo, 4170-4269, from its path); 0 = any free port. A busy port is an error, never another port',
        )
        .option(
          '--new-key',
          'make a new link key for this repo (links printed before stop working); default: the key remembered in ~/.c4mp/serve-keys.json',
        )
        .option(
          '--link',
          'print this repo\'s link (the kept port and the remembered key) and whether a server answers on it (running / not running); starts nothing, makes no key. With --port: that port. Not with --new-key',
        )
        .option('--no-open', 'do not open the browser; only print the link')
        .option('--debounce <ms>', 'wait this many milliseconds after the last file change before rebuilding', '500')
        .option(
          '--from <ref>',
          'mark what changed since this stored snapshot: prev, latest, oldest, a snapshot id, a commit hash prefix or YYYY-MM-DD (default: no comparison)',
        ),
      ['lang', 'ignore', 'tests', 'store', 'sprint'],
    ),
    EXAMPLES,
  ).action(async (opts: Opts) => {
    let run: ServeRun;
    try {
      const port = wholeNumberOpt('--port', opts.port, 0);
      if (port !== undefined && port > 65535) throw new Error(`--port must be 65535 or less, got '${String(opts.port)}'`);
      const debounceMs = wholeNumberOpt('--debounce', opts.debounce, 0) ?? 500;
      const repoRoot = path.resolve(opts.repo as string);
      if (opts.link === true) {
        if (opts.newKey === true) throw new Error('--link cannot be used with --new-key (a new key would break the links already printed)');
        for (const line of await serveLink(repoRoot, { port, keyFile: userFile(SERVE_KEYS_FILE) })) console.log(line);
        return;
      }
      run = await startServe(repoRoot, deps.buildCliConfig(opts), {
        port,
        newKey: opts.newKey === true,
        debounceMs,
        open: opts.open !== false,
        from: opts.from as string | null | undefined,
        store: opts.store as string | undefined,
        sprint: opts.sprint as string | null | undefined,
      });
    } catch (e) {
      process.exitCode = emitError(opts, 'serve', cmdError('invalid', e instanceof Error ? e.message : String(e)));
      return;
    }
    let stopping = false;
    const onStop = async (): Promise<void> => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log('stopping');
      await run.stop();
      process.exitCode = 0;
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', onStop);   // on, not once: a second Ctrl+C while stopping exits 130
    process.once('SIGTERM', onStop);
  });
}
