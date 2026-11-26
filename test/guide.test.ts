import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { guideDir, listTopics, readGuide } from '../src/guide';
import { CLI_JS, runCli as spawnCli } from './helpers/runCli';
import { LANGUAGES } from '../src/languages/registry';

// P14-T42a: the guide module reads the copy in Project/guide/c4.md.

const DOC_GUIDE = path.resolve(__dirname, '../../Document/C4MP-C4-Guide.md');
const COPY_GUIDE = path.resolve(__dirname, '../guide/c4.md');

const SECTION_TITLES = [
  '## 1. What a .c4 plan is and where the files live',
  '## 2. The model: system, container, component',
  '## 3. File layout written by `plan generate`',
  '## 4. Syntax reference',
  '## 5. Claims: how a component points at code',
  '## 6. Layout metadata (do not hand-edit)',
  '## 7. Worked example (sample repo, real output)',
  '## 8. Check rules (all that exist today)',
  '## 9. Edit checklist for agents',
  '## 10. Greenfield plans (no code yet)',
  '## 11. Common mistakes',
  '## 12. Quick reference card',
];

// Drift guard: while the old Document copy exists, the shipped copy must match it.
// It is skipped once the old file is deleted (K decides when).
const docExists = fs.existsSync(DOC_GUIDE);
const driftTest = docExists ? it : it.skip;

const DOC_AI = path.resolve(__dirname, '../../Document/C4MP-AI-Guide.md');
const COPY_AI = path.resolve(__dirname, '../guide/ai.md');

const DOC_BOARD = path.resolve(__dirname, '../../Document/C4MP-Board-Guide.md');
const COPY_BOARD = path.resolve(__dirname, '../guide/board.md');

describe('guide copy drift guard', () => {
  // P16-B39: the Document file is the source of the board guide
  // The Document folder is private: in the public tree these two skip (b963).
  const boardTest = fs.existsSync(DOC_BOARD) ? it : it.skip;
  const aiTest = fs.existsSync(DOC_AI) ? it : it.skip;
  boardTest('Project/guide/board.md equals Document/C4MP-Board-Guide.md', () => {
    expect(fs.readFileSync(COPY_BOARD, 'utf8')).toBe(fs.readFileSync(DOC_BOARD, 'utf8'));
  });

  aiTest('Project/guide/ai.md equals Document/C4MP-AI-Guide.md', () => {
    expect(fs.readFileSync(COPY_AI, 'utf8')).toBe(fs.readFileSync(DOC_AI, 'utf8'));
  });

  driftTest('Project/guide/c4.md equals Document/C4MP-C4-Guide.md', () => {
    expect(fs.readFileSync(COPY_GUIDE, 'utf8')).toBe(fs.readFileSync(DOC_GUIDE, 'utf8'));
  });
});

// b570: the guides type the language list (markdown), so this ties each list to the registry: a new language fails here
// until the guide names it, and the old "only TypeScript/JavaScript and Python" claims stay out.
describe('guide language lists match the language registry', () => {
  const ids = LANGUAGES.ids.join(', ');
  it.each([
    ['ai.md "Not available yet"', COPY_AI, '- **Automatic language detection.**'],
    ['c4.md Q4 (Bun and Python)', COPY_GUIDE, 'Scan both with `--lang typescript,python`'],
  ])('%s lists every language id', (_name, file, marker) => {
    const text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = text.slice(start, text.indexOf('\n\n', start)).replace(/\s*\n\s*/g, ' ');
    expect(paragraph).toContain(ids);
  });
  it('no guide says only TypeScript/JavaScript and Python are parsed', () => {
    for (const file of [COPY_AI, COPY_GUIDE]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toContain('Only TypeScript/JavaScript and Python are scanned');
      expect(text).not.toContain('languages other than TypeScript/JavaScript and Python');
    }
  });
});

