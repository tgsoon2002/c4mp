import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { boardFileFor, loadBoard } from '../src/board/load';
import { resolvePaths } from '../src/paths';
import { initProject } from '../src/init';
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

function projectRepo(): { repo: string; project: ProjectPaths; file: string } {
  const repo = tmp('c4pm-board-load-');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  const project = resolvePaths(repo, { anchor: repo });
  return { repo, project, file: boardFileFor(project) };
}

const GOOD = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [{ id: 'b1', title: 'One', kind: 'task', status: 'planned' }] }] });

describe('boardFileFor', () => {
  it('is <projectDir>/board/board.json', () => {
    const p = resolvePaths('/x/repo', { anchor: '/x/repo' });
    expect(boardFileFor(p)).toBe(path.join('/x/repo', '.c4mp', 'projects', 'repo', 'board', 'board.json'));
  });
});

describe('loadBoard', () => {
  it('no project: all null', () => {
    expect(loadBoard(null)).toEqual({ data: null, issues: [], notes: [], path: null });
  });

  it('project but no board file: all null and nothing is created', () => {
    const { repo, project } = projectRepo();
    const before = listing(repo);
    expect(loadBoard(project)).toEqual({ data: null, issues: [], notes: [], path: null });
    expect(listing(repo)).toEqual(before);
  });

  it('a board file: parsed, path set', () => {
    const { project, file } = projectRepo();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GOOD);
    const r = loadBoard(project);
    expect(r.issues).toEqual([]);
    expect(r.path).toBe(file);
    expect(r.data!.boards[0].items[0].id).toBe('b1');
  });

  it('a broken board file: data null, issues, path set', () => {
    const { project, file } = projectRepo();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ nope');
    const r = loadBoard(project);
    expect(r.data).toBeNull();
    expect(r.issues).toHaveLength(1);
    expect(r.path).toBe(file);
  });

  const unreadable = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
  unreadable('an unreadable file: data null and one issue with the error message', () => {
    const { project, file } = projectRepo();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GOOD);
    fs.chmodSync(file, 0o000);
    try {
      const r = loadBoard(project);
      expect(r.data).toBeNull();
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].message).toMatch(/cannot read .*EACCES/);
      expect(r.path).toBe(file);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});
