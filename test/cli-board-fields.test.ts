import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import type { BoardFile } from '../src/types';
import { registerBoardCommands } from '../src/cli/board';
import { boardFileFor } from '../src/board/load';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import { parseDocSpec, splitDocSpecs } from '../src/board/fields';

// P16-B42: description, docs, outcome, size, sprint, priority on board add / set / show / bulk add (in-process).

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

function makeRepo(start?: unknown): { repo: string; file: string; data: () => BoardFile; text: () => string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b42-')));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), '# x\n');
  initProject(repo);
  const file = boardFileFor(tryResolveProject(repo)!);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (start !== undefined) fs.writeFileSync(file, typeof start === 'string' ? start : JSON.stringify(start, null, 2) + '\n');
  return { repo, file, text: () => fs.readFileSync(file, 'utf8'), data: () => JSON.parse(fs.readFileSync(file, 'utf8')) as BoardFile };
}

const OLD = { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [{ id: 'b1', title: 'T', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [] }] }] };

describe('doc spec parsing', () => {
  it.each([
    ['path:docs/x.md', { path: 'docs/x.md' }],
    ['Design=path:docs/x.md', { label: 'Design', path: 'docs/x.md' }],
    ['url:https://a.b/c?x=1,2', { url: 'https://a.b/c?x=1,2' }],
    ['The spec, v2=url:https://a.b', { label: 'The spec, v2', url: 'https://a.b' }],
  ])('%s', (spec, doc) => {
    expect(parseDocSpec(spec)).toEqual({ doc });
  });
  it.each(['docs/x.md', 'path:/abs.md', 'path:../x.md', 'url:ftp://a.b', 'url:javascript:alert(1)', 'file:x'])('bad: %s', (spec) => {
    expect(parseDocSpec(spec)).toHaveProperty('error');
  });
  it('comma list splits only before path: / url:', () => {
    expect(splitDocSpecs(['path:a.md,Label=url:https://x.y/?a=1,2,path:b.md', 'path:c.md'])).toEqual(['path:a.md', 'Label=url:https://x.y/?a=1,2', 'path:b.md', 'path:c.md']);
  });
});

