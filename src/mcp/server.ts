/**
 * Minimal MCP server core: hand-written JSON-RPC 2.0, newline-delimited, over a Readable/Writable pair.
 * No npm dependency, no knowledge of C4PM (tools arrive as closures; see ToolDef).
 *
 * PROTOCOL (read 2026-10-22 from https://modelcontextprotocol.io/specification, which resolves to
 * revision 2026-07-28; pages read: .../2026-07-28/basic/versioning, basic/transports, basic/transports/stdio,
 * server/tools, server/discover; .../2025-11-25/basic/lifecycle, basic/utilities/ping;
 * .../2025-06-18/basic/lifecycle):
 *
 *   Modern era  "2026-07-28"  no handshake. Every request carries _meta["io.modelcontextprotocol/protocolVersion"];
 *                             an unsupported value is answered with error -32022 and
 *                             data {supported: string[], requested: string}. `server/discover` is mandatory and
 *                             returns {resultType:'complete', supportedVersions, capabilities, _meta:{serverInfo}}.
 *                             Results carry resultType:'complete'.
 *   Legacy era  "2025-11-25", "2025-06-18"   `initialize` handshake; the server echoes the requested version when it
 *                             supports it, otherwise answers with the latest version it supports (spec: "MUST respond
 *                             with another protocol version it supports ... SHOULD be the latest"). The client then
 *                             sends notifications/initialized (a notification, never answered).
 *   Both eras:  stdio framing = one JSON message per line, no embedded newlines; nothing but MCP messages on stdout;
 *               logging only on stderr; exit when stdin closes. ping -> result {} (documented for 2025-11-25).
 *               tools/list -> {tools:[{name,description,inputSchema}]}; tools/call -> {content:[...], isError?};
 *               unknown tool -> JSON-RPC error -32602; tool execution failure -> result with isError:true.
 *
 *   UNVERIFIED (not read, or chosen by this implementation, not by the spec):
 *   - ping in the 2026-07-28 revision (page not read; answered with {} plus resultType, same as other results).
 *   - pagination of tools/list (cursor is ignored; the full list is always returned, nextCursor never set).
 *   - notifications/cancelled is accepted and ignored (requests run to completion, in order).
 *   - JSON-RPC batch arrays: answered with -32600 (this core does not support batches; spec pages read do not
 *     mention batches).
 *   - 2025-06-18 stdio/tools pages were not read individually; its initialize page was read and matches 2025-11-25.
 *   - Older revisions (2025-03-26, 2024-11-05) are not offered.
 *
 * JSON-RPC rules implemented: ids echoed exactly (string or number); a message without an `id` key is a
 * notification and is NEVER answered (unknown ones included); malformed JSON -> -32700 id null; invalid request or
 * batch -> -32600; unknown method -> -32601; unknown tool / bad params -> -32602.
 *
 * stdout hygiene: serve() points console.log/info/debug at the log sink (stderr by default) while it runs, because
 * src/log.ts prints C4PM_DEBUG lines with console.log and would otherwise corrupt the protocol stream.
 */
import type { Readable, Writable } from 'stream';
import { isObj } from '../util/obj';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18']; // newest first
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_LINE_BYTES = 1024 * 1024;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;
const E_UNSUPPORTED_VERSION = -32022;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: ToolDef[];
  onLog?: (s: string) => void;
}

export interface McpServer {
  /** Returns the single-line JSON response, or null when nothing must be sent (notifications, blank lines). Never rejects. */
  handleLine(line: string): Promise<string | null>;
  /** Reads newline-delimited messages until `input` ends, writing one JSON line per answer. Resolves when drained. */
  serve(input: Readable, output: Writable): Promise<void>;
}

type Id = string | number | null;
type Obj = Record<string, unknown>;

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

