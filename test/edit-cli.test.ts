import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli, SPAWN_TIMEOUT_MS } from './helpers/runCli';

// Phase 32 (ED-2): `c4pm edit replace / insert / remove`, spawned (dist/bin/cli.js).

const A_TS = 'export function f(): number {\n  return 1;\n}\n\nexport function g(): number {\n  return 2;\n}\n';
const NEW_F = 'export function f(): number {\n  return 10;\n}\n';

describe('c4pm edit (ED-2)', () => {
  let dir: string;
  const file = () => path.join(dir, 'a.ts');
  const read = () => fs.readFileSync(file(), 'utf8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-edit-cli-'));
    fs.writeFileSync(file(), A_TS);
    fs.writeFileSync(path.join(dir, 'new-f.txt'), NEW_F);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('replace --from: the dry run prints the diff and writes nothing; --yes writes', () => {
    const dry = runCli(['edit', 'replace', 'a.ts#f', '--repo', dir, '--from', 'new-f.txt']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('edit replace a.ts#f');
    expect(dry.stdout).toContain('-  return 1;');
    expect(dry.stdout).toContain('+  return 10;');
    expect(dry.stdout).toContain('dry run: nothing written');
    expect(read()).toBe(A_TS);

    const yes = runCli(['edit', 'replace', 'a.ts#f', '--repo', dir, '--from', 'new-f.txt', '--yes']);
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain('written: a.ts');
    expect(read()).toBe(A_TS.replace('return 1;', 'return 10;'));
  }, SPAWN_TIMEOUT_MS);

  it('the new text can come from stdin', () => {
    const r = runCli(['edit', 'insert', 'a.ts#g', '--after', '--repo', dir, '--yes'], { input: '\nexport const h = 3;\n' });
    expect(r.status).toBe(0);
    expect(read()).toBe(A_TS + '\nexport const h = 3;\n');
  }, SPAWN_TIMEOUT_MS);

  it('--json prints one WriteReport object', () => {
    const r = runCli(['edit', 'remove', 'a.ts#g', '--repo', dir, '--json']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ ok: true, command: 'edit remove', dryRun: true, written: false, target: null, error: null });
    expect(report.files).toEqual([{ file: 'a.ts', diff: expect.stringContaining('-export function g(): number {') }]);
    expect(report.findings).toEqual({ new: [], fixed: [] });
    expect(Array.isArray(report.notes)).toBe(true);
    expect(read()).toBe(A_TS);
  }, SPAWN_TIMEOUT_MS);

  it('insert without a placement flag exits 1 with invalid, and writes nothing', () => {
    const r = runCli(['edit', 'insert', 'a.ts#g', '--repo', dir, '--from', 'new-f.txt', '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: invalid: edit insert needs exactly one of --after, --before, --into');
    expect(read()).toBe(A_TS);
  }, SPAWN_TIMEOUT_MS);

  it('an unknown name exits 1 with not-found', () => {
    const r = runCli(['edit', 'remove', 'a.ts#nope', '--repo', dir, '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: not-found:');
    expect(read()).toBe(A_TS);
  }, SPAWN_TIMEOUT_MS);
});
