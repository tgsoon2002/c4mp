import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { planPath } from '../src/query/planPath';
import { formatPlanPath } from '../src/query/format';
import { QueryError } from '../src/query/errors';
import { runCli } from './helpers/runCli';

// b469: `c4pm plan path <from> <to>` on fixture layers-path: Entry points > Services > Engines > Readers, Foundation shared.
// Arrows: cli -> query, cli -> workspace (skips two layers), tool -> query, query -> workspace, query -> checks,
// checks -> files, checks/render -> types; loose -> workspace (no subregion); page (container Web) -> workspace.
const FIX = path.join(__dirname, 'fixtures', 'layers-path');
const C = (id: string): string => `app.core.${id}`;

describe('planPath', () => {
  let ctx: QueryContext;
  beforeAll(() => { ctx = loadQueryContext(FIX); });

  it('a route through an existing caller: one layer between, its caller is the step', () => {
    const r = planPath(ctx, C('entry.cli'), C('engines.checks'));
    expect(r.direction).toBe('down');
    expect(r.between.map((b) => [b.layer, b.missing, b.callers.map((c) => c.component)])).toEqual([[C('services'), false, [C('services.query')]]]);
    expect(r.route).toEqual([C('entry.cli'), C('services.query'), C('engines.checks')]);
    expect(r.suggestions).toEqual([]);
  });

  it('a layer with no caller: missing, the candidate that reaches further down, a planned-fn command with the <name> placeholder', () => {
    const r = planPath(ctx, 'Cli', C('readers.workspace'));
    expect(r.from).toMatchObject({ id: C('entry.cli'), layer: C('entry'), rank: 0 });
    expect(r.to).toMatchObject({ id: C('readers.workspace'), layer: C('readers'), rank: 3 });
    expect(r.between.map((b) => [b.layerTitle, b.missing, b.candidates])).toEqual([['Services', false, []], ['Engines', true, [C('engines.checks')]]]);
    expect(r.route).toEqual([C('entry.cli'), C('services.query'), '(planned-fn needed in Engines)', C('readers.workspace')]);
    expect(r.suggestions).toEqual([{
      layer: C('engines'), parent: C('engines.checks'),
      command: `c4mp plan add planned-fn <name> --parent ${C('engines.checks')} --signature "<name>(...)"`,
      note: 'a function in Engines that calls readers.workspace',
    }]);
    expect(formatPlanPath(r).split('\n')).toEqual([
      'app.core.entry.cli (Entry points, 1/5) -> app.core.readers.workspace (Readers, 4/5): down, 2 layers between',
      'between:',
      '  Services  services.query already calls it (x1)',
      '  Engines   no component calls it: put a planned-fn in engines.checks',
      'route: entry.cli -> services.query -> (planned-fn needed in Engines) -> readers.workspace',
      'suggest:',
      `  c4mp plan add planned-fn <name> --parent ${C('engines.checks')} --signature "<name>(...)"`,
      '    a function in Engines that calls readers.workspace',
    ]);
  });

  it('a function target: its owner is the end, the callers come from the traced calls', () => {
    const r = planPath(ctx, C('entry.cli'), 'src/readers/open.ts#openProject');
    expect(r.to).toMatchObject({ id: C('readers.workspace'), function: { file: 'src/readers/open.ts', name: 'openProject' } });
    expect(r.between[0].callers).toEqual([{ component: C('services.query'), weight: 1, via: ['src/services/query.ts#runQuery'] }]);
    expect(r.suggestions[0].note).toBe('a function in Engines that calls openProject (src/readers/open.ts)');
  });

  it.each([
    ['adjacent layers', C('entry.cli'), C('services.query'), 'down', null],
    ['same layer', C('entry.cli'), C('entry.tool'), 'same', /both are in Entry points/],
    ['upward', C('readers.workspace'), C('services.query'), 'up', /a layer above Readers: call down/],
    ['shared target', C('entry.cli'), C('foundation.types'), 'shared', /shared subregion Foundation/],
    ['loose component', C('loose'), C('readers.workspace'), 'unlayered', /app\.core\.loose is in no subregion/],
    ['two containers', 'app.web.pages.page', C('readers.workspace'), 'other-container', /two containers/],
  ])('%s: %s -> %s gives direction %s and nothing between (not an error)', (_label, from, to, direction, note) => {
    const r = planPath(ctx, from, to);
    expect(r.direction).toBe(direction);
    expect(r.between).toEqual([]);
    expect(r.suggestions).toEqual([]);
    if (note) expect(r.note).toMatch(note);
    else expect(r.route).toEqual([from, to]);
  });

  it.each([
    ['nope', 'not-found'],
    ['app.core', 'invalid'],
    ['src/readers/open.ts#nope', 'not-found'],
  ])('%s: QueryError %s', (to, code) => {
    let err: unknown;
    try { planPath(ctx, C('entry.cli'), to); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueryError);
    expect((err as QueryError).code).toBe(code);
  });

  it('no plan: unlayered', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-planpath-')));
    fs.cpSync(FIX, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'c4'), { recursive: true });
    const bare = loadQueryContext(dir);
    expect(bare.plan).toBeNull();
    const ids = bare.snapshot.components.map((c) => c.id);
    expect(planPath(bare, ids[0], ids[1]).direction).toBe('unlayered');
  });
});

describe('c4pm plan path (CLI)', () => {
  it('prints the route; the suggested command runs once <name> is filled in', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-planpath-cli-')));
    fs.cpSync(FIX, dir, { recursive: true });
    const r = runCli(['plan', 'path', 'Cli', 'Workspace', '--repo', dir, '--json']);
    expect(r.stderr).toBe('');
    const json = JSON.parse(r.stdout);
    expect(json.route[2]).toBe('(planned-fn needed in Engines)');
    const args = (json.suggestions[0].command as string).replace(/<name>/g, 'scanAll').match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, ''));
    expect(args.slice(0, 4)).toEqual(['c4mp', 'plan', 'add', 'planned-fn']);
    const add = runCli([...args.slice(1), '--repo', dir, '--force']);   // --force: the fixture's plan is outside .c4pm/
    expect(add.stderr).toBe('');
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("scanAll = function 'scanAll'");
    expect(add.stdout).toContain('dry run');
  });
});
