import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildSkill, extractMarked, removeLegacySkill, SKILL_POINTER, writeSkillFile } from '../src/guideSkill';
import { readGuide } from '../src/guide';
import { runCli as spawnCli } from './helpers/runCli';

// P15-T8b: `c4pm guide ai --skill` makes SKILL.md / an AGENTS.md snippet from the marked parts of the AI guide.

const PROJECT = path.resolve(__dirname, '..');
const runCli = (args: string[]) =>
  spawnCli([...args], { cwd: PROJECT, encoding: 'utf8' });

const guide = readGuide('ai')!;
let tmp: string;
beforeAll(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-skill-'))); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('buildSkill', () => {
  it('SKILL.md: valid frontmatter, description and rules come from the guide markers', () => {
    const text = buildSkill(guide);
    const m = /^---\nname: c4mp\ndescription: (".*")\n---\n\n([\s\S]*)$/.exec(text);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toBe(extractMarked(guide, 'description').replace(/\s+/g, ' '));
    expect(JSON.parse(m![1])).toMatch(/\.c4mp/);
    expect(JSON.parse(m![1])).toMatch(/b-items/);
    const rules = extractMarked(guide, 'rules');
    expect(rules.split('\n').filter((l) => /^\d+\. /.test(l)).length).toBeGreaterThanOrEqual(8);
    expect(rules.split('\n').filter((l) => /^\d+\. /.test(l)).length).toBeLessThanOrEqual(10);
    expect(m![2]).toBe(`${rules}\n\n${SKILL_POINTER}\n`);
  });

  it('agents format: same rules, no frontmatter, ends with the pointer', () => {
    const text = buildSkill(guide, 'agents');
    expect(text.startsWith('## c4mp\n\n')).toBe(true);
    expect(SKILL_POINTER).toBe('For everything else run `c4mp guide ai`.');
    expect(text).not.toContain('---');
    expect(text).toContain(extractMarked(guide, 'rules'));
    expect(text.endsWith(`${SKILL_POINTER}\n`)).toBe(true);
  });

  it('contains only text of the markers plus the pointer (and the fixed frame lines)', () => {
    const allowed = new Set<string>([
      ...extractMarked(guide, 'rules').split('\n'),
      ...extractMarked(guide, 'description').split('\n').map((l) => l.trim()),
      SKILL_POINTER, '', '---', 'name: c4mp', '## c4mp',
    ]);
    for (const format of ['skill', 'agents'] as const) {
      for (const line of buildSkill(guide, format).split('\n')) {
        if (line.startsWith('description: ')) continue;   // checked in the first test
        expect(allowed.has(line)).toBe(true);
      }
    }
  });

  it('a guide without the markers, or with a half pair, is refused', () => {
    expect(() => buildSkill('# no markers')).toThrow(/skill:description/);
    expect(() => buildSkill('<!-- skill:description -->x')).toThrow(/without/);
    expect(() => extractMarked('<!-- skill:rules -->a<!-- /skill:rules --><!-- skill:rules -->b<!-- /skill:rules -->', 'rules')).toThrow(/exactly one/);
  });

  it('a colon or quote in the description cannot break the frontmatter', () => {
    const g = '<!-- skill:description -->Use it: when "x"<!-- /skill:description --><!-- skill:rules -->1. r<!-- /skill:rules -->';
    const m = /description: (".*")\n/.exec(buildSkill(g));
    expect(JSON.parse(m![1])).toBe('Use it: when "x"');
  });
});

describe('writeSkillFile', () => {
  it('creates parent folders, reports unchanged for equal content, refuses a different file without force', () => {
    const file = path.join(tmp, 'a', 'b', 'SKILL.md');
    expect(writeSkillFile(file, 'one\n')).toEqual({ path: file, status: 'written' });
    expect(fs.readFileSync(file, 'utf8')).toBe('one\n');
    expect(writeSkillFile(file, 'one\n').status).toBe('unchanged');
    expect(() => writeSkillFile(file, 'two\n')).toThrow(/--force/);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\n');
    expect(writeSkillFile(file, 'two\n', true).status).toBe('written');
    expect(fs.readFileSync(file, 'utf8')).toBe('two\n');
  });

  it('refuses a folder as the target', () => {
    expect(() => writeSkillFile(tmp, 'x')).toThrow(/folder/);
  });
});

