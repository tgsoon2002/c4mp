import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AnchorNotFoundError, EXPORT_DIR, INTERNAL_DIR, LEGACY_EXPORT_DIR, VIEW_FILE, defaultRepoRoot, findAnchor, isAnchorExportDir, isInsideExportDir, otherProjects, resolvePaths,
} from '../src/paths';

let tmp: string;
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-paths-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// The "nothing found" test is only hermetic if no marker exists above the OS tmp dir.
function markerAboveTmp(): boolean {
  let d = fs.realpathSync(os.tmpdir());
  for (;;) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, INTERNAL_DIR))) return true;
    const u = path.dirname(d);
    if (u === d) return false;
    d = u;
  }
}

describe('findAnchor', () => {
  it('finds a git root above the target', () => {
    mk('.git');
    const t = mk('a', 'b');
    expect(findAnchor(t)).toBe(tmp);
  });

  it('accepts .git as a file (worktree/submodule)', () => {
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: /elsewhere');
    expect(findAnchor(mk('x'))).toBe(tmp);
  });

  it('accepts a .c4mp marker without git', () => {
    mk(INTERNAL_DIR);
    expect(findAnchor(mk('x', 'y'))).toBe(tmp);
  });

  it('nearest wins: .c4mp in a subfolder beats .git above', () => {
    mk('.git');
    const sub = mk('sub');
    mk('sub', INTERNAL_DIR);
    expect(findAnchor(mk('sub', 'deep'))).toBe(sub);
  });

  it('either marker is enough at the same level', () => {
    mk('.git');
    mk(INTERNAL_DIR);
    expect(findAnchor(tmp)).toBe(tmp);
  });

  (markerAboveTmp() ? it.skip : it)('throws AnchorNotFoundError with init hint when nothing found', () => {
    const t = mk('lonely');
    let err: unknown;
    try { findAnchor(t); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AnchorNotFoundError);
    const e = err as AnchorNotFoundError;
    expect(e.hint).toContain('c4mp init');
    expect(e.message).toContain('c4mp init --repo ' + t);
  });
});

describe('defaultRepoRoot (R7)', () => {
  it('a sub-folder of a repo with .c4mp at its root -> that root', () => {
    mk(INTERNAL_DIR);
    expect(defaultRepoRoot(mk('Project', 'src'))).toBe(tmp);
  });

  (markerAboveTmp() ? it.skip : it)('no .c4mp and no .git above -> the working folder itself', () => {
    const t = mk('lonely');
    expect(defaultRepoRoot(t)).toBe(t);
  });

  it('no argument -> from the working folder', () => {
    expect(defaultRepoRoot()).toBe(defaultRepoRoot(process.cwd()));
  });
});

describe('resolvePaths', () => {
  it('builds all paths from anchor and repoId', () => {
    mk('.git');
    const t = mk('MyRepo');
    const p = resolvePaths(t);
    expect(p).toEqual({
      anchor: tmp,
      internalDir: path.join(tmp, INTERNAL_DIR),
      projectDir: path.join(tmp, INTERNAL_DIR, 'projects', 'my-repo'),
      dataDir: path.join(tmp, INTERNAL_DIR, 'projects', 'my-repo', 'data'),
      historyDir: path.join(tmp, INTERNAL_DIR, 'projects', 'my-repo', 'history'),
      planDir: path.join(tmp, INTERNAL_DIR, 'projects', 'my-repo', 'plan'),
      exportDir: path.join(tmp, EXPORT_DIR, 'my-repo'),
      viewFile: path.join(tmp, EXPORT_DIR, 'my-repo', VIEW_FILE),
      configFile: path.join(tmp, INTERNAL_DIR, 'config.json'),
      repoId: 'my-repo',
    });
  });

  it('two targets under one anchor share the anchor but not project/export dirs', () => {
    mk('.git');
    const a = resolvePaths(mk('svc-a'));
    const b = resolvePaths(mk('svc-b'));
    expect(a.anchor).toBe(b.anchor);
    expect(a.projectDir).not.toBe(b.projectDir);
    expect(a.exportDir).not.toBe(b.exportDir);
  });

  it('honours explicit opts.anchor and opts.repoId (no marker needed)', () => {
    const t = mk('whatever');
    const anchor = mk('custom-anchor');
    const p = resolvePaths(t, { anchor, repoId: 'my-id' });
    expect(p.anchor).toBe(anchor);
    expect(p.repoId).toBe('my-id');
    expect(p.projectDir).toBe(path.join(anchor, INTERNAL_DIR, 'projects', 'my-id'));
    expect(p.exportDir).toBe(path.join(anchor, 'C4MP', 'my-id'));
  });

  it('creates nothing on disk', () => {
    mk('.git');
    const t = mk('repo');
    const snap = () => fs.readdirSync(tmp, { recursive: true }).map(String).sort();
    const before = snap();
    resolvePaths(t);
    expect(snap()).toEqual(before);
  });
});

