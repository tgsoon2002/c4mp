import * as fs from 'fs';
import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { containerOf, subregionOf, subregionsOf, declaredOrder, planById } from '../src/plan/layers';
import type { Plan, PlanElement } from '../src/types';

// Phase 28 LK-A (b391): helpers that skip the layer between a container and its components.
const A = [
  "model {",
  "  shop = system 'Shop' {",
  "    api = container 'Api' {",
  "      entry = layer 'Entry' {",
  "        cli = component 'Cli'",
  "      }",
  "      engines = layer 'Engines' {",
  "        scan = component 'Scan'",
  "      }",
  "      loose = component 'Loose'",
  "    }",
  "  }",
  "}",
].join('\n');
// Layers added from two more files: 0.c4 sorts before a.c4, b.c4 after it.
const B = ["model {", "  extend shop.api {", "    foundation = layer 'Foundation'", "  }", "}"].join('\n');
const Z = ["model {", "  extend shop.api {", "    top = layer 'Top'", "  }", "}"].join('\n');

const planOf = (texts: Map<string, string>): Plan => parsePlanTexts('/repo', texts);
const get = (p: Plan, id: string): PlanElement => p.elements.find((e) => e.id === id)!;

describe('layers helpers', () => {
  let p: Plan;
  beforeAll(() => { p = planOf(new Map([['a.c4', A], ['b.c4', B], ['0.c4', Z]])); });

  it('subregionsOf: declaration order across files (file index, then line)', () => {
    expect(subregionsOf(p, 'shop.api').map((l) => l.id)).toEqual(['shop.api.top', 'shop.api.entry', 'shop.api.engines', 'shop.api.foundation']);
    expect(subregionsOf(p, 'shop')).toEqual([]);
  });

  it.each([
    ['shop.api.entry.cli', 'shop.api', 'shop.api.entry'],
    ['shop.api.loose', 'shop.api', null],
    ['shop.api.entry', 'shop.api', null],
    ['shop.api', 'shop', null],
    ['shop', null, null],
  ])('%s: containerOf %s, subregionOf %s', (id, container, layer) => {
    expect(containerOf(p, get(p, id))).toBe(container);
    expect(subregionOf(p, get(p, id))?.id ?? null).toBe(layer);
  });

  it('a broken chain through a layer gives null, never a default; a missing direct parent stays unchanged', () => {
    const base = get(p, 'shop.api.entry.cli');
    const mk = (over: Partial<PlanElement>[]): Plan => ({ ...p, elements: over.map((o) => ({ ...base, ...o })) });
    const cycle = mk([{ id: 'x', kind: 'subregion', parent: 'y' }, { id: 'y', kind: 'subregion', parent: 'x' }, { id: 'c', kind: 'component', parent: 'x' }]);
    expect(containerOf(cycle, cycle.elements[2])).toBeNull();
    expect(subregionOf(cycle, cycle.elements[2])?.id).toBe('x');
    const orphan = mk([{ id: 'x', kind: 'subregion', parent: 'gone' }, { id: 'c', kind: 'component', parent: 'x' }]);
    expect(containerOf(orphan, orphan.elements[1])).toBeNull();
    const missing = mk([{ id: 'c', kind: 'component', parent: 'gone' }]);
    expect(containerOf(missing, missing.elements[0])).toBe('gone');
  });

  it('declaredOrder and subregionsOf throw for a file that is not in plan.files', () => {
    const bad: Plan = { ...p, files: ['a.c4'] };
    expect(() => subregionsOf(bad, 'shop.api')).toThrow(/not in plan\.files/);
    expect(() => declaredOrder(bad)(get(bad, 'shop.api.foundation'), get(bad, 'shop.api.entry'))).toThrow(/b\.c4/);
  });

  it('planById follows the elements array', () => {
    const q: Plan = { ...p, elements: [...p.elements] };
    expect(planById(q).has('extra')).toBe(false);
    q.elements.push({ ...get(q, 'shop'), id: 'extra' });
    expect(planById(q).get('extra')?.id).toBe('extra');
  });
});

// A plan without layers: containerOf is el.parent for every element (corpus and fixture plans).
const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'Document', 'plan-standard-corpus');
const c4Files = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.c4')).map((f) => path.join(dir, f));
const textsOf = (files: string[]): Map<string, string> => new Map(files.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')] as const));
// Corpus files are separate models (one plan each); a fixture is one plan of all its files.
const PLANS: [string, Plan][] = [
  // The corpus is in the private Document folder: the public tree has only the fixture plans (b963).
  ...(fs.existsSync(CORPUS) ? ['valid', 'invalid'] : []).flatMap((d) => c4Files(path.join(CORPUS, d)).map((f): [string, Plan] => [path.relative(ROOT, f), planOf(textsOf([f]))])),
  ...['io-shop', 'phofast', 'level4', 'transitive-shared'].map((n): [string, Plan] => [n, planOf(textsOf(c4Files(path.join(__dirname, 'fixtures', n))))]),
].filter(([, pl]) => !pl.elements.some((e) => e.kind === 'subregion'));

describe('containerOf on plans without layers', () => {
  it('finds corpus and fixture plans', () => {
    expect(PLANS.length).toBeGreaterThan(fs.existsSync(CORPUS) ? 20 : 0);
  });
  it.each(PLANS)('%s: el.parent for every element', (_name, pl) => {
    expect(pl.elements.filter((e) => containerOf(pl, e) !== e.parent).map((e) => e.id)).toEqual([]);
  });
});