describe('c4pm guide ai --skill (CLI)', () => {
  it('prints SKILL.md; every command it names exists in c4pm --help', () => {
    const run = runCli(['guide', 'ai', '--skill']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(buildSkill(guide));
    const help = runCli(['--help']).stdout;
    const named = new Set<string>();
    for (const m of run.stdout.matchAll(/`c4mp ([a-z][a-z0-9-]*)/g)) named.add(m[1]);
    // bare command words in backticks inside the rules
    for (const m of run.stdout.matchAll(/`(find|outline|show|check|stubs)\b/g)) named.add(m[1]);
    for (const c of ['board', 'guide', 'find', 'check']) expect(named.has(c)).toBe(true);
    for (const name of named) expect(help).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
    // `c4pm plan <x>`: every x is listed by plan --help
    const planHelp = runCli(['plan', '--help']).stdout;
    const planSubs = [...run.stdout.matchAll(/`(?:c4mp )?plan ([a-z][a-z0-9-]*)/g)].map(m => m[1]);
    expect(planSubs.length).toBeGreaterThan(0);
    for (const name of planSubs) expect(planHelp).toMatch(new RegExp(`^  ${name}[ ]`, 'm'));
  }, 180000);

  it('--format agents prints the snippet; --out writes, prints where, refuses a different file, --force overwrites', () => {
    expect(runCli(['guide', 'ai', '--skill', '--format', 'agents']).stdout).toBe(buildSkill(guide, 'agents'));
    const out = path.join(tmp, 'deep', 'dir', 'SKILL.md');
    const first = runCli(['guide', 'ai', '--skill', '--out', out]);
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(`wrote ${out}`);
    expect(fs.readFileSync(out, 'utf8')).toBe(buildSkill(guide));
    expect(runCli(['guide', 'ai', '--skill', '--out', out]).stdout).toContain('unchanged');
    fs.writeFileSync(out, 'mine\n');
    const refused = runCli(['guide', 'ai', '--skill', '--out', out]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(fs.readFileSync(out, 'utf8')).toBe('mine\n');
    expect(runCli(['guide', 'ai', '--skill', '--out', out, '--force']).status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(buildSkill(guide));
  }, 180000);

  it('--out <skills>/c4mp/SKILL.md replaces an old c4pm skill folder next to it (temp skills folder only)', () => {
    const skills = path.join(tmp, 'skills');
    const oldFile = path.join(skills, 'c4pm', 'SKILL.md');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, '---\nname: c4pm\ndescription: "old"\n---\n\nold rules\n');
    const out = path.join(skills, 'c4mp', 'SKILL.md');
    const run = runCli(['guide', 'ai', '--skill', '--out', out]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`removed the old c4pm skill ${oldFile}`);
    expect(fs.existsSync(path.join(skills, 'c4pm'))).toBe(false);   // the folder goes too: only one skill is left
    expect(fs.readFileSync(out, 'utf8')).toBe(buildSkill(guide));
  }, 180000);

  it('removeLegacySkill touches only our own old skill, only beside a c4mp/SKILL.md target', () => {
    const skills = path.join(tmp, 'skills2');
    const oldDir = path.join(skills, 'c4pm');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'SKILL.md'), '---\nname: c4pm\n---\n');
    fs.writeFileSync(path.join(oldDir, 'extra.txt'), 'mine');
    expect(removeLegacySkill(path.join(skills, 'other', 'SKILL.md'))).toBeNull();      // not a c4mp folder
    expect(removeLegacySkill(path.join(skills, 'c4mp', 'notes.md'))).toBeNull();       // not SKILL.md
    expect(fs.existsSync(path.join(oldDir, 'SKILL.md'))).toBe(true);
    expect(removeLegacySkill(path.join(skills, 'c4mp', 'SKILL.md'))).toBe(path.join(oldDir, 'SKILL.md'));
    expect(fs.existsSync(path.join(oldDir, 'extra.txt'))).toBe(true);                  // other files stay, so does the folder
    fs.writeFileSync(path.join(oldDir, 'SKILL.md'), '---\nname: somebody-else\n---\n');
    expect(removeLegacySkill(path.join(skills, 'c4mp', 'SKILL.md'))).toBeNull();       // not ours
  });

  it('wrong use is an error: other topic, bad format, --out without --skill', () => {
    for (const args of [['guide', 'c4', '--skill'], ['guide', 'ai', '--skill', '--format', 'x'], ['guide', 'ai', '--out', path.join(tmp, 'z.md')]]) {
      const run = runCli(args);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('error:');
    }
    expect(fs.existsSync(path.join(tmp, 'z.md'))).toBe(false);
  }, 180000);
});
