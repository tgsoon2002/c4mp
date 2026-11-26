import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPlanCli, makeRepo, listing } from './helpers/planEditHarness';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';
import { loadWireframes } from '../src/c4/wireframeFiles';
import { starterWireframe, wireframeOf } from '../src/c4/wireframeRefs';
import { runCheck } from '../src/query/check';

// W9 (b305): `c4mp plan wireframe <screen>` writes a starter io/<screen fqn>.html (PHASE_20_WIREFRAMES.md section 7 L5),
// in-process on tmp copies of the io-shop plan (four screens, regions with controls, states that are not placed).
const SHOP = fs.readFileSync(path.join(__dirname, 'fixtures', 'io-shop', 'c4', 'shop.c4'), 'utf-8');
const SCREENS = ['shop.web.login', 'shop.web.home', 'shop.web.products', 'shop.web.cart'];

type Repo = ReturnType<typeof makeRepo>;
const cli = (repo: Repo, ...args: string[]) => runPlanCli(['plan', 'wireframe', ...args, '--repo', repo.root]);
const planOf = (root: string) => parsePlan(root, findPlanFiles(root, loadConfig(root, {})).files);
const wireFindings = (root: string) => runCheck(root, {}, {})!.findings.filter(f => f.rule.startsWith('wireframe-'));

describe('c4mp plan wireframe <screen>', () => {
  let repo: Repo;
  let io: string;
  beforeEach(() => {
    repo = makeRepo('c4mp-wf-starter-', { 'shop.c4': SHOP });
    io = path.join(repo.planDir, 'io');
  });
  afterEach(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  it('dry run prints the file and writes nothing', async () => {
    const before = listing(repo.root);
    const r = await cli(repo, 'login');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    for (const line of [
      'wireframe shop.web.login',
      '+<link rel="stylesheet" href="site.css">',
      '+  <div data-c4="form" class="form">',
      '+      <button data-c4="email" class="btn"></button>',
      'note: io/site.css does not exist',
      'dry run: nothing written. Add --yes to apply.',
    ]) expect(r.stdout).toContain(line);
    expect(r.stdout).not.toContain('data-c4="loading"');   // states are not placed (H5)
    expect(listing(repo.root)).toEqual(before);
  });

  it('--yes writes io/<fqn>.html (io/ made when missing); a second run is refused and leaves it alone', async () => {
    expect(fs.existsSync(io)).toBe(false);
    const r = await cli(repo, 'shop.web.login', '--yes');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const file = path.join(io, 'shop.web.login.html');
    expect(fs.readFileSync(file, 'utf-8')).toBe(starterWireframe(planOf(repo.root), 'shop.web.login'));
    expect(r.stdout).toContain('written: .c4mp/projects/');
    expect(fs.readdirSync(io)).toEqual(['shop.web.login.html']);   // one file per command: no site.css

    const plan = fs.readFileSync(repo.files['shop.c4'], 'utf-8');
    const again = await cli(repo, 'shop.web.login', '--yes');
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/^error: invalid: .*io\/shop\.web\.login\.html exists; plan wireframe never overwrites/);
    expect(fs.readFileSync(file, 'utf-8')).toBe(starterWireframe(planOf(repo.root), 'shop.web.login'));
    expect(fs.readFileSync(repo.files['shop.c4'], 'utf-8')).toBe(plan);
  });

  it.each([
    ['a container', 'shop.web', /shop\.web is a container, not a screen/],
    ['a region', 'shop.web.login.form', /shop\.web\.login\.form is a region, not a screen/],
  ])('%s is refused with exit 1, nothing written', async (_name, target, message) => {
    const before = listing(repo.root);
    const r = await cli(repo, target, '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(listing(repo.root)).toEqual(before);
  });

  it.each(SCREENS)('the written file of %s round-trips: nothing missing, no ref problem, no wireframe finding', async fqn => {
    fs.mkdirSync(io);
    fs.writeFileSync(path.join(io, 'site.css'), '.page { display: flex; flex-direction: column; height: 100%; }\n.row { display: flex; }\n.btn { width: 80px; height: 28px; }\n');
    const r = await cli(repo, fqn, '--yes');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('note: io/site.css');
    const plan = planOf(repo.root);
    const load = loadWireframes(repo.root, repo.planDir, [fqn]);
    if (load.status !== 'ok') throw new Error('expected an io/ folder');
    const wf = wireframeOf(plan, fqn, load.files.get(fqn)!);
    expect(wf.missing).toEqual([]);
    expect(wf.refs.filter(x => x.problem !== undefined)).toEqual([]);
    expect(load.files.get(fqn)!.inlined).toEqual(['site.css']);
    expect(wireFindings(repo.root).filter(f => f.id === fqn || f.id.endsWith(`/${fqn}.html`))).toEqual([]);
  });

  it('without io/site.css the file still loads; check reports only the dropped link', async () => {
    await cli(repo, 'login', '--yes');
    const findings = wireFindings(repo.root).filter(f => f.id.endsWith('/shop.web.login.html') || f.id === 'shop.web.login');
    expect(findings).toEqual([
      { severity: 'warning', rule: 'wireframe-bad-stylesheet', id: expect.stringMatching(/io\/shop\.web\.login\.html$/), message: '<link href="site.css"> dropped: file does not exist' },
    ]);
  });
});

describe('c4mp plan wireframe on a repo-wide plan (no plan folder, K1)', () => {
  it('is refused with exit 1 and writes nothing', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-wf-wide-')));
    try {
      fs.mkdirSync(path.join(root, '.git'));
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'docs', 'shop.c4'), SHOP);
      const before = listing(root);
      const r = await runPlanCli(['plan', 'wireframe', 'login', '--yes', '--repo', root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/the plan has no folder/);
      expect(listing(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
