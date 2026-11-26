import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { parsePlan } from '../src/plan/parser';
import { runPlanCli, makeRepo } from './helpers/planEditHarness';
import { KIND_TABLE, ENTRY_KINDS, PART_KINDS, addRuleOf, addableKinds, parentKindsOf, owningEntry, isElementKind, isFrontendKind, isStorageKind, levelOf, needsCode, isArchBox, isMapActor, viewOfKind, kindsOfView } from '../src/plan/kinds';
import { buildKindWords } from '../src/view/kindWords';

// P20-T1: the one kind table; plan/element/tree/ids/remove find and treat screen, flow, journey, ..., person, external.
const PLAN = [
  'model {',
  "  shop = system 'Shop' {",
  "    web = container 'Web' {",
  "      signin = screen 'Sign in' {",
  "        form = region 'Form' {",
  "          submit = control 'Submit'",
  '        }',
  "        failed = state 'Failed'",
  '      }',
  "      login = flow 'Login flow'",
  '    }',
  '  }',
  "  buyer = person 'Buyer'",
  "  mail = external 'Mail service'",
  "  trip = journey 'Buy something'",
  "  shop.web.signin -> shop.web.login 'starts'",
  '}',
  '',
].join('\n');

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-kinds-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'c4'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'kinds' }));
  fs.writeFileSync(path.join(repo, 'c4', 'arch.c4'), PLAN);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const cli = (...args: string[]) => runCli([...args, '--repo', repo]);

describe('kind table', () => {
  it('levels and families', () => {
    expect(['system', 'container', 'component', 'screen', 'function'].map(levelOf)).toEqual(['c1', 'c2', 'c3', null, null]);
    expect(isElementKind('screen') && isElementKind('person') && !isElementKind('function')).toBe(true);
    expect(isFrontendKind('region') && !isFrontendKind('external')).toBe(true);
  });

  it('b210: store, record and field are storage element kinds with no level and no code need', () => {
    for (const k of ['store', 'record', 'field']) {
      expect([isElementKind(k), isStorageKind(k), isFrontendKind(k), levelOf(k), needsCode(k)]).toEqual([true, true, false, null, false]);
    }
    expect(KIND_TABLE.store.family).toBe('storage');
    expect(isStorageKind('screen') || isStorageKind('container')).toBe(false);
  });
});

// Phase 28 (b391), b456: the subregion kind (was layer; the old word still reads); isArchBox is the one list of the nesting boxes of the architecture map.
describe('subregion kind', () => {
  it('plan add rules: a subregion goes in a container, a component in a container or a subregion; the old word layer adds a subregion', () => {
    expect(addRuleOf('subregion')).toEqual({ plan: 'subregion', parents: ['container'], code: false });
    expect(addRuleOf('layer')).toEqual({ plan: 'subregion', parents: ['container'], code: false });
    expect(addRuleOf('component')!.parents).toEqual(['container', 'subregion']);
    expect(addableKinds()).toContain('subregion');
    expect(addableKinds()).not.toContain('layer');
    expect(parentKindsOf('layer')).toEqual(['container']);
  });

  it('level c3, architecture element, no code need, words in the arch view only', () => {
    expect([levelOf('subregion'), isElementKind('subregion'), needsCode('subregion'), isMapActor('subregion'), viewOfKind('subregion')]).toEqual(['c3', true, false, false, 'arch']);
    expect(kindsOfView('arch').slice(0, 4)).toEqual(['system', 'container', 'subregion', 'component']);
    expect(buildKindWords().arch.subregion).toMatchObject({ tag: 'subregion', hud: 'Subregion' });
  });

  it.each([
    ['system', true], ['container', true], ['subregion', true], ['component', true],
    ['person', false], ['external', false], ['screen', false], ['store', false], ['function', false], ['nope', false],
  ])('isArchBox(%s) = %s', (kind, box) => {
    expect(isArchBox(kind)).toBe(box);
  });
});

