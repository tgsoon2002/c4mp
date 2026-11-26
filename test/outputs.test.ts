import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { toId } from '../src/names';
import { soleProjectId } from '../src/paths';
import { projectIdFor, tryResolveProject, requireProject, configOptsFor, scanConfigFor, defaultStoreRoot, resolveStoreRoot, ensureExportDir, ensureInternalDirFor } from '../src/outputs';
import { ensureInternalDir, INTERNAL_GITIGNORE } from '../src/init';
import { AnchorNotFoundError, INTERNAL_DIR } from '../src/paths';
import { runCli } from './helpers/runCli';

let tmp: string;
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-outputs-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function markerAboveTmp(): boolean {
  let d = fs.realpathSync(os.tmpdir());
  for (;;) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, INTERNAL_DIR))) return true;
    const u = path.dirname(d);
    if (u === d) return false;
    d = u;
  }
}
const noMarkerIt = markerAboveTmp() ? it.skip : it;

function mkRepo(name = 'demo-app'): string {
  mk('.git');
  const repo = mk('packages', 'folder-name');
  mk('packages', 'folder-name', 'src');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  return repo;
}

describe('outputs helper', () => {
  it('projectIdFor uses package.json name, not folder name', () => {
    expect(projectIdFor(mkRepo('Demo-App'))).toBe('demo-app');
  });

  describe('soleProjectId (Phase 34)', () => {
    const mkRoot = (...projects: string[]) => {
      mk('.git');
      const code = mk('Project');
      for (const p of projects) mk('.c4mp', 'projects', p);
      return code;
    };

    it('no package.json + one project folder -> that id', () => {
      const code = mkRoot('c4mp');
      expect(soleProjectId(tmp)).toBe('c4mp');
      expect(projectIdFor(tmp)).toBe('c4mp');
      expect(requireProject(tmp).planDir).toBe(path.join(tmp, '.c4mp', 'projects', 'c4mp', 'plan'));
      // a folder below the anchor with no package.json keeps its own name (b927 follow-up)
      expect(projectIdFor(code)).toBe('project');
    });

    it('b927 follow-up: the sole project id applies only at the .c4mp folder itself', () => {
      mk('.c4mp', 'projects', 'x');
      const sub = mk('sub');
      expect(projectIdFor(tmp)).toBe('x');
      expect(projectIdFor(sub)).toBe('sub');
    });

    it('no package.json + two project folders -> the folder-name id, as before', () => {
      mkRoot('one', 'two');
      expect(soleProjectId(tmp)).toBeNull();
      expect(projectIdFor(tmp)).toBe(toId(path.basename(tmp)));
    });

    it('no project folder -> null', () => {
      mkRoot();
      expect(soleProjectId(tmp)).toBeNull();
    });

    it('a package.json name wins over a different sole folder', () => {
      const code = mkRoot('other');
      fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'Demo-App' }));
      expect(projectIdFor(code)).toBe('demo-app');
    });
  });

  it('resolves project paths at the anchor with the package.json-name id', () => {
    const repo = mkRepo();
    const p = requireProject(repo);
    expect(p.anchor).toBe(tmp);
    expect(p.repoId).toBe('demo-app');
    expect(p.dataDir).toBe(path.join(tmp, INTERNAL_DIR, 'projects', 'demo-app', 'data'));
    expect(tryResolveProject(repo)).toEqual(p);
    expect(defaultStoreRoot(p)).toBe(path.join(tmp, INTERNAL_DIR, 'projects'));
    expect(configOptsFor(repo)).toEqual({ configPath: path.join(tmp, INTERNAL_DIR, 'config.json') });
  });

  noMarkerIt('no anchor: try -> null, require -> throws with init hint, configOpts -> {}', () => {
    const repo = mk('lonely');
    expect(tryResolveProject(repo)).toBeNull();
    expect(configOptsFor(repo)).toEqual({});
    let err: unknown;
    try { requireProject(repo); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AnchorNotFoundError);
    expect((err as Error).message).toContain('c4mp init --repo');
  });
});

