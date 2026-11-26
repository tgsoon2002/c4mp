import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  historyDir,
  entryId,
  saveToHistory,
  loadManifest,
  loadFromHistory,
  resolveRef,
} from '../src/history/store';
import { Snapshot, Manifest } from '../src/types';
import { SPAWN_TIMEOUT_MS } from './helpers/runCli';

describe('store', () => {
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-'));
  });

  afterEach(() => {
    if (fs.existsSync(storeRoot)) {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  describe('historyDir', () => {
    it('returns the correct path', () => {
      const result = historyDir(storeRoot, 'test-repo');
      expect(result).toBe(path.join(storeRoot, 'test-repo', 'history'));
    });
  });

  describe('entryId', () => {
    it('creates ID from git date and commit', () => {
      const snapshot: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test',
          createdAt: '2026-01-05T10:00:00.000Z',
          git: {
            commit: 'aaaaaaa7777777777',
            branch: 'main',
            date: '2026-01-01T10:00:00Z',
            depth: 5,
          },
        },
        system: { id: 'test', name: 'test' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
      };

      const id = entryId(snapshot);
      expect(id).toBe('2026-01-01T100000Z--aaaaaaa');
    });

    it('uses createdAt when git info is missing', () => {
      const snapshot: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test',
          createdAt: '2026-01-03T15:45:30.123Z',
          git: null,
        },
        system: { id: 'test', name: 'test' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
      };

      const id = entryId(snapshot);
      expect(id).toBe('2026-01-03T154530Z--nogit');
    });
  });

  describe('saveToHistory and loadFromHistory', () => {
    it('saves and loads a snapshot', () => {
      const snapshot1: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-02T12:00:00.000Z',
          git: {
            commit: 'bbbbbbb7777777777',
            branch: 'main',
            date: '2026-01-02T10:00:00Z',
            depth: 3,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 1, components: 2, files: 3, codeElements: 5, componentEdges: 1, unresolvedImports: 0 },
      };

      const entry1 = saveToHistory(storeRoot, snapshot1);
      expect(entry1.id).toBe('2026-01-02T100000Z--bbbbbbb');
      expect(entry1.commit).toBe('bbbbbbb7777777777');
      expect(entry1.branch).toBe('main');
      expect(entry1.depth).toBe(3);

      const loaded = loadFromHistory(storeRoot, 'test-app', entry1);
      expect(loaded.meta.repoName).toBe('test-app');
      expect(loaded.stats).toEqual(snapshot1.stats);
    });

    it('creates directories recursively', () => {
      const snapshot: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-02T12:00:00.000Z',
          git: {
            commit: 'aaaaaaa7777777777',
            branch: 'main',
            date: '2026-01-02T10:00:00Z',
            depth: 1,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
      };

      saveToHistory(storeRoot, snapshot);
      const histDirPath = historyDir(storeRoot, 'test-app');
      expect(fs.existsSync(histDirPath)).toBe(true);
    });
  });

  describe('saveToHistory with upsert', () => {
    it('replaces entry with same id', () => {
      const snapshot1: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-02T12:00:00.000Z',
          git: {
            commit: 'aaaaaaa7777777777',
            branch: 'main',
            date: '2026-01-02T10:00:00Z',
            depth: 2,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 1, components: 2, files: 3, codeElements: 5, componentEdges: 1, unresolvedImports: 0 },
      };

      const snapshot2: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-02T15:00:00.000Z',
          git: {
            commit: 'aaaaaaa7777777777',  // Same commit
            branch: 'main',
            date: '2026-01-02T10:00:00Z',
            depth: 2,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 2, components: 3, files: 4, codeElements: 6, componentEdges: 2, unresolvedImports: 0 },
      };

      saveToHistory(storeRoot, snapshot1);
      saveToHistory(storeRoot, snapshot2);

      const manifest = loadManifest(storeRoot, 'test-app');
      // Should still have only 1 entry
      expect(manifest.entries.length).toBe(1);
      // Entry should be updated with new stats
      expect(manifest.entries[0].stats.components).toBe(3);
    });

    it('keeps every snapshot without git taken in the same second: later ones get -2, -3', () => {
      const nogit = (ms: string, files: number): Snapshot => ({
        schemaVersion: 2,
        meta: { tool: 'c4pm@0.1.0', repoPath: '/tmp/repo', repoName: 'test-app', createdAt: `2026-01-02T12:00:00.${ms}Z`, git: null },
        system: { id: 'test-app', name: 'Test App' },
        containers: [], components: [], files: [], componentEdges: [], fileEdges: [], externals: [],
        stats: { containers: 0, components: 0, files, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
      });
      const ids = [nogit('100', 1), nogit('400', 2), nogit('900', 3)].map((s) => saveToHistory(storeRoot, s).id);

      expect(ids).toEqual(['2026-01-02T120000Z--nogit', '2026-01-02T120000Z--nogit-2', '2026-01-02T120000Z--nogit-3']);
      const manifest = loadManifest(storeRoot, 'test-app');
      expect(manifest.entries.map((e) => loadFromHistory(storeRoot, 'test-app', e).stats.files)).toEqual([1, 2, 3]);
      expect(resolveRef(manifest, 'prev').id).toBe(ids[1]);
    });
  });

  describe('loadManifest', () => {
    it('returns empty manifest when no history exists', () => {
      const manifest = loadManifest(storeRoot, 'nonexistent');
      expect(manifest.repoId).toBe('nonexistent');
      expect(manifest.repoName).toBe('');
      expect(manifest.entries).toEqual([]);
    });

    it.each([
      ['bad JSON', '{"entries": [', 'is not valid JSON'],
      ['no entries list', '{"repoId": "x"}', 'has no entries list'],
    ])('throws with the path on a corrupt manifest (%s), never returns an empty one', (_case, text, reason) => {
      const file = path.join(historyDir(storeRoot, 'broken'), 'manifest.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      expect(() => loadManifest(storeRoot, 'broken')).toThrow(file);
      expect(() => loadManifest(storeRoot, 'broken')).toThrow(reason);
    });

    it('throws when the manifest cannot be read (not a missing file)', () => {
      const file = path.join(historyDir(storeRoot, 'dir'), 'manifest.json');
      fs.mkdirSync(file, { recursive: true });   // a folder where the file should be: EISDIR
      expect(() => loadManifest(storeRoot, 'dir')).toThrow(`history manifest ${file} cannot be read`);
    });
  });

  describe('safe writes', () => {
    const commitSnapshot = (commit: string, depth: number): Snapshot => ({
      schemaVersion: 2,
      meta: { tool: 'c4pm@0.1.0', repoPath: '/tmp/repo', repoName: 'test-app', createdAt: '2026-01-02T12:00:00.000Z', git: { commit, branch: 'main', date: `2026-01-02T10:00:0${depth}Z`, depth } },
      system: { id: 'test-app', name: 'Test App' },
      containers: [], components: [], files: [], componentEdges: [], fileEdges: [], externals: [],
      stats: { containers: 0, components: 0, files: depth, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
    });

    it('saveToHistory leaves no temp file and no lock behind', () => {
      saveToHistory(storeRoot, commitSnapshot('a'.repeat(40), 1));
      saveToHistory(storeRoot, commitSnapshot('b'.repeat(40), 2));
      expect(fs.readdirSync(historyDir(storeRoot, 'test-app')).sort()).toEqual([
        '2026-01-02T100001Z--aaaaaaa.json',
        '2026-01-02T100002Z--bbbbbbb.json',
        'manifest.json',
      ]);
    });

    it('a corrupt manifest stops the save instead of being overwritten', () => {
      const file = path.join(historyDir(storeRoot, 'test-app'), 'manifest.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"entries": [');
      expect(() => saveToHistory(storeRoot, commitSnapshot('a'.repeat(40), 1))).toThrow(file);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"entries": [');
    });

    it('two processes saving 5 snapshots each into one store end with 10 entries', async () => {
      const project = path.join(__dirname, '..');
      // each child: ts-node (transpile only) loads the real store and saves 5 commit snapshots, one after another
      const child = (letter: string) => `
        require(${JSON.stringify(path.join(project, 'node_modules', 'ts-node'))}).register({ transpileOnly: true, project: ${JSON.stringify(path.join(project, 'tsconfig.json'))} });
        const { saveToHistory } = require(${JSON.stringify(path.join(project, 'src', 'history', 'store.ts'))});
        for (let i = 1; i <= 5; i++) {
          const commit = '${letter}'.repeat(39) + i;
          saveToHistory(process.argv[1], {
            schemaVersion: 2,
            meta: { tool: 't', repoPath: '/tmp/repo', repoName: 'test-app', createdAt: '2026-01-02T12:00:00.000Z', git: { commit, branch: 'main', date: '2026-01-02T10:00:0' + i + 'Z', depth: i } },
            system: { id: 'test-app', name: 'Test App' },
            containers: [], components: [], files: [], componentEdges: [], fileEdges: [], externals: [],
            stats: { containers: 0, components: 0, files: i, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
          });
        }`;
      const run = (letter: string) =>
        new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ['-e', child(letter), storeRoot], { stdio: ['ignore', 'ignore', 'pipe'] });
          let err = '';
          p.stderr.on('data', (d) => (err += d));
          p.on('error', reject);
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${letter} exited ${code}: ${err}`))));
        });
      await Promise.all([run('a'), run('b')]);

      const manifest = loadManifest(storeRoot, 'test-app');
      expect(manifest.entries).toHaveLength(10);
      expect(new Set(manifest.entries.map((e) => e.commit)).size).toBe(10);
      expect(fs.readdirSync(historyDir(storeRoot, 'test-app')).filter((f) => !f.endsWith('.json'))).toEqual([]);
    }, SPAWN_TIMEOUT_MS);   // under load macOS can hold a new node process at exec (_dyld_start) for 10-40 s
  });

  describe('full workflow with 3 snapshots', () => {
    it('saves 3 synthetic snapshots with correct ordering', () => {
      // Create 3 snapshots with different dates
      const snapshot1: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-03T10:00:00.000Z',  // Latest createdAt, no git
          git: null,
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 7, files: 8, codeElements: 12, componentEdges: 7, unresolvedImports: 1 },
      };

      const snapshot2: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-01T11:00:00.000Z',
          git: {
            commit: 'bbbbbbb2222222222',
            branch: 'main',
            date: '2026-01-02T10:00:00Z',  // Second date
            depth: 2,
          },
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 7, files: 7, codeElements: 11, componentEdges: 6, unresolvedImports: 1 },
      };

      const snapshot3: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-01T10:00:00.000Z',
          git: {
            commit: 'aaaaaaa1111111111',
            branch: 'main',
            date: '2026-01-01T10:00:00Z',  // Earliest date
            depth: 1,
          },
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 6, files: 6, codeElements: 10, componentEdges: 5, unresolvedImports: 0 },
      };

      // Save in mixed order
      const entry1 = saveToHistory(storeRoot, snapshot1);
      const entry2 = saveToHistory(storeRoot, snapshot2);
      const entry3 = saveToHistory(storeRoot, snapshot3);

      const manifest = loadManifest(storeRoot, 'sample-shop');

      // Should have 3 entries sorted by time
      expect(manifest.entries.length).toBe(3);
      expect(manifest.entries[0].id).toBe(entry3.id);  // aaaaaaa at 2026-01-01
      expect(manifest.entries[1].id).toBe(entry2.id);  // bbbbbbb at 2026-01-02
      expect(manifest.entries[2].id).toBe(entry1.id);  // nogit at 2026-01-03

      // Save same commit again - should stay 3 entries
      saveToHistory(storeRoot, snapshot3);
      const manifest2 = loadManifest(storeRoot, 'sample-shop');
      expect(manifest2.entries.length).toBe(3);
    });

    it('sorts entries with same date by depth', () => {
      // Create 2 snapshots with the SAME date but different depths
      // The one with lower depth should come first
      const snapshotDepth4: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-01T10:00:00.000Z',
          git: {
            commit: 'ffff0000',
            branch: 'main',
            date: '2026-01-01T12:00:00Z',  // Same date
            depth: 4,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 1, components: 2, files: 3, codeElements: 5, componentEdges: 1, unresolvedImports: 0 },
      };

      const snapshotDepth5: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'test-app',
          createdAt: '2026-01-01T10:00:00.000Z',
          git: {
            commit: 'aaaa1111',
            branch: 'main',
            date: '2026-01-01T12:00:00Z',  // Same date
            depth: 5,
          },
        },
        system: { id: 'test-app', name: 'Test App' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 1, components: 2, files: 3, codeElements: 5, componentEdges: 1, unresolvedImports: 0 },
      };

      // Save in reverse order (higher depth first)
      const entry5 = saveToHistory(storeRoot, snapshotDepth5);
      const entry4 = saveToHistory(storeRoot, snapshotDepth4);

      const manifest = loadManifest(storeRoot, 'test-app');

      // Should have 2 entries sorted by depth (lower depth first)
      expect(manifest.entries.length).toBe(2);
      expect(manifest.entries[0].depth).toBe(4);  // ffff with depth 4 comes first
      expect(manifest.entries[1].depth).toBe(5);  // aaaa with depth 5 comes second
      expect(manifest.entries[0].id).toBe(entry4.id);
      expect(manifest.entries[1].id).toBe(entry5.id);
    });
  });

  describe('resolveRef', () => {
    let manifest: Manifest;

    beforeEach(() => {
      const snapshot1: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-03T10:00:00.000Z',
          git: null,
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 7, files: 8, codeElements: 12, componentEdges: 7, unresolvedImports: 1 },
      };

      const snapshot2: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-01T11:00:00.000Z',
          git: {
            commit: 'bbbbbbb2222222222',
            branch: 'main',
            date: '2026-01-02T10:00:00Z',
            depth: 2,
          },
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 7, files: 7, codeElements: 11, componentEdges: 6, unresolvedImports: 1 },
      };

      const snapshot3: Snapshot = {
        schemaVersion: 2,
        meta: {
          tool: 'c4pm@0.1.0',
          repoPath: '/tmp/repo',
          repoName: 'sample-shop',
          createdAt: '2026-01-01T10:00:00.000Z',
          git: {
            commit: 'aaaaaaa1111111111',
            branch: 'main',
            date: '2026-01-01T10:00:00Z',
            depth: 1,
          },
        },
        system: { id: 'sample-shop', name: 'Sample Shop' },
        containers: [],
        components: [],
        files: [],
        componentEdges: [],
        fileEdges: [],
        externals: [],
        stats: { containers: 3, components: 6, files: 6, codeElements: 10, componentEdges: 5, unresolvedImports: 0 },
      };

      saveToHistory(storeRoot, snapshot1);
      saveToHistory(storeRoot, snapshot2);
      saveToHistory(storeRoot, snapshot3);
      manifest = loadManifest(storeRoot, 'sample-shop');
    });

    it('resolves "latest"', () => {
      const entry = resolveRef(manifest, 'latest');
      expect(entry.id).toBe('2026-01-03T100000Z--nogit');
    });

    it('resolves "oldest"', () => {
      const entry = resolveRef(manifest, 'oldest');
      expect(entry.id).toBe('2026-01-01T100000Z--aaaaaaa');
    });

    it('resolves "prev"', () => {
      const entry = resolveRef(manifest, 'prev');
      expect(entry.id).toBe('2026-01-02T100000Z--bbbbbbb');
    });

    it('resolves exact id', () => {
      const entry = resolveRef(manifest, '2026-01-02T100000Z--bbbbbbb');
      expect(entry.id).toBe('2026-01-02T100000Z--bbbbbbb');
    });

    it('resolves commit prefix', () => {
      const entry = resolveRef(manifest, 'bbbb');
      expect(entry.id).toBe('2026-01-02T100000Z--bbbbbbb');
    });

    it('resolves date', () => {
      const entry = resolveRef(manifest, '2026-01-02');
      expect(entry.id).toBe('2026-01-02T100000Z--bbbbbbb');
    });

    it('resolves date that falls between snapshots', () => {
      const entry = resolveRef(manifest, '2026-01-02');
      expect(entry.id).toBe('2026-01-02T100000Z--bbbbbbb');
    });

    it('throws on ambiguous commit prefix', () => {
      expect(() => {
        resolveRef(manifest, 'aa');  // Too short, might match multiple
      }).toThrow();
    });

    it('throws on prev with < 2 entries', () => {
      const singleEntryManifest: Manifest = {
        repoId: 'test',
        repoName: 'test',
        entries: manifest.entries.slice(0, 1),
      };
      expect(() => {
        resolveRef(singleEntryManifest, 'prev');
      }).toThrow('Cannot resolve \'prev\'');
    });

    it('throws on unknown ref', () => {
      expect(() => {
        resolveRef(manifest, 'unknown-ref-123');
      }).toThrow('Unknown snapshot ref');
    });
  });
});
