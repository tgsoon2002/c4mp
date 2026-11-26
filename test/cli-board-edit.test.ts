import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerBoardCommands } from '../src/cli/board';
import { runBoardCli, makeBoardRepo } from './helpers/boardHarness';
import type { BoardRepo } from './helpers/boardHarness';
import type { BoardFile, BoardItem } from '../src/types';

// Phase 24 board CLI round 2: field edits of board add / board set. In-process on a tmp repo (START_BOARD).

let repo: BoardRepo;
beforeEach(() => { repo = makeBoardRepo('c4pm-p24-'); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const run = (...args: string[]) => runBoardCli([...args, '--repo', repo.root]);
const read = (): BoardFile => JSON.parse(repo.text()) as BoardFile;
const itemOf = (id: string): BoardItem => read().boards.flatMap((b) => b.items).find((i) => i.id === id)!;

describe('--tags and the old --tag (b219)', () => {
  it('add: --tags and --tag give the same item', async () => {
    expect((await run('add', '--title', 'A', '--kind', 'task', '--board', 'main', '--tags', 'API, billing', '--yes')).code).toBe(0);
    expect((await run('add', '--title', 'B', '--kind', 'task', '--board', 'main', '--tag', 'API, billing', '--yes')).code).toBe(0);
    expect(itemOf('b7').tags).toEqual(['api', 'billing']);
    expect(itemOf('b8').tags).toEqual(['api', 'billing']);
  });

  it('set: --tags replaces, none clears; --tag still works', async () => {
    expect((await run('set', 'b5', '--tags', 'a,b', '--yes')).code).toBe(0);
    expect(itemOf('b5').tags).toEqual(['a', 'b']);
    expect((await run('set', 'b5', '--tag', 'c', '--yes')).code).toBe(0);
    expect(itemOf('b5').tags).toEqual(['c']);
    expect((await run('set', 'b5', '--tags', 'none', '--yes')).code).toBe(0);
    expect(itemOf('b5').tags).toEqual([]);
  });

  it('both spellings at once are refused, nothing written', async () => {
    const before = repo.text();
    const r = await run('set', 'b5', '--tags', 'a', '--tag', 'b', '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('give --tags or --tag, not both');
    expect(repo.text()).toBe(before);
  });

  it('help shows --tags and hides --tag', () => {
    const program = new Command();
    registerBoardCommands(program);
    const boardCmd = program.commands.find((c) => c.name() === 'board')!;
    for (const name of ['add', 'set', 'list']) {
      const help = boardCmd.commands.find((c) => c.name() === name)!.helpInformation();
      expect(help).toContain('--tags <tags>');
      expect(help).not.toMatch(/--tag </);
    }
  });
});

describe('board add --json (b445)', () => {
  it('dry run: one object with minted [{index 0, id b7}], nothing written', async () => {
    const before = repo.text();
    const r = await run('add', '--title', 'A', '--kind', 'task', '--board', 'main', '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, command: 'board add', dryRun: true, written: false, minted: [{ index: 0, id: 'b7' }], error: null });
    expect(j.changes[0]).toBe("add to board 'main':");
    expect(j.file).toMatch(/board\.json$/);
    expect(repo.text()).toBe(before);
  });

  it('--yes writes it and says written: true', async () => {
    const r = await run('add', '--title', 'A', '--kind', 'task', '--board', 'main', '--tags', 'x', '--json', '--yes');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, dryRun: false, written: true, minted: [{ index: 0, id: 'b7' }] });
    expect(read().boards[0].items.map((i) => i.id)).toContain('b7');
    expect(itemOf('b7').tags).toEqual(['x']);
  });

  it('a refusal is one object, exit 1, empty stderr', async () => {
    const before = repo.text();
    const r = await run('add', '--title', 'A', '--kind', 'epic', '--board', 'main', '--json');
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe('invalid');
    expect(j.error.message).toMatch(/--kind 'epic'/);
    const two = JSON.parse((await run('add', '--title', 'A', '--kind', 'task', '--json')).stdout);
    expect(two.error.message).toContain('say which with --board');
    expect(repo.text()).toBe(before);
  });

  it('text output without --json is unchanged', async () => {
    const r = await run('add', '--title', 'A', '--kind', 'task', '--board', 'main', '--yes');
    expect(r.stdout.split('\n').slice(-1)[0]).toBe("added b7 to board 'main'");
  });
});

describe('description: replace, append, prepend (b440)', () => {
  it('append onto none is the text; then append and prepend add a blank line', async () => {
    expect((await run('set', 'b5', '--append-description', 'one', '--yes')).code).toBe(0);
    expect(itemOf('b5').description).toBe('one');
    expect((await run('set', 'b5', '--append-description', 'two', '--yes')).code).toBe(0);
    expect((await run('set', 'b5', '--prepend-description', 'zero', '--yes')).code).toBe(0);
    expect(itemOf('b5').description).toBe('zero\n\none\n\ntwo');
    // the word none is plain text for append (only --description none clears)
    expect((await run('set', 'b5', '--append-description', 'none', '--yes')).code).toBe(0);
    expect(itemOf('b5').description).toBe('zero\n\none\n\ntwo\n\nnone');
  });

  it('the -file forms read the file', async () => {
    const f = path.join(repo.root, 'more.txt');
    fs.writeFileSync(f, 'from file\n');
    expect((await run('set', 'b5', '--description', 'start', '--yes')).code).toBe(0);
    expect((await run('set', 'b5', '--append-description-file', f, '--yes')).code).toBe(0);
    expect((await run('set', 'b5', '--prepend-description-file', f, '--yes')).code).toBe(0);
    expect(itemOf('b5').description).toBe('from file\n\nstart\n\nfrom file');
  });

  it('dry run shows old -> new and writes nothing', async () => {
    const before = repo.text();
    const r = await run('set', 'b5', '--append-description', 'one');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('description: (none) -> one');
    expect(repo.text()).toBe(before);
  });

  it.each<[string, string[], RegExp]>([
    ['two description options', ['--description', 'a', '--append-description', 'b'], /give only one description option, not both --description and --append-description/],
    ['append and prepend', ['--append-description', 'a', '--prepend-description', 'b'], /not both --append-description and --prepend-description/],
    ['empty text to add', ['--append-description', ' '], /--append-description: the text to add is empty/],
    ['joined text over the limit', ['--append-description', 'x'.repeat(8000)], /limit is 8000/],
    ['missing file', ['--append-description-file', '/nonexistent/zz.txt'], /--append-description-file: cannot read/],
  ])('refuses %s, nothing written', async (_n, args, re) => {
    expect((await run('set', 'b5', '--description', 'old', '--yes')).code).toBe(0);
    const before = repo.text();
    const r = await run('set', 'b5', ...args, '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(repo.text()).toBe(before);
  });

  it('board add has no append or prepend option', async () => {
    const r = await run('add', '--title', 'A', '--kind', 'task', '--board', 'main', '--append-description', 'x');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option '--append-description'/);
  });
});

describe('add and remove list values (b441)', () => {
  it('add-tag and remove-tag change only those tags', async () => {
    expect((await run('set', 'b5', '--add-tag', 'api,web', '--yes')).code).toBe(0);
    expect(itemOf('b5').tags).toEqual(['api', 'web']);
    expect((await run('set', 'b5', '--remove-tag', 'web', '--add-tag', 'ui', '--add-tag', 'API', '--yes')).code).toBe(0);
    expect(itemOf('b5').tags).toEqual(['api', 'ui']);
  });

  it('add-depends checks the ids; remove-depends takes a dangling id', async () => {
    expect((await run('set', 'b5', '--add-depends', 'b4', '--yes')).code).toBe(0);
    expect(itemOf('b5').dependsOn).toEqual(['b4']);
    const before = repo.text();
    const bad = await run('set', 'b5', '--add-depends', 'zz', '--yes');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/--add-depends 'zz' is not an item/);
    expect(repo.text()).toBe(before);
    const f = read();
    f.boards[0].items.find((i) => i.id === 'b5')!.dependsOn = ['ghost'];
    fs.writeFileSync(repo.file, JSON.stringify(f, null, 2) + '\n');
    expect((await run('set', 'b5', '--remove-depends', 'ghost', '--yes')).code).toBe(0);
    expect(itemOf('b5').dependsOn).toEqual([]);
  });

  it('add-depends that closes a cycle is refused', async () => {
    const before = repo.text();
    const r = await run('set', 'b3', '--add-depends', 'b2', '--yes');   // b2 already depends on b3
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cycle/);
    expect(repo.text()).toBe(before);
  });

  it('remove-doc matches by path or url; the last one removed drops docs', async () => {
    expect((await run('set', 'b5', '--add-doc', 'Spec=path:docs/a.md,url:https://x.y/s', '--yes')).code).toBe(0);
    expect(itemOf('b5').docs).toEqual([{ label: 'Spec', path: 'docs/a.md' }, { url: 'https://x.y/s' }]);
    expect((await run('set', 'b5', '--remove-doc', 'path:docs/a.md', '--yes')).code).toBe(0);
    expect(itemOf('b5').docs).toEqual([{ url: 'https://x.y/s' }]);
    expect((await run('set', 'b5', '--remove-doc', 'Other=url:https://x.y/s', '--yes')).code).toBe(0);
    expect(itemOf('b5')).not.toHaveProperty('docs');
  });

  it('a value not there: a note, nothing to change, exit 0', async () => {
    const before = repo.text();
    const r = await run('set', 'b5', '--remove-tag', 'nope', '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toEqual(["  note: b5 has no tag 'nope' (nothing to remove)", 'nothing to change']);
    expect(repo.text()).toBe(before);
    const mixed = await run('set', 'b5', '--remove-tag', 'nope', '--add-tag', 'x');
    expect(mixed.stdout).toContain("  note: b5 has no tag 'nope' (nothing to remove)");
    expect(mixed.stdout).toContain('tags: (none) -> x');
  });

  it.each<[string, string[], RegExp]>([
    ['--tags with --add-tag', ['--tags', 'a', '--add-tag', 'b'], /give --tags or --add-tag\/--remove-tag, not both/],
    ['--depends with --remove-depends', ['--depends', 'b4', '--remove-depends', 'b4'], /give --depends or --add-depends\/--remove-depends, not both/],
    ['--doc with --add-doc', ['--doc', 'path:a.md', '--add-doc', 'path:b.md'], /give --doc or --add-doc\/--remove-doc, not both/],
    ['the same value added and removed', ['--add-tag', 'x', '--remove-tag', 'x'], /--add-tag and --remove-tag both name 'x'/],
    ['a bad tag', ['--add-tag', 'Bad_1'], /tag 'bad_1' should be/],
  ])('refuses %s, nothing written', async (_n, args, re) => {
    const before = repo.text();
    const r = await run('set', 'b5', ...args, '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(repo.text()).toBe(before);
  });
});
