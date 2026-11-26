import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { BoardItem } from '../src/types';
import { boardFileFor } from '../src/board/load';
import { nestedOrder } from '../src/query/board';
import { formatBoardItemLine } from '../src/cli/common';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import { CLI_JS } from './helpers/runCli';

// P16-B13: `c4mp board list`. Real CLI through ts-node (transpile-only to keep the spawns quick; tsc runs separately).

const projectRoot = path.resolve(__dirname, '..');

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd: projectRoot, encoding: 'utf8',
  });
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const it1 = (id: string, over: Partial<BoardItem> = {}): BoardItem =>
  ({ id, title: `Title ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

const BOARD = {
  schemaVersion: 1,
  boards: [
    { id: 'main', name: 'Main', items: [
      it1('b1', { kind: 'feature', status: 'in-progress', owner: 'K', title: 'Quiz', tags: ['api', 'billing'], links: ['u1', 'u2'], due: '2000-01-01' }),
      it1('b2', { parent: 'b1', title: 'Child', status: 'done', owner: 'J', due: '2000-01-01' }),
      it1('b3', { kind: 'bug', title: 'Fix header', due: '2999-01-01', tags: ['api'] }),
      it1('b10', { title: 'Tenth', links: ['u1'] }),
    ] },
    { id: 'old', name: 'Old', archived: true, items: [it1('b4', { title: 'Archived item' })] },
    { id: 'later', name: 'Later', items: [it1('b5', { title: 'Other board', kind: 'issue', owner: 'K' })] },
  ],
};

describe('c4mp board list', () => {
  const repos: string[] = [];
  afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });
  const makeRepo = (board?: unknown | string): string => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-b13-')));
    repos.push(repo);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    initProject(repo);
    if (board !== undefined) {
      const f = boardFileFor(tryResolveProject(repo)!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof board === 'string' ? board : JSON.stringify(board));
    }
    return repo;
  };

  let repo: string;
  let before: string[];
  beforeAll(() => { repo = makeRepo(BOARD); before = listing(repo); });

  it('prints boards, nested items indented, natural id order, archived board hidden', () => {
    const r = cli(['board', 'list', '--repo', repo]);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      'board main  Main  (4 items)',
      '  b1  feature  in-progress  K  Quiz  due 2000-01-01  [api, billing]  -> 2 links',
      '    b2  task  done  J  Child  due 2000-01-01',
      '  b3  bug  planned  Fix header  due 2999-01-01  [api]',
      '  b10  task  planned  Tenth  -> 1 link',
      'board later  Later  (1 item)',
      '  b5  issue  planned  K  Other board',
      '',
    ]);
  });

  it.each<[string, string[], string[]]>([
    ['--status', ['--status', 'done'], ['b2']],
    ['--kind', ['--kind', 'bug'], ['b3']],
    ['--tag (case-insensitive)', ['--tag', 'API'], ['b1', 'b3']],
    ['--tags (case-insensitive)', ['--tags', 'API'], ['b1', 'b3']],   // b219
    ['--tags a,b needs both', ['--tags', 'api,billing'], ['b1']],
    ['--owner', ['--owner', 'K'], ['b1', 'b5']],
    ['--overdue (done is not overdue)', ['--overdue'], ['b1']],
    ['--due-before', ['--due-before', '2500-01-01'], ['b1', 'b2']],
    ['--board shows an archived board', ['--board', 'old'], ['b4']],
    ['--board main', ['--board', 'main'], ['b1', 'b2', 'b3', 'b10']],
  ])('filter %s', (_n, args, ids) => {
    const r = cli(['board', 'list', '--repo', repo, '--json', ...args]);
    expect(r.status).toBe(0);
    const got = JSON.parse(r.stdout).boards.flatMap((b: { items: BoardItem[] }) => b.items.map((i) => i.id));
    expect(got).toEqual(ids);
  });

  it('--all lists the archived board, marked (b443)', () => {
    const r = cli(['board', 'list', '--repo', repo, '--all']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('board old  Old  (archived)  (1 item)');
    expect(r.stdout).toContain('board main  Main  (4 items)');
    const j = JSON.parse(cli(['board', 'list', '--repo', repo, '--all', '--json']).stdout);
    expect(j.boards.map((b: { id: string; name: string; archived?: boolean }) => ({ id: b.id, name: b.name, archived: b.archived }))).toEqual([
      { id: 'main', name: 'Main', archived: undefined },
      { id: 'old', name: 'Old', archived: true },
      { id: 'later', name: 'Later', archived: undefined },
    ]);
    expect(j.boards[0]).not.toHaveProperty('archived');
  });

  it('a filtered child whose parent is filtered out is shown at the top level, boards without a match are left out', () => {
    const r = cli(['board', 'list', '--repo', repo, '--status', 'done']);
    expect(r.stdout.split('\n')).toEqual(['board main  Main  (1 item)', '  b2  task  done  J  Child  due 2000-01-01', '']);
  });

  it('--json prints exactly one object on stdout', () => {
    const r = cli(['board', 'list', '--repo', repo, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.boards.map((b: { id: string }) => b.id)).toEqual(['main', 'later']);
    expect(parsed.boards[0].items[0]).toMatchObject({ id: 'b1', links: ['u1', 'u2'], tags: ['api', 'billing'] });
  });

  it('bad filter values and unknown boards exit 1 with a message on stderr', () => {
    for (const args of [['--board', 'nope'], ['--due-before', 'Oct 5']]) {
      const r = cli(['board', 'list', '--repo', repo, ...args]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^error: /);
    }
  });

  it.each([
    ['--status bogus', ['--status', 'bogus'], "error: --status 'bogus' should be one of planned, in-progress, done, abandoned"],
    ['--kind bogus', ['--kind', 'bogus', '--json'], "error: --kind 'bogus' should be one of task, feature, issue, bug, decision, question"],
  ])('b709: %s exits 1 with the allowed values (as board add and set), not an empty list', (_n, args, message) => {
    const r = cli(['board', 'list', '--repo', repo, ...args]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe(message);
  });

  it('no board file: friendly line (text) or an empty object (json), exit 0, nothing created', () => {
    const empty = makeRepo();
    const snap = listing(empty);
    const t = cli(['board', 'list', '--repo', empty]);
    expect(t.status).toBe(0);
    expect(t.stdout).toContain('no board file (c4mp board add --repo R --title T --kind task --yes to start one)');
    const j = cli(['board', 'list', '--repo', empty, '--json']);
    expect(JSON.parse(j.stdout)).toEqual({ boards: [] });
    expect(listing(empty)).toEqual(snap);
  });

  it('a broken file prints its issues on stderr and exits 1', () => {
    const bad = makeRepo('{ nope');
    const r = cli(['board', 'list', '--repo', bad]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not valid JSON');
  });

  it('a file with a parse issue (unknown key) also exits 1 instead of showing partial data', () => {
    const bad = makeRepo({ schemaVersion: 1, boards: [{ id: 'main', name: 'M', surprise: 1, items: [] }] });
    const r = cli(['board', 'list', '--repo', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown key 'surprise'");
  });

  it('list is read-only: the repo listing is unchanged after all the calls above', () => {
    expect(listing(repo)).toEqual(before);
  });
});

describe('nestedOrder / formatBoardItemLine', () => {
  it('a 20000-deep nesting chain is ordered without a stack error', () => {
    const items = Array.from({ length: 20000 }, (_, i) => it1(`b${i}`, i > 0 ? { parent: `b${i - 1}` } : {}));
    const out = nestedOrder(items);
    expect(out).toHaveLength(20000);
    expect(out[19999]).toMatchObject({ depth: 19999 });
  });

  it('items in a parent cycle or with an unknown parent are still listed', () => {
    const out = nestedOrder([it1('b1', { parent: 'b2' }), it1('b2', { parent: 'b1' }), it1('b3', { parent: 'zzz' }), it1('b4', { parent: 'b4' })]);
    expect(out.map((x) => x.item.id).sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('a missing kind or status prints a dash; singular link', () => {
    expect(formatBoardItemLine(it1('b1', { kind: '', status: '', links: ['x'] }))).toBe('b1  -  -  Title b1  -> 1 link');
  });
});
