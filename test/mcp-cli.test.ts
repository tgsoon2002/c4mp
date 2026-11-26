import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { CLI_JS } from './helpers/runCli';
import { buildTools } from '../src/mcp/tools';
import { makeSimRepo } from './helpers/simHarness';
import { listing } from './helpers/planEditHarness';

// P15-T7c: the real `c4mp mcp` process. A scripted JSON-RPC client, stdout purity with C4MP_DEBUG=*, fail-fast start-up.

const projectRoot = path.resolve(__dirname, '..');
const fixtures = path.resolve(__dirname, 'fixtures');

interface Run { stdoutLines: string[]; stderr: string; code: number | null }

/** Spawns `c4mp mcp <args>`, writes `input` to stdin, closes it, collects everything until exit. */
function runMcp(args: string[], input: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_JS, 'mcp', ...args], {
      cwd: projectRoot,
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

const req = (id: number, method: string, params?: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

jest.setTimeout(120000);

describe('c4mp mcp', () => {
  const repo = path.join(fixtures, 'sample');
  const calls: [string, Record<string, unknown>][] = [
    ['find', { query: 'order' }],
    ['outline', { path: 'api/src/routes/orders.ts' }],
    ['show', { target: 'api/src/routes/orders.ts', max_lines: 3 }],
    ['deps', { id: 'api' }],
    ['view_path', {}],
    ['check', {}],
    ['status', {}],
    ['sim_list', {}],
  ];
  const input =
    req(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }) +
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
    req(2, 'tools/list') +
    calls.map(([name, args], i) => req(10 + i, 'tools/call', { name, arguments: args })).join('');

  it.each([
    ['plain', {}],
    ['C4MP_DEBUG=*', { C4MP_DEBUG: '*' }],
  ])('answers initialize, tools/list and every tool; stdout is pure JSON (%s)', async (_label, env) => {
    const r = await runMcp(['--repo', repo], input, env);
    expect(r.code).toBe(0);
    const msgs = r.stdoutLines.map((l) => JSON.parse(l)); // throws if any stdout line is not JSON
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(msgs[0].result.serverInfo.name).toBe('c4mp');   // b948: the server announces CMD_NAME
    const listed = msgs[1].result.tools.map((t: { name: string }) => t.name);
    expect(listed).toEqual(buildTools(repo, {}).map((t) => t.name));   // the whole registry (plan_show too: T26-11)
    for (const [name] of calls) expect(listed).toContain(name);
    for (const m of msgs.slice(2)) {
      expect(m.error).toBeUndefined();
      expect(m.result.isError).toBeUndefined();
      expect(() => JSON.parse(m.result.content[0].text)).not.toThrow();
    }
  });

  // T6b (b768): the two write tools over the wire: a dry run writes nothing, `yes: true` writes the s-item file.
  it('sim_apply and sim_remove: listed; a dry run writes nothing, yes writes only the sim/ file', async () => {
    const sim = makeSimRepo('c4mp-t6b-cli-', { 's-1': { kind: 'flow', title: 'Buy', steps: [{ target: 'u-add', view: 'io' }] } });
    try {
      const spec = { sims: [{ kind: 'journey', title: 'Gift', stages: [{ outside: 'Birthday' }] }] };
      const before = listing(sim.root);
      const dry = await runMcp(['--repo', sim.root], req(1, 'tools/list') +
        req(2, 'tools/call', { name: 'sim_apply', arguments: { spec } }) +
        req(3, 'tools/call', { name: 'sim_remove', arguments: { id: 's-1' } }));
      expect(dry.code).toBe(0);
      const [list, apply, remove] = dry.stdoutLines.map((l) => JSON.parse(l));
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['sim_apply', 'sim_remove']));
      for (const m of [apply, remove]) {
        expect(m.result.isError).toBeUndefined();
        expect(JSON.parse(m.result.content[0].text)).toMatchObject({ ok: true, dryRun: true, written: false });
      }
      expect(listing(sim.root)).toEqual(before);
      const wet = await runMcp(['--repo', sim.root], req(1, 'tools/call', { name: 'sim_apply', arguments: { spec, yes: true } }));
      expect(JSON.parse(JSON.parse(wet.stdoutLines[0]).result.content[0].text)).toMatchObject({ ok: true, written: true, minted: ['s-2'] });
      // The s-item file, plus `.c4mp/.gitignore`: the Workspace sets the internal folder up on its first write (as the CLI).
      const added = listing(sim.root).filter((l) => !before.includes(l));
      expect(added).toEqual([expect.stringMatching(/^\.c4mp\/\.gitignore:\d+$/), expect.stringMatching(/^\.c4mp\/projects\/[^/]+\/sim\/s-2\.json:\d+$/)]);
    } finally {
      fs.rmSync(sim.root, { recursive: true, force: true });
    }
  });

  it('--help prints usage on stdout and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI_JS, 'mcp', '--help'], { cwd: projectRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: c4mp mcp');
    expect(r.stdout).toContain('--repo <path>');
  });

  it('invalid config -> exit 1, message on stderr, empty stdout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-t7c-'));
    try {
      fs.mkdirSync(path.join(tmp, '.c4mp'));
      fs.writeFileSync(path.join(tmp, '.c4mp', 'config.json'), '{ not json');
      const r = await runMcp(['--repo', tmp], req(1, 'ping'));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('error:');
      expect(r.stdoutLines).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ['nonexistent repo', ['--repo', path.join(fixtures, 'does-not-exist')]],
    ['repo is a file', ['--repo', path.join(fixtures, 'sample', 'package.json')]],
    // R7: a missing --repo is no error any more (the folder that holds .c4mp, found from the working folder, is used)
  ])('%s -> exit 1, message on stderr, empty stdout', async (_label, args) => {
    const r = await runMcp(args, req(1, 'ping'));
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe('');
    expect(r.stdoutLines).toEqual([]);
  });
});
