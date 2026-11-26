import * as fs from 'fs';
import { runBoardCli, makeBoardRepo } from './helpers/boardHarness';
import type { BoardRepo } from './helpers/boardHarness';
import { listing } from './helpers/planEditHarness';
import { todayIso } from '../src/board/dates';
import type { BoardFile } from '../src/types';

// P18-PB4: board remove, move, group add|remove|order. In-process on a tmp repo; dry run vs --yes, refusals, JSON.

let repo: BoardRepo;
beforeEach(() => { repo = makeBoardRepo('c4pm-pb4-'); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const run = (...args: string[]) => runBoardCli([...args, '--repo', repo.root]);
const read = (): BoardFile => JSON.parse(repo.text()) as BoardFile;
const ids = (f: BoardFile, board: string) => f.boards.find((b) => b.id === board)!.items.map((i) => i.id).sort();

/** Normalise the fixture through the writer once (a no-op edit would not rewrite), so later diffs show only the intended change. */
async function normalise(): Promise<void> {
  expect((await run('group', 'add', 'Tmp', '--board', 'main', '--yes')).code).toBe(0);
  expect((await run('group', 'remove', 'Tmp', '--board', 'main', '--yes')).code).toBe(0);
}

describe('dry run is the default', () => {
  it.each([
    [['remove', 'b4']],
    [['move', 'b1', '--board', 'other']],
    [['group', 'add', 'QA', '--board', 'main']],
    [['rename', 'main', '--id', 'core', '--name', 'Core']],
    [['archive', 'other']],
    [['group', 'order', 'Needs triage,Planned', '--board', 'main']],
  ])('%j prints the change and writes nothing', async (args) => {
    const bytes = repo.text();
    const before = listing(repo.root);
    const r = await run(...args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(r.stderr).toBe('');
    expect(repo.text()).toBe(bytes);
    expect(listing(repo.root)).toEqual(before);
  });
});

describe('--yes writes only the intended change', () => {
  it('remove', async () => {
    await normalise();
    const before = read();
    const r = await run('remove', 'b4', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('remove b4');
    expect(r.stdout).toContain('written: ');
    const after = read();
    expect(ids(after, 'main')).toEqual(['b1', 'b2', 'b3', 'b5']);
    expect(after.boards[1]).toEqual(before.boards[1]);
  });
  it('rename: id and name change, items keep their ids, other boards untouched; --json reports it', async () => {
    await normalise();
    const before = read();
    const j = JSON.parse((await run('rename', 'main', '--id', 'core', '--name', 'Core', '--json')).stdout);
    expect(j).toMatchObject({ ok: true, command: 'board rename', dryRun: true, written: false });
    const r = await run('rename', 'main', '--id', 'core', '--name', 'Core', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("id 'main' -> 'core'");
    const after = read();
    expect(after.boards[0]).toMatchObject({ id: 'core', name: 'Core' });
    expect(ids(after, 'core')).toEqual(ids(before, 'main'));
    expect(after.boards[1]).toEqual(before.boards[1]);
  });
  it('move: nest moves with ids kept, updated set only on moved items', async () => {
    await normalise();
    const r = await run('move', 'b1', '--board', 'other', '--yes');
    expect(r.code).toBe(0);
    const after = read();
    expect(ids(after, 'other')).toEqual(['b1', 'b2', 'b3', 'b6']);
    expect(ids(after, 'main')).toEqual(['b4', 'b5']);
    const items = after.boards.flatMap((b) => b.items);
    expect(items.filter((i) => i.updated === todayIso()).map((i) => i.id).sort()).toEqual(['b1', 'b2', 'b3']);
  });
  it('move of a nested item: alone, nest link becomes a dependency (b444)', async () => {
    await normalise();
    const bytes = repo.text();
    const dry = await run('move', 'b2', '--board', 'other');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("move b2  T b2  from board 'main' to board 'other' (alone: it was nested under b1)");
    expect(dry.stdout).toContain('  nest link b1 > b2 becomes a dependency: b1 depends on b2');
    expect(repo.text()).toBe(bytes);
    const j = JSON.parse((await run('move', 'b2', '--board', 'other', '--json')).stdout);
    expect(j.changes).toEqual(dry.stdout.split('\n').slice(0, -1));
    expect((await run('move', 'b2', '--board', 'other', '--yes')).code).toBe(0);
    const after = read();
    expect(ids(after, 'other')).toEqual(['b2', 'b6']);
    const b1 = after.boards[0].items.find((i) => i.id === 'b1')!;
    const b2 = after.boards[1].items.find((i) => i.id === 'b2')!;
    expect(b1.dependsOn).toEqual(['b2']);
    expect(b2.parent).toBeUndefined();
  });
  it('group add / remove / order change only the groups array', async () => {
    await normalise();
    const items = JSON.stringify(read().boards[0].items);
    expect((await run('group', 'add', 'Blocked by QA', '--board', 'main', '--yes')).code).toBe(0);
    expect(read().boards[0].groups!.map((g) => g.id)).toEqual(['planned', 'triage', 'blocked-by-qa']);
    expect((await run('group', 'order', 'blocked by qa,planned,needs triage', '--board', 'main', '--yes')).code).toBe(0);
    expect(read().boards[0].groups!.map((g) => g.id)).toEqual(['blocked-by-qa', 'planned', 'triage']);
    expect((await run('group', 'remove', 'Blocked by QA', '--board', 'main', '--yes')).code).toBe(0);
    expect(read().boards[0].groups!.map((g) => g.id)).toEqual(['planned', 'triage']);
    expect(JSON.stringify(read().boards[0].items)).toBe(items);
  });
  it('archive, unarchive and delete change only the boards array (b443)', async () => {
    await normalise();
    const before = read();
    const a = await run('archive', 'other', '--yes');
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("archive board 'other' (Other): its 1 item stay");
    let after = read();
    expect(after.boards[1].archived).toBe(true);
    expect(after.boards[1].items).toEqual(before.boards[1].items);
    expect(after.boards[0]).toEqual(before.boards[0]);
    expect((await run('unarchive', 'other', '--yes')).code).toBe(0);
    after = read();
    expect(after.boards[1]).not.toHaveProperty('archived');
    expect(after.boards[1]).toEqual(before.boards[1]);
    // an empty board made with commands, then deleted
    expect((await run('add', '--title', 'X', '--kind', 'task', '--board', 'tmp', '--yes')).code).toBe(0);
    expect((await run('remove', 'b7', '--yes')).code).toBe(0);
    const withTmp = read();
    expect(withTmp.boards.map((b) => b.id)).toEqual(['main', 'other', 'tmp']);
    const d = await run('delete', 'tmp', '--yes');
    expect(d.code).toBe(0);
    expect(d.stdout).toContain("delete board 'tmp' (tmp)");
    after = read();
    expect(after.boards.map((b) => b.id)).toEqual(['main', 'other']);
    expect(after.boards).toEqual(withTmp.boards.slice(0, 2));
  });
  it('archive twice: nothing to change (b443)', async () => {
    expect((await run('archive', 'other', '--yes')).code).toBe(0);
    const bytes = repo.text();
    const r = await run('archive', 'other', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('nothing to change');
    expect(repo.text()).toBe(bytes);
  });
  it('board add and move to an archived board are refused with the unarchive hint (b443)', async () => {
    expect((await run('archive', 'other', '--yes')).code).toBe(0);
    const bytes = repo.text();
    const add = await run('add', '--title', 'X', '--kind', 'task', '--board', 'other', '--yes');
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("board 'other' is archived; unarchive it first (c4mp board unarchive other)");
    const move = await run('move', 'b5', '--board', 'other', '--yes');
    expect(move.code).toBe(1);
    expect(move.stderr).toContain('unarchive it first');
    // without --board the only OPEN board takes the add
    const solo = await run('add', '--title', 'X', '--kind', 'task');
    expect(solo.code).toBe(0);
    expect(solo.stdout).toContain("add to board 'main':");
    expect(repo.text()).toBe(bytes);
  });
  it('--json of archive is one object (b443)', async () => {
    const r = await run('archive', 'other', '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, command: 'board archive', dryRun: true, written: false, error: null });
    expect(j.changes[0]).toContain("archive board 'other'");
  });
  it('--board is optional when only one board is open', async () => {
    fs.writeFileSync(repo.file, JSON.stringify({ schemaVersion: 1, boards: [{ id: 'solo', name: 'Solo', items: [] }] }));
    expect((await run('group', 'add', 'QA', '--yes')).code).toBe(0);
    expect(read().boards[0].groups!.map((g) => g.id)).toEqual(['planned', 'in-progress', 'done', 'qa']);
    const two = await run('group', 'add', 'X');   // already one board: fine; now make two
    expect(two.code).toBe(0);
  });
});

describe('refusals exit 1 and write nothing', () => {
  it.each([
    [['remove', 'b3'], 'b2 depends on b3'],
    [['remove', 'b1'], 'b2 is nested under b1'],
    [['remove', 'zz'], "error: not-found: no item 'zz'"],
    [['move', 'b1', '--board', 'nope'], "no board 'nope'"],
    [['move', 'b4', '--board', 'other'], "group 'triage' is not a group of board 'other'"],
    [['group', 'add', 'needs TRIAGE', '--board', 'main'], 'already has a group'],
    [['group', 'remove', 'Planned', '--board', 'main'], 'built in'],
    [['group', 'remove', 'Needs triage', '--board', 'main'], 'b4 is in group triage'],
    [['group', 'order', 'Planned', '--board', 'main'], "missing from the list"],
    [['group', 'add', 'X'], '2 open boards'],
    [['rename', 'nope', '--name', 'X'], "error: not-found: no board 'nope'"],
    [['rename', 'main'], 'say what to change'],
    [['rename', 'main', '--id', 'other'], "'other' already exists"],
    [['delete', 'main'], 'still has 5 items'],   // b443
    [['archive', 'nope'], "error: not-found: no board 'nope'"],
  ])('%j', async (args, text) => {
    const bytes = repo.text();
    const r = await run(...args, '--yes');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(text);
    expect(repo.text()).toBe(bytes);
  });
  it('--json: one object on stdout, empty stderr, full reasons', async () => {
    const r = await run('remove', 'b3', '--json');
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, command: 'board remove', error: { code: 'invalid', reasons: ['b2 depends on b3'] } });
    const ok = JSON.parse((await run('remove', 'b4', '--json')).stdout);
    expect(ok).toMatchObject({ ok: true, dryRun: true, written: false, error: null });
    expect(ok.changes[0]).toContain('remove b4');
  });
  it('text reasons are capped at 10 lines', async () => {
    const items = Array.from({ length: 15 }, (_, k) => ({ id: `c${k}`, title: 'c', kind: 'task', status: 'planned', parent: 'b5', dependsOn: [], links: [], tags: [] }));
    const f = read();
    f.boards[0].items.push(...items);
    fs.writeFileSync(repo.file, JSON.stringify(f));
    const r = await run('remove', 'b5');
    expect(r.stderr.split('\n')).toHaveLength(1 + 10 + 1);
    expect(r.stderr).toContain('... 6 more (use --json for all)');   // 15 children + 1 dependent = 16 reasons
  });
  it('a damaged board file is not touched', async () => {
    fs.writeFileSync(repo.file, '{ nope');
    const r = await run('remove', 'b1', '--yes');
    expect(r.code).toBe(1);
    expect(repo.text()).toBe('{ nope');
  });
});

describe('board set --group takes a name (what the Kanban prints)', () => {
  it('by name, and --status with --group none', async () => {
    const r = await run('set', 'b5', '--group', 'needs triage', '--yes');
    expect(r.code).toBe(0);
    expect(read().boards[0].items.find((i) => i.id === 'b5')!.group).toBe('triage');
    const back = await run('set', 'b5', '--status', 'in-progress', '--group', 'none', '--yes');
    expect(back.code).toBe(0);
    const b5 = read().boards[0].items.find((i) => i.id === 'b5')!;
    expect([b5.status, b5.group]).toEqual(['in-progress', undefined]);
  });
});
