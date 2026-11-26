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

// P16-B16: `c4mp board link` / `unlink` (in-process).

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

const UID_API = '3f2a7c1e-0000-4000-8000-00000000aaaa';
const UID_AUTH1 = '3f2a7c1e-0000-4000-8000-00000000bbbb';
const UID_AUTH2 = '3f2a7c1e-0000-4000-8000-00000000cccc';
const GONE = '3f2a7c1e-0000-4000-8000-00000000dead';

const PLAN = `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' {
      technology 'Node'
      metadata { uid '${UID_API}' }
      auth = component 'Auth' {
        metadata { uid '${UID_AUTH1}' }
      }
    }
    web = container 'Web' {
      technology 'Node'
      auth = component 'Auth' {
        metadata { uid '${UID_AUTH2}' }
      }
    }
    worker = container 'Worker' {
      technology 'Node'
    }
  }
}
`;

const it1 = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

function makeRepo(withPlan = true): { repo: string; file: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-b16-')));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  if (withPlan) {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'architecture.c4'), PLAN);
  }
  const file = boardFileFor(tryResolveProject(repo)!);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [it1('b1'), it1('b2', { links: [UID_API, GONE] })] }] }));
  return { repo, file };
}
const read = (file: string): BoardFile => JSON.parse(fs.readFileSync(file, 'utf8')) as BoardFile;
const links = (file: string, id: string) => read(file).boards[0].items.find((i) => i.id === id)!.links;

describe('c4mp board link', () => {
  it('dry run shows the change and writes nothing; --yes stores the uid found by fqn', async () => {
    const { repo, file } = makeRepo();
    const before = fs.readFileSync(file, 'utf8');
    const dry = await run(['board', 'link', 'b1', 'app.api', '--repo', repo]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`links: (none) -> ${UID_API}`);
    expect(dry.out).toContain('dry run: nothing written');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const yes = await run(['board', 'link', 'b1', 'app.api', '--repo', repo, '--yes']);
    expect(yes.code).toBe(0);
    expect(links(file, 'b1')).toEqual([UID_API]);
    expect(read(file).boards[0].items[0].updated).toBe(todayIso());
  });

  it('prints the updated line only when the date changes', async () => {
    const { repo, file } = makeRepo();
    const first = await run(['board', 'link', 'b1', UID_API, '--repo', repo]);
    expect(first.out).toContain(`  updated: (none) -> ${todayIso()}`);
    const f = read(file);
    f.boards[0].items[0].updated = todayIso();
    fs.writeFileSync(file, JSON.stringify(f));
    const same = await run(['board', 'link', 'b1', UID_API, '--repo', repo]);
    expect(same.out).toContain('links:');
    expect(same.out).not.toContain('updated:');
    const un = await run(['board', 'unlink', 'b2', UID_API, '--repo', repo]);
    expect(un.out).toContain(`  updated: (none) -> ${todayIso()}`);
  });

  it('linking twice leaves one entry and says nothing to change', async () => {
    const { repo, file } = makeRepo();
    await run(['board', 'link', 'b1', UID_API, '--repo', repo, '--yes']);
    const again = await run(['board', 'link', 'b1', UID_API, '--repo', repo, '--yes']);
    expect(again.code).toBe(0);
    expect(again.out).toBe('nothing to change');
    expect(links(file, 'b1')).toEqual([UID_API]);
  });

  it('an ambiguous target exits 1 and lists the uids; nothing is written', async () => {
    const { repo, file } = makeRepo();
    const before = fs.readFileSync(file, 'utf8');
    const r = await run(['board', 'link', 'b1', 'Auth', '--repo', repo, '--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("matches 2 elements, use a uid:");
    expect(r.out).toContain(UID_AUTH1);
    expect(r.out).toContain(UID_AUTH2);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('an element without a uid is refused with the ids hint', async () => {
    const { repo, file } = makeRepo();
    const before = fs.readFileSync(file, 'utf8');
    const r = await run(['board', 'link', 'b1', 'app.worker', '--repo', repo, '--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('run c4mp plan ids to give every element a uid');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('no match exits 1 with suggestions; unknown item and missing plan exit 1', async () => {
    const { repo } = makeRepo();
    const none = await run(['board', 'link', 'b1', 'zzzz', '--repo', repo, '--yes']);
    expect(none.code).toBe(1);
    expect(none.out).toContain("no element matches 'zzzz'");
    const item = await run(['board', 'link', 'b99', 'app.api', '--repo', repo, '--yes']);
    expect(item.code).toBe(1);
    expect(item.err).toContain("no item 'b99'");
    const bare = makeRepo(false);
    const noPlan = await run(['board', 'link', 'b1', 'app.api', '--repo', bare.repo, '--yes']);
    expect(noPlan.code).toBe(1);
    expect(noPlan.out).toContain('no .c4 files found');
  });
});

describe('c4mp board unlink', () => {
  it('removes only that uid', async () => {
    const { repo, file } = makeRepo();
    const r = await run(['board', 'unlink', 'b2', 'app.api', '--repo', repo, '--yes']);
    expect(r.code).toBe(0);
    expect(links(file, 'b2')).toEqual([GONE]);
  });

  it('can remove a dead link by its uid (the plan no longer has it), even without a plan', async () => {
    const { repo, file } = makeRepo(false);
    const r = await run(['board', 'unlink', 'b2', GONE, '--repo', repo, '--yes']);
    expect(r.code).toBe(0);
    expect(links(file, 'b2')).toEqual([UID_API]);
  });

  it('exits 1 when the item is not linked to that element', async () => {
    const { repo, file } = makeRepo();
    const before = fs.readFileSync(file, 'utf8');
    const r = await run(['board', 'unlink', 'b1', 'app.api', '--repo', repo, '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not linked to');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
