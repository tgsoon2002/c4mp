import * as fs from 'fs';
import { runPlanCli, makeRepo, writeSource } from './helpers/planEditHarness';
import { formatErrorText } from '../src/cli/common';

// P18-T10c: refusal output of the plan-editing commands: next step after the folder->claim switch, no doubled
// prefix, capped reason list.
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const setup = (extraFiles: number) => {
  repo = makeRepo('c4pm-hints-', { 'a.c4': PLAN });
  writeSource(repo.root, repo.planDir, 'src/auth/login.ts', 'export function login(): void {}\n');
  for (let i = 0; i < extraFiles; i++) writeSource(repo.root, repo.planDir, `src/other/f${i}.ts`, `export function f${i}(): void {}\n`);
};

const NEXT = 'NEXT STEP: link the file or folder without #name to stay in folder mode, or claim every function of it (see: c4mp plan unplanned)';

describe('T10c refusal hints', () => {
  it('link refused after the folder->claim switch: prints the NEXT STEP; --json carries it as hint', async () => {
    setup(2);
    const r = await runPlanCli(['plan', 'link', 'auth', 'src/auth/login.ts#login', '--yes', '--repo', repo.root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(NEXT);
    const j = JSON.parse((await runPlanCli(['plan', 'link', 'auth', 'src/auth/login.ts#login', '--json', '--repo', repo.root])).stdout);
    expect(j.error).toMatchObject({ code: 'new-findings', hint: NEXT });
  });

  it('a refusal without the switch note has no NEXT STEP', async () => {
    setup(0);
    const r = await runPlanCli(['plan', 'link', 'auth', 'src/gone.ts', '--repo', repo.root]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('NEXT STEP');
  });

  it('long reason list: 10 lines then "... N more", full list in --json', async () => {
    setup(14);
    const r = await runPlanCli(['plan', 'link', 'auth', 'src/auth/login.ts#login', '--repo', repo.root]);
    const lines = r.stderr.split('\n');
    expect(lines.filter(l => l.startsWith('  - '))).toHaveLength(10);
    expect(r.stderr).toMatch(/\n {2}\.\.\. \d+ more \(use --json for all\)\n/);
    const j = JSON.parse((await runPlanCli(['plan', 'link', 'auth', 'src/auth/login.ts#login', '--json', '--repo', repo.root])).stdout);
    expect(j.error.message.split('\n').filter((l: string) => l.startsWith('  - ')).length).toBeGreaterThan(10);
  });

  it('rolled-back message has no second "rolled back:" prefix', () => {
    expect(formatErrorText({ code: 'rolled-back', message: 'disk differs' })).toBe('error: rolled-back: disk differs');
  });
});