describe('isInsideExportDir', () => {
  it('true for the C4MP folder and anything below it', () => {
    expect(isInsideExportDir(tmp, path.join(tmp, 'C4MP'))).toBe(true);
    expect(isInsideExportDir(tmp, path.join(tmp, 'C4MP', 'repo', 'c4mpView.html'))).toBe(true);
  });

  // Phase 35 C (b945): the export folder of an earlier version is left alone in a user's repo but still recognised
  it('true for the old C4PM folder of an earlier version and anything below it', () => {
    expect(isInsideExportDir(tmp, path.join(tmp, 'C4PM'))).toBe(true);
    expect(isInsideExportDir(tmp, path.join(tmp, 'C4PM', 'repo', 'c4pmView.html'))).toBe(true);
  });

  it('false for siblings, the anchor, and prefix look-alikes', () => {
    expect(isInsideExportDir(tmp, tmp)).toBe(false);
    expect(isInsideExportDir(tmp, path.join(tmp, 'src'))).toBe(false);
    expect(isInsideExportDir(tmp, path.join(tmp, 'C4PM-other', 'x'))).toBe(false);
  });

  it('false for a nested folder merely named C4PM', () => {
    expect(isInsideExportDir(tmp, path.join(tmp, 'packages', 'C4PM'))).toBe(false);
    expect(isInsideExportDir(tmp, path.join(tmp, 'packages', 'C4PM', 'a.ts'))).toBe(false);
  });
});

describe('isAnchorExportDir', () => {
  it('true for C4PM beside a .c4mp marker', () => {
    mk(INTERNAL_DIR);
    expect(isAnchorExportDir(mk(EXPORT_DIR))).toBe(true);
  });

  it('Phase 35 C (b945): the names are C4MP / c4mpView.html, and the old C4PM folder of an earlier version still counts', () => {
    expect([EXPORT_DIR, LEGACY_EXPORT_DIR, VIEW_FILE]).toEqual(['C4MP', 'C4PM', 'c4mpView.html']);
    mk(INTERNAL_DIR);
    expect(isAnchorExportDir(mk(LEGACY_EXPORT_DIR))).toBe(true);
  });

  it('true for C4PM beside a .git file', () => {
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: /elsewhere');
    expect(isAnchorExportDir(mk(EXPORT_DIR))).toBe(true);
  });

  it('false for a nested C4PM whose parent has no marker, and for other names', () => {
    mk(INTERNAL_DIR);
    expect(isAnchorExportDir(mk('packages', EXPORT_DIR))).toBe(false);
    expect(isAnchorExportDir(mk('src'))).toBe(false);
  });
});

describe('otherProjects (b564)', () => {
  const listing = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).sort();

  it('empty when the project folder exists, even with siblings', () => {
    mk('.git');
    mk(INTERNAL_DIR, 'projects', 'app');
    mk(INTERNAL_DIR, 'projects', 'other');
    expect(otherProjects(resolvePaths(mk('app'), { repoId: 'app' }))).toEqual([]);
  });

  it('lists the sibling projects (sorted, folders only) when the project folder does not exist, and creates nothing', () => {
    mk('.git');
    mk(INTERNAL_DIR, 'projects', 'zeta');
    mk(INTERNAL_DIR, 'projects', 'myproj');
    fs.writeFileSync(path.join(tmp, INTERNAL_DIR, 'projects', 'stray.txt'), 'x');
    const before = listing(tmp);
    expect(otherProjects(resolvePaths(tmp, { repoId: 'r564' }))).toEqual(['myproj', 'zeta']);
    expect(listing(tmp)).toEqual(before);
  });

  it('empty when the anchor has no projects folder yet', () => {
    mk('.git');
    expect(otherProjects(resolvePaths(tmp, { repoId: 'fresh' }))).toEqual([]);
  });
});
