import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, initConfig, DEFAULT_CONFIG } from '../src/config';
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from '../src/constants';
import { runCli } from './helpers/runCli';

describe('config', () => {
  let tempDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(__dirname, 'config-test-'));
    process.env = { ...originalEnv };
    delete process.env.C4PM_LANGUAGES;
    delete process.env.C4PM_IGNORE;
    delete process.env.C4PM_STORE;
    delete process.env.C4PM_SPRINT;
    delete process.env.C4PM_FAIL_ON;
    delete process.env.C4PM_ARCHITECTURE_DIR;
    delete process.env.C4PM_VIEW_ON_COMMIT;
    delete process.env.C4PM_FILE_ONLY;
    delete process.env.C4PM_TESTS;
    delete process.env.C4PM_LAYERS_SKIP;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  describe('DEFAULT_CONFIG', () => {
    it('has correct default values', () => {
      expect(DEFAULT_CONFIG).toEqual({
        languages: ['typescript'],
        ignore: [],
        store: null,
        sprint: null,
        failOn: 'none',
        architectureDir: null,
        viewOnCommit: true,
      });
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no config exists', () => {
      const config = loadConfig(tempDir);
      expect(config).toEqual(DEFAULT_CONFIG);
      // Ensure it's a fresh object, not the same reference
      expect(config).not.toBe(DEFAULT_CONFIG);
    });

    it('loads config from file', () => {
      const fileConfig = {
        languages: ['python'],
        ignore: ['test/fixtures'],
        store: '/tmp/store',
        sprint: 'S15',
        failOn: 'critical' as const,
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      const config = loadConfig(tempDir);
      expect(config).toEqual({ ...fileConfig, architectureDir: null, viewOnCommit: true });
    });

    it('Phase 35 B2: .c4mprc.json is read first; the legacy .c4pmrc.json only when the new file is absent', () => {
      fs.writeFileSync(path.join(tempDir, LEGACY_CONFIG_FILE), JSON.stringify({ sprint: 'old' }));
      expect(loadConfig(tempDir).sprint).toBe('old');
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify({ sprint: 'new' }));
      expect(loadConfig(tempDir).sprint).toBe('new');
    });

    it('env vars beat file config', () => {
      const fileConfig = {
        languages: ['python'],
        ignore: ['test'],
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      process.env.C4PM_LANGUAGES = 'typescript,python';
      process.env.C4PM_IGNORE = 'node_modules';

      const config = loadConfig(tempDir);
      expect(config.languages).toEqual(['typescript', 'python']);
      expect(config.ignore).toEqual(['node_modules']);
    });

    it('CLI config beats env vars and file', () => {
      const fileConfig = {
        languages: ['python'],
        ignore: ['test'],
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      process.env.C4PM_LANGUAGES = 'typescript,python';
      process.env.C4PM_IGNORE = 'node_modules';

      const config = loadConfig(tempDir, {
        languages: ['python'],
        ignore: ['dist'],
      });
      expect(config.languages).toEqual(['python']);
      expect(config.ignore).toEqual(['dist']);
    });

    it('loads architectureDir from file', () => {
      const fileConfig = {
        architectureDir: 'Documents/C4',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      const config = loadConfig(tempDir);
      expect(config.architectureDir).toBe('Documents/C4');
    });

    it('env architectureDir beats file config', () => {
      const fileConfig = {
        architectureDir: 'Documents/C4',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      process.env.C4PM_ARCHITECTURE_DIR = 'Docs/C4';

      const config = loadConfig(tempDir);
      expect(config.architectureDir).toBe('Docs/C4');
    });

    it('CLI architectureDir beats env and file', () => {
      const fileConfig = {
        architectureDir: 'Documents/C4',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      process.env.C4PM_ARCHITECTURE_DIR = 'Docs/C4';

      const config = loadConfig(tempDir, { architectureDir: 'cli/C4' });
      expect(config.architectureDir).toBe('cli/C4');
    });

    it('normalizes ignore paths: strips leading ./ and trailing /', () => {
      const config = loadConfig(tempDir, {
        ignore: ['./test/fixtures/', 'src/', './app'],
      });
      expect(config.ignore).toEqual(['test/fixtures', 'src', 'app']);
    });

    it('normalizes ignore paths from env', () => {
      process.env.C4PM_IGNORE = './test/fixtures/, ./src/, app/';

      const config = loadConfig(tempDir);
      expect(config.ignore).toEqual(['test/fixtures', 'src', 'app']);
    });

    it('normalizes ignore paths from file', () => {
      const fileConfig = {
        ignore: ['./test/fixtures/', './src/', 'app/'],
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      const config = loadConfig(tempDir);
      expect(config.ignore).toEqual(['test/fixtures', 'src', 'app']);
    });

    it('throws on unknown language in file', () => {
      const fileConfig = {
        languages: ['typescript', 'go'],
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      expect(() => loadConfig(tempDir)).toThrow(/.c4mprc.json.*unknown language "go"/);
    });

    it('throws on unknown language in env', () => {
      process.env.C4PM_LANGUAGES = 'typescript,fortran';

      expect(() => loadConfig(tempDir)).toThrow(/env.*unknown language "fortran"/);
    });

    it('throws on unknown language in CLI', () => {
      expect(() => loadConfig(tempDir, { languages: ['typescript', 'java'] })).toThrow(
        /cli.*unknown language "java"/,
      );
    });

    it('throws on non-array languages in file', () => {
      const fileConfig = {
        languages: 'typescript',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      expect(() => loadConfig(tempDir)).toThrow(/.c4mprc.json.*languages must be an array/);
    });

    it('throws on non-array ignore in file', () => {
      const fileConfig = {
        ignore: 'test',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      expect(() => loadConfig(tempDir)).toThrow(/.c4mprc.json.*ignore must be an array/);
    });

    it('loads fileOnlyExtensions from file; env C4PM_FILE_ONLY beats it; unset leaves the key absent', () => {
      expect('fileOnlyExtensions' in loadConfig(tempDir)).toBe(false);
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify({ fileOnlyExtensions: ['.java'] }));
      expect(loadConfig(tempDir).fileOnlyExtensions).toEqual(['.java']);
      process.env.C4PM_FILE_ONLY = '.go,.cs';
      expect(loadConfig(tempDir).fileOnlyExtensions).toEqual(['.go', '.cs']);
    });

    it('throws on invalid fileOnlyExtensions in file', () => {
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify({ fileOnlyExtensions: ['java'] }));
      expect(() => loadConfig(tempDir)).toThrow(/fileOnlyExtensions/);
    });

    it('throws on invalid failOn in file', () => {
      const fileConfig = {
        failOn: 'error',
      };
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(fileConfig));

      expect(() => loadConfig(tempDir)).toThrow(
        /.c4mprc.json.*failOn must be 'critical', 'warning', or 'none'/,
      );
    });

    it('throws on invalid failOn in env', () => {
      process.env.C4PM_FAIL_ON = 'fatal';

      expect(() => loadConfig(tempDir)).toThrow(/env.*failOn must be 'critical', 'warning', or 'none'/);
    });

    it('throws on invalid JSON in file with path included', () => {
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), '{ invalid json }');

      expect(() => loadConfig(tempDir)).toThrow(new RegExp(`.c4mprc.json`));
    });

    it('handles empty env vars gracefully', () => {
      process.env.C4PM_LANGUAGES = '';
      process.env.C4PM_IGNORE = '';

      const config = loadConfig(tempDir);
      expect(config.languages).toEqual(['typescript']); // defaults
      expect(config.ignore).toEqual([]);
    });

    it('handles comma-separated env vars with spaces', () => {
      process.env.C4PM_LANGUAGES = ' typescript , python ';

      const config = loadConfig(tempDir);
      expect(config.languages).toEqual(['typescript', 'python']);
    });

    it('handles comma-separated env vars with empty entries', () => {
      process.env.C4PM_LANGUAGES = 'typescript,,python,';

      const config = loadConfig(tempDir);
      expect(config.languages).toEqual(['typescript', 'python']);
    });

    it('returns a fresh object every time', () => {
      const config1 = loadConfig(tempDir);
      const config2 = loadConfig(tempDir);

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });
  });

  describe('viewOnCommit and config.json (P12-T8)', () => {
    const newPath = () => path.join(tempDir, '.c4pm', 'config.json');
    const writeNew = (obj: unknown) => {
      fs.mkdirSync(path.join(tempDir, '.c4pm'), { recursive: true });
      fs.writeFileSync(newPath(), typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const writeLegacy = (obj: unknown) =>
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(obj));

    it('viewOnCommit defaults to true', () => {
      expect(loadConfig(tempDir).viewOnCommit).toBe(true);
    });

    it('reads viewOnCommit=false from new file', () => {
      writeNew({ viewOnCommit: false });
      expect(loadConfig(tempDir, undefined, { configPath: newPath() }).viewOnCommit).toBe(false);
    });

    it('reads viewOnCommit=false from legacy file', () => {
      writeLegacy({ viewOnCommit: false });
      expect(loadConfig(tempDir).viewOnCommit).toBe(false);
      expect(loadConfig(tempDir, undefined, { configPath: newPath() }).viewOnCommit).toBe(false);
    });

    it('new file beats legacy for the same key', () => {
      writeLegacy({ sprint: 'OLD', viewOnCommit: false });
      writeNew({ sprint: 'NEW' });
      const config = loadConfig(tempDir, undefined, { configPath: newPath() });
      expect(config.sprint).toBe('NEW');
      expect(config.viewOnCommit).toBe(false); // legacy-only key still read
    });

    it('legacy-only key is read when new file lacks it', () => {
      writeLegacy({ store: '/legacy/store' });
      writeNew({ sprint: 'S1' });
      const config = loadConfig(tempDir, undefined, { configPath: newPath() });
      expect(config.store).toBe('/legacy/store');
      expect(config.sprint).toBe('S1');
    });

    it('env C4PM_VIEW_ON_COMMIT overrides file; accepts 0/1/true/false; cli beats env', () => {
      writeNew({ viewOnCommit: true });
      process.env.C4PM_VIEW_ON_COMMIT = 'false';
      expect(loadConfig(tempDir, undefined, { configPath: newPath() }).viewOnCommit).toBe(false);
      process.env.C4PM_VIEW_ON_COMMIT = '0';
      expect(loadConfig(tempDir).viewOnCommit).toBe(false);
      process.env.C4PM_VIEW_ON_COMMIT = '1';
      expect(loadConfig(tempDir).viewOnCommit).toBe(true);
      expect(loadConfig(tempDir, { viewOnCommit: false }).viewOnCommit).toBe(false);
    });

    it('bad env value throws naming the variable', () => {
      process.env.C4PM_VIEW_ON_COMMIT = 'maybe';
      expect(() => loadConfig(tempDir)).toThrow(/C4PM_VIEW_ON_COMMIT/);
    });

    it('non-boolean viewOnCommit in file throws naming the file', () => {
      writeNew({ viewOnCommit: 'yes' });
      expect(() => loadConfig(tempDir, undefined, { configPath: newPath() })).toThrow(
        /config\.json.*viewOnCommit must be a boolean/,
      );
      fs.rmSync(path.join(tempDir, '.c4pm'), { recursive: true, force: true });
      writeLegacy({ viewOnCommit: 1 });
      expect(() => loadConfig(tempDir)).toThrow(/.c4mprc.json.*viewOnCommit must be a boolean/);
    });

    it('invalid JSON in new file names its path', () => {
      writeNew('{ nope }');
      expect(() => loadConfig(tempDir, undefined, { configPath: newPath() })).toThrow(newPath());
    });

    it('configPath given but file missing falls back to legacy silently', () => {
      writeLegacy({ sprint: 'S9' });
      const config = loadConfig(tempDir, undefined, { configPath: newPath() });
      expect(config.sprint).toBe('S9');
    });

    it('omitting opts ignores .c4pm/config.json', () => {
      writeNew({ sprint: 'NEW' });
      expect(loadConfig(tempDir).sprint).toBeNull();
    });
  });

  describe('tests key (Phase 26 T26-1)', () => {
    const FILE_TESTS = { globs: ['spec/'], ignoreReach: ['src/log.ts'], command: 'npx jest {file} -t "{nameRegex}"' };
    const writeFile = (tests: unknown) => fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify({ tests }));

    it('is absent by default (the matcher uses its default globs)', () => {
      expect('tests' in loadConfig(tempDir)).toBe(false);
    });

    it.each([
      ['file only', undefined, undefined, FILE_TESTS],
      ['env sets globs, keeps file ignoreReach and command', 'a/**, b/', undefined, { ...FILE_TESTS, globs: ['a/**', 'b/'] }],
      ['cli beats env', 'a/**', { globs: ['c/'] }, { ...FILE_TESTS, globs: ['c/'] }],
    ])('%s', (_label, env, cli, expected) => {
      writeFile(FILE_TESTS);
      if (env) process.env.C4PM_TESTS = env;
      expect(loadConfig(tempDir, cli ? { tests: cli } : undefined).tests).toEqual(expected);
    });

    it.each([
      [['**/*.test.ts'], /tests must be an object/],
      [{ globs: '**/*.test.ts' }, /tests\.globs must be an array of non-empty strings/],
      [{ ignoreReach: ['src/log.ts', ''] }, /tests\.ignoreReach must be an array of non-empty strings/],
      [{ command: '' }, /tests\.command must be a non-empty string/],
      [{ command: 'pytest {path}' }, /tests\.command has unknown placeholder \{path\} \(valid: \{file\}, \{name\}, \{nameRegex\}\)/],
      [{ noTests: 'yes' }, /tests\.noTests must be true or false/],
      [{ glob: ['x'] }, /tests: unknown key "glob" \(valid: globs, ignoreReach, command, noTests\)/],
    ])('rejects tests %j naming the file', (tests, message) => {
      writeFile(tests);
      expect(() => loadConfig(tempDir)).toThrow(new RegExp(`c4mprc\\.json: ${message.source}`));
    });

    it.each([
      ['flag --tests', ['--tests', 'spec/,**/*_check.ts'], {}],
      ['env C4PM_TESTS', [], { C4PM_TESTS: 'spec/,**/*_check.ts' }],
    ])('config show takes tests.globs from %s', (_label, args, env) => {
      // outside the repo: no anchor above it, so no project config.json is read
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-tests-cli-'));
      try {
        const r = runCli(['config', 'show', '--repo', repo, ...args], { env: { ...process.env, ...env } });
        expect(r.stderr).toBe('');
        expect(JSON.parse(r.stdout).tests).toEqual({ globs: ['spec/', '**/*_check.ts'] });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('layers key (b466)', () => {
    const writeFile = (layers: unknown) => fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify({ layers }));

    it('is absent by default (layer-skip off)', () => {
      expect('layers' in loadConfig(tempDir)).toBe(false);
    });

    it.each([
      ['file only', undefined, undefined, { skip: true }],
      ['env C4PM_LAYERS_SKIP beats file (0)', '0', undefined, { skip: false }],
      ['env accepts true', 'true', undefined, { skip: true }],
      ['cli beats env', 'false', { skip: true }, { skip: true }],
    ])('%s', (_label, env, cli, expected) => {
      writeFile({ skip: true });
      if (env) process.env.C4PM_LAYERS_SKIP = env;
      expect(loadConfig(tempDir, cli ? { layers: cli } : undefined).layers).toEqual(expected);
    });

    it('env C4PM_LAYERS_SKIP rejects other words', () => {
      process.env.C4PM_LAYERS_SKIP = 'maybe';
      expect(() => loadConfig(tempDir)).toThrow(/env: C4PM_LAYERS_SKIP must be 'true', 'false', '1' or '0', got "maybe"/);
    });

    it.each([
      [true, /layers must be an object with keys skip/],
      [{ skip: 'yes' }, /layers\.skip must be true or false/],
      [{ x: true }, /layers: unknown key "x" \(valid: skip\)/],
    ])('rejects layers %j naming the file', (layers, message) => {
      writeFile(layers);
      expect(() => loadConfig(tempDir)).toThrow(new RegExp(`c4mprc\\.json: ${message.source}`));
    });
  });

  describe('initConfig', () => {
    it('writes config file with DEFAULT_CONFIG', () => {
      const filePath = initConfig(tempDir);

      expect(filePath).toBe(path.join(tempDir, CONFIG_FILE));
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(DEFAULT_CONFIG);
    });

    it('writes pretty JSON with trailing newline', () => {
      const filePath = initConfig(tempDir);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('\n');
      expect(content.endsWith('\n')).toBe(true);
      expect(content).toContain('  '); // indentation
    });

    it('throws if config file already exists', () => {
      initConfig(tempDir);

      expect(() => initConfig(tempDir)).toThrow(
        new RegExp(`Config file already exists at.*${CONFIG_FILE}`),
      );
    });

    it('returns the correct file path', () => {
      const filePath = initConfig(tempDir);
      expect(filePath).toBe(path.join(tempDir, CONFIG_FILE));
    });
  });
});
