import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli, SPAWN_TIMEOUT_MS } from './helpers/runCli';
import { isoDateOpt, wholeNumberOpt } from '../src/cliHelp';
import { toId } from '../src/names';
import { INTERNAL_DIR } from '../src/paths';

// CLI contract run 2026-11-13 (Document/Test Runs/2026-11-13-CLI-Contract/REPORT.md): one describe per bug, each through
// the built CLI with stdout and stderr on pipes (spawnSync), as a script or CI job reads them.

const created: string[] = [];
afterAll(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A repo (with .git) whose files are `files` (repo-relative path -> content). */
function makeRepo(prefix: string, files: Record<string, string>): string {
  const repo = tempDir(prefix);
  fs.mkdirSync(path.join(repo, '.git'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  return repo;
}

/** A plan of `n` done components that each link a missing file: `n` critical missing-code findings. */
function missingCodePlan(n: number): Record<string, string> {
  const comps = Array.from({ length: n }, (_, i) =>
    `    gone${i} = component 'Gone ${i}' {\n      link ./missing-${i}.ts\n      metadata {\n        status 'done'\n      }\n    }\n`,
  ).join('');
  return {
    'src/index.ts': 'export const x = 1;\n',
    'src/architecture.c4':
      `specification {\n  element system\n  element container\n  element component\n}\n\n` +
      `model {\n  app = system 'App' {\n    api = container 'API' {\n${comps}    }\n  }\n}\n`,
  };
}

describe('b706: check and diff print all of a large output through a pipe', () => {
  it('check --format json: the whole findings array, more than 64 KB', () => {
    const repo = makeRepo('c4mp-b706-check-', missingCodePlan(400));
    const r = runCli(['check', '--repo', repo, '--format', 'json', '--fail-on', 'critical'], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.stdout.length).toBeGreaterThan(64 * 1024);
    const findings = JSON.parse(r.stdout) as { rule: string }[];
    expect(findings.filter(f => f.rule === 'missing-code')).toHaveLength(400);
    expect(r.status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('diff --format json: the whole diff, more than 64 KB', () => {
    const before = makeRepo('c4mp-b706-a-', { 'src/a.ts': 'export const a = 1;\n' });
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`src/m${i}/f${i}.ts`] = `export function f${i}(): number {\n  return ${i};\n}\n`;
    const after = makeRepo('c4mp-b706-b-', files);
    const out = tempDir('c4mp-b706-out-');
    for (const [repo, dir] of [[before, 'a'], [after, 'b']]) {
      expect(runCli(['snapshot', '--repo', repo, '--out', path.join(out, dir)]).status).toBe(0);
    }
    const r = runCli(
      ['diff', '--a', path.join(out, 'a', 'snapshot.json'), '--b', path.join(out, 'b', 'snapshot.json'), '--format', 'json'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    expect(r.stdout.length).toBeGreaterThan(64 * 1024);
    const diff = JSON.parse(r.stdout) as { changes: unknown[] };
    expect(diff.changes.length).toBeGreaterThan(600);
    expect(r.status).toBe(0);
  }, SPAWN_TIMEOUT_MS);
});

describe('b707: an unknown --format, --min-severity or --fail-on is refused', () => {
  let repo = '';
  beforeAll(() => {
    repo = makeRepo('c4mp-b707-', missingCodePlan(1));
  });

  it('a known --min-severity with --fail-on critical still fails on the critical finding', () => {
    const r = runCli(['check', '--repo', repo, '--min-severity', 'critical', '--fail-on', 'critical']);
    expect(r.stdout).toContain('missing-code');
    expect(r.status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ['check --min-severity critcal', ['check', '--min-severity', 'critcal', '--fail-on', 'critical'], '--min-severity'],
    ['check --format jsn', ['check', '--format', 'jsn'], '--format'],
    ['check --fail-on critcal', ['check', '--fail-on', 'critcal'], '--fail-on'],
    ['diff --format xml', ['diff', '--format', 'xml'], '--format'],
    ['diff --min-severity high', ['diff', '--min-severity', 'high'], '--min-severity'],
  ])('%s: exit 1, the allowed values named, nothing on stdout', (_name, args, flag) => {
    const r = runCli([...args, '--repo', repo]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`error: option '${flag}`);
    expect(r.stderr).toContain('Allowed choices are');
  }, SPAWN_TIMEOUT_MS);
});

describe('b708: a bad number or date option is refused', () => {
  let repo = '';
  beforeAll(() => {
    repo = makeRepo('c4mp-b708-', { 'src/a.ts': 'export const a = 1;\n' });
  });

  it.each([
    ['history --max abc', ['history', '--max', 'abc'], "--max must be a whole number of 1 or more, got 'abc'"],
    ['history --max -1', ['history', '--max', '-1'], "--max must be a whole number of 1 or more, got '-1'"],
    ['history --max 2.5', ['history', '--max', '2.5'], "--max must be a whole number of 1 or more, got '2.5'"],
    ['history --since not-a-date', ['history', '--since', 'not-a-date'], "--since must be an ISO 8601 date (YYYY-MM-DD), got 'not-a-date'"],
    ['history --since 2026-13-45', ['history', '--since', '2026-13-45'], "--since must be an ISO 8601 date (YYYY-MM-DD), got '2026-13-45'"],
    ['watch --debounce soon', ['watch', '--debounce', 'soon'], "--debounce must be a whole number of 0 or more, got 'soon'"],
    ['serve --port abc', ['serve', '--port', 'abc'], "--port must be a whole number of 0 or more, got 'abc'"],
    ['serve --port 70000', ['serve', '--port', '70000'], "--port must be 65535 or less, got '70000'"],
    ['serve --debounce soon', ['serve', '--debounce', 'soon'], "--debounce must be a whole number of 0 or more, got 'soon'"],
  ])('%s: exit 1 with the reason, nothing written', (_name, args, message) => {
    const r = runCli([...args, '--repo', repo]);
    expect(r.stderr).toContain(message);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(repo, '.c4mp'))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it('the shared parsers take what the help promises', () => {
    expect(wholeNumberOpt('--max', '20', 1)).toBe(20);
    expect(wholeNumberOpt('--max', undefined, 1)).toBeUndefined();
    expect(wholeNumberOpt('--debounce', '0', 0)).toBe(0);
    expect(() => wholeNumberOpt('--debounce', '-5', 0)).toThrow("--debounce must be a whole number of 0 or more, got '-5'");
    for (const ok of ['2026-01-01', '2026-02-28T10:30', '2026-02-28T10:30:00Z', '2026-02-28T10:30:00.5+02:00']) {
      expect(isoDateOpt('--since', ok)).toBe(ok);
    }
    for (const bad of ['2026-02-30', '2026-1-1', 'yesterday', '']) expect(() => isoDateOpt('--since', bad)).toThrow('--since must be an ISO 8601 date');
  });
});

describe('b710: diff --a/--b with a file that is not a snapshot says so', () => {
  let dir = '';
  let good = '';
  beforeAll(() => {
    dir = tempDir('c4mp-b710-');
    const repo = makeRepo('c4mp-b710-repo-', { 'src/a.ts': 'export const a = 1;\n' });
    expect(runCli(['snapshot', '--repo', repo, '--out', path.join(dir, 'good')]).status).toBe(0);
    good = path.join(dir, 'good', 'snapshot.json');
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ['a JSON object of another kind', '{"boards": []}', 'missing or wrong: schemaVersion, meta, stats, containers, components, files, componentEdges, externals'],
    ['a JSON array', '[1, 2]', 'not a JSON object'],
    ['not JSON', 'hello', 'not JSON: '],
  ])('%s: exit 1, one line naming the file, no TypeError', (_name, text, why) => {
    const bad = path.join(dir, `bad-${why.length}.json`);
    fs.writeFileSync(bad, text);
    const r = runCli(['diff', '--a', good, '--b', bad]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`invalid: ${bad} is not a c4mp snapshot.json (${why}`);
    expect(r.stderr).not.toContain('TypeError');
    expect(r.stderr).not.toContain('Cannot read properties');
  }, SPAWN_TIMEOUT_MS);

  it('two real snapshots still compare', () => {
    const r = runCli(['diff', '--a', good, '--b', good, '--format', 'json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).changes).toEqual([]);
  }, SPAWN_TIMEOUT_MS);
});

describe('b564: --repo must be a folder; a new project next to others gets a note', () => {
  let repo = '';
  beforeAll(() => {
    repo = makeRepo('c4mp-b564-', { 'src/a.ts': 'export const a = 1;\n', 'notes.txt': 'not a folder\n' });
  });
  const refusal = (p: string) => `error: invalid: --repo is not a directory: ${p}\n`;

  it.each([
    ['status', ['status']],
    ['config show', ['config', 'show']],
    ['board list', ['board', 'list']],
    ['board show', ['board', 'show', 'b1']],
    ['board tree', ['board', 'tree']],
    ['init', ['init']],
    ['check', ['check']],
    ['serve', ['serve']],
  ])('%s --repo <missing>: exit 1, the refusal on stderr, the folder not created', (_name, args) => {
    const missing = path.join(repo, 'no-such-folder');
    const r = runCli([...args, '--repo', missing]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(refusal(missing));
    expect(fs.existsSync(missing)).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ['board list --json', ['board', 'list', '--json'], 'board list'],
    ['check --format json', ['check', '--format', 'json'], 'check'],
  ])('%s --repo <missing>: one JSON error object on stdout', (_name, args, command) => {
    const missing = path.join(repo, 'gone');
    const r = runCli([...args, '--repo', missing]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, command, error: { code: 'invalid', message: `--repo is not a directory: ${missing}` } });
  }, SPAWN_TIMEOUT_MS);

  it('a file as --repo is refused and left unchanged', () => {
    const file = path.join(repo, 'notes.txt');
    const r = runCli(['status', '--repo', file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(refusal(file));
    expect(fs.readFileSync(file, 'utf8')).toBe('not a folder\n');
  }, SPAWN_TIMEOUT_MS);

  it('a typo inside the repo (srcc) writes no phantom project; a real sub-folder still works', () => {
    const typo = path.join(repo, 'srcc');
    const add = runCli(['board', 'add', '--repo', typo, '--title', 'T', '--kind', 'task', '--yes']);
    expect(add.status).toBe(1);
    expect(add.stderr).toBe(refusal(typo));
    expect(fs.existsSync(typo)).toBe(false);
    expect(fs.existsSync(path.join(repo, INTERNAL_DIR, 'projects', 'srcc'))).toBe(false);
    const sub = runCli(['status', '--repo', path.join(repo, 'src')]);
    expect(sub.status).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('a --repo that would start a new project beside an existing one prints a note on stderr (not for init)', () => {
    const root = makeRepo('c4mp-b564-sib-', {
      'Project/package.json': '{"name": "myproj"}\n',
      'Project/src/a.ts': 'export const a = 1;\n',
    });
    // the triage repro: one item written with --repo Project makes the project myproj (its package.json name)
    expect(runCli(['board', 'add', '--repo', path.join(root, 'Project'), '--title', 'T', '--kind', 'task', '--yes']).status).toBe(0);
    expect(fs.readdirSync(path.join(root, INTERNAL_DIR, 'projects'))).toEqual(['myproj']);

    const own = runCli(['board', 'list', '--repo', path.join(root, 'Project')]);
    expect(own.stderr).toBe('');
    // Phase 34: the root names the one project folder itself, so the note needs a second project folder
    fs.mkdirSync(path.join(root, INTERNAL_DIR, 'projects', 'other'));
    const wrong = runCli(['board', 'list', '--repo', root]);
    expect(wrong.status).toBe(0);
    const id = toId(path.basename(root));
    expect(wrong.stderr).toBe(
      `note: no c4mp project '${id}' at ${root} yet; it holds: myproj, other. Check --repo (the folder that holds that project's package.json or code).\n`,
    );
    const init = runCli(['init', '--repo', root]);
    expect(init.status).toBe(0);
    expect(init.stderr).toBe('');
  }, SPAWN_TIMEOUT_MS);
});

// Root can write a read-only folder, so the refusal cannot be seen there.
const describeNotRoot = process.getuid?.() === 0 ? describe.skip : describe;

describeNotRoot('b723: a write into a read-only .c4mp names the file, through the one failure printer', () => {
  let repo = '';
  let c4mp = '';
  beforeAll(() => {
    const plan =
      `specification {\n  element system\n  element container\n  element component\n}\n\n` +
      `model {\n  app = system 'App' {\n    api = container 'API' {\n      orders = component 'Orders' {\n        link ../../../../src/\n      }\n    }\n  }\n}\n`;
    repo = makeRepo('c4mp-b723-', {
      'package.json': '{"name": "rofix"}\n',
      'src/a.ts': 'export const a = 1;\n',
      '.c4mp/projects/rofix/plan/architecture.c4': plan,
      'layout.json': JSON.stringify({ version: 2, nodes: { 'app.api.orders': { rx: 1, ry: 2, rw: 3, rh: 4 } } }),
    });
    c4mp = path.join(repo, '.c4mp');
    expect(runCli(['board', 'add', '--repo', repo, '--title', 'T', '--kind', 'task', '--yes']).status).toBe(0);
    expect(runCli(['board', 'add', '--repo', repo, '--title', 'T2', '--kind', 'task', '--board', 'other', '--yes']).status).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  /** chmod -R a-w (or back to writable) of a folder. */
  const setWritable = (dir: string, writable: boolean): void => {
    if (writable) fs.chmodSync(dir, 0o755);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) setWritable(path.join(dir, e.name), writable);
      else fs.chmodSync(path.join(dir, e.name), writable ? 0o644 : 0o444);
    }
    if (!writable) fs.chmodSync(dir, 0o555);
  };
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it.each([
    ['plan remove', ['plan', 'remove', 'app.api.orders', '--yes']],
    ['plan ids', ['plan', 'ids', '--yes']],
    ['plan generate', ['plan', 'generate']],
    ['snapshot', ['snapshot']],
    ['board move', ['board', 'move', 'b1', '--board', 'other', '--yes']],
  ])('%s: exit 1, `error: invalid: cannot write <file>: permission denied` on stderr, no temp file named', (_name, args) => {
    const argv = args.map((a) => (a === 'LAYOUT' ? path.join(repo, 'layout.json') : a));
    setWritable(c4mp, false);
    try {
      const r = runCli([...argv, '--repo', repo]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`^error: invalid: cannot write ${escape(c4mp)}/\\S+: permission denied\\n$`));
      expect(r.stderr).not.toContain('.tmp');
    } finally {
      setWritable(c4mp, true);
    }
  }, SPAWN_TIMEOUT_MS);

  // SV2 (b678): apply-layout goes through the plan write gate, so its read-only text is the gate's (like `plan set`).
  it('plan apply-layout: exit 1, `error: rolled-back: ` with permission denied, no temp file named, plan unchanged', () => {
    const planFile = path.join(c4mp, 'projects', 'rofix', 'plan', 'architecture.c4');
    const before = fs.readFileSync(planFile, 'utf8');
    setWritable(c4mp, false);
    try {
      const r = runCli(['plan', 'apply-layout', '--file', path.join(repo, 'layout.json'), '--repo', repo]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^error: rolled-back: /);
      expect(r.stderr).toContain('permission denied');
      expect(r.stderr).not.toContain('.tmp');
      expect(fs.readFileSync(planFile, 'utf8')).toBe(before);
    } finally {
      setWritable(c4mp, true);
    }
  }, SPAWN_TIMEOUT_MS);
});