describe('new kinds in a plan', () => {
  it('parser reads every kind with its parent', () => {
    const plan = parsePlan(repo, ['c4/arch.c4']);
    expect(plan.issues).toEqual([]);
    const kinds = Object.fromEntries(plan.elements.map(e => [e.id, e.kind]));
    expect(kinds).toMatchObject({
      'shop.web.signin': 'screen', 'shop.web.signin.form': 'region', 'shop.web.signin.form.submit': 'control',
      'shop.web.signin.failed': 'state', 'shop.web.login': 'flow', buyer: 'person', mail: 'external', trip: 'journey',
    });
    expect(plan.elements.find(e => e.id === 'shop.web.signin.form')!.parent).toBe('shop.web.signin');
  });

  it('ids gives every new kind a uid', () => {
    const dry = cli('plan', 'ids', '--force');
    expect(dry.stdout).toContain('+10 uid');
    expect(cli('plan', 'ids', '--yes', '--force').status).toBe(0);
    const plan = parsePlan(repo, ['c4/arch.c4']);
    expect(plan.elements.every(e => e.metadata.uid !== undefined)).toBe(true);
  });

  it('element finds a screen by fqn and name', () => {
    const r = cli('plan', 'show', 'shop.web.signin');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('screen  Sign in');
    expect(r.stdout).toContain('children:  2');
    expect(cli('plan', 'show', 'Buyer').stdout.split('\n')[0]).toBe('person  Buyer');
  });

  it('tree of a container shows its screen subtree; a screen has no tree level', () => {
    const r = cli('tree', 'c2', 'shop.web', '-r', '--format', 'text');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shop.web.signin  [screen]');
    expect(r.stdout).toContain('shop.web.signin.form.submit  [control]');
    expect(r.stdout).toContain('shop.web.login  [flow]');
    const bad = cli('tree', 'c3', 'shop.web.signin');
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('has no tree level');
  });

  it('remove takes a screen with its nested elements', () => {
    const r = cli('plan', 'remove', 'shop.web.signin');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removes 4 element(s)');
    expect(r.stdout).toContain('shop.web.signin.form.submit');
  });
});

// b266: CLI / API / MCP kinds: parents come from KIND_TABLE, entries and parts from ENTRY_KINDS / PART_KINDS.
describe('b266 command, options, flag, arg, route, body, param, tool', () => {
  it.each([
    ['command', ['container', 'command'], true], ['options', ['command'], false], ['flag', ['command', 'options'], false],
    ['arg', ['command'], false], ['route', ['container'], true], ['body', ['route'], false],
    ['param', ['route', 'body', 'tool'], false], ['tool', ['container'], true],
  ] as [string, string[], boolean][])('%s: parents %j, needsCode %s, frontend element with no level', (kind, parents, code) => {
    expect(addRuleOf(kind)).toEqual({ plan: kind, parents, code: false });
    expect([isElementKind(kind), isFrontendKind(kind), levelOf(kind), needsCode(kind)]).toEqual([true, true, null, code]);
  });

  it('entries and parts: screen, command, route, tool are entries; the rest hang under them', () => {
    expect([...ENTRY_KINDS]).toEqual(['screen', 'command', 'route', 'tool']);
    expect([...PART_KINDS].sort()).toEqual(['arg', 'body', 'control', 'flag', 'options', 'param', 'region', 'state']);
    const els = new Map([
      ['c', { id: 'c', kind: 'command', parent: 'app' }], ['c.o', { id: 'c.o', kind: 'options', parent: 'c' }], ['c.o.f', { id: 'c.o.f', kind: 'flag', parent: 'c.o' }],
      ['c.sub', { id: 'c.sub', kind: 'command', parent: 'c' }], ['app', { id: 'app', kind: 'container', parent: null }],
    ]);
    expect(['c', 'c.o', 'c.o.f', 'c.sub', 'app'].map(id => owningEntry(id, els))).toEqual(['c', 'c', 'c', 'c.sub', null]);
  });

  it('plan add rejects a parent outside the rule for each kind', async () => {
    const r = makeRepo('c4pm-kinds-add-', { 'a.c4': "model {\n  app = system 'App' {\n    cli = container 'Cli'\n  }\n}\n" });
    try {
      for (const [kind, parent] of [['flag', 'cli'], ['arg', 'cli'], ['options', 'cli'], ['body', 'cli'], ['param', 'cli'], ['command', 'app'], ['route', 'app'], ['tool', 'app']]) {
        const res = await runPlanCli(['plan', 'add', kind, 'x', '--parent', parent, '--yes', '--repo', r.root]);
        expect([kind, parent, res.code]).toEqual([kind, parent, 1]);
        expect(res.stderr).toContain(`a ${kind} goes under`);
      }
    } finally {
      fs.rmSync(r.root, { recursive: true, force: true });
    }
  });
});
