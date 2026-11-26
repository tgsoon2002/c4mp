import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runSnapshot } from '../src/pipeline';
import { CLI_JS } from './helpers/runCli';

const projectRoot = path.join(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'java-tiny');

const JAVA_FILES = [
  'app/src/main/java/com/acme/App.java',
  'app/src/main/java/com/acme/Util.java',
  'lib/src/main/java/com/acme/Lib.java',
];

describe('T31 java-tiny file-only end to end', () => {
  it('files ON: 4 files, 3 file-only java files, containers app lib web', () => {
    const snap = runSnapshot({
      repo: fixtureRoot,
      write: false,
      quiet: true,
      config: { languages: ['typescript', 'files'] },
    });

    expect(snap.files.map((f) => f.file).sort()).toEqual([...JAVA_FILES, 'web/src/index.ts'].sort());
    expect(snap.files.filter((f) => f.fileOnly).map((f) => f.file).sort()).toEqual([...JAVA_FILES].sort());
    expect(snap.containers.map((c) => c.id).sort()).toEqual(['app', 'lib', 'web']);
    expect(snap.components.map((c) => c.id).sort()).toEqual(['app/main', 'lib/main', 'web/_root']);

    for (const file of JAVA_FILES) {
      const folder = file.split('/')[0];
      const owner = snap.components.find((c) => c.files.includes(file));
      expect(owner?.containerId).toBe(folder);
    }

    for (const f of snap.files.filter((x) => x.fileOnly)) {
      expect(f.elements).toEqual([]);
    }
    expect(snap.files.find((f) => f.file === 'web/src/index.ts')?.elements.length).toBe(1);
  });

  it('files OFF: only the typescript file is listed', () => {
    const snap = runSnapshot({
      repo: fixtureRoot,
      write: false,
      quiet: true,
      config: { languages: ['typescript'] },
    });
    expect(snap.files.map((f) => f.file)).toEqual(['web/src/index.ts']);
  });

  it('CLI view with --lang typescript,files writes a page that names the java file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-t31-'));
    const copy = path.join(tmp, 'repo');
    fs.cpSync(fixtureRoot, copy, { recursive: true });
    const out = path.join(tmp, 'p.html');

    execFileSync(
      process.execPath,
      [CLI_JS, 'view', '--repo', copy, '--lang', 'typescript,files', '--out', out],
      { cwd: projectRoot, timeout: 60000, stdio: 'pipe' },
    );

    expect(fs.readFileSync(out, 'utf8')).toContain('app/src/main/java/com/acme/App.java');
  }, 60000);
});
