import * as fs from 'fs';
import { runPlanCli, makeRepo, listing } from './helpers/planEditHarness';
import { splitAncestorEdges } from '../src/cli/treeCmd';
import { makeBoardRepo } from './helpers/boardHarness';
import type { BoardRepo } from './helpers/boardHarness';

// P18-T11: `c4mp plan tree`, run in-process on a tmp repo with a hand-written plan.
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  "        plan_fn = function 'planFn' { metadata { status 'planned' signature 'planFn(): void' } }",
  '      }',
  "      orders = component 'Orders' { metadata { status 'done' owner 'K' } }",
  '      -> app.api.orders',
  '    }',
  "    web = container 'Web'",
  '  }',
  "  app.api.orders -> app.api.auth 'uses \"auth\"'",
  "  app.api.auth -> app.web 'calls'",
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
beforeEach(() => { repo = makeRepo('c4mp-tree-', { 'a.c4': PLAN }); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const tree = (...args: string[]) => runPlanCli(['plan', 'tree', ...args, '--repo', repo.root]);

describe('c4mp plan tree', () => {
  it('Phase 28: the layers of a container are listed in declaration order, before its components; -r shows what is inside', async () => {
    // ids sort as a < m < z, the declaration order is z, a, m
    const layered = ['model {', "  app = system 'App' {", "    api = container 'Api' {", "      misc = component 'Misc'",
      "      z_top = layer 'Top' { c_one = component 'One' }", "      a_mid = layer 'Mid'", "      m_low = layer 'Low'", '    }', '  }', '}', ''];
    fs.writeFileSync(repo.files['a.c4'], layered.join('\n'));
    const want = ['app.api.z_top', 'app.api.a_mid', 'app.api.m_low', 'app.api.misc'];
    const ids: Record<string, (out: string) => string[]> = {
      json: out => (JSON.parse(out).nodes as { id: string }[]).map(n => n.id).filter(id => id !== 'app.api'),
      text: out => out.split('\n').filter(l => /^ {2}app\.api\./.test(l)).map(l => l.trim().split(/\s+/)[0]),
      mermaid: out => [...out.matchAll(/^ {4}n_app_api_(\w+?)\[/gm)].map(m => `app.api.${m[1]}`),
    };
    for (const [format, parse] of Object.entries(ids)) {
      expect({ format, ids: parse((await tree('c2', 'api', '--format', format)).stdout) }).toEqual({ format, ids: want });
    }
    expect((await tree('c2', 'api', '--format', 'json', '-r')).stdout).toContain('app.api.z_top.c_one');
  });

  it('c2 default: one level down, declared edge, the leaving relation counted in a comment', async () => {
    const r = await tree('c2', 'api');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.startsWith('flowchart TD\n')).toBe(true);
    expect(r.stdout).toContain('%% 1 relation(s) leave this view');
    expect(r.stdout).toContain('subgraph n_app_api["Api (container)"]');
    expect(r.stdout).toContain('n_app_api_auth["Auth<br/>component"]');
    expect(r.stdout).toContain('n_app_api_orders["Orders<br/>component · done · K"]:::done');
    expect(r.stdout).toContain('n_app_api_orders -->|"uses #quot;auth#quot;"| n_app_api_auth');
    expect(r.stdout).not.toContain('planFn');
    expect(r.stdout).not.toContain('```');
  });

  it('-r adds planned code; --depth 2 at c1; --fence; --direction LR', async () => {
    expect((await tree('c2', 'api', '-r')).stdout).toContain('planFn');
    const d2 = await tree('c1', 'app', '--depth', '2');
    expect(d2.stdout).toContain('Auth');
    expect(d2.stdout).not.toContain('planFn');
    const fenced = await tree('c2', 'api', '--fence', '--direction', 'lr');
    expect(fenced.stdout.startsWith('```mermaid\nflowchart LR\n')).toBe(true);
    expect(fenced.stdout.endsWith('```')).toBe(true);
  });

  it('the edge between a box and its own descendant is dropped from Mermaid, with a comment (documented choice)', async () => {
    // Api declares `-> app.api.orders` in its own body: parent -> descendant.
    const r = await tree('c2', 'api');
    expect(r.stdout).toContain('%% 1 relation(s) between a box and its own descendant are not drawn');
    expect(r.stdout).not.toMatch(/n_app_api -->/);
    // text and json keep it
    const json = JSON.parse((await tree('c2', 'api', '--format', 'json')).stdout);
    expect(json.edges).toContainEqual({ from: 'app.api', to: 'app.api.orders' });
    expect((await tree('c2', 'api', '--format', 'text')).stdout).toContain('app.api -> app.api.orders');
    // helper on its own: sibling edge kept, both directions dropped
    const g = {
      nodes: [{ id: 'p', label: 'P', kind: 'container' }, { id: 'c', label: 'C', kind: 'component', parent: 'p' }, { id: 's', label: 'S', kind: 'component', parent: 'p' }],
      edges: [{ from: 'p', to: 'c' }, { from: 'c', to: 'p' }, { from: 'c', to: 's' }],
    };
    expect(splitAncestorEdges(g)).toEqual({ kept: [{ from: 'c', to: 's' }], dropped: 2 });
  });

  it('--format text is the AI form; --format json is one object', async () => {
    const text = await tree('c2', 'api', '--format', 'text');
    expect(text.stdout.split('\n')).toEqual([
      'app.api  [container]',
      '  app.api.auth  [component]',
      '  app.api.orders  [component]  done K',
      'relations:',
      '  app.api -> app.api.orders',
      '  app.api.orders -> app.api.auth  uses "auth"',
    ]);
    const j = await tree('c2', 'api', '--format', 'json', '--external');
    const obj = JSON.parse(j.stdout);
    expect(Object.keys(obj).sort()).toEqual(['edges', 'nodes', 'outside', 'truncated']);
    expect(obj.nodes.filter((n: { outside?: boolean }) => n.outside).map((n: { kind: string }) => n.kind)).toEqual(['container']);
    expect(obj.edges.some((e: { dashed?: boolean }) => e.dashed)).toBe(true);
  });

  it('P20-T9: --external stubs keep the real kind (person, external) in text, JSON and Mermaid', async () => {
    fs.writeFileSync(repo.files['a.c4'], PLAN.replace("  app.api.auth -> app.web 'calls'", "  app.api.auth -> app.web 'calls'\n  admin = person 'Admin'\n  cloud = external 'Cloud'\n  admin -> app 'manages'\n  app -> cloud 'hosted on'"));
    const text = (await tree('c1', 'app', '--format', 'text', '--external')).stdout;
    expect(text).toContain('external:');
    expect(text).toContain('\n  admin  [person]\n');
    expect(text).toContain('\n  cloud  [external]\n');
    const nodes = JSON.parse((await tree('c1', 'app', '--format', 'json', '--external')).stdout).nodes;
    expect(nodes.filter((n: { outside?: boolean }) => n.outside).map((n: { id: string; kind: string }) => `${n.id}:${n.kind}`)).toContain('admin:person');
    const mmd = (await tree('c1', 'app', '--external')).stdout;
    expect(mmd).toContain('n_admin["Admin<br/>person"]:::external');
    // default output has no stubs
    expect((await tree('c1', 'app', '--format', 'text')).stdout).not.toContain('external:');
  });

  it('refusals exit 1 on stderr: wrong level, unknown target, bad options, max-nodes, no plan', async () => {
    const wrong = await tree('c3', 'api');
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).toContain('use level c2');
    const unknown = await tree('c2', 'apx');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no element matches 'apx'");
    expect(unknown.stderr).toContain('app.api');
    expect((await tree('c2', 'api', '-r', '--depth', '2')).stderr).toContain('cannot be used together');
    expect((await tree('c2', 'api', '--depth', '0')).code).toBe(1);
    expect((await tree('c9', 'api')).stderr).toContain('level must be c1, c2 or c3');
    expect((await tree('c2', 'api', '--format', 'svg')).code).toBe(1);
    const cap = await tree('c1', 'app', '-r', '--max-nodes', '2');
    expect(cap.code).toBe(1);
    expect(cap.stderr).toContain('--max-nodes 2');
    const none = makeRepo('c4mp-tree-none-', {});
    const noPlan = await runPlanCli(['plan', 'tree', 'c2', 'api', '--repo', none.root]);
    expect(noPlan.code).toBe(1);
    expect(noPlan.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan');
    fs.rmSync(none.root, { recursive: true, force: true });
  });

  it('writes nothing: listing and plan bytes identical', async () => {
    const before = listing(repo.root);
    const bytes = fs.readFileSync(repo.files['a.c4']);
    await tree('c1', 'app', '-r');
    expect(listing(repo.root)).toEqual(before);
    expect(fs.readFileSync(repo.files['a.c4']).equals(bytes)).toBe(true);
  });
});

// P18-PB6: tree --boards
describe('c4mp plan tree --boards', () => {
  let br: BoardRepo;
  beforeEach(() => { br = makeBoardRepo('c4mp-tree-boards-'); });
  afterEach(() => { fs.rmSync(br.root, { recursive: true, force: true }); });
  const t = (...args: string[]) => runPlanCli(['plan', 'tree', ...args, '--repo', br.root]);

  it('adds one dashed node per linking b-item, labelled "b1 feature planned"', async () => {
    const r = await t('c1', 'app', '--boards');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('n_board_b1["b1 feature planned<br/>board-item"]');
    expect(r.stdout).toContain('n_board_b2["b2 task planned<br/>board-item"]');
    expect(r.stdout).toContain('n_board_b6["b6 task planned<br/>board-item"]');
    expect(r.stdout).toContain('n_board_b1 -.-> n_app_api');
    expect(r.stdout).toContain('n_board_b6 -.-> n_app_web');
    expect(r.stdout.match(/n_board_b1\[/g)).toHaveLength(1);
  });

  it('text and json forms carry the board items too', async () => {
    const text = await t('c1', 'app', '--boards', '--format', 'text');
    expect(text.stdout).toContain('board items:\n  b1 feature planned');
    expect(text.stdout).toContain('board links:\n  b1 -> app.api');
    expect(text.stdout).not.toContain('board/b1');
    const j = JSON.parse((await t('c1', 'app', '--boards', '--format', 'json')).stdout);
    expect(j.nodes.filter((n: { kind: string }) => n.kind === 'board-item').map((n: { id: string }) => n.id)).toEqual(['board/b1', 'board/b2', 'board/b6']);
  });

  it('without the flag the output is byte-identical to before (board file present or not)', async () => {
    const plain = await t('c1', 'app', '-r');
    expect(plain.stdout).not.toContain('board');
    fs.rmSync(br.file);
    const without = await t('c1', 'app', '-r');
    expect(without.stdout).toBe(plain.stdout);
  });

  it('no board file: not an error, one note on stderr, same graph, nothing created', async () => {
    fs.rmSync(br.file);
    const before = listing(br.root);
    const plain = await t('c1', 'app');
    const r = await t('c1', 'app', '--boards');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(plain.stdout);
    expect(r.stderr).toBe('note: no board file; --boards adds nothing');
    expect(listing(br.root)).toEqual(before);
  });

  it('a board file with problems is a note, and a bigger-than-max graph is refused', async () => {
    const big = await t('c1', 'app', '--boards', '--max-nodes', '3');
    expect(big.code).toBe(1);
    expect(big.stderr).toContain('with the board items is more than --max-nodes 3');
    fs.writeFileSync(br.file, '{ nope');
    const bad = await t('c1', 'app', '--boards');
    expect(bad.code).toBe(0);
    expect(bad.stderr).toContain('has problems');
  });
});
