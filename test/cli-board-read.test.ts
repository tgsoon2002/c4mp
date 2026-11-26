import * as fs from 'fs';
import { runBoardCli, makeBoardRepo } from './helpers/boardHarness';
import type { BoardRepo } from './helpers/boardHarness';
import { listing } from './helpers/planEditHarness';
import { NO_BOARD_MESSAGE } from '../src/cli/common';

// P18-PB3: board show, tree, for. In-process on a tmp repo with a plan and a board file.

let repo: BoardRepo;
beforeEach(() => { repo = makeBoardRepo('c4mp-pb3-'); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const run = (...args: string[]) => runBoardCli([...args, '--repo', repo.root]);

describe('board show', () => {
  it('text: item, board, parent, dependencies, dependents, links with plan facts and a dead link', async () => {
    const r = await run('show', 'b2');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('b2  task  planned  T b2');
    expect(r.stdout).toContain('parent:      b1  T b1  planned');
    expect(r.stdout).toContain('depends on:  b3  T b3  planned');
    expect(r.stdout).toContain('u-api  container  app.api  Api  in-progress  K');
    const b1 = await run('show', 'b1');
    expect(b1.stdout).toContain('children:    b2  T b2  planned');
    expect(b1.stdout).toContain('u-gone  missing');
    expect((await run('show', 'b3')).stdout).toContain('required by: b2  T b2');
  });
  it('--json is one object; unknown id exits 1 on stderr (or as JSON)', async () => {
    const r = await run('show', 'b1', '--json');
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, command: 'board show', item: { id: 'b1' }, board: { id: 'main' } });
    expect(j.linked.map((l: { state: string }) => l.state)).toEqual(['resolved', 'missing']);
    const bad = await run('show', 'zz');
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toBe("error: not-found: no item 'zz'");
    const badJson = await run('show', 'zz', '--json');
    expect(badJson.code).toBe(1);
    expect(JSON.parse(badJson.stdout)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(badJson.stderr).toBe('');
  });
});

describe('board tree', () => {
  it('mermaid: nested subgraph, dependency edge from the item waited for', async () => {
    const r = await run('tree', 'b1');
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('flowchart TD\n')).toBe(true);
    expect(r.stdout).toContain('subgraph n_b1["T b1 (feature)"]');
    expect(r.stdout).toContain('n_b3 --> n_b2');
  });
  it('no id needs --board with 2 open boards; --format text and json; -r', async () => {
    const need = await run('tree');
    expect(need.code).toBe(1);
    expect(need.stderr).toContain('2 boards');
    const text = await run('tree', '--board', 'main', '--format', 'text');
    expect(text.stdout).toContain('b1  [feature]  planned K  T b1\n  b2');
    expect(text.stdout).toContain('b4  [task]');
    expect(text.stdout).toContain('b2 waits for b3');
    const j = JSON.parse((await run('tree', 'b1', '-r', '--format', 'json')).stdout);
    expect(j.nodes.map((n: { id: string }) => n.id)).toEqual(['b1', 'b2', 'b3']);
    expect((await run('tree', 'b1', '--board', 'main')).code).toBe(1);
    expect((await run('tree', 'b1', '--max-nodes', '2')).stderr).toContain('more than --max-nodes 2');
    expect((await run('tree', 'b1', '--format', 'xml')).code).toBe(1);
  });
});

describe('board for', () => {
  it('lists every item linking the element, any board; json too', async () => {
    const r = await run('for', 'app.api');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('app.api  (uid u-api)  is linked by 2 items:');
    expect(r.stdout).toContain('  main  b1  feature');
    expect(r.stdout).toContain('  main  b2  task');
    expect((await run('for', 'Web')).stdout).toContain('  other  b6  task');
    const j = JSON.parse((await run('for', 'u-api', '--json')).stdout);
    expect(j).toMatchObject({ ok: true, target: { uid: 'u-api', fqn: 'app.api' } });
    expect(j.items.map((x: { item: { id: string } }) => x.item.id)).toEqual(['b1', 'b2']);
  });
  it('no match, ambiguous, no uid: exit 1 with the hint', async () => {
    const none = await run('for', 'nothing');
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("error: not-found: no element matches 'nothing'");
    const sys = await run('for', 'app');
    expect(sys.code).toBe(1);
    expect(sys.stderr).toContain("has no uid");
    expect(sys.stderr).toContain('run c4mp plan ids');
  });
});

describe('read-only and no board file', () => {
  it('writes nothing: directory listing and board bytes unchanged', async () => {
    const before = listing(repo.root);
    const bytes = repo.text();
    for (const a of [['show', 'b1'], ['tree', 'b1', '-r'], ['for', 'app.api'], ['tree', '--board', 'main']]) await run(...a);
    expect(listing(repo.root)).toEqual(before);
    expect(repo.text()).toBe(bytes);
  });
  it('no board file: the Phase 16 message, exit 0, nothing created', async () => {
    fs.rmSync(repo.root, { recursive: true, force: true });
    repo = makeBoardRepo('c4mp-pb3b-', null);
    const before = listing(repo.root);
    for (const a of [['show', 'b1'], ['tree', 'b1'], ['for', 'app.api']]) {
      const r = await run(...a);
      expect(r).toMatchObject({ code: 0, stdout: NO_BOARD_MESSAGE, stderr: '' });
    }
    expect(JSON.parse((await run('show', 'b1', '--json')).stdout)).toEqual({ ok: true, command: 'board show', note: NO_BOARD_MESSAGE });
    expect(listing(repo.root)).toEqual(before);
  });
  it('a board file with problems: exit 1 and the issues', async () => {
    fs.writeFileSync(repo.file, '{ nope');
    const r = await run('show', 'b1');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('has problems');
  });
});
