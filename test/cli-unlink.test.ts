import * as fs from 'fs';
import { runPlanCli, makeRepo, listing, writeSource } from './helpers/planEditHarness';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// b904: `c4mp plan unlink`, in-process on tmp repos (same harness and plan as cli-link.test.ts).
const UID_AUTH = '00000000-0000-4000-8000-000000000002';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  `        metadata { uid '${UID_AUTH}' }`,
  "        plan_fn = function 'planFn' {",
  "          metadata { status 'planned' signature 'planFn(): void' }",
  '        }',
  '      }',
  "      other = component 'Other'",
  "      ui = layer 'Ui' { page = component 'Page' }",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
let BASE = PLAN;   // PLAN plus a folder link on page, so unlinking auth never leaves code unowned
beforeEach(async () => {
  repo = makeRepo('c4mp-unlink-', { 'a.c4': PLAN });
  writeSource(repo.root, repo.planDir, 'src/auth/login.ts', 'export function login(): void {}\n');
  writeSource(repo.root, repo.planDir, 'src/auth/other.ts', 'export function other(): void {}\n');
  await runPlanCli(['plan', 'link', 'page', 'src/auth/', '--yes', '--repo', repo.root]);
  BASE = fs.readFileSync(repo.files['a.c4'], 'utf-8');
});
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const run = (verb: 'link' | 'unlink', ...args: string[]) => runPlanCli(['plan', verb, ...args, '--repo', repo.root]);
const link = (...a: string[]) => run('link', ...a);
const unlink = (...a: string[]) => run('unlink', ...a);
const text = () => fs.readFileSync(repo.files['a.c4'], 'utf-8');
const reparse = () => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
const links = (id: string) => reparse().elements.find(e => e.id === id)!.links.map(l => l.path + (l.name ? '#' + l.name : ''));

describe('c4mp plan unlink', () => {
  it.each(['src/auth/login.ts'])('link then unlink %s leaves the file byte-identical', async arg => {
    const l = await link('auth', arg, '--yes'); expect([l.code, l.stderr]).toEqual([0, '']);
    expect(text()).not.toBe(BASE);
    const r = await unlink('auth', arg, '--yes');
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(text()).toBe(BASE);
  });

  it('a #function link and a folder link match by their fragment', async () => {
    const withFn = BASE.replace('        plan_fn =', '        link ../../../../src/auth/login.ts#login\n        plan_fn =');
    fs.writeFileSync(repo.files['a.c4'], withFn);
    expect((await unlink('auth', 'src/auth/login.ts', '--yes')).stderr).toMatch(/has no link 'src\/auth\/login\.ts' \(links: src\/auth\/login\.ts#login\)/);
    const r = await unlink('auth', 'src/auth/login.ts#login', '--yes');
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(text()).toBe(BASE);
  });

  it('dry run prints the removed line and writes nothing', async () => {
    await link('auth', 'src/auth/login.ts', '--yes');
    const before = fs.readFileSync(repo.files['a.c4']);
    const listed = listing(repo.root);
    const dry = await unlink('auth', 'src/auth/login.ts');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('-        link ../../../../src/auth/login.ts');
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
    expect(listing(repo.root)).toEqual(listed);
  });

  it('an element without a body: the link goes, the file still parses', async () => {
    await link('other', 'src/auth/login.ts', '--yes');
    expect((await unlink('other', 'src/auth/login.ts', '--yes')).code).toBe(0);
    expect(links('app.api.other')).toEqual([]);
  });

  it('a titled link is found without its title; other links stay in order; targets by fqn, name and uid', async () => {
    await link('auth', 'src/auth/login.ts', '--title', 'x', '--yes');
    await link('auth', 'src/auth/other.ts', '--yes');
    expect((await unlink('app.api.auth', 'src/auth/login.ts', '--yes')).code).toBe(0);
    expect(links('app.api.auth')).toEqual(['src/auth/other.ts']);
    expect(text()).not.toContain("'x'");
    expect((await unlink(UID_AUTH, 'src/auth/other.ts', '--yes')).code).toBe(0);
    expect(links('app.api.auth')).toEqual([]);
    await link('auth', 'src/auth/login.ts', '--yes');
    expect((await unlink('Auth', 'src/auth/login.ts', '--yes')).code).toBe(0);
    expect(text()).toBe(BASE);
  });

  it('the findings gate refuses a removal that leaves code unowned', async () => {
    const r = await unlink('page', 'src/auth/', '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/new critical unplanned-code src\/auth\//);
    expect(text()).toBe(BASE);
  });

  it('--json prints one object', async () => {
    await link('auth', 'src/auth/login.ts', '--yes');
    const r = await unlink('auth', 'src/auth/login.ts', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, command: 'unlink', dryRun: true, written: false, target: { fqn: 'app.api.auth' } });
  });

  describe('refusals: code 1, stdout empty, file unchanged', () => {
    const dup = PLAN.replace("        plan_fn =", '        link ../../../../src/auth/login.ts\n        link ../../../../src/auth/login.ts\n        plan_fn =');
    it.each([
      ['no links', PLAN, ['auth', 'src/auth/login.ts'], /has no link 'src\/auth\/login\.ts' \(it has no links\); to delete the whole element use c4mp plan remove app\.api\.auth/],
      ['other links', PLAN.replace('        plan_fn =', '        link ../../../../src/auth/other.ts\n        plan_fn ='), ['auth', 'src/auth/login.ts'], /\(links: src\/auth\/other\.ts\).*plan remove/],
      ['unknown target', PLAN, ['nope', 'src/auth/login.ts'], /no element matches 'nope'/],
      ['absolute path', PLAN, ['auth', '/etc/x'], /repo-relative/],
      ['subregion', PLAN, ['app.api.ui', 'src/auth/login.ts'], /is a subregion/],
      ['duplicates', dup, ['auth', 'src/auth/login.ts'], /has 2 link lines/],
    ])('%s', async (_n, plan, args, re) => {
      fs.writeFileSync(repo.files['a.c4'], plan);
      const r = await unlink(...args, '--yes');
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(re);
      expect(text()).toBe(plan);
    });

    it('no plan', async () => {
      const empty = makeRepo('c4mp-unlink-none-', {});
      const r = await runPlanCli(['plan', 'unlink', 'auth', 'src/x.ts', '--repo', empty.root]);
      fs.rmSync(empty.root, { recursive: true, force: true });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan');
    });
  });
});
