import * as fs from 'fs';
import { runPlanCli, makeRepo, listing, writeSource } from './helpers/planEditHarness';
import { runCheck } from '../src/query/check';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// P18-T15: `c4mp plan link`, in-process on tmp repos with a hand-written plan and small source files.
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
beforeEach(() => {
  repo = makeRepo('c4mp-link-', { 'a.c4': PLAN });
  writeSource(repo.root, repo.planDir, 'src/auth/login.ts', 'export function login(): void {}\n');
  writeSource(repo.root, repo.planDir, 'src/with space/x.ts', 'export function x(): void {}\n');
});
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const link = (...args: string[]) => runPlanCli(['plan', 'link', ...args, '--repo', repo.root]);
const text = () => fs.readFileSync(repo.files['a.c4'], 'utf-8');
const reparse = () => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
const el = (id: string) => reparse().elements.find(e => e.id === id)!;

describe('c4mp plan link', () => {
  it('dry run changes nothing; --yes writes a ../ relative line that resolves; check shows no missing-code path under .c4mp/', async () => {
    const before = fs.readFileSync(repo.files['a.c4']);
    const listed = listing(repo.root);
    const dry = await link('auth', 'src/auth/login.ts');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('+        link ../../../../src/auth/login.ts');
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
    expect(listing(repo.root)).toEqual(listed);

    const yes = await link('auth', 'src/auth/login.ts', '--yes');
    expect(yes.code).toBe(0);
    expect(el('app.api.auth').links.map(l => l.path)).toEqual(['src/auth/login.ts']);
    const findings = runCheck(repo.root, {}, {})!.findings;
    expect(findings.filter(f => f.rule === 'missing-code' || f.message.includes('.c4mp/'))).toEqual([]);
    // only an insertion
    expect(text().replace(/ {8}link \.\.\/[^\n]*\n/, '')).toBe(PLAN);
  });

  it('targets by uid, fqn and name; a folder; a title; a path with a space (quoted); a planned function', async () => {
    expect((await link(UID_AUTH, 'src/auth/', '--yes')).code).toBe(0);
    expect(el('app.api.auth').links[0].path).toBe('src/auth/');
    expect((await link('Other', 'src/auth/login.ts', '--title', "the 'login'", '--yes')).code).toBe(0);
    expect(el('app.api.other').links[0]).toMatchObject({ path: 'src/auth/login.ts', title: "the 'login'" });
    expect((await link('app.api.auth.plan_fn', 'src/with space/x.ts', '--yes')).code).toBe(0);
    expect(el('app.api.auth.plan_fn').links[0].path).toBe('src/with space/x.ts');
  });

  it('refusals: missing file, missing function, absolute path, empty fragment, unknown target; nothing written', async () => {
    const before = fs.readFileSync(repo.files['a.c4']);
    const cases: [string[], RegExp][] = [
      [['auth', 'src/nope.ts'], /link target does not exist: src\/nope\.ts/],
      [['auth', 'src/auth/login.ts#nope'], /function 'nope' not found in src\/auth\/login\.ts/],
      [['auth', '/etc/passwd'], /repo-relative/],
      [['auth', 'src/auth/login.ts#'], /repo-relative/],
      [['auth', '../outside.ts'], /(points outside the repo|does not exist)/],
      [['nope', 'src/auth/login.ts'], /no element matches 'nope'/],
      [['app.api.ui', 'src/auth/login.ts'], /app\.api\.ui is a subregion: a subregion claims nothing; link one of its components/],
    ];
    for (const [args, re] of cases) {
      const r = await link(...args, '--yes');
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
      expect(r.stdout).toBe('');
    }
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
  });

  it('a duplicate is refused: a second identical run adds nothing', async () => {
    await link('auth', 'src/auth/login.ts', '--yes');
    const once = text();
    const again = await link('auth', 'src/auth/login.ts', '--yes');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already links src/auth/login.ts; nothing added');
    expect(text()).toBe(once);
    expect(el('app.api.auth').links).toHaveLength(1);
  });

  it('the first function link switches to claim mode: refused with the reasons while other functions are unassigned', async () => {
    const before = fs.readFileSync(repo.files['a.c4']);
    const r = await link('auth', 'src/auth/login.ts#login', '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('new critical unassigned-code src/with space/x.ts#x');
    expect(r.stderr).toContain('note: this function link switches the whole plan to claim mode');
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
  });

  it('a function link on a component: written; claim-mode switch is noted', async () => {
    fs.rmSync(`${repo.root}/src/with space`, { recursive: true });
    const r = await link('auth', 'src/auth/login.ts#login', '--yes');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('note: this function link switches the whole plan to claim mode');
    expect(el('app.api.auth').links[0]).toMatchObject({ path: 'src/auth/login.ts', name: 'login' });
  });

  it('an old broken link does not block adding a good one', async () => {
    fs.writeFileSync(repo.files['a.c4'], PLAN.replace("      other = component 'Other'", "      other = component 'Other' {\n        link ../../../../src/gone.ts\n      }"));
    const r = await link('other', 'src/auth/login.ts', '--yes');
    expect(r.code).toBe(0);
    expect(el('app.api.other').links.map(l => l.path)).toEqual(['src/gone.ts', 'src/auth/login.ts']);
  });

  it('--json: one object; no plan: hint and exit 1', async () => {
    const out = JSON.parse((await link('auth', 'src/auth/login.ts', '--json')).stdout);
    expect(out).toMatchObject({ ok: true, command: 'link', dryRun: true, written: false, target: { fqn: 'app.api.auth' } });
    const none = makeRepo('c4mp-link-none-', {});
    try {
      const r = await runPlanCli(['plan', 'link', 'auth', 'x.ts', '--repo', none.root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan');
    } finally {
      fs.rmSync(none.root, { recursive: true, force: true });
    }
  });
});
