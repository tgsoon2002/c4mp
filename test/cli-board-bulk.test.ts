import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBoardCli, makeBoardRepo } from './helpers/boardHarness';
import type { BoardRepo } from './helpers/boardHarness';
import { listing } from './helpers/planEditHarness';
import type { BoardFile } from '../src/types';
import { requireProject } from '../src/outputs';

// P18-PB5: board add --from-file. In-process on a tmp repo; the JSON file lives OUTSIDE the repo.

let repo: BoardRepo;
let dir: string;
beforeEach(() => {
  repo = makeBoardRepo('c4pm-pb5-');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-pb5-json-'));
});
afterEach(() => {
  fs.rmSync(repo.root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const spec = (obj: unknown): string => {
  const f = path.join(dir, 'items.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
};
const run = (...args: string[]) => runBoardCli(['add', ...args, '--repo', repo.root]);
const read = (): BoardFile => JSON.parse(repo.text()) as BoardFile;

const FEATURE = {
  items: [
    { ref: 'f', title: 'Quiz generator', kind: 'feature', owner: 'K', links: ['u-api'] },
    { title: 'Build makeQuiz()', kind: 'task', parentRef: 'f' },
    { ref: 'schema', title: 'Quiz schema', kind: 'task', parentRef: 'f', tags: ['api'] },
    { title: 'Tests', kind: 'task', parentRef: 'f', dependsOnRefs: ['schema'], due: '2026-11-30' },
  ],
};

describe('board add --from-file', () => {
  it('dry run lists every item with its minted id and writes nothing', async () => {
    const bytes = repo.text();
    const before = listing(repo.root);
    const r = await run('--from-file', spec(FEATURE), '--board', 'other');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain("add 4 items to board 'other':");
    expect(r.stdout).toContain('  b7  feature  planned  K  Quiz generator  (ref f)');
    expect(r.stdout).toContain('  b8  task  planned  Build makeQuiz()  parent b7');
    expect(r.stdout).toContain('  b10  task  planned  Tests  parent b7  depends b9');
    expect(r.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(repo.text()).toBe(bytes);
    expect(listing(repo.root)).toEqual(before);
  });

  it('--yes creates b7..b10 with the right parents, one write, board untouched elsewhere', async () => {
    const other = read().boards[0];
    const r = await run('--from-file', spec(FEATURE), '--board', 'other', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('written: ');
    const f = read();
    const items = f.boards[1].items;
    expect(items.map((i) => i.id)).toEqual(['b6', 'b7', 'b8', 'b9', 'b10']);
    expect(items.map((i) => i.parent)).toEqual([undefined, undefined, 'b7', 'b7', 'b7']);
    expect(items[4].dependsOn).toEqual(['b9']);
    expect(items[1].links).toEqual(['u-api']);
    expect(f.boards[0]).toEqual(other);
  });

  it('--json: one object with the minted ids', async () => {
    const r = await run('--from-file', spec(FEATURE), '--board', 'other', '--json');
    expect(r.stderr).toBe('');
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, command: 'board add', dryRun: true, written: false, error: null });
    expect(j.minted).toEqual([{ index: 0, id: 'b7', ref: 'f' }, { index: 1, id: 'b8' }, { index: 2, id: 'b9', ref: 'schema' }, { index: 3, id: 'b10' }]);
  });

  it('one bad item refuses the whole file; nothing written', async () => {
    const bytes = repo.text();
    const bad = { items: [{ title: 'ok', kind: 'task' }, { title: 'bad', kind: 'epic' }, { title: 'x', kind: 'task', links: ['nope'] }] };
    const r = await run('--from-file', spec(bad), '--board', 'other', '--yes');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("items[1]: kind 'epic'");
    expect(repo.text()).toBe(bytes);
    const dead = await run('--from-file', spec({ items: [{ title: 'x', kind: 'task', links: ['nope'] }] }), '--board', 'other', '--yes');
    expect(dead.code).toBe(1);
    expect(dead.stderr).toContain("items[0]: link 'nope' matches no plan element");
    expect(repo.text()).toBe(bytes);
  });

  // b508: an unreadable .c4 file is a plan issue, as for `board add --link`: the links check goes on with the files it can read.
  const unreadable = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
  unreadable('an unreadable plan file: links are checked against the readable files', async () => {
    const z = path.join(requireProject(repo.root).planDir, 'z.c4');
    fs.writeFileSync(z, "model { z = system 'Z' { metadata { uid 'u-z' } } }\n");
    fs.chmodSync(z, 0o000);
    try {
      const bytes = repo.text();
      const hidden = await run('--from-file', spec({ items: [{ title: 'x', kind: 'task', links: ['u-z'] }] }), '--board', 'other', '--yes');
      expect(hidden.code).toBe(1);
      expect(hidden.stderr).toContain("items[0]: link 'u-z' matches no plan element");
      expect(repo.text()).toBe(bytes);
      const ok = await run('--from-file', spec({ items: [{ title: 'x', kind: 'task', links: ['u-api'] }] }), '--board', 'other', '--yes');
      expect(ok.code).toBe(0);
      expect(read().boards[1].items.at(-1)?.links).toEqual(['u-api']);
    } finally {
      fs.chmodSync(z, 0o644);
    }
  });

  it('refusals: invalid JSON, missing file, a cycle, mixed options, 2 boards without --board', async () => {
    const bytes = repo.text();
    const inv = await run('--from-file', spec('{ nope'), '--board', 'other');
    expect(inv.code).toBe(1);
    expect(inv.stderr).toContain('is not valid JSON');
    const missing = await run('--from-file', path.join(dir, 'absent.json'), '--board', 'other');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no such file');
    const cyc = { items: [{ ref: 'a', title: 'A', kind: 'task', dependsOnRefs: ['b'] }, { ref: 'b', title: 'B', kind: 'task', dependsOnRefs: ['a'] }] };
    const c = await run('--from-file', spec(cyc), '--board', 'other');
    expect(c.code).toBe(1);
    expect(c.stderr).toContain('dependsOn cycle');
    const mixed = await run('--from-file', spec(FEATURE), '--title', 'x', '--board', 'other');
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain('--title');
    const two = await run('--from-file', spec(FEATURE));
    expect(two.code).toBe(1);
    expect(two.stderr).toContain('2 open boards');   // b443
    expect(repo.text()).toBe(bytes);
  });

  it('--board-name names a NEW board (b565); an existing board refuses it', async () => {
    const bytes = repo.text();
    const refused = await run('--from-file', spec(FEATURE), '--board', 'other', '--board-name', 'X', '--yes');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--board-name only names a NEW board; board 'other' already exists");
    expect(repo.text()).toBe(bytes);
    const ok = await run('--from-file', spec(FEATURE), '--board', 'night-x', '--board-name', 'Night X', '--yes');
    expect(ok.code).toBe(0);
    const made = read().boards.find((b) => b.id === 'night-x');
    expect(made?.name).toBe('Night X');
    expect(made?.items).toHaveLength(4);
  });

  it('single-item add still needs --title and --kind', async () => {
    const a = await run('--kind', 'task');
    expect(a.code).toBe(1);
    expect(a.stderr).toContain("required option '--title <text>' not specified");
    // b445: --json without --from-file is one JSON object, also for a refusal
    const b = await run('--title', 'T', '--json');
    expect(b.code).toBe(1);
    expect(b.stderr).toBe('');
    const j = JSON.parse(b.stdout);
    expect(j.ok).toBe(false);
    expect(j.error.message).toContain("required option '--kind <kind>' not specified");
  });

  it('ids continue after the max of any board, and a new board id creates the board', async () => {
    const r = await run('--from-file', spec({ items: [{ title: 'A', kind: 'task' }] }), '--board', 'fresh', '--yes');
    expect(r.code).toBe(0);
    const f = read();
    expect(f.boards.map((b) => b.id)).toEqual(['main', 'other', 'fresh']);
    expect(f.boards[2].items[0].id).toBe('b7');
  });
});
