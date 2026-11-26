import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { CMD_NAME } from '../constants';

/**
 * Phase 30 SV6 (b793, b60): the request checks and the answer headers of `c4pm serve` (plan section 4). The server is
 * bound to 127.0.0.1 only; these checks stop what a web page in the user's browser can still try: DNS rebinding (Host),
 * cross-site and same-site requests (Sec-Fetch-Site, Origin), CORS preflights (OPTIONS), requests without the per-run
 * token (the X-C4PM-Token header, never a cookie, never the query string), wrong methods, form posts (Content-Type)
 * and huge bodies (readJsonBody).
 */

/** The answer kinds; each has its Content-Type and its CSP. */
export type AnswerKind = 'html' | 'js' | 'json';

/** One fixed route of the server. Paths are exact: no file is ever served by a path from the request. */
export interface RouteRule {
  method: 'GET' | 'POST' | 'PUT';
  /** The exact request path, like '/api/boot' (the query string is not part of it). */
  path: string;
  /** api/* routes: the X-C4PM-Token header must hold the token. */
  needsToken: boolean;
  /** The largest request body in bytes; 0 = the route takes no body. */
  bodyLimit: number;
  /** The Content-Type a body must have (its media type); null for a route without a body. */
  contentType: 'application/json' | null;
  /** The kind of the answer (securityHeaders). */
  answer: AnswerKind;
  /** The page itself: Sec-Fetch-Site 'none' (typed in the address bar, a bookmark, the opened link) is allowed. */
  navigation: boolean;
}

/** A refused request: the status and one line for the answer. */
export interface Refusal {
  status: number;
  message: string;
}

/** A refusal thrown by readJsonBody (and by a handler that refuses its input). */
export class RequestRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RequestRefused';
  }
}

/** The header that carries the token on every api/* call (serve-boot.js sends it). */
export const TOKEN_HEADER = 'x-c4pm-token';

/** The per-run token: 32 random bytes, base64url (43 characters, safe in the URL fragment). */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** The two names our page can be reached by. Never a wildcard and never another port. */
const ourHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];
const ourOrigins = (port: number): string[] => ourHosts(port).map(h => `http://${h}`);

/** One header as a single string ('' when missing). Node joins repeated custom headers with ', ', which then never matches. */
const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
};

/** Equal tokens, compared in constant time; a different length is simply false. */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** The media type of a Content-Type header: 'application/json; charset=utf-8' -> 'application/json'. */
const mediaType = (value: string): string => value.split(';')[0].trim().toLowerCase();

/**
 * The checks of plan section 4.3 for one request, in this order; the first that fails is the answer, null = allowed.
 * `rule` is the route of the request path (null: no such route). ctx.port is the port the server listens on.
 * 1. Host must be 127.0.0.1:<port> or localhost:<port> (403): a rebound DNS name sends its own Host.
 * 2. OPTIONS: 403, with no Access-Control-* header (no CORS, ever: a preflight never passes).
 * 3. Sec-Fetch-Site, when sent, must be same-origin, or none on the page route (403).
 * 4. Origin: required on any method but GET and HEAD, and when sent it must be ours (403).
 * 5. The path must be a route (404); 6. the route's method (405).
 * 7. Token routes: the X-C4PM-Token header must equal the token (401). The query string is never read for it.
 * 8. A body route: Content-Type application/json (415). The size and the JSON itself: readJsonBody (413, 400).
 */
export function checkRequest(req: IncomingMessage, rule: RouteRule | null, ctx: { port: number; token: string }): Refusal | null {
  const host = header(req, 'host').toLowerCase();
  if (!ourHosts(ctx.port).includes(host)) return { status: 403, message: 'wrong Host: this server answers only 127.0.0.1 and localhost on its port' };
  const method = req.method ?? '';
  if (method === 'OPTIONS') return { status: 403, message: 'cross-origin requests are not allowed' };
  const site = header(req, 'sec-fetch-site');
  if (site && site !== 'same-origin' && !(site === 'none' && rule?.navigation)) {
    return { status: 403, message: `Sec-Fetch-Site ${site} is not allowed` };
  }
  const origin = header(req, 'origin');
  const needsOrigin = method !== 'GET' && method !== 'HEAD';
  if (needsOrigin && !origin) return { status: 403, message: 'a write needs the Origin header' };
  if (origin && !ourOrigins(ctx.port).includes(origin)) return { status: 403, message: 'wrong Origin' };
  if (!rule) return { status: 404, message: 'not found' };
  if (method !== rule.method) return { status: 405, message: `${rule.path} takes ${rule.method} only` };
  if (rule.needsToken && !sameToken(header(req, TOKEN_HEADER), ctx.token)) {
    return { status: 401, message: `missing or wrong key: open the link that ${CMD_NAME} serve printed` };
  }
  if (rule.contentType && mediaType(header(req, 'content-type')) !== rule.contentType) {
    return { status: 415, message: `the body must be ${rule.contentType}` };
  }
  return null;
}

/** The CSP of the page: its own inline scripts and viewer.js, inline styles, fetch only to itself, never framed. */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Script and data answers are never a document: nothing may load from them. */
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'";

const CONTENT_TYPES: Record<AnswerKind, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** The headers of every answer of the given kind (plan section 4.3 item 7). No Access-Control-* header, ever. */
export function securityHeaders(kind: AnswerKind): Record<string, string> {
  return {
    'Content-Type': CONTENT_TYPES[kind],
    'Content-Security-Policy': kind === 'html' ? PAGE_CSP : DATA_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/**
 * Read a JSON request body of at most limitBytes. Rejects with a RequestRefused: 413 when the Content-Length or the bytes
 * read pass the limit (reading stops at once), 400 when the body is empty or not JSON.
 */
export function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooBig = (): RequestRefused => new RequestRefused(413, `the body is larger than ${limitBytes} bytes`);
    const declared = Number(header(req, 'content-length') || '0');
    if (declared > limitBytes) { reject(tooBig()); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: RequestRefused | null, value?: unknown): void => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limitBytes) { req.pause(); finish(tooBig()); return; }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('error', () => finish(new RequestRefused(400, 'the body could not be read')));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        finish(null, JSON.parse(text));
      } catch {
        finish(new RequestRefused(400, 'the body is not JSON'));
      }
    });
  });
}
