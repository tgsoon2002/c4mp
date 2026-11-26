import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runSnapshot } from '../src/pipeline';

const fixtureRoot = path.join(__dirname, 'fixtures', 'sample');

describe('pipeline', () => {
  it('runs snapshot on fixture with correct stats', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));

    const snapshot = runSnapshot({
      repo: fixtureRoot,
      out: outDir,
    });

    // Verify stats
    expect(snapshot.stats).toEqual({
      containers: 3,
      components: 7,
      files: 8,
      codeElements: 12,
      componentEdges: 7,
      unresolvedImports: 1,
    });

    // Verify all 4 JSON files exist
    expect(fs.existsSync(path.join(outDir, 'outline.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'imports.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'components.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'snapshot.json'))).toBe(true);

    // Cleanup
    fs.rmSync(outDir, { recursive: true });
  });

  it('produces identical output except meta.createdAt on second run', () => {
    const outDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));
    const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));

    const snapshot1 = runSnapshot({
      repo: fixtureRoot,
      out: outDir1,
    });

    const snapshot2 = runSnapshot({
      repo: fixtureRoot,
      out: outDir2,
    });

    // CreatedAt should be different
    expect(snapshot1.meta.createdAt).not.toEqual(snapshot2.meta.createdAt);

    // Everything else should be identical
    const snap1Copy = JSON.parse(JSON.stringify(snapshot1));
    const snap2Copy = JSON.parse(JSON.stringify(snapshot2));
    snap1Copy.meta.createdAt = undefined;
    snap2Copy.meta.createdAt = undefined;

    expect(snap1Copy).toEqual(snap2Copy);

    // JSON files should also be identical except for meta.createdAt
    const snap1Json = JSON.parse(
      fs.readFileSync(path.join(outDir1, 'snapshot.json'), 'utf8')
    );
    const snap2Json = JSON.parse(
      fs.readFileSync(path.join(outDir2, 'snapshot.json'), 'utf8')
    );

    snap1Json.meta.createdAt = undefined;
    snap2Json.meta.createdAt = undefined;
    expect(snap1Json).toEqual(snap2Json);

    // Cleanup
    fs.rmSync(outDir1, { recursive: true });
    fs.rmSync(outDir2, { recursive: true });
  });

  it('quiet + write:false produces no console output and no output dir', () => {
    // Create a path that doesn't exist yet
    const nonExistentDir = path.join(os.tmpdir(), `c4pm-nonexistent-${Date.now()}`);

    const spy = jest.spyOn(console, 'log');

    const snapshot = runSnapshot({
      repo: fixtureRoot,
      out: nonExistentDir,
      quiet: true,
      write: false,
    });

    // Verify no console.log calls were made
    expect(spy).toHaveBeenCalledTimes(0);

    // Verify output dir was not created
    expect(fs.existsSync(nonExistentDir)).toBe(false);

    // Verify snapshot was still created with correct stats
    expect(snapshot.stats).toEqual({
      containers: 3,
      components: 7,
      files: 8,
      codeElements: 12,
      componentEdges: 7,
      unresolvedImports: 1,
    });

    // Cleanup spy
    spy.mockRestore();
  });

  it('meta option overrides repoName and updates system.id', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-'));

    const snapshot = runSnapshot({
      repo: fixtureRoot,
      out: outDir,
      meta: { repoName: 'Other Name' },
    });

    // Verify repoName was overridden in metadata
    expect(snapshot.meta.repoName).toBe('Other Name');

    // Verify system.id is derived from the overridden repoName
    expect(snapshot.system.id).toBe('other-name');

    // Cleanup
    fs.rmSync(outDir, { recursive: true });
  });
});