describe('board add with the new fields', () => {
  it('dry run prints them; --yes writes them; show prints them wrapped', async () => {
    const { repo, data } = makeRepo();
    const long = 'word '.repeat(40).trim();
    const args = ['board', 'add', '--repo', repo, '--title', 'Pick db', '--kind', 'decision', '--description', `${long}\nsecond line`,
      '--doc', 'Design=path:docs/x.md', '--doc', 'url:https://example.com/s', '--outcome', 'commit abc1234', '--size', 'M', '--sprint', 'S15', '--priority', 'high'];
    const dry = await run(args);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('size: M');
    expect(dry.out).toContain('docs: Design=path:docs/x.md; url:https://example.com/s');
    expect(dry.out).toContain('(');   // description summary with a character count
    expect(fs.existsSync(path.join(repo, '.c4pm')) && (() => { try { data(); return true; } catch { return false; } })()).toBe(false);

    expect((await run([...args, '--yes'])).code).toBe(0);
    const it = data().boards[0].items[0];
    expect(it).toMatchObject({ kind: 'decision', size: 'M', sprint: 'S15', priority: 'high', outcome: 'commit abc1234', docs: [{ label: 'Design', path: 'docs/x.md' }, { url: 'https://example.com/s' }] });
    expect(it.description).toBe(`${long}\nsecond line`);

    const show = await run(['board', 'show', 'b1', '--repo', repo]);
    expect(show.out).toContain('size M, sprint S15, priority high');
    expect(show.out).toMatch(/docs: +Design=path:docs\/x\.md/);
    expect(show.out).toMatch(/\n +url:https:\/\/example\.com\/s/);
    expect(show.out).toContain('outcome:');
    const desc = show.out.split('description:\n')[1].split('\n');
    expect(desc.every((l) => l.length <= 80)).toBe(true);
    expect(desc[desc.length - 1]).toBe('  second line');
  });

  it('description-file, question kind, missing doc path is a note not an error', async () => {
    const { repo, data } = makeRepo();
    const f = path.join(repo, 'notes.txt');
    fs.writeFileSync(f, 'from file\n\nparagraph two\n\n');
    const r = await run(['board', 'add', '--repo', repo, '--title', 'Q', '--kind', 'question', '--description-file', f, '--doc', 'path:docs/missing.md', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("note: docs path 'docs/missing.md' does not exist");
    expect(data().boards[0].items[0].description).toBe('from file\n\nparagraph two');
  });

  it.each([
    [['--size', 'XXL'], /size 'XXL' should be one of S, M, L, XL/],
    [['--sprint', '15'], /sprint '15' should look like S15/],
    [['--priority', 'urgent'], /priority 'urgent' should be one of/],
    [['--doc', 'docs/x.md'], /should look like path:/],
    [['--doc', 'path:/etc/passwd'], /not absolute/],
    [['--doc', 'url:ftp://x'], /http\(s\)/],
    [['--description', 'x'.repeat(8001)], /limit is 8000/],
    [['--outcome', 'x'.repeat(2001)], /limit is 2000/],
    [['--description', 'a', '--description-file', 'b'], /not both/],
    [['--description-file', '/nonexistent/zz.txt'], /cannot read/],
    [['--add-doc', 'path:a.md'], /unknown option '--add-doc'/],
  ])('refuses %j', async (extra, re) => {
    const { repo, text } = makeRepo();
    const r = await run(['board', 'add', '--repo', repo, '--title', 'T', '--kind', 'task', ...extra, '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(re);
    expect(() => text()).toThrow();   // nothing written
  });
});

describe('board set with the new fields', () => {
  it('doc replaces, add-doc appends (deduped), none clears; other fields set and cleared', async () => {
    const { repo, data } = makeRepo(OLD);
    const set = (...a: string[]) => run(['board', 'set', 'b1', '--repo', repo, ...a, '--yes']);
    expect((await set('--doc', 'path:docs/x.md')).code).toBe(0);
    expect((await set('--add-doc', 'path:docs/x.md', '--add-doc', 'Spec=url:https://a.b/s')).code).toBe(0);
    expect(data().boards[0].items[0].docs).toEqual([{ path: 'docs/x.md' }, { label: 'Spec', url: 'https://a.b/s' }]);
    expect((await set('--add-doc', 'path:docs/new.md,url:https://c.d')).code).toBe(0);
    expect(data().boards[0].items[0].docs).toHaveLength(4);
    expect((await set('--doc', 'url:https://only.one')).code).toBe(0);
    expect(data().boards[0].items[0].docs).toEqual([{ url: 'https://only.one' }]);
    expect((await set('--doc', 'none', '--description', 'hello', '--outcome', 'done well', '--size', 'XL', '--sprint', 'S3', '--priority', 'low')).code).toBe(0);
    expect(data().boards[0].items[0]).toMatchObject({ description: 'hello', outcome: 'done well', size: 'XL', sprint: 'S3', priority: 'low' });
    expect(data().boards[0].items[0].docs).toBeUndefined();
    expect((await set('--description', 'none', '--outcome', 'none', '--size', 'none', '--sprint', 'none', '--priority', 'none')).code).toBe(0);
    const it = data().boards[0].items[0];
    for (const k of ['description', 'outcome', 'size', 'sprint', 'priority', 'docs']) expect(it).not.toHaveProperty(k);
  });

  it('dry run shows old -> new for the new fields and writes nothing', async () => {
    const { repo, text } = makeRepo(OLD);
    const before = text();
    const r = await run(['board', 'set', 'b1', '--repo', repo, '--size', 'L', '--add-doc', 'path:docs/x.md']);
    expect(r.out).toContain('size: (none) -> L');
    expect(r.out).toContain('docs: (none) -> path:docs/x.md');
    expect(text()).toBe(before);
  });

  it('a no-op set leaves an old file byte-identical; a real set keeps unknown keys and writes the rest as before', async () => {
    const { repo, text } = makeRepo(OLD);
    const before = text();
    expect((await run(['board', 'set', 'b1', '--repo', repo, '--title', 'T', '--yes'])).out).toContain('nothing to change');
    expect(text()).toBe(before);

    const withExtra = JSON.parse(before);
    withExtra.boards[0].items[0].futureField = { a: 1 };
    fs.writeFileSync(boardFileFor(tryResolveProject(repo)!), JSON.stringify(withExtra, null, 2) + '\n');
    expect((await run(['board', 'set', 'b1', '--repo', repo, '--size', 'S', '--yes'])).code).toBe(0);
    const it = (JSON.parse(text()) as BoardFile).boards[0].items[0] as unknown as Record<string, unknown>;
    expect(it.futureField).toEqual({ a: 1 });
    expect(it.size).toBe('S');
  });

  it.each([
    [['--size', 'big'], /size 'big'/],
    [['--add-doc', 'nonsense'], /should look like/],
  ])('refuses %j', async (extra, re) => {
    const { repo, text } = makeRepo(OLD);
    const before = text();
    const r = await run(['board', 'set', 'b1', '--repo', repo, ...extra, '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(re);
    expect(text()).toBe(before);
  });
});

describe('bulk add accepts the same keys', () => {
  it('description, docs (strings and objects), outcome, size, sprint, priority, kinds', async () => {
    const { repo, data } = makeRepo(OLD);
    const spec = path.join(repo, 'items.json');
    fs.writeFileSync(spec, JSON.stringify({ items: [
      { title: 'D', kind: 'decision', description: 'why\nhow', docs: ['path:docs/x.md', { label: 'S', url: 'https://a.b' }], outcome: 'o', size: 'S', sprint: 'S2', priority: 'medium' },
      { title: 'Q', kind: 'question' },
    ] }));
    expect((await run(['board', 'add', '--repo', repo, '--from-file', spec, '--yes'])).code).toBe(0);
    const items = data().boards[0].items;
    expect(items[1]).toMatchObject({ kind: 'decision', description: 'why\nhow', docs: [{ path: 'docs/x.md' }, { label: 'S', url: 'https://a.b' }], outcome: 'o', size: 'S', sprint: 'S2', priority: 'medium' });
    expect(items[2].kind).toBe('question');
  });

  it('a bad value refuses the whole file', async () => {
    const { repo, text } = makeRepo(OLD);
    const before = text();
    const spec = path.join(repo, 'items.json');
    fs.writeFileSync(spec, JSON.stringify({ items: [{ title: 'D', kind: 'task', size: 'HUGE', docs: [{ path: 'a', url: 'https://b.c' }] }] }));
    const r = await run(['board', 'add', '--repo', repo, '--from-file', spec, '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("size 'HUGE'");
    expect(text()).toBe(before);
  });
});
