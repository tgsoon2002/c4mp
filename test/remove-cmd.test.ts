import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { requireProject } from '../src/outputs';
import { runCli as spawnCli } from './helpers/runCli';

// P14-T22b: `c4mp plan remove`. Real CLI on a tmp repo with a hand-written plan that has uids.
const projectRoot = path.resolve(__dirname, '..');
const UID_AUTH = '00000000-0000-4000-8000-000000000003';
const UID_ORDERS = '00000000-0000-4000-8000-000000000004';
const UID_AUTH2 = '00000000-0000-4000-8000-000000000006';

const PLAN = [
  'model {',
  "  app = system 'Claim App' {",
  "    web = container 'Web' {",
  "      auth = component 'Auth' {",
  '        metadata {',
  `          uid '${UID_AUTH}'`,
  '        }',
  '      }',
  "      orders = component 'Orders' {",
  '        metadata {',
  `          uid '${UID_ORDERS}'`,
  '        }',
  '      }',
  '    }',
  "    api = container 'Api' {",
  "      auth2 = component 'Auth' {",
  '        metadata {',
  `          uid '${UID_AUTH2}'`,
  '        }',
  '      }',
  '    }',
  '  }',
  '  app.web.orders -> app.web.auth',
  '}',
  '',
].join('\n');

let tmp: string;
let planFile: string;

function runCli(args: string[]) {
  return spawnCli([...args], { cwd: projectRoot, encoding: 'utf8' });
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-remove-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  const planDir = requireProject(tmp).planDir;
  fs.mkdirSync(planDir, { recursive: true });
  planFile = path.join(planDir, 'a.c4');
  fs.writeFileSync(planFile, PLAN);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('c4mp plan remove', () => {
  it('dry run leaves every file byte-identical and prints a diff; --yes removes exactly the block, check parses; unknown target exits 1', () => {
    const bytes = fs.readFileSync(planFile);
    const dry = runCli(['plan', 'remove', UID_ORDERS, '--repo', tmp]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('-      orders = component');
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(dry.stdout).toContain('kept');
    expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);

    const yes = runCli(['plan', 'remove', UID_ORDERS, '--repo', tmp, '--yes']);
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain('removed app.web.orders');
    const after = fs.readFileSync(planFile, 'utf8');
    expect(after).toBe(PLAN.split('\n').filter((_, i) => i < 8 || i > 12).join('\n'));
    const check = runCli(['check', '--repo', tmp]);
    expect(check.stdout + check.stderr).not.toContain('parse-error');

    const unknown = runCli(['plan', 'remove', 'nothing-like-this', '--repo', tmp]);
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("no plan element matches 'nothing-like-this'");
  });

  it('name matching two elements refuses and lists uids, even when one is an exact id', () => {
    const bytes = fs.readFileSync(planFile);
    const r = runCli(['plan', 'remove', 'Auth', '--repo', tmp, '--yes']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'Auth' matches 2 elements; use a uid:");
    expect(r.stdout).toContain(UID_AUTH);
    expect(r.stdout).toContain(UID_AUTH2);
    expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);
  });

  it('--relations removes the relation line; without it the line stays and is listed', () => {
    const plain = runCli(['plan', 'remove', UID_AUTH, '--repo', tmp, '--yes']);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('app.web.orders -> app.web.auth');
    expect(fs.readFileSync(planFile, 'utf8')).toContain('app.web.orders -> app.web.auth');

    fs.writeFileSync(planFile, PLAN);
    const rel = runCli(['plan', 'remove', UID_AUTH, '--repo', tmp, '--yes', '--relations']);
    expect(rel.status).toBe(0);
    expect(fs.readFileSync(planFile, 'utf8')).not.toContain('app.web.orders -> app.web.auth');
  });

  it('plan folder <repo>/c4 refuses without --force, works with --force', () => {
    fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'c4'));
    const legacy = path.join(tmp, 'c4', 'a.c4');
    fs.writeFileSync(legacy, PLAN);
    const refused = runCli(['plan', 'remove', UID_ORDERS, '--repo', tmp, '--yes']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('refused: c4/a.c4 is outside .c4mp/ (use --force)');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(PLAN);
    const forced = runCli(['plan', 'remove', UID_ORDERS, '--repo', tmp, '--yes', '--force']);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(legacy, 'utf8')).not.toContain('orders = component');
  });
});
