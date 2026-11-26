import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { loadConfig, initConfig } from '../src/config';
import { installHooks, uninstallHooks } from '../src/hooks';
import { runCli } from './helpers/runCli';

describe('CLI Phase 4 Tests', () => {
  const fixtureDir = path.resolve(__dirname, 'fixtures/sample');
  const phofastDir = path.resolve(__dirname, 'fixtures/phofast');
  const pyshopDir = path.resolve(__dirname, 'fixtures/pyshop');

  describe('config commands', () => {
    it('should initialize config', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-'));
      try {
        const configPath = initConfig(tmpDir);
        expect(fs.existsSync(configPath)).toBe(true);
        const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(content).toEqual({
          languages: ['typescript'],
          ignore: [],
          store: null,
          sprint: null,
          failOn: 'none',
          architectureDir: null,
          viewOnCommit: true,
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw when initializing config twice', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-'));
      try {
        initConfig(tmpDir);
        expect(() => initConfig(tmpDir)).toThrow();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should load default config', () => {
      const config = loadConfig(fixtureDir);
      expect(config.languages).toEqual(['typescript']);
      expect(config.ignore).toEqual([]);
      expect(config.store).toBeNull();
      expect(config.failOn).toBe('none');
    });

    it('should load config from CLI overrides', () => {
      const config = loadConfig(fixtureDir, {
        languages: ['python'],
        ignore: ['test'],
      });
      expect(config.languages).toEqual(['python']);
      expect(config.ignore).toEqual(['test']);
    });
  });

  describe('hooks', () => {
    it('should install and uninstall hooks', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));
      try {
        // Initialize git repo
        execFileSync('git', ['init'], { cwd: tmpDir });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir });

        // Install hooks
        const store = path.join(os.tmpdir(), 'c4pm-store');
        const hookFiles = installHooks(tmpDir, { store });
        expect(hookFiles.length).toBe(2);
        for (const hookFile of hookFiles) {
          expect(fs.existsSync(hookFile)).toBe(true);
        }

        // Uninstall hooks
        const uninstalled = uninstallHooks(tmpDir);
        expect(uninstalled.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('CLI commands', () => {
    it('should show config init usage', () => {
      const result = runCli(['config', 'init', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Write a default .c4mprc.json');
    });

    it('should show config show usage', () => {
      const result = runCli(['config', 'show', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Print the effective settings');
    });

    it('should show status usage', () => {
      const result = runCli(['status', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--repo');
    });

    it('should show watch usage', () => {
      const result = runCli(['watch', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--repo');
    });

    it('should show install-hooks usage', () => {
      const result = runCli(['install-hooks', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--repo');
    });

    it('should show uninstall-hooks usage', () => {
      const result = runCli(['uninstall-hooks', '--help'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--repo');
    });

    it('should check with --fail-on critical and exit 0', () => {
      const result = runCli(['check', '--repo', phofastDir, '--fail-on', 'none'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    });

    it('should diff with --format github', () => {
      const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-'));
      try {
        // Create two test snapshots
        const snap1 = {
          schemaVersion: 1,
          meta: { tool: 'c4pm', repoPath: fixtureDir, repoName: 'test', createdAt: '2024-01-01T00:00:00Z', git: null },
          system: { id: 'test', name: 'Test' },
          containers: [],
          components: [],
          files: [],
          componentEdges: [],
          externals: [],
          stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
        };

        const snap2 = {
          schemaVersion: 1,
          meta: { tool: 'c4pm', repoPath: fixtureDir, repoName: 'test', createdAt: '2024-01-02T00:00:00Z', git: null },
          system: { id: 'test', name: 'Test' },
          containers: [],
          components: [],
          files: [],
          componentEdges: [],
          externals: [],
          stats: { containers: 0, components: 0, files: 0, codeElements: 0, componentEdges: 0, unresolvedImports: 0 },
        };

        const snap1Path = path.join(snapshotDir, 'snap1.json');
        const snap2Path = path.join(snapshotDir, 'snap2.json');

        fs.writeFileSync(snap1Path, JSON.stringify(snap1));
        fs.writeFileSync(snap2Path, JSON.stringify(snap2));

        const result = runCli(['diff', '--a', snap1Path, '--b', snap2Path, '--format', 'github'], {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('### c4mp drift');
      } finally {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
    });

    it('should run status on phofast', () => {
      const result = runCli(['status', '--repo', phofastDir], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
      // Should have 4 lines: Snapshot, History, Plan, Config
      expect(lines.length).toBe(4);

      // Verify Snapshot line has the correct format
      expect(lines[0]).toMatch(/^Snapshot: phofast — \d+ containers/);

      // Verify Plan line has correct findings without sprint (3 critical, 1 warning, 4 info; one info is plan-unmatched)
      expect(lines[2]).toContain('3 critical');
      expect(lines[2]).toContain('1 warning');
      expect(lines[2]).toContain('4 info');

      // Verify Config line
      expect(lines[3]).toContain('languages=typescript');
    });

    it('should run status on phofast with --sprint S15', () => {
      const result = runCli(['status', '--repo', phofastDir, '--sprint', 'S15'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
      // Should have 4 lines: Snapshot, History, Plan, Config
      expect(lines.length).toBe(4);

      // Verify Plan line has correct findings with S15 sprint (3 critical, 2 warning, 4 info; one info is plan-unmatched)
      expect(lines[2]).toContain('3 critical');
      expect(lines[2]).toContain('2 warning');
      expect(lines[2]).toContain('4 info');
    });

    it('should run status on pyshop with python language', () => {
      const result = runCli(['status', '--repo', pyshopDir, '--lang', 'python'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Snapshot:');
    });

    it('should snapshot pyshop with python', () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-'));
      try {
        const result = runCli(['snapshot', '--repo', pyshopDir, '--lang', 'python', '--out', outDir], {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('pyshop');
        expect(result.stdout).toContain('components');
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it('should use package.json name for snapshots command', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-test-'));
      const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-'));
      try {
        // Copy the fixture's contents into the temp dir (GNU `cp -r src/ dst/` would nest it as dst/sample)
        fs.cpSync(fixtureDir, tmpDir, { recursive: true });

        // Initialize git repo
        execFileSync('git', ['init'], { cwd: tmpDir });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir });

        // Make initial commit
        execFileSync('git', ['add', '.'], { cwd: tmpDir });
        execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir });

        // Run history command to create snapshots
        const historyResult = runCli(['history', '--repo', tmpDir, '--max', '1', '--store', tmpStore], {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
        });
        expect(historyResult.status).toBe(0);

        // Run snapshots command with absolute path
        const snapshotsResult = runCli(['snapshots', '--repo', tmpDir, '--store', tmpStore], {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
        });
        expect(snapshotsResult.status).toBe(0);
        expect(snapshotsResult.stdout).toContain('1 snapshots in');
        expect(snapshotsResult.stdout).toContain('sample-shop');

      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(tmpStore, { recursive: true, force: true });
      }
    });
  });
});
