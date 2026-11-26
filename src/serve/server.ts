import * as http from 'http';
import type { AddressInfo } from 'net';
import { renderViewShell, viewerScriptText } from '../page/html';
import type { LiveModel } from '../page/liveModel';
import { log } from '../log';
import { createApiHandlers, type ApiContext } from './api';
import { checkRequest, readJsonBody, RequestRefused, securityHeaders, type AnswerKind, type Refusal, type RouteRule } from './security';

/**
 * Phase 30 SV6 (b793, b57, b60): the http server of `c4pm serve`. Bound to 127.0.0.1 only (the literal: never 0.0.0.0,
 * '::' or 'localhost', plan 4.1). Fixed routes only; every request goes through checkRequest, a body route through
 * readJsonBody, then its handler; every answer has the security headers. The command (SV7) makes the live model and the
 * token, picks the port and prints the URL.
 */

/** The only address the server listens on. */
const BIND_HOST = '127.0.0.1';

/** b939: the link to the served page: the page with the key in the fragment (what the server prints, and `serve --link`). */
export function serveLinkUrl(port: number, token: string): string {
  return `http://${BIND_HOST}:${port}/#t=${token}`;
}

const KB = 1024;

/** The route table (plan 4.3). The write routes are checked and read like the real ones, then answer 501 (api.ts). */
export const SERVE_ROUTES: readonly RouteRule[] = [
  { method: 'GET', path: '/', needsToken: false, bodyLimit: 0, contentType: null, answer: 'html', navigation: true },
  { method: 'GET', path: '/viewer.js', needsToken: false, bodyLimit: 0, contentType: null, answer: 'js', navigation: false },
  { method: 'GET', path: '/api/boot', needsToken: true, bodyLimit: 0, contentType: null, answer: 'json', navigation: false },
  { method: 'GET', path: '/api/wait', needsToken: true, bodyLimit: 0, contentType: null, answer: 'json', navigation: false },
  { method: 'POST', path: '/api/export', needsToken: true, bodyLimit: 1 * KB, contentType: 'application/json', answer: 'json', navigation: false },
  { method: 'POST', path: '/api/layout', needsToken: true, bodyLimit: 2048 * KB, contentType: 'application/json', answer: 'json', navigation: false },
  { method: 'POST', path: '/api/board', needsToken: true, bodyLimit: 256 * KB, contentType: 'application/json', answer: 'json', navigation: false },
  { method: 'PUT', path: '/api/settings', needsToken: true, bodyLimit: 16 * KB, contentType: 'application/json', answer: 'json', navigation: false },
];

export interface ServeOptions {
  live: LiveModel;
  /** The per-run token (newToken); every api/* call must send it in X-C4PM-Token. */
  token: string;
  /** The port to listen on; 0 = any free port. */
  port: number;
  /** The longest an api/wait is held, in ms (default 25 000; tests pass less). */
  waitMs?: number;
  /** The time a client has to send a whole request, in ms (default 30 000). */
  requestTimeoutMs?: number;
  /** b914: the Export writer; startServe binds exportPageData. Absent: api/export answers 501. */
  exportPage?: ApiContext['exportPage'];
  /** SV18: the repo and cli config the write routes edit; startServe binds them. Absent: api/layout and api/board answer 501. */
  repo?: ApiContext['repo'];
  /** SV18 (b646): the personal settings file; null = turned off; absent: api/settings answers 501. */
  settingsFile?: ApiContext['settingsFile'];
}

export interface ServeServer {
  /** Listen on 127.0.0.1. `url` is the link to open: the page with the token in the fragment. A busy port rejects. */
  listen(): Promise<{ host: string; port: number; url: string }>;
  /** Answers the open long-polls, stops the live model, closes every connection. */
  close(): Promise<void>;
}

/** Write one answer with the security headers of its kind. */
function send(res: http.ServerResponse, status: number, kind: AnswerKind, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders(kind), 'Content-Length': String(Buffer.byteLength(body)), ...extra });
  res.end(body);
}

/** A refusal: JSON `{ message }`, and the connection closes (an unread body is never drained). */
const refuse = (res: http.ServerResponse, r: Refusal): void =>
  send(res, r.status, 'json', JSON.stringify({ message: r.message }), { Connection: 'close' });

/** The request path and query, split at the first '?'. The path is used as it is: no decoding, no '..' folding. */
function splitUrl(url: string): { path: string; query: URLSearchParams } {
  const q = url.indexOf('?');
  return q < 0 ? { path: url, query: new URLSearchParams() } : { path: url.slice(0, q), query: new URLSearchParams(url.slice(q + 1)) };
}

/**
 * The server of one live model. The shell and the viewer script are built once here. Nothing listens before listen().
 */
export function createServeServer(opts: ServeOptions): ServeServer {
  const shell = renderViewShell();
  const viewerJs = viewerScriptText();
  const routes = new Map(SERVE_ROUTES.map(r => [r.path, r]));
  const api = createApiHandlers({ live: opts.live, waitMs: opts.waitMs ?? 25000, exportPage: opts.exportPage, repo: opts.repo, settingsFile: opts.settingsFile });
  const requestTimeout = opts.requestTimeoutMs ?? 30000;
  // Node checks the two time-outs every connectionsCheckingInterval (default 30 s): checked often enough to hold to them.
  const server = http.createServer({
    requestTimeout,
    headersTimeout: Math.min(10000, requestTimeout),
    connectionsCheckingInterval: Math.min(5000, requestTimeout),
  });
  const open = new Set<Promise<void>>();   // answers not finished yet (close() waits for them)
  let port = -1;                           // the bound port, known after listen()
  let closing: Promise<void> | null = null;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path, query } = splitUrl(req.url ?? '');
    const rule = routes.get(path) ?? null;
    const refusal = checkRequest(req, rule, { port, token: opts.token });
    if (refusal || !rule) { refuse(res, refusal ?? { status: 404, message: 'not found' }); return; }
    if (rule.path === '/') { send(res, 200, 'html', shell); return; }
    if (rule.path === '/viewer.js') { send(res, 200, 'js', viewerJs); return; }
    const body = rule.bodyLimit > 0 ? await readJsonBody(req, rule.bodyLimit) : undefined;
    const answer = await api[rule.path.slice(1)]({ query, body });
    send(res, answer.status, 'json', answer.json);
  }

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const finished = new Promise<void>(resolve => { res.once('finish', resolve); res.once('close', resolve); });
    open.add(finished);
    void finished.then(() => open.delete(finished));
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof RequestRefused) { refuse(res, { status: err.status, message: err.message }); return; }
      log('serve', 'error', { url: req.url, message: err instanceof Error ? err.message : String(err) });
      refuse(res, { status: 500, message: 'internal error' });
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          reject(err.code === 'EADDRINUSE' ? new Error(`port ${opts.port} is in use`) : err);
        };
        server.once('error', onError);
        server.listen(opts.port, BIND_HOST, () => {
          server.removeListener('error', onError);
          const a = server.address() as AddressInfo;
          port = a.port;
          resolve({ host: a.address, port: a.port, url: serveLinkUrl(a.port, opts.token) });
        });
      });
    },
    close() {
      closing ??= (async () => {
        opts.live.stop();                       // answers every api/wait
        // those answers are sent; a client still sending a body is not waited for longer than a second
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...open]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        clearTimeout(timer);
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      })();
      return closing;
    },
  };
}
