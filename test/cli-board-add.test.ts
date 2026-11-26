import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import type { BoardFile } from '../src/types';
import { registerBoardCommands } from '../src/cli/board';
import { nextItemId } from '../src/services/boardEdit';
import { boardFileFor } from '../src/board/load';
import { todayIso } from '../src/board/dates';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import { CLI_JS } from './helpers/runCli';

// P16-B14: `c4mp board add`. Most cases run the command in-process (fast); two cases spawn the real CLI.

const projectRoot = path.resolve(__dirname, '..');
const UID = '3f2a7c1e-0000-4000-8000-00000000abcd';

interface Run { code: number; out: string; err: string }

async function run(args: string[]): Promise<Run> {
  const program = new Command();
  const out: string[] = [];
  const err: string[] = [];
  program.exitOverride().configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  registerBoardCommands(program);
  const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const error = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  process.exitCode = undefined;
  let code = 0;
  try {
    await program.parseAsync(['node', 'c4mp', ...args]);
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    code = 1;
    err.push((e as Error).message);
  } finally {
    process.exitCode = undefined;
    log.mockRestore();
    error.mockRestore();
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PLAN = `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' {
      technology 'Node'
      metadata { uid '${UID}' }
    }
  }
}
`;

function makeRepo(withPlan = false): { repo: string; file: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-b14-')));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  if (withPlan) {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'architecture.c4'), PLAN);
  }
  return { repo, file: boardFileFor(tryResolveProject(repo)!) };
}

const read = (file: string): BoardFile => JSON.parse(fs.readFileSync(file, 'utf8')) as BoardFile;
const itemsOf = (f: BoardFile) => f.boards.flatMap((b) => b.items.map((i) => ({ board: b.id, ...i })));

describe('nextItemId', () => {
  const it1 = (id: string) => ({ id, title: 't', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [] });
  it('is b<max+1> over every board; hand ids and b-prefixed words are ignored', () => {
    expect(nextItemId({ schemaVersion: 1, boards: [] })).toBe('b1');
    const f: BoardFile = { schemaVersion: 1, boards: [
      { id: 'x', name: 'X', items: [it1('b2'), it1('epic-1'), it1('b9x')] },
      { id: 'y', name: 'Y', items: [it1('b10'), it1('b3')] },
    ] };
    expect(nextItemId(f)).toBe('b11');
  });
});

describe('c4mp board add', () => {
  it('dry run prints the item and writes nothing; --yes creates board main with b1, then b2', async () => {
    const { repo, file } = makeRepo();
    const dry = await run(['board', 'add', '--repo', repo, '--title', 'Fix header', '--kind', 'bug']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("create board 'main' (main) and add:");
    expect(dry.out).toContain('  id: b1');
    expect(dry.out).toContain('  title: Fix header');
    expect(dry.out).toContain(`  created: ${todayIso()}`);
    expect(dry.out).toContain('dry run: nothing written. Add --yes to apply.');
    expect(fs.existsSync(file)).toBe(false);

    const one = await run(['board', 'add', '--repo', repo, '--title', 'Fix header', '--kind', 'bug', '--tag', 'API, Billing', '--yes']);
    expect(one.code).toBe(0);
    expect(one.out).toContain("added b1 to board 'main'");
    const two = await run(['board', 'add', '--repo', repo, '--title', 'Second', '--kind', 'task', '--owner', 'K', '--due', '2026-12-01', '--yes']);
    expect(two.out).toContain("added b2 to board 'main'");
    const items = itemsOf(read(file));
    expect(items.map((i) => [i.board, i.id])).toEqual([['main', 'b1'], ['main', 'b2']]);
    expect(items[0]).toMatchObject({ kind: 'bug', status: 'planned', tags: ['api', 'billing'], created: todayIso() });
    expect(items[1]).toMatchObject({ owner: 'K', due: '2026-12-01' });
    expect(fs.existsSync(path.join(repo, '.c4mp', '.gitignore'))).toBe(true);
  });

  it('--board x creates board x with --board-name; ids are minted across all boards; nesting and depends work', async () => {
    const { repo, file } = makeRepo();
    await run(['board', 'add', '--repo', repo, '--title', 'A', '--kind', 'task', '--yes']);
    // one board exists: no --board needed. A new --board id creates a second board:
    const x = await run(['board', 'add', '--repo', repo, '--title', 'B', '--kind', 'feature', '--board', 'x', '--board-name', 'Board X', '--depends', 'b1', '--yes']);
    expect(x.code).toBe(0);
    const child = await run(['board', 'add', '--repo', repo, '--title', 'C', '--kind', 'task', '--board', 'x', '--parent', 'b2', '--status', 'done', '--yes']);
    expect(child.code).toBe(0);
    const f = read(file);
    expect(f.boards.map((b) => [b.id, b.name])).toEqual([['main', 'main'], ['x', 'Board X']]);
    const items = itemsOf(f);
    expect(items.find((i) => i.id === 'b2')).toMatchObject({ board: 'x', dependsOn: ['b1'] });
    expect(items.find((i) => i.id === 'b3')).toMatchObject({ board: 'x', parent: 'b2', status: 'done', closed: todayIso() });
  });

  it('two boards and no --board is refused', async () => {
    const { repo, file } = makeRepo();
    await run(['board', 'add', '--repo', repo, '--title', 'A', '--kind', 'task', '--yes']);
    await run(['board', 'add', '--repo', repo, '--title', 'B', '--kind', 'task', '--board', 'x', '--yes']);
    const text = fs.readFileSync(file, 'utf8');
    const r = await run(['board', 'add', '--repo', repo, '--title', 'C', '--kind', 'task', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('say which with --board');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  describe('refusals exit 1 and write nothing', () => {
    let repo: string;
    let file: string;
    let text: string;
    beforeAll(async () => {
      ({ repo, file } = makeRepo(true));
      await run(['board', 'add', '--repo', repo, '--title', 'A', '--kind', 'task', '--yes']);
      await run(['board', 'add', '--repo', repo, '--title', 'Other', '--kind', 'task', '--board', 'other', '--yes']);
      // now b1 in main, b2 in other; two boards, so every case below names --board
      text = fs.readFileSync(file, 'utf8');
    });

    it.each<[string, string[], RegExp]>([
      ['unknown kind', ['--kind', 'epic'], /--kind 'epic' should be one of/],
      ['unknown status', ['--kind', 'task', '--status', 'todo'], /--status 'todo' should be one of/],
      ['empty title', ['--kind', 'task', '--title', '  '], /--title must not be empty/],
      ['parent in another board', ['--kind', 'task', '--parent', 'b2'], /is in board 'other', not in board 'main'/],
      ['parent that does not exist', ['--kind', 'task', '--parent', 'b99'], /--parent 'b99' is not an item/],
      ['depends on a missing item', ['--kind', 'task', '--depends', 'b1,b99'], /--depends 'b99' is not an item/],
      ['link that is not a plan uid', ['--kind', 'task', '--link', 'nope'], /--link 'nope' matches no plan element/],
      ['group that is not on the board', ['--kind', 'task', '--group', 'triage'], /--group 'triage' is not a group of board 'main'/],
      ['bad date', ['--kind', 'task', '--due', '2026-02-30'], /--due '2026-02-30' is not a date/],
      ['due before start', ['--kind', 'task', '--start', '2026-10-10', '--due', '2026-10-01'], /earlier than --start/],
      ['bad tag', ['--kind', 'task', '--tag', 'ok,bad_tag'], /tag 'bad_tag' should be/],
      ['--board-name for an existing board', ['--kind', 'task', '--board-name', 'Nope'], /only names a NEW board/],
      ['bad new board id', ['--kind', 'task', '--board', '1bad'], /board id '1bad' must match/],
    ])('%s', async (_name, args, message) => {
      const hasTitle = args.includes('--title');
      const full = ['board', 'add', '--repo', repo, ...(hasTitle ? [] : ['--title', 'T']), ...args, ...(args.includes('--board') ? [] : ['--board', 'main']), '--yes'];
      const r = await run(full);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(message);
      expect(r.out).toBe('');
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });

    it('a missing --title or --kind is a usage error', async () => {
      expect((await run(['board', 'add', '--repo', repo, '--kind', 'task'])).code).toBe(1);
      expect((await run(['board', 'add', '--repo', repo, '--title', 'T'])).code).toBe(1);
    });

    it('--link with a plan uid works, and without any plan it says "no plan found"', async () => {
      const ok = await run(['board', 'add', '--repo', repo, '--title', 'L', '--kind', 'task', '--board', 'main', '--link', UID, '--yes']);
      expect(ok.code).toBe(0);
      expect(itemsOf(read(file)).find((i) => i.title === 'L')!.links).toEqual([UID]);

      const bare = makeRepo(false);
      const no = await run(['board', 'add', '--repo', bare.repo, '--title', 'L', '--kind', 'task', '--link', UID, '--yes']);
      expect(no.code).toBe(1);
      expect(no.err).toContain('no plan found');
      expect(fs.existsSync(bare.file)).toBe(false);
    });
  });

  it('refuses to edit a board file that has parse issues, and leaves it untouched', async () => {
    const { repo, file } = makeRepo();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'M', mystery: 1, items: [] }] });
    fs.writeFileSync(file, text);
    const r = await run(['board', 'add', '--repo', repo, '--title', 'T', '--kind', 'task', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown key 'mystery'");
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('a new item cannot close a cycle (nothing points at it yet): parent plus depends on the same item is accepted', async () => {
    const { repo } = makeRepo();
    await run(['board', 'add', '--repo', repo, '--title', 'A', '--kind', 'task', '--yes']);
    const r = await run(['board', 'add', '--repo', repo, '--title', 'B', '--kind', 'task', '--parent', 'b1', '--depends', 'b1', '--yes']);
    expect(r.code).toBe(0);
  });

  it('ids that look like object keys are safe: a hand-written __proto__ item does not break the next id', async () => {
    const { repo, file } = makeRepo();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'M', items: [{ id: '__proto__', title: 'P', kind: 'task', status: 'planned' }] }] }));
    const r = await run(['board', 'add', '--repo', repo, '--title', 'T', '--kind', 'task', '--parent', '__proto__', '--yes']);
    expect(r.code).toBe(0);
    expect(itemsOf(read(file)).map((i) => i.id).sort()).toEqual(['__proto__', 'b1']);
  });

  it('real CLI: dry run, then --yes, exit codes and stdout', () => {
    const { repo, file } = makeRepo();
    const cli = (args: string[]) => spawnSync(process.execPath, [CLI_JS, ...args], {
      cwd: projectRoot, encoding: 'utf8',
    });
    const dry = cli(['board', 'add', '--repo', repo, '--title', 'Spawned', '--kind', 'bug']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run: nothing written');
    expect(fs.existsSync(file)).toBe(false);
    const bad = cli(['board', 'add', '--repo', repo, '--title', 'Spawned', '--kind', 'nope', '--yes']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--kind 'nope'");
    const yes = cli(['board', 'add', '--repo', repo, '--title', 'Spawned', '--kind', 'bug', '--yes']);
    expect(yes.status).toBe(0);
    expect(itemsOf(read(file))[0]).toMatchObject({ id: 'b1', title: 'Spawned' });
  });
});
