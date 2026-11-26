import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// P22-2 (b880): scripts/install.sh (macOS / Linux) and scripts/install.ps1 (Windows) download the binary for this
// platform, check it against SHA256SUMS and run its `c4mp install`. Tested against a local folder only (file://).
// Phase 35 D: names come from scripts/names.sh (install.sh repeats them inline); C4MP_* env wins over the old C4PM_*.

const scripts = path.join(__dirname, '../scripts');
const installSh = path.join(scripts, 'install.sh');
const installPs1 = path.join(scripts, 'install.ps1');
const namesSh = path.join(scripts, 'names.sh');
const REPO = 'tgsoon2002/c4mp-releases';
const LATEST = `https://github.com/${REPO}/releases/latest/download`;
const PINNED = `https://github.com/${REPO}/releases/download/v`;
const PLATFORMS = ['darwin-arm64', 'linux-x64'];
const INSTALL_ENV = ['RELEASE_BASE', 'VERSION', 'PLATFORM', 'DRY_URL'].flatMap(s => [`C4MP_${s}`, `C4PM_${s}`]);

/** process.env without the C4MP_ / C4PM_ install variables, plus `extra`. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of INSTALL_ENV) delete env[k];
  return { ...env, ...extra };
}

/** The NAME=value lines of a shell file, as a map (only plain `C4MP_X=value` lines). */
function shellValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^(C4MP_[A-Z_]+)=(\S+)$/gm)) out[m[1]] = m[2];
  return out;
}

const onPath = (cmd: string): boolean => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

