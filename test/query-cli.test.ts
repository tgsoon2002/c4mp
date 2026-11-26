import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli as spawnCli } from './helpers/runCli';

// P15-T5b: the real CLI (ts-node bin/cli.ts) on COPIES of fixtures. Checks stdout, stderr, exit code,
// and that the repo is untouched (read-only, Decision 1).

const projectRoot = path.resolve(__dirname, '..');
const fixtures = path.resolve(__dirname, 'fixtures');

interface Run { status: number | null; stdout: string; stderr: string; }

function runCli(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnCli([...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function copyFixture(name: string, dest: string): string {
  const to = path.join(dest, name);
  fs.cpSync(path.join(fixtures, name), to, { recursive: true });
  return to;
}

/** Every path under root (dirs included) with mtime and size, sorted. */
function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${st.isDirectory() ? 'd' : 'f'}|${st.mtimeMs}|${st.size}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

/** stdout must be exactly one JSON object followed by a newline. */
function parseOneObject(stdout: string): any {
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stdout.trimEnd().split('\n')).toHaveLength(1);
  const v = JSON.parse(stdout);
  expect(typeof v).toBe('object');
  expect(Array.isArray(v)).toBe(false);
  return v;
}

describe('find / show / outline / deps through the real CLI', () => {
  let tmp: string;
  let sample: string;
  let level4: string;
  let withAnchor: string;
  const before: Record<string, string[]> = {};

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t5b-'));
    sample = copyFixture('sample', tmp);
    level4 = copyFixture('level4', tmp);
    // A repo that already has a .c4pm folder: it must come out byte- and mtime-identical.
    withAnchor = copyFixture('sample', path.join(fs.mkdtempSync(path.join(tmp, 'anchor-')), '.'));
    fs.mkdirSync(path.join(withAnchor, '.c4pm'));
    fs.writeFileSync(path.join(withAnchor, '.c4pm', 'note.txt'), 'keep\n');
    // Python property pair: the setter repeats the getter's name, so it is Box.size#2 (b138).
    // Crate.size makes the method name `size` ambiguous for calls.
    fs.writeFileSync(
      path.join(sample, 'worker', 'dup.py'),
      ['class Box:', '    @property', '    def size(self):', '        return 1', '', '    @size.setter', '    def size(self, v):', '        pass', '',
        'class Crate:', '    def size(self):', '        return 2', ''].join('\n'),
    );
    for (const [k, p] of Object.entries({ sample, level4, withAnchor })) before[k] = listing(p);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('find: text, --kind, --limit with truncation hint', () => {
    const r = runCli(['find', 'order', '--repo', sample, '--limit', '3']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^api\/src\/models\/order\.ts:1-3 {2}type {2}Order {2}\[Models\]$/);   // B17: the exact-name type ranks first
    expect(lines[3]).toMatch(/^\.\.\. truncated, showing 3 of \d+;/);

    const files = runCli(['find', 'order', '--repo', sample, '--kind', 'file']);
    expect(files.status).toBe(0);
    expect(files.stdout).toMatch(/orders\.ts {2}file {2}\[Routes\]/);
    expect(files.stdout).not.toMatch(/ function /);

    const none = runCli(['find', 'zzzq', '--repo', sample]);
    expect([none.status, none.stdout, none.stderr]).toEqual([0, 'no results\n', '']);
  }, 120000);

  it('find --json: stdout is exactly one JSON object; invalid limit and kind are errors', () => {
    const r = runCli(['find', 'order', '--repo', sample, '--limit', '2', '--json']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const obj = parseOneObject(r.stdout);
    expect(obj.results).toHaveLength(2);
    expect(obj.truncated).toBe(true);
    expect(obj.total).toBeGreaterThan(2);

    // b681: code types are a kind of their own
    const types = parseOneObject(runCli(['find', 'order', '--repo', sample, '--kind', 'type', '--json']).stdout);
    expect(types.results.map((x: { kind: string; name: string }) => `${x.kind} ${x.name}`)).toEqual(['type Order']);

    for (const bad of [['--limit', '0'], ['--limit', 'abc'], ['--limit', '101'], ['--kind', 'nope']]) {
      const e = runCli(['find', 'order', '--repo', sample, '--json', ...bad]);
      expect(e.status).toBe(1);
      expect(e.stdout).toBe('');
      expect(e.stderr).toMatch(/^error: invalid: /);
    }
  }, 120000);

  it('show: element text with numbered lines, --max-lines, --json', () => {
    const target = 'api/src/services/orderService.ts#OrderService.create';
    const r = runCli(['show', target, '--repo', sample]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('api/src/services/orderService.ts:6-12  method  OrderService.create  [Services]  (folder-mode)');
    expect(lines[1]).toBe('   6    create(input: Partial<Order>): Order {');
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe('tests:     none');   // T26-11: an element's tests follow its code

    const cut = runCli(['show', 'api/src/services/orderService.ts', '--repo', sample, '--max-lines', '3']);
    expect(cut.status).toBe(0);
    expect(cut.stdout.trimEnd().split('\n')).toHaveLength(5); // header + 3 lines + truncation hint
    expect(cut.stdout).toContain('... truncated, 17 lines in total');

    const j = runCli(['show', target, '--repo', sample, '--json']);
    const obj = parseOneObject(j.stdout);
    expect(obj.startLine).toBe(6);
    expect(obj.code).toHaveLength(7);
    expect(obj.truncated).toBe(false);

    const bad = runCli(['show', target, '--repo', sample, '--max-lines', '0']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/^error: invalid: /);
  }, 120000);

  it('errors: out-of-repo, not-found, ambiguous (candidates on stderr, stdout empty); a repeated name is name#2', () => {
    const out = runCli(['show', '../x', '--repo', sample]);
    expect([out.status, out.stdout]).toEqual([1, '']);
    expect(out.stderr).toMatch(/^error: out-of-repo: /);

    const nf = runCli(['show', 'api/src/services/orderService.ts#nope', '--repo', sample, '--json']);
    expect([nf.status, nf.stdout]).toEqual([1, '']);
    expect(nf.stderr).toMatch(/^error: not-found: /);

    const py = ['--repo', sample, '--lang', 'typescript,python', '--json'];
    const setter = runCli(['show', 'worker/dup.py#Box.size#2', ...py]);
    expect(setter.status).toBe(0);
    const { name, startLine, endLine } = parseOneObject(setter.stdout);
    expect([name, startLine, endLine]).toEqual(['Box.size#2', 6, 8]);

    const amb = runCli(['calls', 'size', ...py]);
    expect([amb.status, amb.stdout]).toEqual([1, '']);
    const errLines = amb.stderr.trimEnd().split('\n');
    expect(errLines[0]).toMatch(/^error: ambiguous: /);
    expect(errLines.slice(1).map((l) => l.trim())).toEqual(['worker/dup.py#Box.size', 'worker/dup.py#Crate.size']);
  }, 120000);

  it('outline: text tree and --json; unknown file is not-found', () => {
    const r = runCli(['outline', 'api/src/services/orderService.ts', '--repo', sample]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('api/src/services/orderService.ts  17 lines');
    expect(lines[1]).toMatch(/^ {2}3-\d+ {2}class {2}OrderService {2}\[Services\]$/);
    expect(lines.some((l) => /^ {4}6-12 {2}method {2}OrderService\.create /.test(l))).toBe(true);

    const j = parseOneObject(runCli(['outline', 'api/src/services/orderService.ts', '--repo', sample, '--json']).stdout);
    expect(j.elements[0].name).toBe('OrderService');
    expect(j.elements[0].children.length).toBeGreaterThan(1);

    const nf = runCli(['outline', 'api/src/nothing.ts', '--repo', sample]);
    expect([nf.status, nf.stdout]).toEqual([1, '']);
    expect(nf.stderr).toMatch(/^error: not-found: /);
  }, 120000);

  it('deps: text, --json, not-found lists candidates on stderr', () => {
    const r = runCli(['deps', 'api', '--repo', sample]);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('api  container  Api  (resolved from id)');

    const obj = parseOneObject(runCli(['deps', 'api', '--repo', sample, '--json']).stdout);
    expect(obj).toMatchObject({ id: 'api', level: 'container', resolvedFrom: 'id' });
    expect(Array.isArray(obj.uses)).toBe(true);

    const nf = runCli(['deps', 'nope', '--repo', sample]);
    expect([nf.status, nf.stdout]).toEqual([1, '']);
    const errLines = nf.stderr.trimEnd().split('\n');
    expect(errLines[0]).toMatch(/^error: not-found: /);
    expect(errLines.length).toBeGreaterThan(1);

    const l4 = runCli(['deps', 'billing', '--repo', level4]);
    expect(l4.status).toBe(0);
    expect(l4.stdout.split('\n')[0]).toBe('billing  component  Billing  (resolved from id)');

    // b467: --files puts the import lines under each arrow; --json carries them as usesFiles / usedByFiles
    const files = runCli(['deps', 'api/routes', '--repo', sample, '--files']);
    expect(files.status).toBe(0);
    expect(files.stdout).toMatch(/\n {4}api\/src\/routes\/\S+:\d+ {2}-> api\/src\/\S+/);
    const fobj = parseOneObject(runCli(['deps', 'api/routes', '--repo', sample, '--files', '--json']).stdout);
    expect(fobj.usesFiles.map((g: any) => g.id)).toEqual(fobj.uses.map((e: any) => e.id));
    expect(fobj.usesFiles[0].imports.length).toBeGreaterThan(0);
    expect(Array.isArray(fobj.usedByFiles)).toBe(true);
  }, 120000);

  it('R7: --repo is optional (default: the folder that holds .c4pm, found from the working folder); a missing repo path is an error on stderr', () => {
    const gone = runCli(['find', 'x', '--repo', path.join(tmp, 'no-such-folder')]);
    expect([gone.status, gone.stdout]).toEqual([1, '']);
    expect(gone.stderr.length).toBeGreaterThan(0);

    // no --repo, run from a sub-folder of a repo with .c4pm at its root: the root is used
    const repo = copyFixture('sample', fs.mkdtempSync(path.join(tmp, 'r7-')));
    fs.mkdirSync(path.join(repo, '.c4pm'), { recursive: true });
    const sub = path.join(repo, 'sub', 'deeper');
    fs.mkdirSync(sub, { recursive: true });
    const viaSub = spawnCli(['find', 'order', '--json'], { cwd: sub, encoding: 'utf8' });
    const explicit = runCli(['find', 'order', '--json', '--repo', repo]);
    expect(viaSub.status).toBe(0);
    expect(viaSub.stdout).toBe(explicit.stdout);
  }, 120000);

  it('C4PM_DEBUG=* : --json stdout is still one object; the debug lines go to stderr', () => {
    // Measured before the fix: log() uses console.log, so ~50 "[tag] ..." lines landed on stdout.
    const r = runCli(['find', 'order', '--repo', sample, '--json'], { C4PM_DEBUG: '*' });
    expect(r.status).toBe(0);
    const obj = parseOneObject(r.stdout);
    expect(Array.isArray(obj.results)).toBe(true);
    expect(r.stderr).toMatch(/^\[\w+\] /m);
  }, 120000);

  it('QS-3 guard: a second outline with the same C4PM_CACHE_DIR parses nothing (every file cached)', () => {
    // C4PM_TIMING=1 prints "parse files  <s> s  <N> files (<M> cached)" on stderr (src/pipeline.ts scanCore).
    const cache = fs.mkdtempSync(path.join(tmp, 'cache-'));
    const env = { C4PM_CACHE_DIR: cache, C4PM_TIMING: '1' };
    const parseLine = (stderr: string): [number, number] => {
      const m = /^parse files .* (\d+) files \((\d+) cached\)/m.exec(stderr);
      expect(m).not.toBeNull();
      return [Number(m![1]), Number(m![2])];
    };
    const args = ['outline', 'api/src/services/orderService.ts', '--repo', sample];
    const cold = runCli(args, env);
    expect(cold.status).toBe(0);
    const [files, coldCached] = parseLine(cold.stderr);
    expect(files).toBeGreaterThan(0);
    expect(coldCached).toBe(0);

    const warm = runCli(args, env);
    expect(warm.status).toBe(0);
    expect(warm.stdout).toBe(cold.stdout);
    expect(parseLine(warm.stderr)).toEqual([files, files]);
  }, 120000);

  it('b680/b683: search with no hit and show/outline of a .json file answer without the parse scan; a hit still scans', () => {
    const env = { C4PM_CACHE_DIR: fs.mkdtempSync(path.join(tmp, 'cache-')), C4PM_TIMING: '1' };
    const none = runCli(['search', 'zzzz-no-hit', '--repo', sample], env);
    expect(none.status).toBe(0);
    expect(none.stdout).toMatch(/^no results\n0 hits in \d+ files searched/);
    expect(none.stderr).not.toMatch(/^parse files /m);
    const json = runCli(['show', 'package.json', '--repo', sample], env);
    expect([json.status, json.stdout]).toEqual([0, 'package.json:1  file  [Unassigned]\n  1  { "name": "sample-shop", "private": true }\n']);
    expect(json.stderr).not.toMatch(/^parse files /m);
    const out = runCli(['outline', 'package.json', '--repo', sample], env);
    expect([out.status, out.stdout]).toEqual([0, 'package.json  1 lines\n  1  key  name  [Unassigned]\n  1  key  private  [Unassigned]\n']);
    expect(out.stderr).not.toMatch(/^parse files /m);
    const nf = runCli(['outline', 'notes.txt', '--repo', sample], env);
    expect([nf.status, nf.stdout]).toEqual([1, '']);
    expect(nf.stderr).toMatch(/^error: not-found: /);
    const hit = runCli(['search', 'order', '--repo', sample, '--max', '1'], env);
    expect(hit.status).toBe(0);
    expect(hit.stderr).toMatch(/^parse files /m);
  }, 120000);

  it('read-only: listing and mtimes identical after all commands; no .c4pm created', () => {
    // sample, level4 and withAnchor were scanned above (withAnchor now too)
    runCli(['find', 'order', '--repo', withAnchor]);
    runCli(['show', 'api/src/services/orderService.ts#OrderService.create', '--repo', withAnchor]);
    runCli(['outline', 'api/src/services/orderService.ts', '--repo', withAnchor]);
    runCli(['deps', 'api', '--repo', withAnchor]);
    runCli(['find', 'built', '--repo', level4]);
    runCli(['deps', 'level4', '--repo', level4, '--json']);
    const afterSample = listing(sample);
    // dup.py was created before the snapshot in `before`, so equal lists prove nothing was written
    expect(afterSample).toEqual(before.sample);
    expect(listing(level4)).toEqual(before.level4);
    expect(listing(withAnchor)).toEqual(before.withAnchor);
    expect(fs.existsSync(path.join(sample, '.c4pm'))).toBe(false);
    expect(fs.existsSync(path.join(level4, '.c4pm'))).toBe(false);
  }, 120000);
});
