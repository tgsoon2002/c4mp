import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { makeRepo } from './helpers/planEditHarness';
import { STANDARD_STEPS, PLAN_STANDARD_VERSION, canonicalKind, canonicalRule, canonicalWith, oldKindWords } from '../src/plan/renames';
import type { StandardStep } from '../src/plan/renames';
import { parsePlanTexts } from '../src/plan/parser';
import { upgradePlanText } from '../src/c4/planUpgrade';
import { applyAcks } from '../src/findings';
import type { AckEntry } from '../src/findings';
import { loadQueryContext } from '../src/query/context';
import { getModel } from '../src/query/elements';
import type { PlanFinding } from '../src/types';

// b456 (SR1): the plan kind `layer` is now `subregion`. Readers accept both words, writers write `subregion`, and
// `c4pm plan upgrade` rewrites the old words of a plan.

const FIXTURES = path.join(__dirname, 'fixtures');
const DOC = path.join(__dirname, '..', '..', 'Document');

/** A temp copy of a fixture folder. */
function copyFixture(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sr1-${name}-`)));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** `c4pm plan upgrade` on `repo`; JSON parsed when --json is given. */
const upgrade = (repo: string, ...extra: string[]) => runCli(['plan', 'upgrade', '--repo', repo, ...extra]);

describe('renames table', () => {
  it('canonicalKind / canonicalRule map the old words, keep the current and unknown ones', () => {
    expect(canonicalKind('layer')).toBe('subregion');
    expect(canonicalKind('subregion')).toBe('subregion');
    expect(canonicalKind('component')).toBe('component');
    expect(canonicalKind('constructor')).toBe('constructor');   // an Object.prototype key is not a rename
    expect(canonicalRule('layer-misplaced')).toBe('subregion-misplaced');
    expect(canonicalRule('subregion-misplaced')).toBe('subregion-misplaced');
    expect(canonicalRule('missing-code')).toBe('missing-code');
    expect(oldKindWords()).toEqual(['layer']);
    expect(STANDARD_STEPS[STANDARD_STEPS.length - 1].version).toBe(PLAN_STANDARD_VERSION);
  });

  it('a chain of steps goes straight to the newest word (a -> b -> c)', () => {
    const steps: StandardStep[] = [{ version: '1', kinds: { a: 'b' } }, { version: '2', kinds: { b: 'c' } }];
    expect(['a', 'b', 'c', 'd'].map((w) => canonicalWith(steps, (s) => s.kinds, w))).toEqual(['c', 'c', 'c', 'd']);
  });

  it('PLAN_STANDARD_VERSION is the version on line 3 of Document/PLAN-STANDARD.md', () => {
    // Private repo: ../Document/PLAN-STANDARD.md; the public tree has it at docs/PLAN-STANDARD.md (b963).
    const std = [path.join(DOC, 'PLAN-STANDARD.md'), path.join(__dirname, '..', 'docs', 'PLAN-STANDARD.md')].find((p) => fs.existsSync(p))!;
    const line3 = fs.readFileSync(std, 'utf8').split('\n')[2];
    expect(line3).toMatch(new RegExp(`^Version ${PLAN_STANDARD_VERSION.replace('.', '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`));
  });
});

describe('the parser reads both words as subregion', () => {
  const plan = (word: string) => [
    'specification {', `  element ${word}`, '}',
    'model {', "  s = system 'S' {", "    c = container 'C' {", `      x = ${word} 'X' {`, "        k = component 'K'", '      }', '    }', '  }', '}', '',
  ].join('\n');

  it.each(['layer', 'subregion'])('%s', (word) => {
    const p = parsePlanTexts('/r', new Map([['plan.c4', plan(word)]]));
    expect(p.issues).toEqual([]);
    expect(p.elements.find((e) => e.id === 's.c.x')?.kind).toBe('subregion');
    expect(p.elements.find((e) => e.id === 's.c.x.k')?.parent).toBe('s.c.x');
  });

  // The corpus lives in the private Document folder: it skips in the public tree (b963).
  (fs.existsSync(path.join(DOC, 'plan-standard-corpus')) ? it : it.skip)('the corpus pair 15-layers / 18-subregions parses to the same elements and relations (source file aside)', () => {
    const read = (f: string) => {
      const p = parsePlanTexts('/r', new Map([['plan.c4', fs.readFileSync(path.join(DOC, 'plan-standard-corpus', 'valid', f), 'utf8')]]));
      return { issues: p.issues, elements: p.elements, relations: p.relations };
    };
    expect(read('18-subregions.c4')).toEqual(read('15-layers.c4'));
  });
});