describe('guide module', () => {
  it('guideDir() holds c4.md', () => {
    expect(fs.existsSync(path.join(guideDir(), 'c4.md'))).toBe(true);
  });

  it('readGuide("c4") starts with the audience line', () => {
    const text = readGuide('c4');
    expect(text).not.toBeNull();
    expect(text!.startsWith('Written for: AI agents that read or edit c4mp .c4 plan files.')).toBe(true);
  });

  it('readGuide("c4") contains every section title', () => {
    const text = readGuide('c4') ?? '';
    for (const title of SECTION_TITLES) {
      expect(text).toContain(title);
    }
  });

  it('readGuide("ai") starts with the guide title; listTopics() includes ai', () => {
    expect(readGuide('ai')!.startsWith('# c4mp — guide for AI assistants')).toBe(true);
    expect(listTopics().some((t) => t.topic === 'ai')).toBe(true);
  });

  it('readGuide("board") starts with the board guide title; three topics are listed', () => {
    expect(readGuide('board')!.startsWith('# c4mp boards: tasks, features, issues and bugs')).toBe(true);
    expect(listTopics().map((t) => t.topic)).toEqual(['c4', 'ai', 'board']);
  });

  it('readGuide("nope") is null', () => {
    expect(readGuide('nope')).toBeNull();
  });

  it('listTopics() includes c4 with a non-empty summary', () => {
    const topics = listTopics();
    const c4 = topics.find((t) => t.topic === 'c4');
    expect(c4).toBeDefined();
    expect(c4!.summary.length).toBeGreaterThan(0);
  });
});

// P14-T42b-1: the `c4pm guide` command (spawns the CLI from Project/).
const PROJECT = path.resolve(__dirname, '..');
const runCli = (args: string[]) =>
  spawnCli([...args], { cwd: PROJECT, encoding: 'utf8' });

