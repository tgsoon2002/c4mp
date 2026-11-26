import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from './helpers/runCli';

// P14-T18b: every scan command reads `languages` and `ignore` from .c4pm/config.json (Q11), and a
// CLI flag still wins over the file. One temp repo, one ts-node spawn per command. Each command
// is observed through a different output:
//   snapshot -> files[] in the written snapshot.json      status -> "N files" in the summary line
//   check    -> unplanned-code finding for b.py            stubs  -> the stub in b.py
//   view     -> a file node with id "b.py" in the page

const PROJECT = path.resolve(__dirname, '..');
const created: string[] = [];

function makeRepo(config: object): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-scancfg-'));
  created.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.c4pm'));
  fs.writeFileSync(path.join(repo, '.c4pm', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'b.py'), 'def todo():\n    pass\n');
  fs.mkdirSync(path.join(repo, 'skipme'));
  fs.writeFileSync(path.join(repo, 'skipme', 'c.ts'), 'export const c = 3;\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(
    path.join(repo, 'src', 'architecture.c4'),
    `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node' }
  }
}
`,
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'feature.c4'),
    `model {
  extend app.api {
    tsjob = component 'Ts Job' {
      technology 'TypeScript'
      link ../a.ts 'Entrypoint'
      metadata {
        status 'done'
        owner 'K'
      }
    }
  }
}
`,
  );
  return repo;
}

function c4pm(args: string[]) {
  const r = runCli([...args], { cwd: PROJECT, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}

function snapshotFiles(repo: string, extra: string[]): string[] {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-scancfg-out-'));
  created.push(outDir);
  const r = c4pm(['snapshot', '--repo', repo, '--out', outDir, ...extra]);
  expect(r.status).toBe(0);
  const snap = JSON.parse(fs.readFileSync(path.join(outDir, 'snapshot.json'), 'utf8'));
  return snap.files.map((f: { file: string }) => f.file).sort();
}

function statusFileCount(repo: string, extra: string[]): number {
  const r = c4pm(['status', '--repo', repo, ...extra]);
  expect(r.status).toBe(0);
  const m = r.stdout.match(/(\d+) files/);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

function viewHasPyNode(repo: string, extra: string[]): boolean {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-scancfg-view-')), 'v.html');
  created.push(path.dirname(outFile));
  const r = c4pm(['view', '--repo', repo, '--out', outFile, ...extra]);
  expect(r.status).toBe(0);
  return fs.readFileSync(outFile, 'utf8').includes('"id":"b.py","kind":"file"');
}

describe('scan commands honour .c4pm/config.json (languages, ignore)', () => {
  let repo: string; // languages typescript+python, ignore skipme
  let noIgnoreRepo: string; // languages typescript+python, no ignore

  beforeAll(() => {
    repo = makeRepo({ languages: ['typescript', 'python'], ignore: ['skipme'] });
    noIgnoreRepo = makeRepo({ languages: ['typescript', 'python'] });
  });

  afterAll(() => {
    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
  });

  it('snapshot: config languages include b.py; --lang typescript drops it', () => {
    expect(snapshotFiles(repo, [])).toEqual(['a.ts', 'b.py']);
    expect(snapshotFiles(repo, ['--lang', 'typescript'])).toEqual(['a.ts']);
  }, 120000);

  it('snapshot: the same repo without "ignore" in its config sees skipme/c.ts (so ignore hid it above)', () => {
    expect(snapshotFiles(noIgnoreRepo, [])).toEqual(['a.ts', 'b.py', 'skipme/c.ts']);
  }, 120000);

  it('status: file count differs with --lang typescript', () => {
    expect(statusFileCount(repo, [])).toBe(2);
    expect(statusFileCount(repo, ['--lang', 'typescript'])).toBe(1);
  }, 120000);

  it('check: b.py is unplanned only when python is scanned', () => {
    expect(c4pm(['check', '--repo', repo]).out).toContain('unplanned-code  b.py');
    expect(c4pm(['check', '--repo', repo, '--lang', 'typescript']).out).not.toContain('b.py');
  }, 120000);

  it('stubs: the python stub is listed only when python is scanned', () => {
    expect(c4pm(['stubs', '--repo', repo]).stdout).toContain('1 stubs');
    expect(c4pm(['stubs', '--repo', repo, '--lang', 'typescript']).stdout).toContain('0 stubs');
  }, 120000);

  it('view: b.py file node only when python is scanned', () => {
    expect(viewHasPyNode(repo, [])).toBe(true);
    expect(viewHasPyNode(repo, ['--lang', 'typescript'])).toBe(false);
  }, 120000);
});
