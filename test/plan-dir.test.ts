import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { requireProject } from '../src/outputs';
import { planDirsFor, findPlanFiles } from '../src/plan/files';
import { INTERNAL_DIR } from '../src/paths';
import { DATA_DIR } from '../src/constants';
import { runSnapshot } from '../src/pipeline';
import { generateC4 } from '../src/c4/generate';
import { parsePlan } from '../src/plan/parser';
import { resolveLinks } from '../src/plan/resolve';
import { runCli as spawnCli } from './helpers/runCli';

// P12-T9: plans live in <anchor>/.c4pm/projects/<repoId>/plan; link base follows the real folder.

const projectRoot = path.resolve(__dirname, '..');
let tmp: string;
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-plandir-'))); });
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

/** <tmp>/.git anchor, repo at <tmp>/Project named demo-app with two folders. */
function mkRepo(): string {
  mk('.git');
  const repo = mk('Project');
  write(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  write(path.join(repo, 'src', 'alpha', 'a.ts'), 'export const a = 1;\n');
  write(path.join(repo, 'src', 'beta', 'b.ts'), "import { a } from '../alpha/a';\nexport const b = a + 1;\n");
  return repo;
}

function runCli(args: string[], cwd = projectRoot) {
  return spawnCli([...args], { cwd, encoding: 'utf8' });
}
const c4In = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.c4')) : []);

describe('planDirsFor / findPlanFiles', () => {
  it('orders architectureDir > planDir > legacy c4 with an anchor', () => {
    const repo = mkRepo();
    const planDir = requireProject(repo).planDir;
    expect(planDirsFor(repo, { architectureDir: 'docs/arch' })).toEqual([path.join(repo, 'docs/arch'), planDir, path.join(repo, 'c4')]);
    expect(planDirsFor(repo, { architectureDir: null })).toEqual([planDir, path.join(repo, 'c4')]);
  });

  noMarkerIt('omits planDir when there is no anchor', () => {
    const repo = mk('lonely');
    expect(planDirsFor(repo, null)).toEqual([path.join(repo, 'c4')]);
  });

  it('first existing candidate wins; legacy c4 still found when planDir has none', () => {
    const repo = mkRepo();
    write(path.join(repo, 'c4', 'legacy.c4'), '// x\n');
    expect(findPlanFiles(repo, null)).toEqual({ dir: path.join(repo, 'c4'), files: ['c4/legacy.c4'] });
    const planDir = requireProject(repo).planDir;
    write(path.join(planDir, 'new.c4'), '// y\n');
    const found = findPlanFiles(repo, null);
    expect(found.dir).toBe(planDir);
    expect(found.files).toEqual([`../${DATA_DIR}/projects/demo-app/plan/new.c4`]);
  });
});

describe('generateC4 link base round trip', () => {
  function roundTrip(repo: string, outDir: string) {
    const snapshot = runSnapshot({ repo, write: false, quiet: true });
    const linkBase = path.relative(repo, outDir).split(path.sep).join('/');
    const files = generateC4(snapshot, null, { linkBase, repoRoot: repo });
    for (const [name, text] of Object.entries(files)) write(path.join(outDir, name), text);
    const rel = Object.keys(files).map(f => path.relative(repo, path.join(outDir, f)).split(path.sep).join('/'));
    const plan = parsePlan(repo, rel);
    return { linkBase, resolved: resolveLinks(plan, repo, snapshot.files), files };
  }

  it.each([
    ['plan outside the repo (.c4pm at the anchor)', (repo: string) => path.join(repo, '..', DATA_DIR, 'projects', 'demo-app', 'plan')],
    ['plan in a non-c4 folder inside the repo', (repo: string) => path.join(repo, 'docs', 'arch')],
  ])('%s: every generated link resolves to a real source path', (_n, outOf) => {
    const repo = mkRepo();
    const { resolved, linkBase } = roundTrip(repo, outOf(repo));
    expect(linkBase).not.toBe('c4');
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every(r => r.exists)).toBe(true);
    expect(resolved.some(r => r.link.path === 'src/alpha/')).toBe(true);
  });

  it('default linkBase c4 is unchanged (old callers)', () => {
    const repo = mkRepo();
    const snapshot = runSnapshot({ repo, write: false, quiet: true });
    const counter = () => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); };
    expect(generateC4(snapshot, null, { newUid: counter() })).toEqual(generateC4(snapshot, null, { linkBase: 'c4', newUid: counter() }));
  });
});