describe('c4pm guide command', () => {
  it('guide c4: exit 0, stdout contains the audience line and section 10', () => {
    const run = runCli(['guide', 'c4']);
    expect(run.status).toBe(0);
    expect(run.stdout.startsWith('Written for: AI agents that read or edit c4mp .c4 plan files.')).toBe(true);
    expect(run.stdout).toContain('## 10. Greenfield plans (no code yet)');
  }, 120000);

  it('guide: exit 0, stdout lists c4', () => {
    const run = runCli(['guide']);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^c4 {2}/m);
  }, 120000);

  it('guide nope: exit 1, stderr lists the topics', () => {
    const run = runCli(['guide', 'nope']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown topic');
    expect(run.stderr).toContain('c4');
  }, 120000);

  it('--help lists guide with its short text', () => {
    const run = runCli(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/guide \[options\] \[topic\]\s+Print a built-in guide/);
  }, 120000);

  it('guide ai piped into a reader that stops early (| head): exit 0, nothing on stderr (b518)', () => {
    // The guide is ~130 KB, more than a pipe buffer, so the CLI is still writing when head exits.
    const cmd = `set -o pipefail; "${process.execPath}" "${CLI_JS}" guide ai | head -c 10 >/dev/null`;
    const run = spawnSync('bash', ['-c', cmd], { cwd: PROJECT, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 120000);
});

// b163, b183: the guides cite code by symbol name, not by line number (line numbers go stale with every edit),
// and each cited symbol still exists in the file it is cited for.
describe('guide code citations', () => {
  const GUIDE_DIR = path.resolve(__dirname, '../guide');
  const read = (name: string) => fs.readFileSync(path.join(GUIDE_DIR, name), 'utf8');
  // [guide, symbol, text after the symbol in the guide, cited file relative to Project/]
  const cited: [string, string, string, string][] = [
    ['ai.md', 'FILE_ONLY_EXTENSIONS', 'in `src/constants.ts`', 'src/constants.ts'],
    ['ai.md', 'fileOnlyExtensionsFor', 'in `src/pipeline.ts`', 'src/pipeline.ts'],
    ['ai.md', 'configShow', 'in `bin/cli.ts`', 'bin/cli.ts'],
    ['ai.md', 'resolvePaths', 'in `src/paths.ts`', 'src/paths.ts'],
    ['ai.md', 'addNamed', 'in `src/languages/typescript/outline.ts`', 'src/languages/typescript/outline.ts'],
    ['ai.md', 'resolveLinks', 'in `src/plan/resolve.ts`', 'src/plan/resolve.ts'],
    ['ai.md', 'generateC4', 'in `src/c4/generate.ts`', 'src/c4/generate.ts'],
    ['ai.md', 'buildIds', 'in `bin/cli.ts`', 'bin/cli.ts'],
    ['ai.md', 'showPlanElement', 'in `src/query/planShow.ts`', 'src/query/planShow.ts'],   // T26-11: moved from bin/cli.ts
    ['ai.md', 'buildRemove', 'in `bin/cli.ts`', 'bin/cli.ts'],
    ['ai.md', 'backfillUids', 'in `src/c4/ids.ts`', 'src/c4/ids.ts'],
    ['ai.md', 'PLANNED_CODE_KINDS', 'in `src/plan/plannedElements.ts`', 'src/plan/plannedElements.ts'],
    ['ai.md', 'extractPlannedCode', 'in `src/plan/plannedElements.ts`', 'src/plan/plannedElements.ts'],
    ['ai.md', 'attachGhostNodes', 'in `src/view/model.ts`', 'src/view/model.ts'],
    ['ai.md', 'attachPlanOnlyNodes', 'in `src/view/model.ts`', 'src/view/model.ts'],
    ['ai.md', 'drawBubble', 'in `viewer/render.js`', 'viewer/render.js'],
    ['ai.md', 'renderNode', 'in `viewer/tree.js`', 'viewer/tree.js'],
    ['ai.md', 'renderHeader', 'in `viewer/panel.js`', 'viewer/panel.js'],
    ['ai.md', 'isClaimModePlan', 'in `src/c4/ownership.ts`', 'src/c4/ownership.ts'],
    ['ai.md', 'writeMergeDiff', 'in `src/scan/commit.ts`', 'src/scan/commit.ts'],   // ARR-DT-4: moved from src/hookRun.ts
    ['ai.md', 'runHook', 'in `src/hookRun.ts`', 'src/hookRun.ts'],
    ['c4.md', 'PLANNED_CODE_KINDS', 'in `Project/src/plan/plannedElements.ts`', 'src/plan/plannedElements.ts'],
    ['c4.md', 'extractPlannedCode', 'in `plannedElements.ts`', 'src/plan/plannedElements.ts'],
    ['c4.md', 'checkPlan', 'in `check.ts`', 'src/c4/check.ts'],
    ['c4.md', 'validateMetadata', 'in `validate.ts`', 'src/c4/validate.ts'],
    ['c4.md', 'extractClaims', 'in `Project/src/c4/ownership.ts`', 'src/c4/ownership.ts'],
    ['c4.md', 'isClaimModePlan', 'in `ownership.ts`', 'src/c4/ownership.ts'],
  ];

  it.each(cited)('%s: %s is cited without a line number and exists in its file', (guide, symbol, where, file) => {
    expect(read(guide)).toContain(`\`${symbol}\` ${where}`);
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(source).toMatch(new RegExp(`\\b(?:function|const|let|var|class|interface|type)\\s+${symbol}\\b`));
  });

  // Example command output, not a citation (c4.md section 13, `c4pm stubs` output; board.md, `board show --with-tests`;
  // ai.md, `plan show` of a c-item with tests).
  const ALLOWED = new Set(['c4.md: src/stub.ts:1', 'board.md: api/test/orders.test.ts:5', 'board.md: web/test/page.test.ts:3',
    'ai.md: api/test/cancel.test.ts:3', 'ai.md: api/test/orders.test.ts:6', 'ai.md: api/test/orders.test.ts:7',
    'ai.md: web/test/page.test.ts:3']);

  it('no guide cites a <file>.ts or <file>.js line number (outside the allow list)', () => {
    const found: string[] = [];
    for (const name of fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'))) {
      for (const m of read(name).matchAll(/[\w./-]+\.(?:ts|js):\d+/g)) {
        if (!ALLOWED.has(`${name}: ${m[0]}`)) found.push(`${name}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });
});

// P15-T8: every command named in a command table of the AI guide exists in `c4pm --help`.
describe('AI guide commands', () => {
  it('each `c4pm <command>` in the guide tables is listed by c4pm --help', () => {
    const guide = fs.readFileSync(path.resolve(__dirname, '../guide/ai.md'), 'utf8');
    const named = new Set<string>();
    const planNamed = new Set<string>();
    for (const line of guide.split('\n')) {
      const m = /^\| `c4mp ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/.exec(line);
      if (!m) continue;
      if (m[1] === 'plan' && m[2]) planNamed.add(m[2]);
      else named.add(m[1]);
    }
    // P18-T17: the plan-editing commands are documented too (b252: under `c4pm plan`)
    for (const c of ['find', 'show', 'outline', 'deps', 'mcp', 'guide', 'check']) {
      expect(named.has(c)).toBe(true);
    }
    for (const c of ['tree', 'unplanned', 'add', 'set', 'link', 'relate', 'upgrade', 'path']) {   // b456: plan upgrade; b469: plan path
      expect(planNamed.has(c)).toBe(true);
    }
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    for (const name of named) {
      expect(help.stdout).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    }
    const planHelp = runCli(['plan', '--help']).stdout;
    for (const name of planNamed) {
      expect(planHelp).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    }
  }, 120000);
});

// P16-B39: every command the board guide names exists (table rows and `$ c4pm ...` run lines).
describe('board guide', () => {
  it('guide: lists three topics; guide board prints the guide', () => {
    const list = runCli(['guide']);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/^board {2}/m);
    expect(list.stdout.trim().split('\n').length).toBe(3);
    const run = runCli(['guide', 'board']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(fs.readFileSync(COPY_BOARD, 'utf8'));
  }, 120000);

  it('each command named in the board guide is listed by --help (board subcommands by board --help)', () => {
    const guide = fs.readFileSync(COPY_BOARD, 'utf8');
    const top = new Set<string>();
    const sub = new Set<string>();     // `board <x>`
    const groupSub = new Set<string>(); // `board group <x>`
    for (const line of guide.split('\n')) {
      const run = /^\$ c4mp ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?(?: ([a-z][a-z0-9-]*))?/.exec(line);
      if (run) {
        top.add(run[1]);
        if (run[1] === 'board' && run[2]) { if (run[2] === 'group' && run[3]) groupSub.add(run[3]); else sub.add(run[2]); }
        continue;
      }
      if (!line.startsWith('| `')) continue;
      for (const m of line.matchAll(/`(tree|board [a-z]+(?: [a-z]+)?)/g)) {
        const words = m[1].split(' ');
        top.add(words[0]);
        if (words[0] !== 'board') continue;
        if (words[1] === 'group') ['add', 'remove', 'order'].forEach((g) => groupSub.add(g)); else sub.add(words[1]);
      }
    }
    for (const s of ['list', 'show', 'tree', 'for', 'add', 'set', 'link', 'unlink', 'remove', 'move']) expect(sub.has(s)).toBe(true);
    const help = runCli(['--help']).stdout;
    for (const name of top) expect(help).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    const boardHelp = runCli(['board', '--help']).stdout;
    for (const name of sub) expect(boardHelp).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    expect(boardHelp).toMatch(/^  group[ ]/m);
    const groupHelp = runCli(['board', 'group', '--help']).stdout;
    for (const name of groupSub) expect(groupHelp).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    expect(groupSub.size).toBe(3);
  }, 180000);
});
