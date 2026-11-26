import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { boardForView } from '../src/board/run';
import { boardFileFor } from '../src/board/load';
import { resolvePaths } from '../src/paths';
import { initProject } from '../src/init';
import { tryResolveProject } from '../src/outputs';
import type { Plan } from '../src/types';

const TODAY = '2026-10-21';
const UID = '00000000-0000-4000-8000-000000000001';
const PLAN: Plan = {
  files: ['a.c4'],
  elements: [{ id: 'app', kind: 'system', title: 'App', description: null, technology: null, links: [], metadata: { uid: UID }, parent: null, source: { file: 'a.c4', line: 1 } }],
  relations: [],
  issues: [],
};

function repoWith(boardText: string | null): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-board-run-')));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  initProject(repo);
  if (boardText !== null) {
    const file = boardFileFor(resolvePaths(repo, { anchor: repo }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, boardText);
  }
  return repo;
}

const item = (id: string, extra: object = {}) => ({ id, title: `T${id}`, kind: 'task', status: 'planned', ...extra });
const text = (items: object[]) => JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items }] });

/** boardForView with the project of the repo (null without an anchor), as openProject gives it to collectFindings. */
const view = (repo: string, plan: Plan | null) => boardForView(repo, tryResolveProject(repo), plan, TODAY);

describe('boardForView', () => {
  it('no board file: null and no findings', () => {
    expect(view(repoWith(null), PLAN)).toEqual({ data: null, findings: [] });
  });

  it('a repo without a project: null and no findings', () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-board-run-bare-')));
    expect(view(bare, PLAN)).toEqual({ data: null, findings: [] });
  });

  it('broken board: one board-parse finding, data null', () => {
    const r = view(repoWith('{ not json'), PLAN);
    expect(r.data).toBeNull();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: 'warning', rule: 'board-parse', id: 'board.json' });
  });

  it('clean board: data and no findings', () => {
    const r = view(repoWith(text([item('b1', { links: [UID] })])), PLAN);
    expect(r.data?.boards[0].items).toHaveLength(1);
    expect(r.findings).toEqual([]);
  });

  it('dead link is reported', () => {
    const r = view(repoWith(text([item('b1', { links: ['nope'] })])), PLAN);
    expect(r.findings.map((f) => `${f.rule}:${f.id}`)).toEqual(['board-dead-link:b1']);
  });

  it('a partly bad file gives parse findings AND rule findings, sorted', () => {
    const r = view(repoWith(text([item('b1', { links: ['nope'], bogus: 1 })])), PLAN);
    expect(r.data).not.toBeNull();
    expect(r.findings.map((f) => f.rule)).toEqual(['board-dead-link', 'board-parse']);
  });

  it('doc paths are found relative to the folder that holds .c4pm, even when a sub-folder is scanned', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-board-run-sub-')));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec\n');
    const code = path.join(root, 'Project');
    fs.mkdirSync(code);
    fs.writeFileSync(path.join(code, 'a.ts'), 'export const a = 1;\n');
    initProject(code);
    const file = boardFileFor(resolvePaths(code));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text([item('b1', { docs: [{ path: 'docs/spec.md' }, { path: 'docs/none.md' }] })]));
    const r = view(code, null);
    expect(r.findings.filter((f) => f.rule === 'board-doc-missing').map((f) => f.message)).toEqual([
      "b1: docs[1] path 'docs/none.md' does not exist in the repo",
    ]);
  });

  it('plan null: links unchecked info', () => {
    const r = view(repoWith(text([item('b1', { links: ['x'] })])), null);
    expect(r.findings.map((f) => f.rule)).toEqual(['board-links-unchecked']);
  });
});
