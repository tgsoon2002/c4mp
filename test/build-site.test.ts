// b918 SHOW-3: scripts/build-site.sh refuses an existing non-empty out folder, and fills every {{variable}} of the landing page.
// No browser and no showcase build: the showcase step is stubbed with C4MP_SITE_SHOWCASE_CMD.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-site.sh');
const TEMPLATE = path.join(__dirname, '..', 'scripts', 'site-index.template.html');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-site-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]) {
  const stub = path.join(tmp, 'stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nshift\nprintf "<html>demo</html>" > "$1"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: path.dirname(process.execPath) + ':' + process.env.PATH, C4MP_SITE_SHOWCASE_CMD: stub };
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status, err: String(r.stderr), out: String(r.stdout) };
}

describe('build-site.sh', () => {
  it('refuses a non-empty out folder without --force and leaves it alone', () => {
    const out = path.join(tmp, 'site');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
    const r = run(['--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not empty/);
    expect(fs.existsSync(path.join(out, 'keep.txt'))).toBe(true);
  });

  it('rejects an unknown argument', () => {
    const r = run(['--nope']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown argument/);
  });

  it('writes the landing page with every variable filled, the demo page and the assets', () => {
    const out = path.join(tmp, 'site');
    const media = path.join(tmp, 'media');
    fs.mkdirSync(media);
    fs.writeFileSync(path.join(media, 'hero.gif'), 'gif');
    const r = run(['--out', out, '--media', media]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).not.toContain('{{');
    expect(html).toContain('href="demo/"');
    expect(html).toContain('brew install');
    expect(fs.readFileSync(path.join(out, 'demo', 'index.html'), 'utf8')).toContain('demo');
    expect(fs.existsSync(path.join(out, 'assets', 'hero.gif'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'favicon.ico'))).toBe(true);
  });

  it('the template only uses variables the script fills', () => {
    const names = new Set((fs.readFileSync(TEMPLATE, 'utf8').match(/\{\{[A-Z_]+\}\}/g) || []));
    const script = fs.readFileSync(SCRIPT, 'utf8');
    for (const n of names) expect(script).toContain(n);
  });
});