function errorResponse(id: Id, code: number, message: string, data?: unknown): string {
  const error: Obj = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function toolResult(value: unknown): Obj {
  if (isObj(value) && Array.isArray(value.content)) return value;
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  return { content: [{ type: 'text', text }] };
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const log = opts.onLog ?? ((s: string) => void process.stderr.write(s + '\n'));
  const tools = new Map<string, ToolDef>();
  for (const t of opts.tools) {
    if (tools.has(t.name)) throw new Error(`duplicate MCP tool name: ${t.name}`);
    tools.set(t.name, t);
  }
  const serverInfo = { name: opts.name, version: opts.version };
  const capabilities = { tools: {} };

  async function dispatch(method: string, params: Obj, modern: boolean): Promise<Obj> {
    const done = (r: Obj): Obj => (modern ? { resultType: 'complete', ...r } : r);
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        if (typeof requested !== 'string') throw new RpcError(E_INVALID_PARAMS, 'initialize requires params.protocolVersion (string)');
        const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        return { protocolVersion, capabilities, serverInfo };
      }
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: SUPPORTED_VERSIONS, capabilities, _meta: { [META_SERVER_INFO]: serverInfo } };
      case 'ping':
        return done({});
      case 'tools/list':
        return done({ tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') throw new RpcError(E_INVALID_PARAMS, 'tools/call requires params.name (string)');
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObj(args)) throw new RpcError(E_INVALID_PARAMS, 'tools/call params.arguments must be an object');
        const tool = tools.get(name);
        if (!tool) throw new RpcError(E_INVALID_PARAMS, `Unknown tool: ${name}`);
        try {
          return done(toolResult(await tool.handler(args)));
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          log(`[mcp] tool ${name} failed: ${e instanceof Error && e.stack ? e.stack : text}`);
          return done({ content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        throw new RpcError(E_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function handleLine(line: string): Promise<string | null> {
    try {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return errorResponse(null, E_INVALID_REQUEST, `Request exceeds ${MAX_LINE_BYTES} bytes`);
      if (line.trim() === '') return null;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        return errorResponse(null, E_PARSE, `Parse error: ${(e as Error).message}`);
      }
      if (Array.isArray(msg)) return errorResponse(null, E_INVALID_REQUEST, 'Batch requests are not supported');
      if (!isObj(msg) || msg.jsonrpc !== '2.0') return errorResponse(null, E_INVALID_REQUEST, 'Invalid Request');
      const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
      if (typeof msg.method !== 'string') {
        // A response from the client (result/error, no method) is ignored; anything else is an invalid request.
        if (hasId && ('result' in msg || 'error' in msg)) return null;
        return errorResponse(hasId && isId(msg.id) ? msg.id : null, E_INVALID_REQUEST, 'Invalid Request: method must be a string');
      }
      if (!hasId) return null; // notification: never answered (known or unknown)
      if (!isId(msg.id)) return errorResponse(null, E_INVALID_REQUEST, 'Invalid Request: id must be a string or number');
      const id = msg.id;
      if (msg.params !== undefined && !isObj(msg.params)) return errorResponse(id, E_INVALID_PARAMS, 'params must be an object');
      const params = (msg.params ?? {}) as Obj;
      const meta = isObj(params._meta) ? params._meta : {};
      const requested = meta[META_VERSION];
      if (requested !== undefined && (typeof requested !== 'string' || !SUPPORTED_VERSIONS.includes(requested))) {
        return errorResponse(id, E_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
      }
      try {
        const result = await dispatch(msg.method, params, requested === MODERN_VERSIONS[0]);
        return JSON.stringify({ jsonrpc: '2.0', id, result });
      } catch (e) {
        if (e instanceof RpcError) return errorResponse(id, e.code, e.message, e.data);
        log(`[mcp] internal error: ${e instanceof Error && e.stack ? e.stack : String(e)}`);
        return errorResponse(id, E_INTERNAL, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      log(`[mcp] handleLine failed: ${e instanceof Error && e.stack ? e.stack : String(e)}`);
      return errorResponse(null, E_INTERNAL, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function serve(input: Readable, output: Writable): Promise<void> {
    const saved = { log: console.log, info: console.info, debug: console.debug };
    const toSink = (...a: unknown[]): void => log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.log = console.info = console.debug = toSink;

    return new Promise<void>((resolve, reject) => {
      let buf = '';
      let discarding = false; // inside an oversized line, skipping until its newline
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (line: string): void => {
        chain = chain.then(async () => {
          const out = await handleLine(line);
          if (out !== null) output.write(out + '\n');
        });
      };
      const oversized = (): void => {
        chain = chain.then(() => {
          output.write(errorResponse(null, E_INVALID_REQUEST, `Request exceeds ${MAX_LINE_BYTES} bytes`) + '\n');
        });
      };
      input.setEncoding('utf8');
      input.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (discarding) discarding = false;
          else enqueue(line);
        }
        if (!discarding && Buffer.byteLength(buf) > MAX_LINE_BYTES) {
          discarding = true;
          buf = '';
          oversized();
        } else if (discarding) buf = '';
      });
      input.on('error', (e) => {
        console.log = saved.log;
        console.info = saved.info;
        console.debug = saved.debug;
        reject(e);
      });
      input.on('end', () => {
        if (buf !== '' && !discarding) enqueue(buf.replace(/\r$/, ''));
        chain.then(
          () => {
            console.log = saved.log;
            console.info = saved.info;
            console.debug = saved.debug;
            resolve();
          },
          (e) => {
            console.log = saved.log;
            console.info = saved.info;
            console.debug = saved.debug;
            reject(e);
          },
        );
      });
    });
  }

  return { handleLine, serve };
}
