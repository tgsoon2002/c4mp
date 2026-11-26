import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { tryResolveProject } from '../src/outputs';
import { boardFileFor } from '../src/board/load';
import { toId } from '../src/names';
import { CLI_JS } from './helpers/runCli';

// P16-B9: `c4pm check` runs the board rules through boardForView (the same function the page uses).
// Real CLI via ts-node, like the other cli-*.test.ts files.

const projectRoot = path.resolve(__dirname, '..');

function check(repo: string, extra: string[] = []) {
  return spawnSync(process.execPath, [CLI_JS, 'check', '--repo', repo, ...extra], { cwd: projectRoot, encoding: 'utf8' });
}

/** A tiny repo with a valid plan (no findings of its own) and an anchor (.c4pm) so a board file can live in it. */
function buildRepo(board?: unknown | string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-b9-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.c4pm'));
  fs.writeFileSync(path.join(repo, 'src', 'architecture.c4'), `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node' }
  }
}
`);
  if (board !== undefined) {
    const file = boardFileFor(tryResolveProject(repo)!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof board === 'string' ? board : JSON.stringify(board));
  }
  return repo;
}

const item = (over: Record<string, unknown>) => ({ id: 'b1', title: 'T', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });
const boardOf = (items: unknown[]) => ({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items }] });

describe('c4pm check: board rules (P16-B9)', () => {
  const repos: string[] = [];
  afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });
  const make = (board?: unknown | string) => { const r = buildRepo(board); repos.push(r); return r; };

  it('a dead link is reported, and --fail-on warning turns it into exit 1', () => {
    const repo = make(boardOf([item({ links: ['00000000-0000-4000-8000-000000000000'] })]));
    const r = check(repo);
    expect(r.stdout).toContain('board-dead-link');
    expect(r.status).toBe(0);                                  // default fail-on is critical: a warning does not fail
    expect(check(repo, ['--fail-on', 'warning']).status).toBe(1);
  });

  it('a broken board file surfaces as a board-parse warning', () => {
    const r = check(make('{ not json'));
    expect(r.stdout).toContain('board-parse');
    expect(r.stdout).toContain('board.json');
  });

  it('--min-severity warning hides the info-level board rules; --format json stays an array of findings', () => {
    const repo = make(boardOf([item({ links: ['x'], due: '2000-01-01' })]));   // board-overdue is info
    expect(check(repo).stdout).toContain('board-overdue');
    const quiet = check(repo, ['--min-severity', 'warning', '--format', 'json']);
    const parsed = JSON.parse(quiet.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((f: { rule: string }) => f.rule)).toContain('board-dead-link');
    expect(parsed.map((f: { rule: string }) => f.rule)).not.toContain('board-overdue');
  });

  it('a repo without a board file prints exactly what it printed before (no board lines, same exit)', () => {
    const a = make();
    const b = make(boardOf([item({})]));
    const noBoard = check(a);
    const cleanBoard = check(b);
    expect(noBoard.stdout).not.toMatch(/board-/);
    // the header shows the temp folder name and the project id (the sole project folder, F2): normalise both, everything else must match byte for byte
    const norm = (out: string, repo: string) =>
      out.split(path.basename(repo)).join('<repo>').split(toId(path.basename(repo))).join('<repo>');
    expect(norm(cleanBoard.stdout, b)).toBe(norm(noBoard.stdout, a));
    expect(cleanBoard.status).toBe(noBoard.status);
  });
});
