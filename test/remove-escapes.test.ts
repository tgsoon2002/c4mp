import * as fs from 'fs';
import { runPlanCli, makeRepo } from './helpers/planEditHarness';
import { parseC4 } from '../src/plan/parser';
import { planRemoval } from '../src/c4/removeElement';

// P18-T20: the remove scanner honours backslash escapes in quoted strings like the c4 lexer: `add` then `remove`
// of an element whose title/description holds `\'`, `\\`, `//`, braces or unicode gives back the same bytes.
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
beforeEach(() => { repo = makeRepo('c4pm-rmesc-', { 'a.c4': PLAN }); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const TITLES = [
  "it's // not a comment",
  'back\\slash // x',
  'ends with backslash\\',
  'braces { } } { // x',
  "it's { // }",
  'unicode ünï ✓ // é',
  'say "hi" // x',
];

describe('remove scanner: escapes in quoted strings', () => {
  it.each(TITLES)('add then remove round-trips to identical bytes: %s', async title => {
    const r = await runPlanCli(['plan', 'add', 'component', 'Tmp', '--parent', 'api', '--title', title, '--description', `d: ${title}`, '--yes', '--repo', repo.root]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const added = fs.readFileSync(repo.files['a.c4'], 'utf-8');
    expect(added).not.toBe(PLAN);

    const parsed = parseC4(added, 'a.c4');
    expect(parsed.elements.find(e => e.id === 'app.api.Tmp')!.title).toBe(title);
    const plan = { files: ['a.c4'], elements: parsed.elements, relations: parsed.relations, issues: parsed.issues };
    const removal = planRemoval(new Map([['a.c4', added]]), plan, 'app.api.Tmp');
    if (!removal.ok || removal.blocked) throw new Error(`expected a removal: ${JSON.stringify(removal)}`);
    expect(removal.files[0].newText).toBe(PLAN);
  });
});
