import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { driftFrom, listSnapshots, storedSnapshots, takeSnapshot } from '../src/scan/snapshots';
import { historyDir, saveToHistory } from '../src/history/store';
import { compareSnapshots } from '../src/compare/index';
import type { Snapshot } from '../src/types';

// b507 (row G3): the stored snapshot by ref, loaded once in Project & scan (c4pm diff and c4pm view --from)

let store: string;
beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-stored-')); });
afterEach(() => { fs.rmSync(store, { recursive: true, force: true }); });

/** A snapshot of repo 'test-app' at a commit; `files` tells the snapshots apart. */
const snap = (commit: string, date: string, files: number): Snapshot => ({
  schemaVersion: 2,
  meta: { tool: 'c4pm@0.1.0', repoPath: '/tmp/repo', repoName: 'test-app', createdAt: date, git: { commit, branch: 'main', date, depth: files } },
  system: { id: 'test-app', name: 'Test App' },
  containers: [],
  components: [],
  files: [],
  componentEdges: [],
  fileEdges: [],
  externals: [],
  stats: { containers: 0, components: 0, files, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
});
const older = snap('aaaaaaa1111111111', '2026-01-01T10:00:00Z', 1);
const newer = snap('bbbbbbb2222222222', '2026-01-02T10:00:00Z', 2);

describe('storedSnapshots', () => {
  test.each([
    { name: 'two refs, in the order asked', refs: ['latest', 'oldest'], want: [2, 1] },
    { name: 'prev', refs: ['prev'], want: [1] },
    { name: 'commit prefix and date', refs: ['bbbbbbb', '2026-01-01'], want: [2, 1] },
    { name: 'unknown ref', refs: ['nope'], want: /Unknown snapshot ref 'nope'/ },
    { name: 'a bad ref is reported before a missing snapshot file', refs: ['oldest', 'nope'], dropOldest: true, want: /Unknown snapshot ref 'nope'/ },
    { name: 'missing store: no entries', refs: ['latest'], noStore: true, want: /Unknown snapshot ref 'latest'. Known: <none>/ },
  ])('$name', ({ refs, want, dropOldest, noStore }) => {
    const first = saveToHistory(store, older);
    saveToHistory(store, newer);
    if (dropOldest) fs.rmSync(path.join(historyDir(store, 'test-app'), first.file));
    const root = noStore ? path.join(store, 'none') : store;
    if (want instanceof RegExp) {
      expect(() => storedSnapshots(root, 'test-app', refs)).toThrow(want);
      return;
    }
    const got = storedSnapshots(root, 'test-app', refs);
    expect(got.map((s) => s.snapshot.stats.files)).toEqual(want);
    expect(got.map((s) => s.entry.depth)).toEqual(want);
  });
});

describe('driftFrom', () => {
  it('compares the stored snapshot of the same repo with the current one (old -> current)', () => {
    saveToHistory(store, older);
    saveToHistory(store, newer);
    const current = snap('ccccccc3333333333', '2026-01-03T10:00:00Z', 3);
    const { entry, diff } = driftFrom(store, 'oldest', current);
    expect(entry.commit).toBe(older.meta.git?.commit);
    expect(diff).toEqual(compareSnapshots(older, current));
  });
});

describe('Phase 34 F2: the project folder names the history id', () => {
  it('no package.json + one .c4pm/projects/<x>: save and list use <x>, not the folder name', () => {
    const repo = path.join(store, 'Some Folder');
    fs.mkdirSync(path.join(repo, '.c4pm', 'projects', 'myproj'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const taken = takeSnapshot(repo, {}, { save: true });
    expect(taken.saved).not.toBeNull();
    const { entries, dir } = listSnapshots(repo);
    expect(entries).toHaveLength(1);
    expect(dir).toBe(path.join(repo, '.c4pm', 'projects', 'myproj', 'history'));
  });
});
