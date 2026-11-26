import * as path from 'path';
import { spawn } from 'child_process';
import { createMcpServer } from '../src/mcp/server';
import { SPAWN_TIMEOUT_MS } from './helpers/runCli';

const PROJECT = path.resolve(__dirname, '..');
const ENTRY = path.join(__dirname, 'mcp-stub-server.ts');
// Same ts-node resolution as the other CLI tests: node_modules/.bin/ts-node from the Project root.
const TS_NODE = path.join(PROJECT, 'node_modules', 'ts-node', 'dist', 'bin.js');

interface Run {
  stdoutLines: string[];
  stderr: string;
  code: number | null;
}

/** Spawns the stub server, writes `input` verbatim to stdin, closes stdin, collects everything until exit. */
function run(input: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TS_NODE, '--transpile-only', ENTRY], {
      cwd: PROJECT,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdoutLines: out.split('\n').filter((l) => l !== ''), stderr: err, code }));
    child.stdin.end(input);
  });
}

const req = (id: unknown, method: string, params?: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
const parse = (lines: string[]): any[] => lines.map((l) => JSON.parse(l));

jest.setTimeout(SPAWN_TIMEOUT_MS); // each test starts a node + ts-node child (macOS process-start stall, b628)

describe('MCP core over a real process', () => {
  test('initialize (two versions) -> ping -> tools/list -> tools/call; notifications unanswered; exit 0', async () => {
    const input =
      req(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }) +
      req('b', 'initialize', { protocolVersion: '2025-06-18' }) +
      req(3, 'initialize', { protocolVersion: '1999-01-01' }) +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/never-heard-of-it' }) + '\n' +
      req('p', 'ping') +
      req(4.5, 'tools/list') +
      req(5, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }) +
      req(6, 'tools/call', { name: 'boom', arguments: {} }) +
      req(7, 'tools/call', { name: 'nope' }) +
      req(8, 'tools/call', { arguments: {} }) +
      req(9, 'tools/call', { name: 'echo', arguments: [] });
    const r = await run(input);
    expect(r.code).toBe(0);
    const m = parse(r.stdoutLines);
    expect(m).toHaveLength(10); // 10 requests, 2 notifications unanswered
    expect(m[0]).toEqual({ jsonrpc: '2.0', id: 1, result: expect.objectContaining({ protocolVersion: '2025-11-25', serverInfo: { name: 'stub', version: '0.0.1' }, capabilities: { tools: {} } }) });
    expect(m[1].id).toBe('b');
    expect(m[1].result.protocolVersion).toBe('2025-06-18');
    expect(m[2].result.protocolVersion).toBe('2025-11-25'); // unsupported -> latest supported
    expect(m[3]).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(m[4].id).toBe(4.5);
    expect(m[4].result.tools.map((t: any) => t.name)).toEqual(['echo', 'boom']);
    expect(m[4].result.tools[0]).toEqual(expect.objectContaining({ description: expect.any(String), inputSchema: expect.any(Object) }));
    expect(m[5].result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(m[6].result).toEqual({ content: [{ type: 'text', text: 'kaboom' }], isError: true });
    expect(m[7].error.code).toBe(-32602);
    expect(m[7].error.message).toMatch(/Unknown tool: nope/);
    expect(m[8].error.code).toBe(-32602);
    expect(m[9].error.code).toBe(-32602);
  });

  test('modern era: discover, per-request version, unsupported version', async () => {
    const meta = (v: string) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v } });
    const r = await run(
      req(1, 'server/discover', meta('2026-07-28')) +
        req(2, 'tools/list', meta('2026-07-28')) +
        req(3, 'tools/list', meta('1900-01-01')),
    );
    const m = parse(r.stdoutLines);
    expect(m[0].result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18']);
    expect(m[0].result.resultType).toBe('complete');
    expect(m[1].result.resultType).toBe('complete');
    expect(m[2].error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18'], requested: '1900-01-01' } });
  });

  test('garbage, invalid request, batch, unknown method, bad id', async () => {
    const r = await run(
      'this is not json\n' +
        '{"jsonrpc":"2.0","id":7,"method":42}\n' +
        '[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n' +
        '{"id":1,"method":"ping"}\n' +
        req('x', 'no/such/method') +
        '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}\n',
    );
    expect(r.code).toBe(0);
    const m = parse(r.stdoutLines);
    expect(m[0]).toEqual({ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32700 }) });
    expect(m[1]).toEqual({ jsonrpc: '2.0', id: 7, error: expect.objectContaining({ code: -32600 }) });
    expect(m[2]).toEqual({ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32600 }) });
    expect(m[3].error.code).toBe(-32600);
    expect(m[4]).toEqual({ jsonrpc: '2.0', id: 'x', error: expect.objectContaining({ code: -32601 }) });
    expect(m[5]).toEqual({ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32600 }) });
  });

  test('two pipelined requests in one write are answered in order; stdin closed without trailing newline', async () => {
    const r = await run(req(1, 'ping') + req(2, 'ping').trimEnd());
    expect(r.code).toBe(0);
    expect(parse(r.stdoutLines).map((x) => x.id)).toEqual([1, 2]);
  });

  test('stdin closed immediately: no output, exit 0', async () => {
    const r = await run('');
    expect(r).toEqual({ stdoutLines: [], stderr: expect.any(String), code: 0 });
  });

  test('oversized line (> 1 MB) is rejected with -32600 and the server keeps serving', async () => {
    const r = await run('{"pad":"' + 'a'.repeat(1024 * 1024 + 10) + '"}\n' + req(1, 'ping'));
    const m = parse(r.stdoutLines);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32600 }) });
    expect(m[1].id).toBe(1);
  });

  test('C4PM_DEBUG=*: every stdout line is JSON; debug text lands on stderr', async () => {
    const r = await run(req(1, 'tools/call', { name: 'echo', arguments: { text: 'x' } }) + req(2, 'ping'), { C4PM_DEBUG: '*' });
    expect(r.code).toBe(0);
    expect(r.stdoutLines).toHaveLength(2);
    for (const l of r.stdoutLines) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.stderr).toContain('[stub] echo called');
  });
});

describe('handleLine in-process', () => {
  const server = createMcpServer({ name: 'n', version: '1', tools: [], onLog: () => {} });
  test('null for notifications and blank lines, exact id echo', async () => {
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine('{"jsonrpc":"2.0","method":"anything"}')).toBeNull();
    expect(JSON.parse((await server.handleLine('{"jsonrpc":"2.0","id":"0","method":"ping"}'))!).id).toBe('0');
  });
  test('duplicate tool names are rejected at creation', () => {
    const t = { name: 'a', description: '', inputSchema: {}, handler: () => 1 };
    expect(() => createMcpServer({ name: 'n', version: '1', tools: [t, t] })).toThrow(/duplicate/);
  });
});
