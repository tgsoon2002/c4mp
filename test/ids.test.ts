import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { backfillUids } from '../src/c4/ids';
import { UID_RE } from '../src/util/uid';
import { isAutoWritable } from '../src/c4/writeGuard';
import { parsePlan } from '../src/plan/parser';
import { resolvePaths } from '../src/paths';
import { requireProject } from '../src/outputs';
import { runCli as spawnCli } from './helpers/runCli';

// P14-T20: backfillUids (pure), isAutoWritable, and the `c4mp plan ids` command.

const counter = () => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); };

const projectRoot = path.resolve(__dirname, '..');
let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-ids-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const PLAN = `model {
  shop = system 'Shop' {
    api = container 'Api' {
      metadata {
        status 'planned'
      }
      auth = component 'Auth'
      pay = component 'Pay'
    }
  }
}
`;

function parse(text: string, name = 'a.c4') {
  fs.writeFileSync(path.join(tmp, name), text);
  return parsePlan(tmp, [name]);
}

describe('backfillUids', () => {
  it('adds one uid per element without one', () => {
    const plan = parse(PLAN);
    const { files, skipped } = backfillUids(new Map([['a.c4', PLAN]]), plan, counter());
    expect(skipped).toEqual([]);
    expect(files.get('a.c4')!.added).toEqual(['shop', 'shop.api', 'shop.api.auth', 'shop.api.pay']);
    const after = parse(files.get('a.c4')!.text, 'b.c4');
    expect(after.issues).toEqual([]);
    const uids = after.elements.map(e => e.metadata.uid);
    expect(uids).toEqual([1, 2, 3, 4].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')));
    expect(after.elements.find(e => e.id === 'shop.api')!.metadata.status).toBe('planned');
    expect(UID_RE.test(uids[0])).toBe(true);
  });

  it('existing uid is not replaced', () => {
    const text = PLAN.replace("status 'planned'", "uid '11111111-1111-4111-8111-111111111111'");
    const plan = parse(text);
    const { files } = backfillUids(new Map([['a.c4', text]]), plan, counter());
    const out = files.get('a.c4')!;
    expect(out.added).not.toContain('shop.api');
    expect(out.text).toContain("uid '11111111-1111-4111-8111-111111111111'");
    expect(out.text.match(/uid '/g)!.length).toBe(4);
  });

  it('unterminated string file is skipped with a reason', () => {
    const text = PLAN + "x = system 'broken\n";
    const plan = parse(text);
    const { files, skipped } = backfillUids(new Map([['a.c4', text]]), plan, counter());
    expect(files.size).toBe(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].reason).toBe('element not found or file has an unterminated string');
  });

  it('duplicate fqn is skipped', () => {
    const text = PLAN + "model {\n  shop = system 'Shop again'\n}\n";
    const plan = parse(text);
    const { files, skipped } = backfillUids(new Map([['a.c4', text]]), plan, counter());
    expect(skipped.filter(s => s.reason === 'duplicate fqn').map(s => s.fqn)).toEqual(['shop']);
    expect(files.get('a.c4')!.added.filter(f => f === 'shop')).toHaveLength(1);
  });
});

describe('isAutoWritable', () => {
  it('inside .c4mp true, inside C4PM true, <repo>/c4 false, null project false', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    const project = resolvePaths(tmp, { repoId: 'demo' });
    expect(isAutoWritable(project, path.join(project.planDir, 'x.c4'))).toBe(true);
    expect(isAutoWritable(project, path.join(tmp, 'C4PM', 'demo', 'x.c4'))).toBe(true);
    expect(isAutoWritable(project, path.join(tmp, 'c4', 'x.c4'))).toBe(false);
    expect(isAutoWritable(null, path.join(tmp, '.c4mp', 'x.c4'))).toBe(false);
  });
});

function runCli(args: string[]) {
  return spawnCli([...args], { cwd: projectRoot, encoding: 'utf8' });
}

describe('c4mp plan ids', () => {
  it('dry run changes nothing; --yes adds; second --yes adds 0; outside .c4mp needs --force', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    const planDir = requireProject(tmp).planDir;
    fs.mkdirSync(planDir, { recursive: true });
    const file = path.join(planDir, 'a.c4');
    fs.writeFileSync(file, PLAN);
    const bytes = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;

    const dry = runCli(['plan', 'ids', '--repo', tmp]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('4 would be added; run again with --yes');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);

    const yes = runCli(['plan', 'ids', '--repo', tmp, '--yes']);
    expect(yes.status).toBe(0);
    expect(yes.stdout.trim().split('\n').pop()).toBe('4 added');
    expect(fs.readFileSync(file, 'utf8').match(/uid '/g)).toHaveLength(4);

    const again = runCli(['plan', 'ids', '--repo', tmp, '--yes']);
    expect(again.status).toBe(0);
    expect(again.stdout.trim().split('\n').pop()).toBe('0 added');

    // legacy <repo>/c4 plan, no .c4mp plan: not auto-writable
    fs.rmSync(planDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'c4'));
    fs.writeFileSync(path.join(tmp, 'c4', 'a.c4'), PLAN);
    const blocked = runCli(['plan', 'ids', '--repo', tmp, '--yes']);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('skipped c4/a.c4: outside .c4mp/ (use --force)');
    expect(fs.readFileSync(path.join(tmp, 'c4', 'a.c4'), 'utf8')).toBe(PLAN);
    const forced = runCli(['plan', 'ids', '--repo', tmp, '--yes', '--force']);
    expect(forced.status).toBe(0);
    expect(forced.stdout.trim().split('\n').pop()).toBe('4 added');
  });
});