describe('scanConfigFor (P14-T18a)', () => {
  const writeCfg = (obj: unknown) => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(tmp, '.c4mp'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.c4mp', 'config.json'), JSON.stringify(obj));
    return repo;
  };

  it('reads languages and ignore from .c4mp/config.json', () => {
    const repo = writeCfg({ languages: ['typescript', 'python'], ignore: ['vendor'] });
    expect(scanConfigFor(repo)).toEqual({ languages: ['typescript', 'python'], ignore: ['vendor'] });
  });

  it('CLI value beats the file', () => {
    const repo = writeCfg({ languages: ['typescript', 'python'] });
    expect(scanConfigFor(repo, { languages: ['typescript'] }).languages).toEqual(['typescript']);
  });

  it('invalid file value throws the config error', () => {
    const repo = writeCfg({ languages: ['klingon'] });
    expect(() => scanConfigFor(repo)).toThrow(/unknown language "klingon"/);
  });
});

describe('snapshot CLI output location', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const run = (args: string[], cwd: string) =>
    runCli(['snapshot', ...args], { cwd, encoding: 'utf8' });
  const names = ['outline', 'imports', 'components', 'snapshot'];

  it('writes to .c4mp data dir at the anchor, nothing in cwd', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    const res = run(['--repo', repo], cwd);
    expect(res.status).toBe(0);
    for (const n of names) expect(fs.existsSync(path.join(tmp, INTERNAL_DIR, 'projects/demo-app/data', `${n}.json`))).toBe(true);
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 60000);

  it('--save writes history under the project folder', () => {
    const repo = mkRepo();
    const res = run(['--repo', repo, '--save'], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, INTERNAL_DIR, 'projects/demo-app/history/manifest.json'))).toBe(true);
  }, 60000);

  it('--out explicit writes only there', () => {
    const repo = mkRepo();
    const out = path.join(tmp, 'elsewhere');
    const res = run(['--repo', repo, '--out', out], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    for (const n of names) expect(fs.existsSync(path.join(out, `${n}.json`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, INTERNAL_DIR))).toBe(false);
  }, 60000);

  noMarkerIt('no anchor and no --out fails with init hint, writes nothing', () => {
    const repo = mk('lonely');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    const cwd = mk('spawn-cwd');
    const res = run(['--repo', repo], cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('c4mp init');
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, INTERNAL_DIR))).toBe(false);
  }, 60000);
});

describe('resolveStoreRoot', () => {
  it('explicit wins over config, config wins over default; both resolved to absolute', () => {
    const repo = mkRepo();
    expect(resolveStoreRoot(repo, 'ex', 'cfg')).toBe(path.resolve('ex'));
    expect(resolveStoreRoot(repo, undefined, 'cfg')).toBe(path.resolve('cfg'));
    expect(resolveStoreRoot(repo, '', null)).toBe(path.join(tmp, INTERNAL_DIR, 'projects'));
  });

  it('explicit/config do not need an anchor', () => {
    expect(resolveStoreRoot(mk('lonely'), '/x/y', null)).toBe('/x/y');
  });

  noMarkerIt('no anchor and nothing given throws with init hint', () => {
    expect(() => resolveStoreRoot(mk('lonely'))).toThrow(/c4mp init --repo/);
  });
});

