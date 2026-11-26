import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from './helpers/runCli';
import { LANGUAGES } from '../src/languages/registry';

const PROJECT = path.resolve(__dirname, '..');

// One ts-node process loads bin/cli.ts with Command.parse stubbed out, then renders the help of
// every non-hidden command in-process. Keeps this file to two spawns in total.
const COLLECT_SCRIPT = `
const { Command } = require('commander');
let program;
Command.prototype.parse = function () { program = this; return this; };
require(${JSON.stringify(path.join(PROJECT, 'bin', 'cli.ts'))});
const out = [];
function walk(cmd, prefix) {
  let text = '';
  cmd.configureOutput({ writeOut: (s) => { text += s; }, writeErr: () => {}, getOutHelpWidth: () => 80 });
  cmd.outputHelp();
  out.push({
    name: prefix,
    text,
    options: cmd.options.map((o) => ({ flags: o.flags, description: o.description, mandatory: o.mandatory })),
    subcommands: cmd.commands.length,
  });
  for (const c of cmd.commands) if (!c._hidden) walk(c, (prefix ? prefix + ' ' : '') + c.name());
}
for (const c of program.commands) if (!c._hidden) walk(c, c.name());
process.stdout.write('@@JSON@@' + JSON.stringify(out));
`;

interface Collected {
  name: string;
  text: string;
  options: { flags: string; description: string; mandatory: boolean }[];
  subcommands: number;
}

const WITH_EXAMPLES = [
  'view',
  'serve',
  'diff',
  'check',
  'snapshot',
  'history',
  'plan resolve-link',
  'plan apply-layout',
  'init',
  'install-hooks',
  'plan generate',
  'guide',
  'plan ids',
  'plan show',
  'plan remove',
  'plan wireframe',
];

describe('c4mp --help is the documentation', () => {
  let top: string;
  let all: Collected[];

  beforeAll(() => {
    const topRun = runCli(['--help'], { cwd: PROJECT, encoding: 'utf8' });
    expect(topRun.status).toBe(0);
    top = topRun.stdout;

    const run = spawnSync('npx', ['ts-node', '-T', '-e', COLLECT_SCRIPT], { cwd: PROJECT, encoding: 'utf8' });
    expect(run.status).toBe(0);
    all = JSON.parse(run.stdout.split('@@JSON@@')[1]);
  }, 200000);

  it('top-level help has the description, quick start, glossary, config and exit codes', () => {
    expect(top).toContain('Architecture-first project tool: zoomable C4 map, task boards, simulations');
    // b570: the language list comes from the registry, so a new language shows up here without a help edit.
    expect(top).toContain(`Languages (--lang): ${LANGUAGES.ids.join(', ')}.`);
    expect(top).not.toContain('Python code: add --lang typescript,python');
    expect(top).toContain('Quick start');
    expect(top).toContain('c4mp install-hooks --repo .');
    for (const term of ['.c4mp/', 'C4MP/', '.c4 files', 'snapshot', 'drift', 'anchor', 'repoId', 'ref', 'c4mpView.html']) {
      expect(top).toContain(term);
    }
    expect(top).toContain('viewOnCommit');
    expect(top).toContain('Exit codes');
    expect(top).toContain('--fail-on');
    expect(top).toContain('Run c4mp <command> --help for details and examples.');
  });

  it('fits an 80-column terminal', () => {
    const long = top.split('\n').filter(l => l.length > 80);
    expect(long).toEqual([]);
  });

  it('every command lists --repo as optional, with the default text (except diff and hook)', () => {
    const withRepo = all.filter(c => c.options.some(o => o.flags.startsWith('--repo')) && c.name !== 'diff' && c.name !== 'hook');
    expect(withRepo.length).toBeGreaterThan(10);
    for (const c of withRepo) {
      const repo = c.options.find(o => o.flags.startsWith('--repo'))!;
      expect(repo.mandatory).toBe(false);
      expect(repo.description).not.toContain('(required)');
      expect(c.text.replace(/\s+/g, ' ')).toContain('(default: the folder that holds .c4mp, found from the working folder)');
    }
    // diff takes --repo only for history-based comparison
    const diff = all.find(c => c.name === 'diff')!;
    expect(diff.options.find(o => o.flags.startsWith('--repo'))!.mandatory).toBe(false);
  });

  it('no option has an empty description or a doubled default', () => {
    for (const c of all) {
      for (const o of c.options) {
        expect({ cmd: c.name, flags: o.flags, empty: o.description.trim().length === 0 }).toEqual({
          cmd: c.name,
          flags: o.flags,
          empty: false,
        });
      }
      expect(c.text).not.toMatch(/\(default: [^)]*\)\s*\(default: /);
      // description text must not repeat the default that commander already prints
      for (const o of c.options) {
        expect(o.description).not.toMatch(/\(default: (20|"20"|prev|latest|text|info|2000)\)/);
      }
    }
  });

  it('the listed commands carry examples and valid language ids', () => {
    for (const name of WITH_EXAMPLES) {
      const c = all.find(x => x.name === name);
      expect(c).toBeDefined();
      expect(c!.text).toContain('Examples:');
      expect(c!.text).toContain(`c4mp ${name}`);
    }
    const snapshot = all.find(c => c.name === 'snapshot')!;
    expect(snapshot.text).toContain('typescript, python');
  });
});
