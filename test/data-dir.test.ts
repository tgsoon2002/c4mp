import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runCli } from './helpers/runCli';

// Phase 35 A: C4MP names, the data-folder rule, the per-user folder, migrate. Notes are once per process: each test
// loads fresh copies of the modules (jest.isolateModules) and spies on stderr.

type Paths = typeof import('../src/paths');
type Env = typeof import('../src/env');

let tmp: string;
let errs: string[];
let spy: jest.SpyInstance;
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

const savedNoNotes = process.env.C4MP_NO_NOTES;
beforeEach(() => {
  delete process.env.C4MP_NO_NOTES;   // the suite turns notes off (globalSetup); these tests check them
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-a-')));
  errs = [];
  spy = jest.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { errs.push(String(s)); return true; });
});
afterEach(() => { if (savedNoNotes !== undefined) process.env.C4MP_NO_NOTES = savedNoNotes; spy.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fresh(): { paths: Paths; env: Env } {
  let r!: { paths: Paths; env: Env };
  jest.isolateModules(() => {
    r = { paths: require('../src/paths'), env: require('../src/env') };
  });
  return r;
}

describe('readEnv', () => {
  it.each([
    [{ C4MP_X: 'new', C4PM_X: 'old' }, 'new'],
    [{ C4PM_X: 'old' }, 'old'],
    [{}, undefined],
  ])('%j -> %s', (env, want) => {
    expect(fresh().env.readEnv('X', env)).toBe(want);
  });
});

describe('dataDirAt', () => {
  it('none -> .c4mp, no note', () => {
    expect(fresh().paths.dataDirAt(tmp)).toBe(path.join(tmp, '.c4mp'));
    expect(errs).toEqual([]);
  });
  it('only .c4mp -> .c4mp, no note', () => {
    mk('.c4mp');
    expect(fresh().paths.dataDirAt(tmp)).toBe(path.join(tmp, '.c4mp'));
    expect(errs).toEqual([]);
  });
  it('only .c4pm -> .c4pm, one migrate note however often it is asked', () => {
    mk('.c4pm');
    const { paths } = fresh();
    expect(paths.dataDirAt(tmp)).toBe(path.join(tmp, '.c4pm'));
    paths.dataDirAt(tmp);
    paths.resolvePaths(tmp);
    expect(errs).toEqual(['note: this repo still uses .c4pm; run `c4mp migrate` to move it\n']);
  });
  it('both -> .c4mp wins, one warning naming both', () => {
    mk('.c4mp'); mk('.c4pm');
    const { paths } = fresh();
    expect(paths.dataDirAt(tmp)).toBe(path.join(tmp, '.c4mp'));
    paths.dataDirAt(tmp);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/both \.c4mp and \.c4pm/);
  });
  it('the note never appears with --json on the command line', () => {
    mk('.c4pm');
    const argv = process.argv;
    process.argv = [...argv, '--json'];
    try { fresh().paths.dataDirAt(tmp); } finally { process.argv = argv; }
    expect(errs).toEqual([]);
  });
});

describe('anchor walk', () => {
  it('finds a .c4mp repo and an old .c4pm repo from a subfolder', () => {
    mk('new', '.c4mp'); mk('new', 'a', 'b'); mk('old', '.c4pm'); mk('old', 'a', 'b');
    const { paths } = fresh();
    expect(paths.findAnchor(path.join(tmp, 'new', 'a', 'b'))).toBe(path.join(tmp, 'new'));
    expect(paths.findAnchor(path.join(tmp, 'old', 'a', 'b'))).toBe(path.join(tmp, 'old'));
    expect(paths.resolvePaths(path.join(tmp, 'new', 'a')).internalDir).toBe(path.join(tmp, 'new', '.c4mp'));
    expect(paths.resolvePaths(path.join(tmp, 'old', 'a')).internalDir).toBe(path.join(tmp, 'old', '.c4pm'));
  });
});

describe('isCurrentTool', () => {
  it('accepts both names for this version only', () => {
    const { TOOL_VERSION, isCurrentTool } = require('../src/constants');
    const v = TOOL_VERSION.split('@')[1];
    expect(TOOL_VERSION.startsWith('c4mp@')).toBe(true);
    expect(isCurrentTool(`c4mp@${v}`)).toBe(true);
    expect(isCurrentTool(`c4pm@${v}`)).toBe(true);
    expect(isCurrentTool('c4pm@0.0.0')).toBe(false);
    expect(isCurrentTool('other@' + v)).toBe(false);
  });
});

describe('per-user folder', () => {
  const { userDir } = require('../src/util/userFiles');
  const { userCacheRoot } = require('../src/util/userCache');
  const { legacyStoreDir } = require('../src/util/userFiles');
  it('~/.c4mp by default; ~/.c4pm only when that alone exists', () => {
    expect(userDir({}, tmp)).toBe(path.join(tmp, '.c4mp'));
    mk('.c4pm');
    expect(userDir({}, tmp)).toBe(path.join(tmp, '.c4pm'));
    mk('.c4mp');
    expect(userDir({}, tmp)).toBe(path.join(tmp, '.c4mp'));
  });
  it('env: C4MP_USER_DIR first, then C4PM_USER_DIR; off in both names', () => {
    expect(userDir({ C4MP_USER_DIR: '/a', C4PM_USER_DIR: '/b' }, tmp)).toBe('/a');
    expect(userDir({ C4PM_USER_DIR: '/b' }, tmp)).toBe('/b');
    expect(userDir({ C4MP_USER_DIR: 'off' }, tmp)).toBeNull();
    expect(userDir({ C4PM_USER_DIR: 'off' }, tmp)).toBeNull();
  });
  it('cache dir env: both names', () => {
    expect(userCacheRoot({ C4MP_CACHE_DIR: '/a', C4PM_CACHE_DIR: '/b' })).toBe('/a');
    expect(userCacheRoot({ C4PM_CACHE_DIR: '/b' })).toBe('/b');
    expect(userCacheRoot({ C4PM_CACHE_DIR: 'off' })).toBeNull();
  });
  it('legacy store: ~/.c4mp/store, else ~/.c4pm/store when only that exists', () => {
    expect(legacyStoreDir(tmp)).toBe(path.join(tmp, '.c4mp', 'store'));
    mk('.c4pm', 'store');
    expect(legacyStoreDir(tmp)).toBe(path.join(tmp, '.c4pm', 'store'));
    mk('.c4mp', 'store');
    expect(legacyStoreDir(tmp)).toBe(path.join(tmp, '.c4mp', 'store'));
  });
});

describe('init', () => {
  it('creates .c4mp in a new repo and keeps .c4pm in an old one', () => {
    mk('new', '.git'); mk('old', '.c4pm');
    const { initProject } = require('../src/init');
    expect(initProject(path.join(tmp, 'new')).created.every((p: string) => p.includes('.c4mp'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'new', '.c4mp', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'new', '.c4pm'))).toBe(false);
    initProject(path.join(tmp, 'old'));
    expect(fs.existsSync(path.join(tmp, 'old', '.c4pm', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'old', '.c4mp'))).toBe(false);
  });
});

describe('migrateDataDir', () => {
  const { migrateDataDir } = require('../src/services/migrateDataDir');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const oldRepo = (name: string) => {
    const r = mk(name);
    fs.mkdirSync(path.join(r, '.c4pm', 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(r, '.c4pm', 'config.json'), '{}\n');
    fs.writeFileSync(path.join(r, '.c4pm', '.gitignore'), '# c4pm regenerable data (x)\nprojects/*/data/\n');
    return r;
  };

  it('dry run changes nothing', () => {
    const r = oldRepo('r');
    const res = migrateDataDir(r, { yes: false });
    expect(res.status).toBe('would-move');
    expect(res.gitignoreFixed).toBe(true);
    expect(fs.existsSync(path.join(r, '.c4pm'))).toBe(true);
    expect(fs.existsSync(path.join(r, '.c4mp'))).toBe(false);
  });
  it('--yes in a non-git folder renames and fixes the .gitignore comment', () => {
    const r = oldRepo('r');
    const res = migrateDataDir(r, { yes: true });
    expect(res).toMatchObject({ status: 'moved', method: 'rename' });
    expect(fs.existsSync(path.join(r, '.c4pm'))).toBe(false);
    expect(fs.readFileSync(path.join(r, '.c4mp', '.gitignore'), 'utf8')).toMatch(/^# c4mp regenerable data/);
    expect(migrateDataDir(r, { yes: true }).status).toBe('nothing');
  });
  it('--yes in a git repo with tracked data uses git mv (a rename in the index)', () => {
    const r = oldRepo('g');
    git(r, 'init', '-q');
    git(r, 'add', '.');
    git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    const res = migrateDataDir(r, { yes: true });
    expect(res).toMatchObject({ status: 'moved', method: 'git mv' });
    expect(git(r, 'status', '--porcelain')).toMatch(/^R .*\.c4pm\/config\.json -> \.c4mp\/config\.json/m);
  });
  it('refuses when both exist, naming both; nothing to migrate when neither', () => {
    const r = oldRepo('b'); mk('b', '.c4mp');
    const res = migrateDataDir(r, { yes: true });
    expect(res.status).toBe('refused');
    expect(res.message).toMatch(/\.c4pm and \.c4mp/);
    expect(fs.existsSync(path.join(r, '.c4pm'))).toBe(true);
    expect(migrateDataDir(mk('empty'), { yes: false })).toMatchObject({ status: 'nothing', message: 'nothing to migrate' });
  });
  it('the command: --json is clean on stdout and stderr, text mode prints the plan', () => {
    const r = oldRepo('c');
    const env = { ...process.env, C4MP_USER_DIR: 'off', C4PM_USER_DIR: 'off', C4MP_NO_NOTES: '' };
    const j = runCli(['migrate', '--repo', r, '--json'], { env });
    expect(j.status).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({ status: 'would-move' });
    expect(j.stderr).toBe('');
    const t = runCli(['migrate', '--repo', r, '--yes'], { env });
    expect(t.stdout).toMatch(/moved \.c4pm to \.c4mp/);
    expect(fs.existsSync(path.join(r, '.c4mp'))).toBe(true);
  });
  it('end to end in a git repo: status works on the old .c4pm, migrate --yes moves it, status works from .c4mp', () => {
    const r = oldRepo('e2e');
    git(r, 'init', '-q');
    fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: 'e2e-app' }));
    fs.mkdirSync(path.join(r, 'src'));
    fs.writeFileSync(path.join(r, 'src', 'a.ts'), 'export const a = 1;\n');
    const env = { ...process.env, C4MP_USER_DIR: 'off', C4PM_USER_DIR: 'off' };
    const before = runCli(['status', '--repo', r], { env });
    expect(before.status).toBe(0);
    expect(fs.existsSync(path.join(r, '.c4mp'))).toBe(false);
    const mig = runCli(['migrate', '--repo', r, '--yes'], { env });
    expect(mig.status).toBe(0);
    expect(fs.existsSync(path.join(r, '.c4pm'))).toBe(false);
    const after = runCli(['status', '--repo', r], { env });
    expect(after.status).toBe(0);
    expect(after.stderr).not.toMatch(/still uses \.c4pm/);
    expect(fs.existsSync(path.join(r, '.c4pm'))).toBe(false);
  });
});