describe('store-default CLI commands', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const cli = (cmd: string, args: string[], cwd: string) =>
    runCli([cmd, ...args], { cwd, encoding: 'utf8' });
  const hist = () => path.join(tmp, INTERNAL_DIR, 'projects/demo-app/history');

  it('snapshot --save then snapshots lists it from the default store', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    expect(cli('snapshot', ['--repo', repo, '--save'], cwd).status).toBe(0);
    const res = cli('snapshots', ['--repo', repo], cwd);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('1 snapshots in ' + hist());
  }, 90000);

  it('history writes manifest under the project folder, nothing in cwd', () => {
    const repo = mkRepo();
    fs.rmSync(path.join(tmp, '.git'), { recursive: true });
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: tmp, encoding: 'utf8' });
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
    const cwd = mk('spawn-cwd');
    const res = cli('history', ['--repo', repo, '--max', '1'], cwd);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(hist(), 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false);
  }, 90000);

  it('diff between two saved snapshots reads the default store', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    cli('snapshot', ['--repo', repo, '--save'], cwd);
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    cli('snapshot', ['--repo', repo, '--save'], cwd);
    const res = cli('diff', ['--repo', repo, '--from', 'prev', '--to', 'latest'], cwd);
    expect(res.status).toBe(0);
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 120000);

  it('explicit --store still wins', () => {
    const repo = mkRepo();
    const store = path.join(tmp, 'mystore');
    const cwd = mk('spawn-cwd');
    expect(cli('snapshot', ['--repo', repo, '--save', '--store', store], cwd).status).toBe(0);
    const res = cli('snapshots', ['--repo', repo, '--store', store], cwd);
    expect(res.stdout).toContain('1 snapshots in ' + path.join(store, 'demo-app', 'history'));
    expect(fs.existsSync(hist())).toBe(false);
  }, 90000);

  noMarkerIt.each(['history', 'snapshots', 'diff'])('%s with no anchor and no store exits 1 with init hint', (cmd) => {
    const repo = mk('lonely');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    const cwd = mk('spawn-cwd');
    const res = cli(cmd, ['--repo', repo], cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('c4mp init');
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 60000);

  noMarkerIt('status with no anchor still exits 0 and says no .c4mp found', () => {
    const repo = mk('lonely');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    const res = cli('status', ['--repo', repo], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no .c4mp found');
  }, 60000);
});

describe('ensureExportDir', () => {
  it('creates the export folder and a self-ignoring .gitignore once, never overwriting', () => {
    const p = requireProject(mkRepo());
    ensureExportDir(p);
    const ig = path.join(tmp, 'C4MP', '.gitignore');
    expect(fs.existsSync(p.exportDir)).toBe(true);
    expect(fs.readFileSync(ig, 'utf8')).toBe('*\n');
    fs.writeFileSync(ig, 'custom\n');
    ensureExportDir(p);
    expect(fs.readFileSync(ig, 'utf8')).toBe('custom\n');
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(false);
  });
});

describe('view CLI output location', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const view = (args: string[], cwd: string) =>
    runCli(['view', ...args], { cwd, encoding: 'utf8' });
  const viewFile = () => path.join(tmp, 'C4MP', 'demo-app', 'c4mpView.html');

  it('default writes C4MP/<repoId>/c4mpView.html + self-ignore, prints the path, nothing in cwd', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    const res = view(['--repo', repo], cwd);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(viewFile());
    expect(fs.readFileSync(viewFile(), 'utf8')).toContain('C4PM_MAP');
    expect(fs.readFileSync(path.join(tmp, 'C4MP', '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 60000);

  it('second run does not rewrite an edited C4MP/.gitignore', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    expect(view(['--repo', repo], cwd).status).toBe(0);
    const ig = path.join(tmp, 'C4MP', '.gitignore');
    fs.writeFileSync(ig, 'edited\n');
    expect(view(['--repo', repo], cwd).status).toBe(0);
    expect(fs.readFileSync(ig, 'utf8')).toBe('edited\n');
  }, 120000);

  it('--out writes only there, no C4MP folder', () => {
    const repo = mkRepo();
    const out = path.join(tmp, 'elsewhere', 'v.html');
    const res = view(['--repo', repo, '--out', out], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'C4MP'))).toBe(false);
  }, 60000);

  noMarkerIt('no anchor and no --out fails with init hint, writes nothing', () => {
    const repo = mk('lonely');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    const cwd = mk('spawn-cwd');
    const res = view(['--repo', repo], cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('c4mp init');
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'C4MP'))).toBe(false);
  }, 60000);

  noMarkerIt('no anchor with --out still works (store undefined, as before)', () => {
    const repo = mk('lonely');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    const out = path.join(tmp, 'v.html');
    expect(view(['--repo', repo, '--out', out], mk('spawn-cwd')).status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  }, 60000);

  it('--from prev reads the default store', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    const snap = () => runCli(['snapshot', '--repo', repo, '--save'], { cwd, encoding: 'utf8' });
    expect(snap().status).toBe(0);
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    expect(snap().status).toBe(0);
    const res = view(['--repo', repo, '--from', 'prev'], cwd);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(fs.readFileSync(viewFile(), 'utf8')).toContain('C4PM_MAP');
  }, 180000);
});

