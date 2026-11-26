import * as fs from 'fs';
import * as path from 'path';
import { loadSims, simDirFor, simFileFor } from '../src/sim/load';
import { resolvePaths } from '../src/paths';
import { DATA_DIR } from '../src/constants';
import { requireProject } from '../src/outputs';
import { listing, makeRepo } from './helpers/planEditHarness';
import type { ProjectPaths } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'sim');
const EMPTY = { items: [], texts: new Map(), issues: [], notes: [], fileIds: [], dir: null };

function repo(): { root: string; project: ProjectPaths; dir: string } {
  const { root } = makeRepo('c4pm-sim-load-', {});
  const project = requireProject(root);
  return { root, project, dir: simDirFor(project) };
}
function put(dir: string, name: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}

describe('simDirFor / simFileFor', () => {
  it('are <projectDir>/sim and <projectDir>/sim/<id>.json', () => {
    const p = resolvePaths('/x/repo', { anchor: '/x/repo' });
    expect(simDirFor(p)).toBe(path.join('/x/repo', DATA_DIR, 'projects', 'repo', 'sim'));
    expect(simFileFor(p, 's-3')).toBe(path.join('/x/repo', DATA_DIR, 'projects', 'repo', 'sim', 's-3.json'));
  });
});

describe('loadSims', () => {
  it('no project: nothing', () => {
    expect(loadSims(null)).toEqual(EMPTY);
  });

  it('project but no sim folder: nothing, and nothing is created', () => {
    const { root, project } = repo();
    const before = listing(root);
    expect(loadSims(project)).toEqual(EMPTY);
    expect(listing(root)).toEqual(before);
  });

  it('good files load by number, texts kept; a broken file next to them is an issue of that file only; fileIds include it', () => {
    const { project, dir } = repo();
    const s1 = fs.readFileSync(path.join(FIXTURES, 's-1.json'), 'utf8');
    const s2 = fs.readFileSync(path.join(FIXTURES, 's-2.json'), 'utf8');
    put(dir, 's-2.json', s2);
    put(dir, 's-1.json', s1);
    put(dir, 's-10.json', '{ nope');
    const r = loadSims(project);
    expect(r.dir).toBe(dir);
    expect(r.items.map((i) => i.id)).toEqual(['s-1', 's-2']);
    expect(r.fileIds).toEqual(['s-1', 's-2', 's-10']);
    expect(r.texts.get('s-1')).toBe(s1);
    expect(r.texts.get('s-10')).toBe('{ nope');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].file).toBe('s-10.json');
    expect(r.issues[0].message).toMatch(/^not valid JSON/);
    expect(r.notes).toEqual([]);
  });

  it('non-.json files and folders are ignored; a .json with a bad name is an issue; notes are collected', () => {
    const { project, dir } = repo();
    put(dir, 'README.md', '# notes');
    put(dir, 's-3.json.bak', '{');
    fs.mkdirSync(path.join(dir, 's-4.json'));   // a folder named like a file
    put(dir, 'draft.json', '{}');
    put(dir, 's-5.json', JSON.stringify({ schemaVersion: 1, id: 's-5', kind: 'flow', title: 'T', later: 1 }));
    const r = loadSims(project);
    expect(r.items.map((i) => i.id)).toEqual(['s-5']);
    expect(r.fileIds).toEqual(['s-5']);
    expect(r.issues).toEqual([{ file: 'draft.json', message: 'file name must be s-<N>.json (file skipped)' }]);
    expect(r.notes).toEqual([{ file: 's-5.json', message: "unknown key 'later' (kept as written)" }]);
  });

  it('an id that does not match its file name is an issue; the number still counts for minting', () => {
    const { project, dir } = repo();
    put(dir, 's-7.json', JSON.stringify({ schemaVersion: 1, id: 's-8', kind: 'flow', title: 'T' }));
    const r = loadSims(project);
    expect(r.items).toEqual([]);
    expect(r.fileIds).toEqual(['s-7']);
    expect(r.issues.map((i) => i.file)).toEqual(['s-7.json']);
  });

  const unreadable = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
  unreadable('an unreadable file: one issue with the error, its id still in fileIds, no text', () => {
    const { project, dir } = repo();
    put(dir, 's-1.json', fs.readFileSync(path.join(FIXTURES, 's-1.json'), 'utf8'));
    const file = path.join(dir, 's-1.json');
    fs.chmodSync(file, 0o000);
    try {
      const r = loadSims(project);
      expect(r.items).toEqual([]);
      expect(r.fileIds).toEqual(['s-1']);
      expect(r.texts.has('s-1')).toBe(false);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].message).toMatch(/cannot read .*EACCES/);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});
