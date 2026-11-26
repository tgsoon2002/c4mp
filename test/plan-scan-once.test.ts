import * as fs from 'fs';
import { runPlanCli, makeRepo, writeSource } from './helpers/planEditHarness';

jest.mock('../src/history/meta', () => {
  const actual = jest.requireActual('../src/history/meta');
  return { ...actual, readMeta: jest.fn(actual.readMeta) };
});

import { readMeta } from '../src/history/meta';

// b320: a plan write command builds at most one scan core (readMeta is called once per core).
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
beforeEach(() => {
  repo = makeRepo('c4pm-scan-once-', { 'a.c4': PLAN });
  writeSource(repo.root, repo.planDir, 'src/auth/login.ts', 'export function login(): void {}\n');
  (readMeta as jest.Mock).mockClear();
});
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const plan = (...args: string[]) => runPlanCli(['plan', ...args, '--repo', repo.root]);

describe('plan write commands share one scan session', () => {
  it('link --yes scans once (was 3 times)', async () => {
    const r = await plan('link', 'auth', 'src/auth/login.ts', '--yes');
    expect(r.code).toBe(0);
    expect(readMeta).toHaveBeenCalledTimes(1);
  });

  it('set --yes scans once', async () => {
    expect((await plan('link', 'auth', 'src/auth/login.ts', '--yes')).code).toBe(0);
    (readMeta as jest.Mock).mockClear();
    const r = await plan('set', 'auth', 'status=in-progress', 'owner=K', '--yes');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readMeta).toHaveBeenCalledTimes(1);
  });

  it('add without a scan reads no meta', async () => {
    const r = await plan('add', 'component', 'Billing', '--parent', 'api', '--yes');
    expect(r.code).toBe(0);
    expect(readMeta).toHaveBeenCalledTimes(0);
  });

  it('a refused link to a missing file scans once', async () => {
    const r = await plan('link', 'auth', 'src/missing.ts');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('link target does not exist: src/missing.ts');
    expect(readMeta).toHaveBeenCalledTimes(1);
  });
});
