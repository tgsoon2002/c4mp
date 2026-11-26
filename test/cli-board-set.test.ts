import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import type { BoardFile } from '../src/types';
import { registerBoardCommands } from '../src/cli/board';
import { boardFileFor } from '../src/board/load';
import { todayIso } from '../src/board/dates';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';

// P16-B15: `c4pm board set` (in-process; the real-CLI path is covered by cli-board-add and cli-board).

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
    await program.parseAsync(['node', 'c4pm', ...args]);
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

const it1 = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

const START: unknown = {
  schemaVersion: 1,
  boards: [
    { id: 'main', name: 'Main', groups: [{ id: 'planned', name: 'Planned', status: 'planned' }, { id: 'triage', name: 'Needs triage' }],
      items: [it1('b1', { owner: 'K', due: '2026-12-01', tags: ['api'] }), it1('b2'), it1('b3', { status: 'done', closed: '2026-01-01' })] },
    { id: 'other', name: 'Other', items: [it1('b4')] },
  ],
};

function makeRepo(): { repo: string; file: string; text: () => string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b15-')));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  const file = boardFileFor(tryResolveProject(repo)!);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(START));
  return { repo, file, text: () => fs.readFileSync(file, 'utf8') };
}

const read = (file: string): BoardFile => JSON.parse(fs.readFileSync(file, 'utf8')) as BoardFile;
const find = (f: BoardFile, id: string) => f.boards.flatMap((b) => b.items).find((i) => i.id === id)!;

describe('c4pm board set', () => {
  it('dry run shows before and after of the changed field plus updated, and writes nothing', async () => {
    const { repo, text } = makeRepo();
    const before = text();
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--status', 'in-progress']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("set b1 (board 'main'):");
    expect(r.out).toContain('  status: planned -> in-progress');
    expect(r.out).toContain(`  updated: (none) -> ${todayIso()}`);
    expect(r.out).not.toContain('owner:');
    expect(r.out).toContain('dry run: nothing written');
    expect(text()).toBe(before);
  });

  it('prints no updated line when updated is already today', async () => {
    const { repo, file } = makeRepo();
    const f = read(file);
    find(f, 'b1').updated = todayIso();
    fs.writeFileSync(file, JSON.stringify(f));
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--status', 'in-progress']);
    expect(r.out).toContain('  status: planned -> in-progress');
    expect(r.out).not.toContain('updated:');
  });

  it('--yes changes only that field plus updated (file diff)', async () => {
    const { repo, file } = makeRepo();
    const before = read(file);
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--owner', 'J', '--yes']);
    expect(r.code).toBe(0);
    const after = read(file);
    expect(find(after, 'b1')).toEqual({ ...find(before, 'b1'), owner: 'J', updated: todayIso() });
    expect(find(after, 'b2')).toEqual(find(before, 'b2'));
    expect(after.boards[1]).toEqual(before.boards[1]);
  });

  it('--status done sets closed; leaving done clears it; staying done keeps it', async () => {
    const { repo, file } = makeRepo();
    await run(['board', 'set', 'b2', '--repo', repo, '--status', 'done', '--yes']);
    expect(find(read(file), 'b2')).toMatchObject({ status: 'done', closed: todayIso(), updated: todayIso() });
    await run(['board', 'set', 'b2', '--repo', repo, '--status', 'in-progress', '--yes']);
    expect(find(read(file), 'b2').closed).toBeUndefined();
    await run(['board', 'set', 'b3', '--repo', repo, '--title', 'Renamed', '--yes']);
    expect(find(read(file), 'b3')).toMatchObject({ title: 'Renamed', closed: '2026-01-01' });
  });

  it('none clears optional fields and lists; lists and tags are set from comma text', async () => {
    const { repo, file } = makeRepo();
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--due', 'none', '--owner', 'none', '--tag', 'none', '--yes']);
    expect(r.code).toBe(0);
    const b1 = find(read(file), 'b1');
    expect(b1.due).toBeUndefined();
    expect(b1.owner).toBeUndefined();
    expect(b1.tags).toEqual([]);
    await run(['board', 'set', 'b1', '--repo', repo, '--tag', 'Billing, api', '--depends', 'b2,b4', '--parent', 'b2', '--group', 'triage', '--start', '2026-11-01', '--yes']);
    expect(find(read(file), 'b1')).toMatchObject({ tags: ['billing', 'api'], dependsOn: ['b2', 'b4'], parent: 'b2', group: 'triage', start: '2026-11-01' });
  });

  it('a no-op prints "nothing to change" and leaves the file byte-identical', async () => {
    const { repo, text } = makeRepo();
    const before = text();
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--owner', 'K', '--status', 'planned', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('nothing to change');
    expect(text()).toBe(before);
    expect((await run(['board', 'set', 'b1', '--repo', repo, '--yes'])).out).toBe('nothing to change');
    expect(text()).toBe(before);
  });

  describe('refusals exit 1 and write nothing', () => {
    it.each<[string, string[], RegExp]>([
      ['unknown id', ['nope', '--status', 'done'], /no item 'nope'/],
      ['unknown status', ['b1', '--status', 'todo'], /--status 'todo' should be one of/],
      ['unknown kind', ['b1', '--kind', 'epic'], /--kind 'epic'/],
      ['empty title', ['b1', '--title', ' '], /--title must not be empty/],
      ['parent in another board', ['b1', '--parent', 'b4'], /is in board 'other', not in board 'main'/],
      ['unknown parent', ['b1', '--parent', 'zzz'], /--parent 'zzz' is not an item/],
      ['unknown dependency', ['b1', '--depends', 'zzz'], /--depends 'zzz' is not an item/],
      ['bad date', ['b1', '--due', 'Oct 5'], /--due 'Oct 5' is not a date/],
      ['due before start', ['b1', '--start', '2027-01-01'], /due 2026-12-01 is earlier than start 2027-01-01/],
      ['unknown group', ['b1', '--group', 'nope'], /--group 'nope' is not a group/],
      ['bad tag', ['b1', '--tag', 'no_good'], /tag 'no_good'/],
      ['self parent (cycle)', ['b1', '--parent', 'b1'], /cycle/],
      ['self dependency (cycle)', ['b1', '--depends', 'b1'], /cycle/],
    ])('%s', async (_n, args, message) => {
      const { repo, text } = makeRepo();
      const before = text();
      const r = await run(['board', 'set', args[0], '--repo', repo, ...args.slice(1), '--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(message);
      expect(text()).toBe(before);
    });

    it('a two-step nesting cycle and a dependsOn cycle are refused', async () => {
      const { repo, text } = makeRepo();
      await run(['board', 'set', 'b2', '--repo', repo, '--parent', 'b1', '--depends', 'b1', '--yes']);
      const before = text();
      const nest = await run(['board', 'set', 'b1', '--repo', repo, '--parent', 'b2', '--yes']);
      expect(nest.code).toBe(1);
      expect(nest.err).toContain('nesting');
      const dep = await run(['board', 'set', 'b1', '--repo', repo, '--depends', 'b2', '--yes']);
      expect(dep.code).toBe(1);
      expect(dep.err).toContain('dependsOn');
      expect(text()).toBe(before);
    });
  });

  it('a file with a parse issue is not edited', async () => {
    const { repo, file } = makeRepo();
    const bad = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'M', oops: 1, items: [it1('b1')] }] });
    fs.writeFileSync(file, bad);
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--status', 'done', '--yes']);
    expect(r.code).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(bad);
  });
});