describe('install.sh', () => {
  let rel: string;
  let target: string;
  const argsFile = (platform: string): string => path.join(rel, `args-${platform}.txt`);
  const binName = (platform: string): string => `c4mp-9.9.9-${platform}`;

  beforeEach(() => {
    rel = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-install-rel-'));
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-install-dir-'));
    for (const p of PLATFORMS) {
      // A fake binary: prints 9.9.9 for --version, writes its install args (one per line) to args-<platform>.txt.
      const body =
        '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\n' +
        `if [ "$1" = "install" ]; then shift; printf '%s\\n' "$@" > '${argsFile(p)}'; exit 0; fi\n` +
        'exit 2\n';
      fs.writeFileSync(path.join(rel, binName(p)), body, { mode: 0o644 });
    }
    const made = spawnSync('bash', [path.join(scripts, 'sha256sums.sh'), rel], { encoding: 'utf8' });
    expect(made.status).toBe(0);
  });

  afterEach(() => {
    fs.rmSync(rel, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  const run = (platform: string, shell = 'sh', extra: Record<string, string> = {}) =>
    spawnSync(shell, [installSh, '--yes', '--no-path', '--dir', target], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: '',
      env: envWith({ C4MP_RELEASE_BASE: `file://${rel}`, C4MP_PLATFORM: platform, ...extra }),
    });

  const shells = ['sh', 'bash', ...(onPath('dash') ? ['dash'] : [])];
  it.each(shells)('linux-x64 under %s: picks the linux binary, prints 9.9.9, passes the 3 args to install', shell => {
    const r = run('linux-x64', shell);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[install] from file://${rel}`);
    expect(r.stdout).toContain(binName('linux-x64'));
    expect(r.stdout).toMatch(/^9\.9\.9$/m);
    expect(fs.readFileSync(argsFile('linux-x64'), 'utf8')).toBe(`--yes\n--no-path\n--dir\n${target}\n`);
    expect(fs.existsSync(argsFile('darwin-arm64'))).toBe(false);
  });

  it('darwin-arm64 picks the darwin binary', () => {
    const r = run('darwin-arm64');
    expect(r.status).toBe(0);
    expect(fs.existsSync(argsFile('darwin-arm64'))).toBe(true);
    expect(fs.existsSync(argsFile('linux-x64'))).toBe(false);
  });

  it('a changed byte in the binary: exit 1, "checksum mismatch", nothing run', () => {
    const bin = path.join(rel, binName('linux-x64'));
    const bytes = fs.readFileSync(bin);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] ^ 1;
    fs.writeFileSync(bin, bytes);
    const r = run('linux-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('checksum mismatch');
    expect(r.stdout).not.toMatch(/^9\.9\.9$/m);
    expect(fs.existsSync(argsFile('linux-x64'))).toBe(false);
  });

  it('the old C4PM_RELEASE_BASE and C4PM_PLATFORM names still work', () => {
    const r = spawnSync('sh', [installSh, '--yes', '--no-path', '--dir', target], {
      encoding: 'utf8',
      input: '',
      env: envWith({ C4PM_RELEASE_BASE: `file://${rel}`, C4PM_PLATFORM: 'linux-x64' }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[install] from file://${rel}`);
    expect(fs.existsSync(argsFile('linux-x64'))).toBe(true);
  });

  it('the old c4pm-<ver>-<platform> binary name is not picked: exit 1, nothing run', () => {
    const sums = path.join(rel, 'SHA256SUMS');
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/c4mp-9/g, 'c4pm-9'));
    const r = run('linux-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('c4mp-*-linux-x64');
    expect(fs.existsSync(argsFile('linux-x64'))).toBe(false);
  });

  it('C4MP_PLATFORM=linux-arm64: exit 1, the message lists the supported platforms', () => {
    const r = run('linux-arm64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('linux-arm64');
    for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64']) expect(r.stderr).toContain(p);
    for (const p of PLATFORMS) expect(fs.existsSync(argsFile(p))).toBe(false);
  });

  it('a SHA256SUMS without the platform line: exit 1, nothing run', () => {
    const sums = path.join(rel, 'SHA256SUMS');
    const kept = fs.readFileSync(sums, 'utf8').split('\n').filter(l => !l.endsWith('linux-x64')).join('\n');
    fs.writeFileSync(sums, kept);
    const r = run('linux-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('linux-x64');
    expect(fs.existsSync(argsFile('linux-x64'))).toBe(false);
  });

  const dry = (extra: Record<string, string>) =>
    spawnSync('sh', [installSh], { encoding: 'utf8', input: '', env: envWith(extra) });

  it('C4MP_DRY_URL=1: C4MP_VERSION=1.2.3 uses releases/download/v1.2.3, no version uses latest; exit 0, no download', () => {
    const pinned = dry({ C4MP_DRY_URL: '1', C4MP_VERSION: '1.2.3' });
    expect(pinned.status).toBe(0);
    expect(pinned.stdout.trim()).toBe(`[install] from ${PINNED}1.2.3`);
    const latest = dry({ C4MP_DRY_URL: '1' });
    expect(latest.status).toBe(0);
    expect(latest.stdout.trim()).toBe(`[install] from ${LATEST}`);
  });

  it('the new C4MP_ names win over the old C4PM_ names; the old names alone still work (no network)', () => {
    const both = dry({ C4MP_DRY_URL: '1', C4MP_VERSION: '1.2.3', C4PM_VERSION: '9.9.9' });
    expect(both.stdout.trim()).toBe(`[install] from ${PINNED}1.2.3`);
    const base = dry({ C4MP_DRY_URL: '1', C4MP_RELEASE_BASE: 'file:///new/', C4PM_RELEASE_BASE: 'file:///old' });
    expect(base.stdout.trim()).toBe('[install] from file:///new');
    const oldOnly = dry({ C4PM_DRY_URL: '1', C4PM_VERSION: '2.0.0' });
    expect(oldOnly.status).toBe(0);
    expect(oldOnly.stdout.trim()).toBe(`[install] from ${PINNED}2.0.0`);
    const emptyNew = dry({ C4MP_DRY_URL: '1', C4MP_VERSION: '', C4PM_VERSION: '3.0.0' });
    expect(emptyNew.stdout.trim()).toBe(`[install] from ${PINNED}3.0.0`);
  });
});

describe('names.sh', () => {
  const names = shellValues(namesSh);

  it('has the five names of the product', () => {
    expect(names).toEqual({
      C4MP_NAME: 'c4mp',
      C4MP_PRODUCT: 'C4MP',
      C4MP_LEGACY_NAME: 'c4pm',
      C4MP_RELEASES_REPO: REPO,
      C4MP_TAP: 'tgsoon2002/c4mp',
    });
  });

  it('install.sh repeats exactly these values inline (it is downloaded alone and cannot source names.sh)', () => {
    expect(shellValues(installSh)).toEqual(names);
  });

  it('install.ps1 uses the same command name and releases repo', () => {
    const text = fs.readFileSync(installPs1, 'utf8');
    expect(text).toContain(`$c4mpName = '${names.C4MP_NAME}'`);
    expect(text).toContain(`$releasesRepo = '${names.C4MP_RELEASES_REPO}'`);
  });

  it('release-install.sh (shipped alone in the zip) has the same C4MP_NAME', () => {
    expect(shellValues(path.join(scripts, 'release-install.sh')).C4MP_NAME).toBe(names.C4MP_NAME);
  });

  const sh = (body: string, env: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', `. "${namesSh}"\n${body}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

  it('c4mp_env: the C4MP_ value wins, an empty one falls back to C4PM_, none gives an empty string', () => {
    expect(sh('c4mp_env RELEASE_DIR', { C4MP_RELEASE_DIR: '/new', C4PM_RELEASE_DIR: '/old' }).stdout).toBe('/new');
    expect(sh('c4mp_env RELEASE_DIR', { C4PM_RELEASE_DIR: '/old' }).stdout).toBe('/old');
    expect(sh('c4mp_env RELEASE_DIR', { C4MP_RELEASE_DIR: '', C4PM_RELEASE_DIR: '/old' }).stdout).toBe('/old');
    expect(sh('c4mp_env RELEASE_DIR').stdout).toBe('');
  });

  it('c4mp_binary_name and c4mp_zip_name build the release file names', () => {
    expect(sh('c4mp_binary_name 0.11.0 darwin-arm64').stdout).toBe('c4mp-0.11.0-darwin-arm64');
    expect(sh('c4mp_zip_name 0.11.0 20261201-1200').stdout).toBe('c4mp_0.11.0_20261201-1200.zip');
  });
});

describe('make-release.sh ships the install scripts', () => {
  const text = fs.readFileSync(path.join(scripts, 'make-release.sh'), 'utf8');

  it('copies install.sh and install.ps1 into OUT before sha256sums.sh runs', () => {
    const call = text.indexOf('"$SCRIPT_DIR/sha256sums.sh" "$OUT"');
    expect(call).toBeGreaterThan(-1);
    for (const f of ['install.sh', 'install.ps1']) {
      const copy = text.search(new RegExp(`cp "\\$SCRIPT_DIR/${f.replace('.', '\\.')}" "\\$OUT/${f.replace('.', '\\.')}"`));
      expect(copy).toBeGreaterThan(-1);
      expect(copy).toBeLessThan(call);
    }
  });

  it('the leftover check allows install.sh and install.ps1', () => {
    const stray = /^stray\(\) \{\n(?:.*\n)*?\}$/m.exec(text);
    expect(stray?.[0]).toContain("! -name 'install.sh'");
    expect(stray?.[0]).toContain("! -name 'install.ps1'");
  });
});

describe('install.ps1', () => {
  const hasPwsh = onPath('pwsh');

  it('has the stop preference, the hash check, the Windows binary, install @args and both default URLs', () => {
    const text = fs.readFileSync(installPs1, 'utf8');
    expect(text).toContain("$ErrorActionPreference = 'Stop'");
    expect(text).toContain('Get-FileHash');
    expect(text).toContain('windows-x64.exe');
    expect(text).toContain('install @args');
    expect(text).toContain(REPO);
    expect(text).toContain('/releases/latest/download');
    expect(text).toContain('/releases/download/v');
    expect(text).toContain('C4PM_');
  });

  (hasPwsh ? it : it.skip)(
    `runs under pwsh against a local folder${hasPwsh ? '' : ' (skipped: pwsh is not on PATH)'}`,
    () => {
      const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-install-ps-'));
      try {
        const args = path.join(rel, 'args.txt');
        const exe = path.join(rel, 'c4mp-9.9.9-windows-x64.exe');
        fs.writeFileSync(
          exe,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\n' +
            `if [ "$1" = "install" ]; then shift; printf '%s\\n' "$@" > '${args}'; fi\n`,
          { mode: 0o755 },
        );
        expect(spawnSync('bash', [path.join(scripts, 'sha256sums.sh'), rel]).status).toBe(0);
        const r = spawnSync('pwsh', ['-NoProfile', '-File', installPs1, '--yes', '--no-path'], {
          encoding: 'utf8',
          env: envWith({ C4MP_RELEASE_BASE: rel, C4MP_PLATFORM: 'windows-x64' }),
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/^9\.9\.9$/m);
        expect(fs.readFileSync(args, 'utf8')).toBe('--yes\n--no-path\n');
      } finally {
        fs.rmSync(rel, { recursive: true, force: true });
      }
    },
  );
});
