import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from './helpers/runCli';

// P14-T21: `c4mp plan show`. Real CLI on a tmp repo with a hand-written claim-mode plan that has uids.
const projectRoot = path.resolve(__dirname, '..');
const UID_AUTH = '00000000-0000-4000-8000-000000000003';
const UID_ORDERS = '00000000-0000-4000-8000-000000000004';
const UID_AUTH2 = '00000000-0000-4000-8000-000000000006';

const PLAN = [
  'model {',
  "  app = system 'Claim App' {",
  "    web = container 'Web' {",
  "      auth = component 'Auth' {",
  '        link ../src/util.ts#formatDate',
  '        metadata {',
  `          uid '${UID_AUTH}'`,
  '        }',
  '      }',
  "      orders = component 'Orders' {",
  '        link ../src/order.ts#createOrder',
  '        metadata {',
  `          uid '${UID_ORDERS}'`,
  '        }',
  '      }',
  '    }',
  "    api = container 'Api' {",
  "      auth2 = component 'Auth' {",
  '        link ../src/other.ts#other',
  '        metadata {',
  `          uid '${UID_AUTH2}'`,
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let tmp: string;
let repo: string;

function write(rel: string, text: string): void {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-element-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  write('package.json', JSON.stringify({ name: 'claim-app' }));
  write('src/util.ts', 'export function formatDate() {\n  return 1;\n}\n');
  write('src/order.ts', 'export function createOrder() {\n  return 2;\n}\n');
  write('src/other.ts', 'export function other() {\n  return 3;\n}\n');
  write('c4/arch.c4', PLAN);
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function element(...args: string[]) {
  return runCli(['plan', 'show', ...args, '--repo', repo], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('c4mp plan show (P14-T21)', () => {
  it('by uid prints the element', () => {
    const r = element(UID_ORDERS);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('component  Orders');
    expect(r.stdout).toContain(`uid:       ${UID_ORDERS}`);
    expect(r.stdout).toContain('claims:    function src/order.ts#createOrder');
  });

  it('by id prints the same element', () => {
    const byUid = element(UID_ORDERS);
    const r = element('app.web.orders');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(byUid.stdout);
    // P14-T21b: the plan lookup prints `fqn:` (the T21 `id:` line was the view node id).
    expect(r.stdout).toContain('fqn:       app.web.orders');
  });

  it('by name that matches two exits 1 and lists both uids', () => {
    const r = element('Auth');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'Auth' matches 2 elements, use a uid:");
    expect(r.stdout).toContain(UID_AUTH);
    expect(r.stdout).toContain(UID_AUTH2);
  });

  it('unknown name exits 1 and prints closest ids', () => {
    const r = element('nope');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("no element matches 'nope'");
    const suggestions = r.stdout.split('\n').filter((l) => l.startsWith('  '));
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    // P14-T21b: suggestion lines are `  <uid>  <fqn>  <title>`.
    expect(suggestions.some((l) => l === `  ${UID_AUTH}  app.web.auth  Auth`)).toBe(true);
  });

  it('--json parses and has uid', () => {
    const r = element(UID_AUTH, '--json');
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.uid).toBe(UID_AUTH);
    expect(j.id).toBe('app.web.auth');
    expect(j.plan.file).toContain('arch.c4');
    expect(j.fqn).toBe('app.web.auth');
    expect(j.source.file).toContain('arch.c4');
    expect(j.links).toEqual(['../src/util.ts#formatDate']);
    expect(j.meta.uid).toBe(UID_AUTH);
  });

  it('claim mode prints origin and claims', () => {
    const r = element(UID_AUTH);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('origin:');
    expect(r.stdout).toContain('claims:');
    expect(r.stdout).toContain('parent:    app.web');
    expect(r.stdout).toMatch(/source:\s+c4\/arch\.c4:\d+-\d+/);
  });
});

// P14-T21b: folder-mode plan (made by generate-c4 on the sample fixture) and a plan without uids.
function cli(repoDir: string, ...args: string[]) {
  return runCli([...args, '--repo', repoDir], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('c4mp plan show on a folder-mode plan (P14-T21b)', () => {
  let ftmp: string;
  let frepo: string;
  let libUid: string;

  beforeAll(() => {
    ftmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-element-folder-'));
    frepo = path.join(ftmp, 'repo');
    fs.cpSync(path.join(projectRoot, 'test', 'fixtures', 'sample'), frepo, { recursive: true });
    fs.mkdirSync(path.join(frepo, '.git'), { recursive: true });
    expect(cli(frepo, 'plan', 'generate').status).toBe(0);
    expect(cli(frepo, 'plan', 'ids', '--yes').status).toBe(0);
    const j = JSON.parse(cli(frepo, 'plan', 'show', 'sample_shop.api.lib', '--json').stdout);
    libUid = j.uid;
  });

  afterAll(() => { fs.rmSync(ftmp, { recursive: true, force: true }); });

  it('by component uid and by fqn print the same block', () => {
    expect(libUid).toMatch(/^[0-9a-f-]{36}$/);
    const byUid = cli(frepo, 'plan', 'show', libUid);
    expect(byUid.status).toBe(0);
    const lines = byUid.stdout.split('\n');
    expect(lines[0]).toBe('component  Lib');
    expect(lines[1]).toBe(`uid:       ${libUid}`);
    expect(lines[2]).toBe('fqn:       sample_shop.api.lib');
    expect(lines[3]).toBe('parent:    sample_shop.api');
    expect(byUid.stdout).toMatch(/source:\s+\S*api\.c4:\d+-\d+/);
    expect(byUid.stdout).toContain('origin:    scanned (folder api/src/lib)');   // P16-B17b: the scanned box that stands for the plan component now carries its uid, so element finds it
    expect(byUid.stdout).not.toContain('claims:');
    expect(cli(frepo, 'plan', 'show', 'sample_shop.api.lib').stdout).toBe(byUid.stdout);
  });

  it('by name finds it', () => {
    const r = cli(frepo, 'plan', 'show', 'Lib');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('fqn:       sample_shop.api.lib');
  });

  it('ambiguous name exits 1 and lists candidates with uids', () => {
    const r = cli(frepo, 'plan', 'show', 'Root files');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'Root files' matches 2 elements, use a uid:");
    const rows = r.stdout.split('\n').filter((l) => l.startsWith('  '));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(/^ {2}[0-9a-f-]{36}  \S+  Root files$/);
    expect(r.stdout).not.toContain('(no uid)');
  });

  it('unknown name exits 1 with suggestions that carry uids', () => {
    const r = cli(frepo, 'plan', 'show', 'nope');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("no element matches 'nope'");
    const rows = r.stdout.split('\n').filter((l) => l.startsWith('  '));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) expect(row).toMatch(/^ {2}[0-9a-f-]{36}  /);
  });
});

describe('c4mp plan show on a plan without uids (P14-T21b)', () => {
  let ntmp: string;
  let nrepo: string;

  beforeAll(() => {
    ntmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-element-nouid-'));
    nrepo = path.join(ntmp, 'repo');
    fs.cpSync(path.join(projectRoot, 'test', 'fixtures', 'sample'), nrepo, { recursive: true });
    fs.mkdirSync(path.join(nrepo, '.git'), { recursive: true });
    expect(cli(nrepo, 'plan', 'generate').status).toBe(0);
    // generate-c4 gives new components a uid: strip them so the plan is an "old" plan.
    const planFiles = cli(nrepo, 'plan', 'show').stdout;
    expect(planFiles).toContain('elements');
    const root = path.join(nrepo, '.c4mp');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(root).filter((p) => p.endsWith('.c4'))) {
      const text = fs.readFileSync(f, 'utf8');
      fs.writeFileSync(f, text.replace(/^\s*uid '[^']*'\s*\n/gm, ''));
    }
  });

  afterAll(() => { fs.rmSync(ntmp, { recursive: true, force: true }); });

  it('found by fqn prints the no-uid line', () => {
    const r = cli(nrepo, 'plan', 'show', 'sample_shop.api.lib');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('uid:       (none: run c4mp plan ids)');
  });

  it('ambiguous name prints the run c4mp plan ids line', () => {
    const r = cli(nrepo, 'plan', 'show', 'Root files');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('(no uid)');
    expect(r.stdout).toContain('run c4mp plan ids to give every element a uid');
  });
});

// P14-T44c-a: scanned components of a generate-c4 plan have no plan-only twin, so `element` prints no origin line.
describe('c4mp plan show on a scanned component of a folder-mode plan (P14-T44c-a)', () => {
  let ctmp: string;
  let crepo: string;

  beforeAll(() => {
    ctmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-element-scanned-'));
    crepo = path.join(ctmp, 'repo');
    fs.cpSync(path.join(projectRoot, 'test', 'fixtures', 'sample'), crepo, { recursive: true });
    fs.mkdirSync(path.join(crepo, '.git'), { recursive: true });
    expect(cli(crepo, 'plan', 'generate').status).toBe(0);
  });

  afterAll(() => { fs.rmSync(ctmp, { recursive: true, force: true }); });

  it('by fqn of each scanned component prints a scanned origin line (P16-B17b: the stand-in box carries the uid)', () => {
    for (const fqn of ['sample_shop.api.lib', 'sample_shop.api.root_files', 'sample_shop.web.components']) {
      const r = cli(crepo, 'plan', 'show', fqn);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/origin:\s+scanned \(folder /);
    }
  });
});
