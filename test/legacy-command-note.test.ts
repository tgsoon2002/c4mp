import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CLI_JS, SPAWN_TIMEOUT_MS } from './helpers/runCli';

// Phase 35 B: started as `c4pm` (a link or copy of the program), one note goes to stderr; as `c4mp`, none; never with --json.

const NOTE = 'c4pm is now c4mp; the c4pm command keeps working for now (it goes away in a later version)';

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-alias-')));
  fs.symlinkSync(CLI_JS, path.join(tmp, 'c4pm'));
  fs.symlinkSync(CLI_JS, path.join(tmp, 'c4mp'));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// the suite sets C4MP_NO_NOTES=1; these runs turn the notes back on (an empty value is not '1')
const run = (name: string, args: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync(process.execPath, [path.join(tmp, name), ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, C4MP_NO_NOTES: '', C4MP_USER_DIR: 'off', C4PM_USER_DIR: 'off', ...extraEnv },
  });

describe('the c4pm alias note', () => {
  it('started as c4pm: the note once on stderr, nothing extra on stdout', () => {
    const r = run('c4pm', ['--version']);
    expect(r.status).toBe(0);
    expect(r.stderr.split('\n').filter(l => l === NOTE)).toHaveLength(1);
    expect(r.stdout).not.toContain('is now');
  }, SPAWN_TIMEOUT_MS);

  it('started as c4mp: no note; the program name in usage is c4mp under either name', () => {
    const r = run('c4mp', ['--version']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('is now c4mp');
    expect(run('c4pm', ['--help']).stdout).toContain('Usage: c4mp');
  }, SPAWN_TIMEOUT_MS);

  it('--json keeps both streams clean; C4MP_NO_NOTES=1 turns the note off', () => {
    const json = run('c4pm', ['languages', '--json']);
    expect(json.stderr).not.toContain('is now c4mp');
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(run('c4pm', ['--version'], { C4MP_NO_NOTES: '1' }).stderr).not.toContain('is now c4mp');
  }, SPAWN_TIMEOUT_MS);
});
