import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { resolveLinks } from '../src/plan/resolve';
import { checkPlan } from '../src/c4/check';
import type { Plan, PlanElement } from '../src/types';

// A planned/done `type` item (type alias, interface, enum) linking src/types.ts#Name, or a Python file.
describe('type links resolve (b22)', () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-typelink-'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(
      path.join(repo, 'src', 'types.ts'),
      'export type Handler = () => void;\nexport interface Shape { w: number }\nexport enum Color { Red, Blue }\n'
    );
    fs.writeFileSync(path.join(repo, 'src', 'model.py'), 'class Foo:\n    pass\n');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  const typeItem = (name: string, file: string, status: string): PlanElement => ({
    id: `app.${name}`,
    kind: 'type',
    title: name,
    description: null,
    technology: null,
    links: [{ raw: `../${file}#${name}`, path: file, name, lines: null, title: null }],
    metadata: { status },
    parent: null,
    source: { file: 'test.c4', line: 1 },
  });
  const planOf = (elements: PlanElement[]): Plan => ({ files: [], elements, relations: [], issues: [] });
  const snapshot = () => runSnapshot({ repo, write: false, quiet: true });
  const rules = (plan: Plan, id: string) => checkPlan(plan, snapshot(), repo).filter(f => f.id === id).map(f => f.rule);

  it.each([['Handler', 'type alias'], ['Shape', 'interface'], ['Color', 'enum']])(
    '%s (%s): existing resolves and is built-update-status, missing is not-built',
    (name) => {
      const plan = planOf([typeItem(name, 'src/types.ts', 'planned'), typeItem(`Missing${name}`, 'src/types.ts', 'planned')]);
      const resolved = resolveLinks(plan, repo, snapshot().files);
      expect(resolved.find(r => r.elementId === `app.${name}`)).toMatchObject({ target: 'function', found: true });
      expect(resolved.find(r => r.elementId === `app.Missing${name}`)).toMatchObject({ found: false });
      expect(rules(plan, `app.${name}`)).toEqual(['planned-built-update-status']);
      expect(rules(plan, `app.Missing${name}`)).toEqual(['planned-not-built']);
    }
  );

  it('done type missing from a TypeScript file gets broken-function; into a Python file it does not', () => {
    const plan = planOf([typeItem('Gone', 'src/types.ts', 'done'), typeItem('Foo', 'src/model.py', 'done')]);
    expect(rules(plan, 'app.Gone')).toContain('broken-function');
    expect(rules(plan, 'app.Foo')).not.toContain('broken-function');
  });

  it('done type missing from a Rust file gets broken-function: the language says its outline lists types (b510)', () => {
    fs.writeFileSync(path.join(repo, 'src', 'lib.rs'), 'pub enum Color { Red }\n');
    const plan = planOf([typeItem('Color', 'src/lib.rs', 'done'), typeItem('Gone', 'src/lib.rs', 'done')]);
    const snap = runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript', 'rust'] } });
    const rulesOf = (id: string) => checkPlan(plan, snap, repo).filter(f => f.id === id).map(f => f.rule);
    expect(rulesOf('app.Color')).not.toContain('broken-function');
    expect(rulesOf('app.Gone')).toContain('broken-function');
  });
});
