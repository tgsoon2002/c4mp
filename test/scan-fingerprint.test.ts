import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { tryResolveProject } from '../src/outputs';
import { loadQueryContext } from '../src/query/context';
import { computeFingerprint, isStale, withFingerprint } from '../src/scan/fingerprint';

const SAMPLE = path.join(__dirname, 'fixtures', 'sample');

function copyOfSample(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-fp-'));
  fs.cpSync(SAMPLE, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'skipme'));
  fs.writeFileSync(path.join(dir, 'skipme', 'x.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(dir, '.c4pm'));
  fs.writeFileSync(path.join(dir, '.c4pm', 'config.json'), JSON.stringify({ ignore: ['skipme'] }));
  fs.writeFileSync(path.join(dir, 'plan.c4'), 'system a "A"\n');
  return dir;
}

/** Rewrite a file with new text and a clearly different mtime. */
function edit(file: string, text: string): void {
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
}

describe('computeFingerprint', () => {
  let dir: string;
  const fp = (): string => {
    const config = loadConfig(dir, undefined, { configPath: path.join(dir, '.c4pm', 'config.json') });
    return computeFingerprint(dir, config);
  };
  beforeEach(() => { dir = copyOfSample(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is stable across two calls', () => {
    expect(fp()).toMatch(/^[0-9a-f]{40}$/);
    expect(fp()).toBe(fp());
  });

  it('changes when a source file is touched', () => {
    const before = fp();
    edit(path.join(dir, 'api', 'src', 'server.ts'), 'export const touched = 2;\n');
    expect(fp()).not.toBe(before);
  });

  it('changes when a .c4 plan file changes', () => {
    const before = fp();
    edit(path.join(dir, 'plan.c4'), 'system a "A2"\n');
    expect(fp()).not.toBe(before);
  });

  it('changes when .c4pm/config.json changes', () => {
    const before = fp();
    edit(path.join(dir, '.c4pm', 'config.json'), JSON.stringify({ ignore: ['skipme', 'other'] }));
    expect(fp()).not.toBe(before);
  });

  it('does not change for an ignored file', () => {
    const before = fp();
    edit(path.join(dir, 'skipme', 'x.ts'), 'export const a = 99;\n');
    expect(fp()).toBe(before);
  });

  it('withFingerprint fills the context and isStale follows the tree', () => {
    const ctx = withFingerprint(loadQueryContext(dir));
    expect(ctx.fingerprint).not.toBe('');
    expect(isStale(ctx)).toBe(false);
    edit(path.join(dir, 'plan.c4'), 'system a "A3"\n');
    expect(isStale(ctx)).toBe(true);
  });

  // STOR-4 (b336, A17): a migration is no scanned source; the extra extensions the Query layer passes bring it in.
  it('follows the extra extensions: a touched .sql migration makes the context stale', () => {
    const sql = path.join(dir, 'migrations', '0001_init.sql');
    fs.mkdirSync(path.dirname(sql));
    fs.writeFileSync(sql, 'CREATE TABLE t (id int);\n');
    const before = fp();
    const withSql = computeFingerprint(dir, loadConfig(dir, undefined, { configPath: path.join(dir, '.c4pm', 'config.json') }), ['.sql']);
    const ctx = withFingerprint(loadQueryContext(dir));
    expect(ctx.extraExtensions).toContain('.sql');
    expect(isStale(ctx)).toBe(false);
    edit(sql, 'CREATE TABLE t (id int, name text);\n');
    expect(fp()).toBe(before);
    expect(computeFingerprint(dir, loadConfig(dir, undefined, { configPath: path.join(dir, '.c4pm', 'config.json') }), ['.sql'])).not.toBe(withSql);
    expect(isStale(ctx)).toBe(true);
  });

  // b679 (SV3): the fingerprint walks the project's input folders too (projectInputRoots), so a board edit makes the
  // MCP context stale and the live page rebuild.
  describe('project files under .c4pm/projects/<id> (b679)', () => {
    let projectDir: string;
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(projectDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, rel), text);
    };
    beforeEach(() => {
      projectDir = tryResolveProject(dir)!.projectDir;
      for (const f of ['plan/arch.c4', 'plan/io/x.html', 'plan/io/site.css', 'board/board.json', 'sim/s-1.json', 'data/x.json']) put(f, 'x');
    });

    it.each(['board/board.json', 'sim/s-1.json', 'plan/io/x.html', 'plan/io/site.css'])('a touched %s makes the context stale', (rel) => {
      const before = fp();
      const ctx = withFingerprint(loadQueryContext(dir));
      expect(isStale(ctx)).toBe(false);
      edit(path.join(projectDir, rel), 'y');
      expect(fp()).not.toBe(before);
      expect(isStale(ctx)).toBe(true);
    });

    it('a new s-item changes it; data/ does not', () => {
      const before = fp();
      edit(path.join(projectDir, 'data', 'x.json'), 'y');
      expect(fp()).toBe(before);
      put('sim/s-2.json', '{}');
      expect(fp()).not.toBe(before);
    });
  });
});
