import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// P22-1 (b879): scripts/sha256sums.sh writes SHA256SUMS into a release folder; make-release.sh calls it.
// P22-4 (b882): make-release.sh builds the Intel Mac binary (bun-darwin-x64) too.

const scripts = path.join(__dirname, '../scripts');
const sums = path.join(scripts, 'sha256sums.sh');
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('sha256sums.sh', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-sums-'));
    fs.writeFileSync(path.join(dir, 'c4mp-9.9.9-linux-x64'), 'binary bytes');
    fs.writeFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), 'notices text\n');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'finder');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes one sorted "<hex>  <name>" line per file, skipping .DS_Store; shasum -c passes', () => {
    const r = spawnSync('bash', [sums, dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const text = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
    expect(text).toBe(
      `${sha(path.join(dir, 'THIRD-PARTY-NOTICES.txt'))}  THIRD-PARTY-NOTICES.txt\n` +
      `${sha(path.join(dir, 'c4mp-9.9.9-linux-x64'))}  c4mp-9.9.9-linux-x64\n`,
    );
    for (const line of text.trimEnd().split('\n')) expect(line).toMatch(/^[0-9a-f]{64} {2}[^/\s]+$/);
    const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  it('refuses with exit 1 when SHA256SUMS already exists, and leaves it unchanged', () => {
    const file = path.join(dir, 'SHA256SUMS');
    fs.writeFileSync(file, 'old sums\n');
    const r = spawnSync('bash', [sums, dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('old sums\n');
  });
});

describe('make-release.sh', () => {
  const text = fs.readFileSync(path.join(scripts, 'make-release.sh'), 'utf8');

  it('builds the darwin-x64 binary (a known target, in the default list)', () => {
    const targets = /^KNOWN_TARGETS="([^"]*)"$/m.exec(text);
    expect(targets?.[1].split(' ')).toEqual(['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-windows-x64']);
  });

  it('allows SHA256SUMS in the version folder', () => {
    const stray = /^stray\(\) \{\n(?:.*\n)*?\}$/m.exec(text);
    expect(stray?.[0]).toContain("! -name 'SHA256SUMS'");
  });

  it('writes SHA256SUMS after the notices', () => {
    const notices = text.indexOf('log "notices: $N"');
    const call = text.indexOf('"$SCRIPT_DIR/sha256sums.sh" "$OUT"');
    expect(notices).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(notices);
  });
});
