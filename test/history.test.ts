import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runHistory } from '../src/scan/historyRun';
import { loadManifest, loadFromHistory } from '../src/history/store';
import { compareSnapshots } from '../src/compare/index';
import { toId } from '../src/names';

describe('history', () => {
  it('runHistory: creates temp git repo with sample and sample-v2, returns 2 entries', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-history-'));
    const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-'));

    try {
      // Initialize repo
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });

      // Copy sample fixture contents
      const sampleSrc = path.join(__dirname, 'fixtures', 'sample');
      const files = fs.readdirSync(sampleSrc);
      for (const file of files) {
        const src = path.join(sampleSrc, file);
        const dest = path.join(tempRepo, file);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      }

      // First commit with sample
      execFileSync('git', ['-C', tempRepo, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'initial: sample'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z'
        }
      });

      // Delete everything except .git
      const repoContents = fs.readdirSync(tempRepo);
      for (const item of repoContents) {
        if (item !== '.git') {
          const itemPath = path.join(tempRepo, item);
          if (fs.statSync(itemPath).isDirectory()) {
            fs.rmSync(itemPath, { recursive: true });
          } else {
            fs.unlinkSync(itemPath);
          }
        }
      }

      // Copy sample-v2 contents
      const sampleV2Src = path.join(__dirname, 'fixtures', 'sample-v2');
      const filesV2 = fs.readdirSync(sampleV2Src);
      for (const file of filesV2) {
        const src = path.join(sampleV2Src, file);
        const dest = path.join(tempRepo, file);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      }

      // Second commit with sample-v2
      execFileSync('git', ['-C', tempRepo, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'update: sample-v2'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-02T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-02T10:00:00Z'
        }
      });

      // Run history
      const entries = runHistory({
        repo: tempRepo,
        store: tempStore,
        max: 20
      });

      // Verify 2 entries created
      expect(entries).toHaveLength(2);
      expect(entries[0].stats.codeElements).toBeGreaterThan(0);
      expect(entries[1].stats.codeElements).toBeGreaterThan(0);

      // Verify manifest (sample fixture has package.json with name "sample-shop")
      const repoId = toId('sample-shop');
      const manifest = loadManifest(tempStore, repoId);
      expect(manifest.entries).toHaveLength(2);

      // Load and compare snapshots
      const v1 = loadFromHistory(tempStore, repoId, manifest.entries[0]);
      const v2 = loadFromHistory(tempStore, repoId, manifest.entries[1]);

      const diff = compareSnapshots(v1, v2);

      // Verify summary matches expected structure (components, files, elements, edges, cycles, lines)
      expect(diff.summary).toBeDefined();
      expect(diff.summary.componentsAdded).toBeGreaterThanOrEqual(0);
      expect(diff.summary.filesAdded).toBeGreaterThanOrEqual(0);
      expect(diff.summary.elementsAdded).toBeGreaterThanOrEqual(0);

      // Run history again - should return 0 new entries
      const entries2 = runHistory({
        repo: tempRepo,
        store: tempStore,
        max: 20
      });
      expect(entries2).toHaveLength(0);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(tempStore, { recursive: true, force: true });
    }
  });

  it('runHistory: quiet:true prints nothing and still stores the entries', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-history-quiet-'));
    const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-quiet-'));
    try {
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'test-quiet' }));
      fs.writeFileSync(path.join(tempRepo, 'index.ts'), 'export const a = 1;\n');
      execFileSync('git', ['-C', tempRepo, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'first'], { stdio: 'ignore' });

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      let entries;
      try {
        entries = runHistory({ repo: tempRepo, store: tempStore, quiet: true });
      } finally {
        logSpy.mockRestore();
      }
      expect(logSpy).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(tempStore, { recursive: true, force: true });
    }
  });

  it('runHistory refs: records exactly those commits once, in the given order, skipping refs that name no commit; without refs the newest max', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-history-refs-'));
    const storeRefs = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-refs-'));
    const storeMax = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-max-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', tempRepo, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test User');
      fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'test-refs' }));
      const shas: string[] = [];
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(tempRepo, `f${i}.ts`), `export function f${i}() { return ${i}; }\n`);
        git('add', '-A');
        git('commit', '-q', '-m', `c${i}`);
        shas.push(git('rev-parse', 'HEAD'));
      }

      const entries = runHistory({ repo: tempRepo, store: storeRefs, refs: [shas[0], 'HEAD', 'ORIG_HEAD', shas[2]], collectCalls: 'tests', quiet: true });
      expect(entries.map(e => e.commit)).toEqual([shas[0], shas[2]]);
      expect(loadManifest(storeRefs, toId('test-refs')).entries.map(e => e.commit)).toEqual([shas[0], shas[2]]);
      // stored commits are skipped
      expect(runHistory({ repo: tempRepo, store: storeRefs, refs: ['HEAD'], quiet: true })).toHaveLength(0);

      // without refs: unchanged, the newest `max` first-parent commits, oldest first
      expect(runHistory({ repo: tempRepo, store: storeMax, max: 2, quiet: true }).map(e => e.commit)).toEqual([shas[1], shas[2]]);
    } finally {
      for (const d of [tempRepo, storeRefs, storeMax]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('runHistory: removes c4pm-export-* dirs older than 24 h, keeps a fresh one and other names', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-history-sweep-'));
    const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-sweep-'));
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-export-'));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-export-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-xyz-'));
    try {
      fs.writeFileSync(path.join(stale, 'left.ts'), 'export const x = 1;\n');
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      for (const d of [stale, other]) fs.utimesSync(d, twoDaysAgo, twoDaysAgo);
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'test-sweep' }));
      execFileSync('git', ['-C', tempRepo, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'first'], { stdio: 'ignore' });

      expect(runHistory({ repo: tempRepo, store: tempStore, quiet: true })).toHaveLength(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      for (const d of [tempRepo, tempStore, stale, fresh, other]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('runHistory: throws for non-git repo', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nogit-'));
    const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-'));

    try {
      expect(() => runHistory({
        repo: tempDir,
        store: tempStore
      })).toThrow('Not a git repository');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(tempStore, { recursive: true, force: true });
    }
  });

  it('runHistory: honors config.ignore to exclude files from snapshots', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-history-ignore-'));
    const tempStoreWithIgnore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-ignore-'));
    const tempStoreWithoutIgnore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-noignore-'));

    try {
      // Initialize repo
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });

      // Create package.json (required for repo name)
      fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'test-ignore' }, null, 2));

      // Create directory structure: app/a.ts and fixtures/x/b.ts, fixtures/x/package.json
      fs.mkdirSync(path.join(tempRepo, 'app'), { recursive: true });
      fs.mkdirSync(path.join(tempRepo, 'fixtures', 'x'), { recursive: true });

      fs.writeFileSync(
        path.join(tempRepo, 'app', 'a.ts'),
        `export function hello() { return 'hello'; }`
      );

      fs.writeFileSync(
        path.join(tempRepo, 'fixtures', 'x', 'package.json'),
        JSON.stringify({ name: 'fixture' }, null, 2)
      );

      fs.writeFileSync(
        path.join(tempRepo, 'fixtures', 'x', 'b.ts'),
        `export function fixture() { return 'fixture'; }`
      );

      // Commit
      execFileSync('git', ['-C', tempRepo, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'initial'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z'
        }
      });

      // Run history WITH ignore config
      const entriesWithIgnore = runHistory({
        repo: tempRepo,
        store: tempStoreWithIgnore,
        max: 1,
        config: { ignore: ['fixtures'] }
      });

      // Run history WITHOUT ignore config
      const entriesWithoutIgnore = runHistory({
        repo: tempRepo,
        store: tempStoreWithoutIgnore,
        max: 1
      });

      // Verify both returned entries
      expect(entriesWithIgnore).toHaveLength(1);
      expect(entriesWithoutIgnore).toHaveLength(1);

      // Load snapshots
      const repoId = toId('test-ignore');
      const manifestWithIgnore = loadManifest(tempStoreWithIgnore, repoId);
      const manifestWithoutIgnore = loadManifest(tempStoreWithoutIgnore, repoId);

      const snapshotWithIgnore = loadFromHistory(tempStoreWithIgnore, repoId, manifestWithIgnore.entries[0]);
      const snapshotWithoutIgnore = loadFromHistory(tempStoreWithoutIgnore, repoId, manifestWithoutIgnore.entries[0]);

      // With ignore: should NOT have fixtures files
      const filesWithIgnore = snapshotWithIgnore.files.map(f => f.file);
      const hasFixturesWithIgnore = filesWithIgnore.some(f => f.startsWith('fixtures/'));
      expect(hasFixturesWithIgnore).toBe(false);

      // Without ignore: should have fixtures files
      const filesWithoutIgnore = snapshotWithoutIgnore.files.map(f => f.file);
      const hasFixturesWithoutIgnore = filesWithoutIgnore.some(f => f.startsWith('fixtures/'));
      expect(hasFixturesWithoutIgnore).toBe(true);

      // With ignore: should still have app/a.ts
      expect(filesWithIgnore).toContain('app/a.ts');

      // Verify file counts differ
      expect(snapshotWithIgnore.stats.files).toBeLessThan(snapshotWithoutIgnore.stats.files);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(tempStoreWithIgnore, { recursive: true, force: true });
      fs.rmSync(tempStoreWithoutIgnore, { recursive: true, force: true });
    }
  });
});
