import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { initProject, INTERNAL_GITIGNORE } from '../src/init';
import { INTERNAL_DIR } from '../src/paths';
import { DEFAULT_CONFIG } from '../src/config';
import { runCli } from './helpers/runCli';

let tmp: string;
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-init-'))); });
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

const GITIGNORE = [
  '# c4mp regenerable data (rebuilt from the code and from git). Plan, config and layout stay committed.',
  'projects/*/data/',
  'projects/*/history/',
  '',
].join('\n');

describe('initProject', () => {
  it('creates .c4pm at the git root, not at the target', () => {
    mk('.git');
    const t = mk('sub', 'myrepo');
    const r = initProject(t);
    expect(r.anchor).toBe(tmp);
    expect(fs.existsSync(path.join(t, INTERNAL_DIR))).toBe(false);
    const proj = path.join(tmp, INTERNAL_DIR, 'projects', 'myrepo');
    for (const d of ['data', 'history', 'plan']) expect(fs.statSync(path.join(proj, d)).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'C4PM'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, INTERNAL_DIR, '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(INTERNAL_GITIGNORE).toBe(GITIGNORE);
    expect(fs.readFileSync(path.join(tmp, INTERNAL_DIR, 'config.json'), 'utf8'))
      .toBe(JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    expect(r.created).toContain(path.join(tmp, INTERNAL_DIR, 'config.json'));
    expect(r.existing).toEqual([]);
  });

  noMarkerIt('without git, creates .c4pm at the target', () => {
    const t = mk('lonely');
    const r = initProject(t);
    expect(r.anchor).toBe(t);
    expect(fs.existsSync(path.join(t, INTERNAL_DIR, 'config.json'))).toBe(true);
  });

  it('is idempotent and never overwrites edited files', () => {
    mk('.git');
    const t = mk('r');
    initProject(t);
    const cfg = path.join(tmp, INTERNAL_DIR, 'config.json');
    const gi = path.join(tmp, INTERNAL_DIR, '.gitignore');
    fs.writeFileSync(cfg, '{"edited":true}\n');
    fs.writeFileSync(gi, 'custom\n');
    const r2 = initProject(t);
    expect(r2.created).toEqual([]);
    expect(r2.existing.length).toBeGreaterThan(0);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"edited":true}\n');
    expect(fs.readFileSync(gi, 'utf8')).toBe('custom\n');
  });

  it('adds only .c4pm to the anchor', () => {
    mk('.git');
    fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
    const before = fs.readdirSync(tmp).sort();
    initProject(tmp);
    const after = fs.readdirSync(tmp).sort();
    expect(after.filter(n => !before.includes(n))).toEqual([INTERNAL_DIR]);
    expect(before.every(n => after.includes(n))).toBe(true);
  });
});

describe('c4pm init CLI', () => {
  it('exits 0 and reports .c4pm', () => {
    mk('.git');
    const res = runCli(['init', '--repo', tmp], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(INTERNAL_DIR);
    expect(res.stdout).toContain(`anchor: ${tmp}`);
    const again = runCli(['init', '--repo', tmp], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    expect(again.stdout).toContain('already initialised');
  }, 60000);
});
