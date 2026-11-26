import * as fs from 'fs';

// Same module with renameSync wrapped, so one test can make the rename step fail.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, renameSync: jest.fn(actual.renameSync) };
});
import * as os from 'os';
import * as path from 'path';
import type { BoardFile } from '../src/types';
import { boardFileFor } from '../src/board/load';
import { serializeBoard } from '../src/board/serialize';
import { loadBoardForEdit, planBoardWrite, applyBoardWrite, BoardWriteError } from '../src/board/write';
import { initProject } from '../src/init';
import { requireProject } from '../src/outputs';
import { addBoardItem, applyBoardChange, openBoard } from '../src/services/boardEdit';
import type { ProjectPaths } from '../src/types';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Every path under dir, relative, sorted. */
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

const item = (id: string) => ({ id, title: 'T', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [] });
const file = (...ids: string[]): BoardFile => ({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: ids.map(item) }] });

function repoWithProject(): { repo: string; project: ProjectPaths } {
  const repo = tmp('c4pm-board-write-');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  return { repo, project: requireProject(repo) };
}

describe('loadBoardForEdit', () => {
  it('a project without a board file gives an empty file and creates nothing', () => {
    const { repo, project } = repoWithProject();
    const before = listing(repo);
    const { data } = loadBoardForEdit(project);
    expect(data).toEqual({ schemaVersion: 1, boards: [] });
    expect(listing(repo)).toEqual(before);
  });

  it('a file with ANY parse issue throws and lists the issues (nothing is repaired)', () => {
    const { project } = repoWithProject();
    const f = boardFileFor(project);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const text = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', mystery: 1, items: [] }] });
    fs.writeFileSync(f, text);
    let err: unknown;
    try { loadBoardForEdit(project); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BoardWriteError);
    expect((err as BoardWriteError).issues.length).toBeGreaterThan(0);
    expect((err as Error).message).toContain("unknown key 'mystery'");
    expect(fs.readFileSync(f, 'utf8')).toBe(text);
  });
});

describe('planBoardWrite + applyBoardWrite', () => {
  it('a plan changes nothing on disk', () => {
    const { repo, project } = repoWithProject();
    const before = listing(repo);
    const plan = planBoardWrite(project, file('b1'));
    expect(plan.changed).toBe(true);
    expect(plan.before).toBeNull();
    expect(plan.path).toBe(boardFileFor(project));
    expect(listing(repo)).toEqual(before);
  });

  it('apply writes exactly the board file', () => {
    const { repo, project } = repoWithProject();
    const before = listing(repo);
    const plan = planBoardWrite(project, file('b1', 'b2'));
    applyBoardWrite(project, plan);
    expect(fs.readFileSync(plan.path, 'utf8')).toBe(serializeBoard(file('b1', 'b2')));
    const added = listing(repo).filter((p) => !before.includes(p));
    expect(added).toEqual([path.relative(repo, path.dirname(plan.path)), path.relative(repo, plan.path)]);
    // second plan with the same data: unchanged, no write
    expect(planBoardWrite(project, file('b1', 'b2')).changed).toBe(false);
  });

  it('a hand-built plan whose path is outside .c4pm is refused and nothing is written', () => {
    const { project } = repoWithProject();
    const outside = path.join(tmp('c4pm-board-write-out-'), 'board.json');
    const plan = { path: outside, before: null, after: serializeBoard(file('b1')), changed: true };
    expect(() => applyBoardWrite(project, plan)).toThrow(/refusing to write/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a path inside .c4pm but not the board file is refused too', () => {
    const { project } = repoWithProject();
    const other = path.join(project.internalDir, 'config.json');
    const plan = { path: other, before: null, after: '{}', changed: true };
    expect(() => applyBoardWrite(project, plan)).toThrow(/refusing to write/);
  });

  it('rolls back a new file when the result would not parse (invalid id)', () => {
    const { project } = repoWithProject();
    const plan = planBoardWrite(project, file('1bad'));
    expect(() => applyBoardWrite(project, plan)).toThrow(BoardWriteError);
    expect(fs.existsSync(plan.path)).toBe(false);
  });

  it('rolls back to the old text when an existing file is edited into something invalid', () => {
    const { project } = repoWithProject();
    applyBoardWrite(project, planBoardWrite(project, file('b1')));
    const good = fs.readFileSync(boardFileFor(project), 'utf8');
    const bad = planBoardWrite(project, file('b1', '1bad'));
    expect(() => applyBoardWrite(project, bad)).toThrow(/rolled back/);
    expect(fs.readFileSync(boardFileFor(project), 'utf8')).toBe(good);
  });

  it('a file changed between load and write is refused and left untouched', () => {
    const { project } = repoWithProject();
    applyBoardWrite(project, planBoardWrite(project, file('b1')));
    const loaded = loadBoardForEdit(project);
    const plan = planBoardWrite(project, file('b1', 'b2'), loaded.text);
    const other = serializeBoard(file('b1', 'b9'));
    fs.writeFileSync(boardFileFor(project), other);       // a concurrent edit
    expect(() => applyBoardWrite(project, plan)).toThrow(/changed since it was read/);
    expect(fs.readFileSync(boardFileFor(project), 'utf8')).toBe(other);
    expect(listing(path.dirname(boardFileFor(project))).filter((p) => p.endsWith('.tmp'))).toEqual([]);
  });

  it('a file created between load (no file) and write is refused', () => {
    const { project } = repoWithProject();
    const loaded = loadBoardForEdit(project);
    expect(loaded.text).toBeNull();
    const plan = planBoardWrite(project, file('b1'), loaded.text);
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    fs.writeFileSync(plan.path, 'x');
    expect(() => applyBoardWrite(project, plan)).toThrow(/changed since it was read/);
    expect(fs.readFileSync(plan.path, 'utf8')).toBe('x');
  });

  it('a failing write leaves no temp file', () => {
    const { project } = repoWithProject();
    applyBoardWrite(project, planBoardWrite(project, file('b1')));
    const plan = planBoardWrite(project, file('b1', 'b2'));
    (fs.renameSync as jest.Mock).mockImplementationOnce(() => { throw new Error('rename boom'); });
    expect(() => applyBoardWrite(project, plan)).toThrow(/rename boom/);
    expect(listing(path.dirname(plan.path)).filter((p) => p.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(plan.path, 'utf8')).toBe(serializeBoard(file('b1')));
  });

  it('ids such as __proto__ round-trip (Map-safe)', () => {
    const { project } = repoWithProject();
    applyBoardWrite(project, planBoardWrite(project, file('__proto__', 'constructor')));
    const again = loadBoardForEdit(project).data;
    expect(again.boards[0].items.map((i) => i.id).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('Board editing (src/services/boardEdit.ts) finds the project and prepares .c4pm/', () => {
  it('no project (no .c4pm, no .git above) throws with the init hint', () => {
    const bare = tmp('c4pm-board-write-bare-');
    expect(() => openBoard(bare)).toThrow(/c4mp init/);
  });

  it('a write writes .c4pm/.gitignore when it was absent', () => {
    const repo = tmp('c4pm-board-write-anchor-');
    fs.mkdirSync(path.join(repo, '.c4pm'));            // an anchor without .gitignore
    applyBoardChange(addBoardItem(repo, { title: 'T', kind: 'task' }));
    expect(fs.existsSync(path.join(repo, '.c4pm', '.gitignore'))).toBe(true);
    expect(listing(repo).filter((p) => !p.startsWith('.c4pm'))).toEqual([]);   // nothing outside .c4pm
  });
});