describe('upgradePlanText', () => {
  it('rewrites kind positions only: not an id, a string, a comment or a metadata value', () => {
    const text = [
      '// a layer comment: x = layer',
      'specification {',
      '  element layer',
      '  element component',
      '}',
      'model {',
      "  s = system 'S' {",
      "    c = container 'C' {",
      "      top = layer 'Top' 'layer of the top' {",
      "        metadata { note 'layer' }",
      "        layer = component 'Layer'",
      '      }',
      "      mid = subregion 'Mid'",
      '      /* x = layer */',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const r = upgradePlanText(text);
    expect(r.changes).toEqual([
      { line: 3, from: 'layer', to: 'subregion', what: 'specification' },
      { line: 9, from: 'layer', to: 'subregion', what: 'kind' },
    ]);
    expect(r.text).toBe(text.replace('  element layer\n', '  element subregion\n').replace("top = layer 'Top'", "top = subregion 'Top'"));
    expect(upgradePlanText(r.text)).toEqual({ text: r.text, changes: [] });   // idempotent
  });

  it('keeps tabs and CRLF line ends byte for byte', () => {
    const text = "model {\r\n\ts = system 'S' {\r\n\t\tc = container 'C' {\r\n\t\t\tx =\tlayer 'X'\r\n\t\t}\r\n\t}\r\n}\r\n";
    const r = upgradePlanText(text);
    expect(r.text).toBe(text.replace('=\tlayer', '=\tsubregion'));
    expect(r.changes).toEqual([{ line: 4, from: 'layer', to: 'subregion', what: 'kind' }]);
  });

  it('`element` outside a specification block is not a kind position', () => {
    const text = "model {\n  element = system 'E'\n}\n";
    expect(upgradePlanText(text).changes).toEqual([]);
  });
});

describe('acks: the old rule id still hides the finding', () => {
  const finding: PlanFinding = { severity: 'warning', rule: 'subregion-misplaced', id: 'shop.entry', message: 'Entry: a subregion goes directly in a container, not in a system' };
  const ack = (a: Partial<AckEntry>): AckEntry => ({ rule: 'layer-misplaced', reason: 'on purpose', added: '2026-11-12', ...a });
  it.each([
    ['by id', ack({ id: 'shop.entry' })],
    ['by glob', ack({ glob: 'shop.*' })],
    ['with the new id', ack({ rule: 'subregion-misplaced', id: 'shop.entry' })],
  ])('%s', (_name, a) => {
    expect(applyAcks([finding], [a])).toEqual({ kept: [], acknowledged: [finding], stale: [] });
  });
});

describe('same map, same check: layers-claim written with layer, and after plan upgrade --yes', () => {
  let A = '';
  let B = '';
  beforeAll(() => {
    A = copyFixture('layers-claim');
    B = copyFixture('layers-claim');
    const r = upgrade(B, '--yes', '--force');
    expect(r.status).toBe(0);
  });

  it('B now says subregion where A says layer, nothing else changed', () => {
    const a = fs.readFileSync(path.join(A, 'c4', 'plan.c4'), 'utf8');
    const b = fs.readFileSync(path.join(B, 'c4', 'plan.c4'), 'utf8');
    expect(a).toMatch(/= layer '/);
    expect(b).not.toMatch(/= layer '|element layer/);
    expect(b).toBe(a.replace(/= layer '/g, "= subregion '").replace('element layer\n', 'element subregion\n'));
  });

  it('check --format json is the same', () => {
    const check = (repo: string) => {
      const r = runCli(['check', '--repo', repo, '--format', 'json']);
      return JSON.parse(r.stdout.split(repo).join('<repo>'));
    };
    expect(check(B)).toEqual(check(A));
  });

  it('the view model is the same (the kind word in the copied plan text aside)', () => {
    const model = (repo: string) => JSON.stringify(getModel(loadQueryContext(repo))).split(repo).join('<repo>')
      .replace(/= layer '/g, "= subregion '");
    expect(model(B)).toBe(model(A));
  });

  it('plan show of the subregion is the same', () => {
    const show = (repo: string) => runCli(['plan', 'show', 'shop.api.logic', '--repo', repo, '--json']).stdout.split(repo).join('<repo>')
      .replace(/= layer '/g, "= subregion '");
    const a = show(A);
    expect(JSON.parse(a)).toMatchObject({ id: 'shop.api.logic', kind: 'subregion' });
    expect(show(B)).toBe(a);
  });
});

describe('c4pm plan upgrade', () => {
  const PLAN = [
    'specification {',
    '  element layer',
    '}',
    'model {',
    "  shop = system 'Shop' {",
    "    api = container 'Api' {",
    '      // the layer of entry points',
    "      entry = layer 'Entry' 'layer of the entry points' {",
    "        cli = component 'Cli'",
    '      }',
    "      core = subregion 'Core' {",
    "        layer = component 'Layer helpers'",
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('dry run prints the diff and writes nothing; --yes rewrites the kind words only; a second run is "nothing to upgrade"', () => {
    const repo = makeRepo('sr1-up-', { 'plan.c4': PLAN });
    const dry = upgrade(repo.root);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('-      entry = layer \'Entry\'');
    expect(dry.stdout).toContain('+      entry = subregion \'Entry\'');
    expect(dry.stdout).toContain('dry run: nothing written');
    expect(fs.readFileSync(repo.files['plan.c4'], 'utf8')).toBe(PLAN);

    const yes = upgrade(repo.root, '--yes');
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain('written:');
    const after = fs.readFileSync(repo.files['plan.c4'], 'utf8');
    expect(after).toBe(PLAN.replace('  element layer\n', '  element subregion\n').replace("entry = layer 'Entry'", "entry = subregion 'Entry'"));
    const changed = PLAN.split('\n').filter((l, i) => l !== after.split('\n')[i]);
    expect(changed).toEqual(['  element layer', "      entry = layer 'Entry' 'layer of the entry points' {"]);

    const again = upgrade(repo.root, '--json');
    expect(again.status).toBe(0);
    const j = JSON.parse(again.stdout);
    expect(j).toMatchObject({ ok: true, command: 'upgrade', dryRun: true, written: false, files: [], error: null });
    expect(j.notes).toEqual(expect.arrayContaining([expect.stringContaining('nothing to upgrade')]));
  });

  it('--json shape of a dry run with changes', () => {
    const repo = makeRepo('sr1-json-', { 'plan.c4': PLAN });
    const r = upgrade(repo.root, '--json');
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, command: 'upgrade', dryRun: true, written: false, target: null, error: null, findings: { new: [], fixed: [] } });
    expect(j.files).toHaveLength(1);
    expect(j.files[0].file).toMatch(/plan\.c4$/);
    expect(j.notes).toEqual([expect.stringContaining('2 old plan words in 1 file (layer -> subregion x2)')]);
  });

  it('a plan outside .c4pm/ needs --force; nothing written without it', () => {
    const repo = copyFixture('layers-claim');
    const file = path.join(repo, 'c4', 'plan.c4');
    const before = fs.readFileSync(file, 'utf8');
    const r = upgrade(repo, '--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('outside-c4pm');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('no .c4 files: the message of the other plan commands', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr1-empty-')));
    fs.mkdirSync(path.join(dir, '.git'));
    const r = upgrade(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan');
  });

  it('is a plan command only: no hidden top-level `c4pm upgrade`', () => {
    expect(runCli(['plan', '--help']).stdout).toMatch(/^\s+upgrade\b/m);
    expect(runCli(['upgrade', '--repo', '.']).status).not.toBe(0);
  });
});