describe('CLI: plans in the data folder', () => {
  it('generate-c4 writes to planDir (not <repo>/c4); check and view pick it up', () => {
    const repo = mkRepo();
    const planDir = path.join(tmp, DATA_DIR, 'projects', 'demo-app', 'plan');
    const gen = runCli(['plan', 'generate', '--repo', repo]);
    expect(gen.status).toBe(0);
    expect(c4In(planDir)).toContain('architecture.c4');
    expect(fs.existsSync(path.join(repo, 'c4'))).toBe(false);

    const chk = runCli(['check', '--repo', repo]);
    expect(chk.stdout).not.toContain('no .c4 files found');
    expect(chk.stdout).toContain('0 findings');

    const plan = runCli(['plan', '--repo', repo]);
    expect(plan.stdout).toMatch(/\d+ \.c4 files/);
    expect(plan.stdout).toContain('alpha');

    const out = path.join(tmp, 'view.html');
    const view = runCli(['view', '--repo', repo, '--out', out]);
    expect(view.status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('alpha');
  });

  it('plan generate keeps a comment written inside a component and a container block (b397); a third run changes nothing', () => {
    const repo = mkRepo();
    const planDir = path.join(tmp, DATA_DIR, 'projects', 'demo-app', 'plan');
    expect(runCli(['plan', 'generate', '--repo', repo]).status).toBe(0);
    const comp = path.join(planDir, 'demo_app.c4');
    const arch = path.join(planDir, 'architecture.c4');
    const compFile = fs.existsSync(comp) ? comp : path.join(planDir, c4In(planDir).find(f => f !== 'architecture.c4')!);
    write(compFile, fs.readFileSync(compFile, 'utf8').replace(/( {4}\w+ = component '[^']*' \{\n)/, '$1      // my note\n'));
    write(arch, fs.readFileSync(arch, 'utf8').replace(/( {4}\w+ = container '[^']*' \{\n)/, '$1      // cont note\n'));
    const snap = () => c4In(planDir).map(f => fs.readFileSync(path.join(planDir, f), 'utf8'));
    const before = snap();
    expect(runCli(['plan', 'generate', '--repo', repo]).status).toBe(0);
    expect(snap()).toEqual(before);
    expect(before.join('')).toContain('// my note');
    expect(before.join('')).toContain('// cont note');
    expect(runCli(['plan', 'generate', '--repo', repo]).status).toBe(0);
    expect(snap()).toEqual(before);
  });

  it('--out overrides planDir; architectureDir overrides planDir', () => {
    const repo = mkRepo();
    const o = path.join(tmp, 'elsewhere');
    expect(runCli(['plan', 'generate', '--repo', repo, '--out', o]).status).toBe(0);
    expect(c4In(o)).toContain('architecture.c4');
    expect(c4In(path.join(tmp, DATA_DIR, 'projects', 'demo-app', 'plan'))).toEqual([]);

    mk(DATA_DIR);
    write(path.join(tmp, DATA_DIR, 'config.json'), JSON.stringify({ architectureDir: 'docs/arch' }));
    expect(runCli(['plan', 'generate', '--repo', repo]).status).toBe(0);
    expect(c4In(path.join(repo, 'docs', 'arch'))).toContain('architecture.c4');
    expect(c4In(path.join(tmp, DATA_DIR, 'projects', 'demo-app', 'plan'))).toEqual([]);
  });

  it('legacy <repo>/c4 plan is still found by plan when planDir is empty', () => {
    const repo = mkRepo();
    expect(runCli(['plan', 'generate', '--repo', repo, '--out', path.join(repo, 'c4')]).status).toBe(0);
    expect(c4In(path.join(tmp, DATA_DIR, 'projects', 'demo-app', 'plan'))).toEqual([]);
    const plan = runCli(['plan', '--repo', repo]);
    expect(plan.stdout).toMatch(/\d+ \.c4 files, [1-9]\d* elements/);
    expect(plan.stdout).toContain('demo_app');
  });

  noMarkerIt('no anchor and no flags: exit 1 with init hint, nothing written', () => {
    const repo = mk('lonely');
    write(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo-app' }));
    write(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = runCli(['plan', 'generate', '--repo', repo]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('c4mp init');
    expect(fs.readdirSync(repo).sort()).toEqual(['package.json', 'src']);
  });
});
