import * as fs from 'fs';
import { runPlanCli, makeRepo, listing, writeSource } from './helpers/planEditHarness';
import { runCheck } from '../src/query/check';
import { UNPLANNED_RULES } from '../src/query/unplanned';

// P18-T12: `c4mp plan unplanned`, in-process on tmp repos with a hand-written plan and tiny source files.
const planWith = (links: string[]) => [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  ...links.map(l => `        link ${l}`),
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const FN_A = 'export function fnA(): number { return 1; }\n';
const FN_B = 'export function fnB(): number { return 2; }\n';

function repoWith(links: (l: Record<string, string>) => string[]) {
  const repo = makeRepo('c4mp-unplanned-', { 'a.c4': '' });
  const l = {
    a: writeSource(repo.root, repo.planDir, 'src/a.ts', FN_A),
    b: writeSource(repo.root, repo.planDir, 'src/b.ts', FN_B),
  };
  fs.writeFileSync(repo.files['a.c4'], planWith(links(l)));
  return repo;
}

const repos: string[] = [];
afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });
const mk = (links: (l: Record<string, string>) => string[]) => { const r = repoWith(links); repos.push(r.root); return r; };

describe('c4mp plan unplanned', () => {
  it('folder mode: the unclaimed file is listed under unplanned-code; nothing is written', async () => {
    const repo = mk(l => [l.a]);
    const before = listing(repo.root);
    const r = await runPlanCli(['plan', 'unplanned', '--repo', repo.root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('unplanned-code (1): ');
    expect(r.stdout).toContain('src/b.ts');
    expect(r.stdout).not.toContain('src/a.ts');
    expect(listing(repo.root)).toEqual(before);
  });

  it('claim mode: the unclaimed function is listed under unassigned-code', async () => {
    const repo = mk(l => [`${l.a}#fnA`]);
    const r = await runPlanCli(['plan', 'unplanned', '--repo', repo.root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('unassigned-code');
    expect(r.stdout).toContain('src/b.ts#fnB');
  });

  it('clean repo: "nothing unplanned", exit 0', async () => {
    const repo = mk(l => [l.a, l.b]);
    const r = await runPlanCli(['plan', 'unplanned', '--repo', repo.root]);
    expect(r).toMatchObject({ stdout: 'nothing unplanned', code: 0 });
  });

  it('--json is one object equal to the matching rules of check (parity)', async () => {
    const repo = mk(l => [`${l.a}#fnA`]);
    const r = await runPlanCli(['plan', 'unplanned', '--repo', repo.root, '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { groups: { rule: string; items: { id: string; message: string }[] }[] };
    expect(Object.keys(out)).toEqual(['groups']);
    const check = runCheck(repo.root, {}, {})!;
    const wanted = UNPLANNED_RULES.map(x => x.rule);
    const fromCheck = check.findings.filter(f => wanted.includes(f.rule)).map(f => `${f.rule}|${f.id}|${f.message}`).sort();
    const fromCmd = out.groups.flatMap(g => g.items.map(i => `${g.rule}|${i.id}|${i.message}`)).sort();
    expect(fromCmd.length).toBeGreaterThan(0);
    expect(fromCmd).toEqual(fromCheck);
  });

  it('no plan: hint on stdout, exit 0 (as check)', async () => {
    const repo = makeRepo('c4mp-unplanned-none-', {});
    repos.push(repo.root);
    const r = await runPlanCli(['plan', 'unplanned', '--repo', repo.root]);
    expect(r).toMatchObject({ stdout: 'no .c4 files found; run c4mp plan generate to start a plan', code: 0 });
  });
});
