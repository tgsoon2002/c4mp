import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { makeRepo, writeSource } from './helpers/planEditHarness';

// b252: the c-item commands live under `c4mp plan`; the old top-level names are hidden aliases that print one
// stderr note and otherwise behave the same. Real CLI (dist/bin/cli.js) on one tmp repo; every case is read-only or a dry run.
const UID_AUTH = '00000000-0000-4000-8000-000000000002';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  `        metadata { uid '${UID_AUTH}' }`,
  '      }',
  "      other = component 'Other'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
let outDir: string;
beforeAll(() => {
  repo = makeRepo('c4mp-plan-group-', { 'a.c4': PLAN });
  writeSource(repo.root, repo.planDir, 'src/auth/login.ts', 'export function login(): void {}\n');
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-plan-group-out-'));
});
afterAll(() => {
  fs.rmSync(repo.root, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

// A dry-run `add` and `ids` print freshly minted uids: compare them with the uids blanked.
const norm = (s: string): string => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uid>');
const run = (args: string[]) => {
  const r = runCli([...args, '--repo', repo.root]);
  return { out: norm(r.stdout), err: r.stderr, code: r.status };
};

// [old name, new name, arguments after the name]
const MAP: [string, string, string[]][] = [
  ['element', 'show', ['auth']],
  ['element', 'show', ['auth', '--json']],
  ['element', 'show', ['nope']],
  ['add', 'add', ['component', 'Billing', '--parent', 'api']],
  ['set', 'set', ['auth', 'status=in-progress', 'owner=K']],
  ['link', 'link', ['auth', 'src/auth/login.ts']],
  ['relate', 'relate', ['auth', 'other']],
  ['remove', 'remove', ['auth']],
  ['tree', 'tree', ['c2', 'api']],
  ['ids', 'ids', []],
  ['unplanned', 'unplanned', []],
  ['resolve-link', 'resolve-link', ['src/auth/login.ts#login']],
  ['apply-layout', 'apply-layout', ['--file', '/nonexistent/layout.json']],
  ['generate-c4', 'generate', ['--out', '__OUT__']],
];

describe('c4mp plan group (b252)', () => {
  it.each(MAP)('old "%s" = "plan %s": same stdout and exit code, one stderr note', (oldName, newName, rest) => {
    const args = rest.map(a => (a === '__OUT__' ? outDir : a));
    const old = run([oldName, ...args]);
    const now = run(['plan', newName, ...args]);
    expect(old.out).toBe(now.out);
    expect(old.code).toBe(now.code);
    expect(old.err).toBe(`note: 'c4mp ${oldName}' is now 'c4mp plan ${newName}'\n${now.err}`);
    expect(now.err).not.toContain('note:');
  });

  it('plan with no subcommand = plan show; the old `plan` needs no note', () => {
    const bare = run(['plan']);
    const show = run(['plan', 'show']);
    expect(bare).toEqual(show);
    expect(bare.code).toBe(0);
    expect(bare.out).toContain('app.api.auth');
    expect(bare.err).toBe('');
  });

  it('plan show <target> finds one element; a bare `plan <target>` does the same', () => {
    expect(run(['plan', 'show', 'auth']).out).toContain('fqn:       app.api.auth');
    expect(run(['plan', 'auth'])).toEqual(run(['plan', 'show', 'auth']));
  });

  it('c4mp --help lists none of the old names; plan --help lists its 18 subcommands', () => {
    const top = runCli(['--help']).stdout;
    for (const old of ['element', 'add', 'set', 'link', 'relate', 'remove', 'tree', 'ids', 'unplanned', 'generate-c4', 'apply-layout', 'resolve-link', 'upgrade', 'path']) {
      expect(top).not.toMatch(new RegExp(`^  ${old}[ ]`, 'm'));
    }
    expect(top).toMatch(/^  plan[ ]/m);
    const help = runCli(['plan', '--help']).stdout;
    const listed = [...help.matchAll(/^  ([a-z][a-z-]*)[ ]/gm)].map(m => m[1]).filter(n => n !== 'help').sort();
    expect(listed).toEqual(['add', 'apply-layout', 'generate', 'ids', 'link', 'move', 'path', 'relate', 'remove', 'rename', 'resolve-link', 'set', 'show', 'tree', 'unlink', 'unplanned', 'upgrade', 'wireframe']);
  });

  it('b469: plan path is new, so it has no hidden top-level alias', () => {
    const r = runCli(['path', 'a', 'b', '--repo', '.']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown command 'path'/);
  });
});
