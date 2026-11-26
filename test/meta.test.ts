import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { readMeta, readRepoIdentity } from '../src/history/meta';
import pkg from '../package.json';

describe('readMeta', () => {
  it('reads repo name from package.json and git info from fixture', () => {
    const fixtureRoot = path.join(__dirname, 'fixtures/sample');
    const meta = readMeta(fixtureRoot);

    const expectedBranch = execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    expect(meta.repoName).toBe('sample-shop');
    expect(meta.git).not.toBeNull();
    expect(meta.git?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.git?.branch).toBe(expectedBranch);
    expect(meta.git?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.git?.depth).toBeGreaterThanOrEqual(1);
    expect(meta.tool).toBe(`c4mp@${pkg.version}`);
  });

  it('uses basename as repoName when package.json has no name field', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));
    try {
      const meta = readMeta(tempDir);

      expect(meta.repoName).toBe(path.basename(tempDir));
      expect(meta.git).toBeNull();
      expect(meta.tool).toBe(`c4mp@${pkg.version}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('uses provided date for createdAt', () => {
    const fixtureRoot = path.join(__dirname, 'fixtures/sample');
    const testDate = new Date('2026-01-01T00:00:00Z');
    const meta = readMeta(fixtureRoot, testDate);

    expect(meta.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('git: false gives the same meta with git null (no git calls)', () => {
    const fixtureRoot = path.join(__dirname, 'fixtures/sample');
    const testDate = new Date('2026-01-01T00:00:00Z');
    expect(readMeta(fixtureRoot, testDate, { git: false })).toEqual({ ...readMeta(fixtureRoot, testDate), git: null });
  });
});

describe('readRepoIdentity', () => {
  it('gives the repoPath and repoName readMeta gives (package.json name, else basename)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{"version":"1.0.0"}');
      for (const root of [path.join(__dirname, 'fixtures/sample'), tempDir, path.relative(process.cwd(), tempDir)]) {
        const { repoPath, repoName } = readMeta(root);
        expect(readRepoIdentity(root)).toMatchObject({ repoPath, repoName });
      }
      expect(readRepoIdentity(tempDir).repoName).toBe(path.basename(tempDir));
      expect(readRepoIdentity(path.join(__dirname, 'fixtures/sample')).repoName).toBe('sample-shop');
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
});