describe('ensureInternalDir (P12-T13)', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const cli = (cmd: string, args: string[], cwd: string) =>
    runCli([cmd, ...args], { cwd, encoding: 'utf8' });
  const ignoreOf = (anchor: string) => path.join(anchor, INTERNAL_DIR, '.gitignore');

  it('unit: creates exact .gitignore once, never overwrites, never creates config.json', () => {
    const repo = mkRepo();
    const paths = requireProject(repo);
    ensureInternalDir(paths);
    expect(fs.readFileSync(ignoreOf(tmp), 'utf8')).toBe(INTERNAL_GITIGNORE);
    ensureInternalDir(paths); // idempotent
    expect(fs.readFileSync(ignoreOf(tmp), 'utf8')).toBe(INTERNAL_GITIGNORE);
    fs.writeFileSync(ignoreOf(tmp), 'custom\n');
    ensureInternalDir(paths);
    expect(fs.readFileSync(ignoreOf(tmp), 'utf8')).toBe('custom\n');
    expect(fs.existsSync(paths.configFile)).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(false);
  });

  it('unit: ensureInternalDirFor ignores targets outside .c4mp', () => {
    const repo = mkRepo();
    const paths = requireProject(repo);
    expect(ensureInternalDirFor(paths, path.join(tmp, 'elsewhere'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, INTERNAL_DIR))).toBe(false);
    expect(ensureInternalDirFor(paths, paths.dataDir)).toBe(true);
    expect(fs.existsSync(ignoreOf(tmp))).toBe(true);
  });

  it('snapshot --save without init writes .c4mp/.gitignore', () => {
    const repo = mkRepo();
    const res = cli('snapshot', ['--repo', repo, '--save'], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    expect(fs.readFileSync(ignoreOf(tmp), 'utf8')).toBe(INTERNAL_GITIGNORE);
    expect(fs.existsSync(path.join(tmp, INTERNAL_DIR, 'config.json'))).toBe(false);
  }, 120000);

  it('history without init writes .c4mp/.gitignore', () => {
    const repo = mkRepo();
    cli('history', ['--repo', repo, '--max', '1'], mk('spawn-cwd'));
    // not a real git repo here: history may fail, but the guard runs before any store write
    expect(fs.existsSync(ignoreOf(tmp))).toBe(true);
  }, 120000);

  it('real git: after snapshot --save, git status shows no data/history paths', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'real-git' }));
    mk('src');
    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export const a = 1;\n');
    expect(spawnSync('git', ['init', '-q'], { cwd: tmp }).status).toBe(0);
    const res = cli('snapshot', ['--repo', tmp, '--save'], mk('spawn-cwd'));
    expect(res.status).toBe(0);
    const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: tmp, encoding: 'utf8' }).stdout;
    const lines = st.split('\n').filter(Boolean);
    expect(lines.some(l => l.includes(`${INTERNAL_DIR}/.gitignore`))).toBe(true);
    expect(lines.filter(l => /\.c4mp\/projects\/[^/]+\/(data|history)\//.test(l))).toEqual([]);
  }, 120000);

  it('read-only commands on a fresh anchor create no .c4mp', () => {
    const repo = mkRepo();
    const cwd = mk('spawn-cwd');
    for (const cmd of ['status', 'check', 'snapshots']) {
      cli(cmd, ['--repo', repo], cwd);
      expect(fs.existsSync(path.join(tmp, INTERNAL_DIR))).toBe(false);
    }
  }, 180000);
});
