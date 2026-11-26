import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// P22-8: make-release.sh builds the targets named in C4MP_RELEASE_TARGETS (default: all four; install.ps1 and the
// Rosetta self-test only with their target), and build-portable.sh ships the zip without source maps.

const scripts = path.join(__dirname, '../scripts');
const release = fs.readFileSync(path.join(scripts, 'make-release.sh'), 'utf8');
const portable = fs.readFileSync(path.join(scripts, 'build-portable.sh'), 'utf8');
const KNOWN = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-windows-x64'];

// One shell function of a script, by name: "name() { ... }" on one line, or from "name() {" to the first line that is
// only "}".
const fn = (text: string, name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{(?: .* \\}|\\n(?:.*\\n)*?\\})$`, 'm').exec(text);
  if (!m) throw new Error(`no ${name}() in the script`);
  return m[0];
};
const STUBS = 'log() { echo "[t] $*"; }; die() { echo "[t] ERROR: $*" >&2; exit 1; }';
const run = (body: string, env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync('bash', ['-c', `set -euo pipefail\n${STUBS}\n${body}`, '_', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('make-release.sh targets', () => {
  it('reads C4MP_RELEASE_TARGETS (then the old C4PM_ name), default the four known targets', () => {
    const known = /^KNOWN_TARGETS="([^"]*)"$/m.exec(release);
    expect(known?.[1].split(' ')).toEqual(KNOWN);
    expect(release).toMatch(/^TARGETS="\$\(c4mp_env RELEASE_TARGETS\)"\nTARGETS="\$\{TARGETS:-\$KNOWN_TARGETS\}"$/m);
  });

  it('checks the list and echoes it before anything is built', () => {
    const call = release.search(/^check_targets$/m);
    const echo = release.indexOf('log "targets: $TARGETS"');
    expect(call).toBeGreaterThan(-1);
    expect(echo).toBeGreaterThan(call);
    expect(echo).toBeLessThan(release.indexOf('# 1. Zip.'));
  });

  describe('check_targets', () => {
    const check = () => `${fn(release, 'check_targets')}\ncheck_targets`;
    const known = `KNOWN_TARGETS="${KNOWN.join(' ')}"`;

    it.each([
      ['an unknown target', 'bun-darwin-arm64 bun-linux-arm64', 'bun-linux-arm64'],
      ['a blank list', '   ', 'no target'],
      ['a target named twice', 'bun-linux-x64 bun-linux-x64', 'twice'],
    ])('refuses %s, naming the known list', (_label, targets, word) => {
      const r = run(`${known}\nTARGETS="$1"\n${check()}`, {}, [targets]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(word);
      expect(r.stderr).toContain(KNOWN.join(' '));
    });

    it('accepts macOS + Linux only', () => {
      const r = run(`${known}\nTARGETS="$1"\n${check()}`, {}, ['bun-darwin-arm64 bun-darwin-x64 bun-linux-x64']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  });

  describe('install.ps1 only with the Windows target', () => {
    let out: string;
    beforeEach(() => {
      out = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-targets-'));
      for (const f of ['c4mp-9.9.9-linux-x64', 'c4mp_9.9.9_20261201-1200.zip', 'install.sh', 'install.ps1', 'LICENSE']) fs.writeFileSync(path.join(out, f), 'x');
    });
    afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

    // stray() as make-release.sh sets it up: has_target, then WINDOWS from the target list.
    const strayRun = (targets: string, dir: string) => {
      const setup = /^WINDOWS=""\n.*has_target bun-windows-x64.*\n/m.exec(release);
      expect(setup).not.toBeNull();
      return run(
        `. "${path.join(scripts, 'names.sh')}"\nTARGETS="$1"; OUT="$2"; VERSION=9.9.9\n${fn(release, 'has_target')}\n${setup?.[0]}${fn(release, 'stray')}\nstray`,
        {},
        [targets, dir],
      );
    };

    it('stray() reports install.ps1 without bun-windows-x64, allows it with', () => {
      const without = strayRun('bun-darwin-arm64 bun-linux-x64', out);
      expect(without.status).toBe(0);
      expect(without.stdout.trim()).toBe(path.join(out, 'install.ps1'));
      const withWin = strayRun(KNOWN.join(' '), out);
      expect(withWin.status).toBe(0);
      expect(withWin.stdout).toBe('');
    });

    it('stray() accepts the c4mp_ zip and c4mp- binary of the version, reports files with the old c4pm names', () => {
      for (const f of ['c4pm_9.9.9_20261201-1200.zip', 'c4pm-9.9.9-darwin-x64']) fs.writeFileSync(path.join(out, f), 'x');
      const r = strayRun(KNOWN.join(' '), out);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n').sort()).toEqual([
        path.join(out, 'c4pm-9.9.9-darwin-x64'),
        path.join(out, 'c4pm_9.9.9_20261201-1200.zip'),
      ]);
    });

    it('the up-front refusal and the copy of install.ps1 are guarded by WINDOWS', () => {
      expect(release).toMatch(/^for F in install\.sh \$\{WINDOWS:\+install\.ps1\} LICENSE; do$/m);
      expect(release).toMatch(/^if \[ -n "\$WINDOWS" \]; then\n.*\n {2}cp "\$SCRIPT_DIR\/install\.ps1" "\$OUT\/install\.ps1"/m);
    });
  });

  it('runs the Rosetta self-test only when bun-darwin-x64 is in the list', () => {
    const guard = release.indexOf('if ! has_target bun-darwin-x64; then');
    expect(guard).toBeGreaterThan(-1);
    expect(release.indexOf('elif arch -x86_64 /usr/bin/true')).toBeGreaterThan(guard);
  });
});

describe('build-portable.sh ships no source maps', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-maps-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin/cli.js'), 'run();\n//# sourceMappingURL=cli.js.map', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'bin/cli.js.map'), '{"sources":["../../bin/cli.ts"]}');
    fs.writeFileSync(path.join(dir, 'plain.js'), 'const s = "//# sourceMappingURL= in a string";\nend();\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('strip_source_maps deletes *.map and the trailing comment, keeps the rest and the mode', () => {
    const r = run(`${fn(portable, 'strip_source_maps')}\nstrip_source_maps "$1"`, {}, [dir]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed 1 source map files and 1 sourceMappingURL comments');
    expect(fs.existsSync(path.join(dir, 'bin/cli.js.map'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'bin/cli.js'), 'utf8')).toBe('run();\n');
    expect(fs.statSync(path.join(dir, 'bin/cli.js')).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(dir, 'plain.js'), 'utf8')).toBe('const s = "//# sourceMappingURL= in a string";\nend();\n');
  });

  it('runs on the staged dist right after it is copied', () => {
    const copy = portable.indexOf('cp -R "$PROJECT_DIR/dist" "$STAGING_DIR/dist"');
    const strip = portable.indexOf('strip_source_maps "$STAGING_DIR/dist"');
    expect(copy).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(copy);
    expect(strip).toBeLessThan(portable.indexOf('== step 3/6'));
  });
});
