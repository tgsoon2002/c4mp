import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const script = path.join(__dirname, '../scripts/third-party-notices.js');

describe('third-party-notices.js', () => {
  let root: string;
  let modules: string;

  const pkg = (rel: string, json: object, files: Record<string, string> = {}): void => {
    const dir = path.join(modules, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-notices-'));
    modules = path.join(root, 'node_modules');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'c4mp', version: '7.7.7' }));
    pkg('a-pkg', { name: 'a-pkg', version: '1.0.0', license: 'MIT' }, { LICENSE: 'MIT text of a-pkg' });
    pkg('@scope/b', { name: '@scope/b', version: '2.0.0', license: 'Apache-2.0' },
      { 'LICENSE.txt': 'Apache text of b', NOTICE: 'Notice text of b' });
    pkg('a-pkg/node_modules/c', { name: 'c', version: '0.1.0', license: 'ISC' });
    pkg('d', { name: 'd', version: '3.0.0' });
    fs.mkdirSync(path.join(modules, '.bin'));
    fs.writeFileSync(path.join(modules, '.bin', 'package.json'), JSON.stringify({ name: 'bin-ghost', version: '1.0.0' }));
    fs.mkdirSync(path.join(modules, 'no-manifest'));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('prints one block per package, sorted, with licence and notice texts', () => {
    const out = execFileSync(process.execPath, [script, modules], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out.startsWith('c4mp third-party notices\n========================\nc4mp 7.7.7 includes these packages.')).toBe(true);
    const heads = out.split('\n').filter((l) => /^\S+ \S+ \(.*\)$/.test(l));
    expect(heads).toEqual([
      '@scope/b 2.0.0 (Apache-2.0)',
      'a-pkg 1.0.0 (MIT)',
      'c 0.1.0 (ISC)',
      'd 3.0.0 (license: UNKNOWN)',
    ]);
    expect(out).toContain('MIT text of a-pkg');
    expect(out).toContain('Apache text of b');
    expect(out).toContain('--- NOTICE (NOTICE) ---\nNotice text of b');
    expect(out).toContain('c 0.1.0 (ISC)\n' + '-'.repeat(72) + '\n(no licence file in the package; package.json license: ISC)');
    expect(out).toContain('(no licence file in the package; package.json license: UNKNOWN)');
    expect(out).not.toContain('bin-ghost');
    expect(out).not.toContain('no-manifest');
  });

  it('warns on stderr for a package with no licence, and still exits 0', () => {
    const r = spawnSync(process.execPath, [script, modules], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: d@3.0.0 has no license field and no licence file');
    expect(r.stderr).not.toContain('a-pkg');
  });

  it('--bun-section prints only the Bun runtime section', () => {
    const out = execFileSync(process.execPath, [script, '--bun-section', '9.9.9'], { encoding: 'utf8' });
    expect(out).toContain('Bun runtime 9.9.9 (MIT)');
    expect(out).toContain('https://bun.sh/docs/project/licensing');
    expect(out).not.toContain('c4mp third-party notices');
  });
});
