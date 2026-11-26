import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';

const TREE: Record<string, string> = {
  'app/pom.xml': '<project/>',
  'app/src/main/java/com/acme/App.java': 'class App {}\n',
  'app/src/main/java/com/acme/Util.java': 'a\nb\nc\n',
  'lib/pom.xml': '<project/>',
  'lib/src/main/java/com/acme/Lib.java': 'class Lib {}\n',
  'web/package.json': '{"name":"web"}',
  'web/src/index.ts': 'export function hi() {}\n',
};

describe('pipeline file-only files', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-fileonly-'));
    fs.mkdirSync(path.join(repo, '.git'));
    for (const [rel, text] of Object.entries(TREE)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    }
  });

  it('prints the default ignores of a selected language, and nothing without one', () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
    try {
      runSnapshot({ repo, write: false, config: { languages: ['typescript', 'csharp', 'cpp'] } });
      expect(lines).toContain('  default ignores for csharp: bin, obj');
      expect(lines).toContain('  default ignores for cpp: cmake-build-*');
      lines.length = 0;
      runSnapshot({ repo, write: false, config: { languages: ['typescript'] } });
      expect(lines.some((l) => l.includes('default ignores'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('files OFF lists only the parsed language', () => {
    const snap = runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript'] } });
    expect(snap.files.map((f) => f.file)).toEqual(['web/src/index.ts']);
  });

  it('files ON lists java files as file-only outlines', () => {
    const snap = runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript', 'files'] } });
    expect(snap.files).toHaveLength(4);
    const java = snap.files.filter((f) => f.file.endsWith('.java'));
    expect(java).toHaveLength(3);
    for (const f of java) {
      expect(f.fileOnly).toBe(true);
      expect(f.elements).toEqual([]);
    }
    expect(java.map((f) => f.lineCount).sort()).toEqual([1, 1, 3]);
    expect(snap.stats.codeElements).toBe(1);
  });

  it('fileOnlyExtensions override replaces the default list', () => {
    const snap = runSnapshot({
      repo,
      write: false,
      quiet: true,
      config: { languages: ['typescript', 'files'], fileOnlyExtensions: ['.go'] },
    });
    expect(snap.files.filter((f) => f.file.endsWith('.java'))).toHaveLength(0);
  });

  it('imports.json has no entry for file-only files', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-fileonly-out-'));
    runSnapshot({ repo, out, quiet: true, config: { languages: ['typescript', 'files'] } });
    const imports = JSON.parse(fs.readFileSync(path.join(out, 'imports.json'), 'utf8')) as { file: string }[];
    expect(imports.some((i) => i.file.endsWith('.java'))).toBe(false);
  });
});
