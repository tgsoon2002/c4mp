import * as fs from 'fs';
import * as path from 'path';
import { runCli } from './helpers/runCli';
import { runPlanCli, makeRepo, listing, writeSource } from './helpers/planEditHarness';
import { runCheck } from '../src/query/check';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// P18-T13: `c4mp plan add`, in-process on tmp repos with a hand-written plan.
const UID_API = '00000000-0000-4000-8000-000000000001';
const UID_AUTH = '00000000-0000-4000-8000-000000000002';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    web = container 'Web'",
  "    api = container 'Api' {",
  `      metadata { uid '${UID_API}' }`,
  "      auth = component 'Auth' {",
  `        metadata { uid '${UID_AUTH}' }`,
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
let linkBilling: string;
beforeEach(() => {
  repo = makeRepo('c4mp-add-', { 'a.c4': PLAN });
  linkBilling = writeSource(repo.root, repo.planDir, 'src/billing.ts', 'export function chargeCard(): void {}\n');
});
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const add = (...args: string[]) => runPlanCli(['plan', 'add', ...args, '--repo', repo.root]);
const planBytes = () => fs.readFileSync(repo.files['a.c4']);
const reparse = () => {
  const cfg = loadConfig(repo.root, {});
  return parsePlan(repo.root, findPlanFiles(repo.root, cfg).files);
};
const badKeys = (findings: { severity: string; rule: string; id: string; message: string }[]) =>
  new Set(findings.filter(f => f.severity !== 'info').map(f => `${f.rule}|${f.id}|${f.message}`));

describe('c4mp plan add', () => {
  it('Phase 28: a component added with --parent <layer> is written inside the layer block', async () => {
    const layered = ['model {', "  app = system 'App' {", "    api = container 'Api' {", "      core = layer 'Core' {", "        auth = component 'Auth'", '      }', '    }', '  }', '}', ''];
    fs.writeFileSync(repo.files['a.c4'], layered.join('\n'));
    const dry = await add('component', 'Billing', '--parent', 'app.api.core');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("+        Billing = component 'Billing' {");   // one level deeper than a component of the container

    expect((await add('component', 'Billing', '--parent', 'app.api.core', '--yes')).code).toBe(0);
    expect(reparse().elements.find(e => e.id === 'app.api.core.Billing')).toMatchObject({ kind: 'component', parent: 'app.api.core' });
  });

  it('b694: a default id that is a plan keyword becomes <id>_<kind> (dry run says so); an explicit keyword --id is refused', async () => {
    const dry = await add('component', 'description', '--parent', 'api');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("id 'description' is a plan keyword; using 'description_component' (pass --id to choose)");
    expect((await add('component', 'description', '--parent', 'api', '--yes')).code).toBe(0);
    expect(reparse().elements.find(e => e.id === 'app.api.description_component')).toMatchObject({ kind: 'component', title: 'description' });

    expect((await add('store', 'Main DB', '--parent', 'api', '--yes')).code).toBe(0);
    expect((await add('record', 'customers', '--parent', 'app.api.Main_DB', '--yes')).code).toBe(0);
    expect((await add('field', 'title', '--parent', 'app.api.Main_DB.customers', '--yes')).code).toBe(0);
    expect(reparse().elements.find(e => e.id === 'app.api.Main_DB.customers.title_field')).toMatchObject({ kind: 'field', title: 'title' });

    const before = planBytes();
    const bad = await add('component', 'X', '--parent', 'api', '--id', 'description');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/id 'description' is a plan keyword and cannot be an element id/);
    expect(planBytes().equals(before)).toBe(true);
  });

  it('dry run: no byte changes, diff + dry-run line; --yes writes one file; the plan check has nothing new', async () => {
    const before = planBytes();
    const listed = listing(repo.root);
    const checkBefore = badKeys(runCheck(repo.root, {}, {})!.findings);
    const dry = await add('component', 'Billing', '--parent', 'api');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("+      Billing = component 'Billing' {");
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(dry.stdout).not.toMatch(/^-[^-]/m);
    expect(planBytes().equals(before)).toBe(true);
    expect(listing(repo.root)).toEqual(listed);

    const yes = await add('component', 'Billing', '--parent', 'api', '--yes');
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('written: ');
    const el = reparse().elements.find(e => e.id === 'app.api.Billing')!;   // id = c4Id(name): case is kept
    expect(el).toMatchObject({ kind: 'component', title: 'Billing', parent: 'app.api' });
    expect(el.metadata.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(el.metadata.uid).not.toBe(UID_API);
    // only an insertion: the old text is the new text minus the added block
    expect(fs.readFileSync(repo.files['a.c4'], 'utf-8').replace(/ {6}Billing = component[\s\S]*?\n {6}\}\n/, '')).toBe(PLAN);
    const checkAfter = badKeys(runCheck(repo.root, {}, {})!.findings);
    for (const k of checkAfter) expect(checkBefore.has(k)).toBe(true);
  });

  it('P20-T9: plan add context --as person/external/system writes a top-level element into the model block', async () => {
    for (const [as, name, id] of [['person', 'Admin', 'Admin'], ['external', 'Bizfly Cloud', 'Bizfly_Cloud'], ['system', 'Billing Hub', 'Billing_Hub']]) {
      const dry = await add('context', name, '--as', as);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain(`+  ${id} = ${as} '${name}' {`);
      const yes = await add('context', name, '--as', as, '--yes');
      expect(yes.code).toBe(0);
      expect(reparse().elements.find(e => e.id === id)).toMatchObject({ kind: as, title: name, parent: null });
    }
    // same bytes as `plan add <as-kind>`: the kind word is a table kind too
    const direct = await add('person', 'Other', '--yes');
    expect(direct.code).toBe(0);
    expect(reparse().elements.find(e => e.id === 'Other')).toMatchObject({ kind: 'person', parent: null });
    expect(fs.readFileSync(repo.files['a.c4'], 'utf-8').trimEnd().endsWith('}\n}')).toBe(true);   // inserted inside model { }
    // a container goes under an external too
    const c = await add('container', 'Managed PostgreSQL', '--parent', 'Bizfly_Cloud', '--yes');
    expect(c.code).toBe(0);
    expect(reparse().elements.find(e => e.id === 'Bizfly_Cloud.Managed_PostgreSQL')).toMatchObject({ kind: 'container', parent: 'Bizfly_Cloud' });
  });

  it('P20-T9: context needs --as person|external|system; --as elsewhere and --parent on a top-level kind are refused', async () => {
    const before = planBytes();
    const cases: [string[], RegExp][] = [
      [['context', 'Admin'], /plan add context needs --as system, person or external$/],
      [['context', 'Admin', '--as', 'robot'], /needs --as system, person or external, got 'robot'/],
      [['context', 'Admin', '--as', 'screen'], /needs --as system, person or external, got 'screen'/],
      [['person', 'Admin', '--as', 'person'], /--as is only for 'plan add context'/],
      [['context', 'Admin', '--as', 'person', '--parent', 'app'], /person is a top-level element and takes no --parent/],
      [['system', 'Admin', '--parent', 'app'], /system is a top-level element and takes no --parent/],
      [['screen', 'Login'], /a screen goes under a container: --parent <target> is required/],
    ];
    for (const [args, re] of cases) {
      const r = await add(...args, '--yes');
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
    }
    expect(planBytes().equals(before)).toBe(true);
  });

  it('P20-T9: screen, region, control, state go under the kind table parents and are refused under others', async () => {
    const ok = async (kind: string, name: string, parent: string) => {
      const r = await add(kind, name, '--parent', parent, '--yes');
      expect({ kind, err: r.stderr, code: r.code }).toEqual({ kind, err: '', code: 0 });
    };
    await ok('screen', 'Login', 'web');
    await ok('region', 'Header', 'app.web.Login');
    await ok('control', 'Submit', 'app.web.Login');
    await ok('control', 'Logo', 'app.web.Login.Header');
    await ok('state', 'Busy', 'app.web.Login.Submit');
    await ok('state', 'Empty', 'app.web.Login');
    const els = reparse().elements;
    expect(els.find(e => e.id === 'app.web.Login.Header.Logo')).toMatchObject({ kind: 'control', parent: 'app.web.Login.Header' });
    expect(els.find(e => e.id === 'app.web.Login.Submit.Busy')).toMatchObject({ kind: 'state' });
    const before = planBytes();
    const bad: [string[], RegExp][] = [
      [['screen', 'X', '--parent', 'app'], /a screen goes under a container, but 'app' is a system/],
      [['region', 'X', '--parent', 'web'], /a region goes under a screen, but 'web' is a container/],
      [['control', 'X', '--parent', 'web'], /a control goes under a screen or region, but 'web' is a container/],
      [['state', 'X', '--parent', 'web'], /a state goes under a screen, region or control, but/],
    ];
    for (const [args, re] of bad) {
      const r = await add(...args, '--yes');
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
    }
    expect(planBytes().equals(before)).toBe(true);
  });

  it('P20-T9: the old top-level alias c4mp add still works, with the note', async () => {
    const r = await runPlanCli(['add', 'context', 'Admin', '--as', 'person', '--repo', repo.root]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("note: 'c4mp add' is now 'c4mp plan add'");
    expect(r.stdout).toContain("Admin = person 'Admin'");
  });

  it('a second identical run is refused: nothing is added twice', async () => {
    await add('component', 'Billing', '--parent', 'api', '--yes');
    const once = planBytes();
    const again = await add('component', 'Billing', '--parent', 'api', '--yes');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('error: invalid: app.api.Billing already exists');
    expect(planBytes().equals(once)).toBe(true);
    expect(reparse().elements.filter(e => e.id === 'app.api.Billing')).toHaveLength(1);
  });

  it('refuses a wrong parent kind, an unknown/ambiguous parent, a bad kind, a bad id, bad values', async () => {
    const before = planBytes();
    const cases: [string[], RegExp][] = [
      [['container', 'X', '--parent', 'web'], /a container goes under a system or external, but 'web' is a container/],
      [['component', 'X', '--parent', 'app'], /a component goes under a container/],
      [['planned-fn', 'x', '--parent', 'api'], /goes under a component/],
      [['component', 'X', '--parent', 'nope'], /no element matches 'nope'/],
      [['widget', 'X', '--parent', 'api'], /kind must be one of/],
      [['component', 'X', '--parent', 'api', '--id', '1bad'], /invalid id/],
      [['component', 'X', '--parent', 'api', '--status', 'finished'], /status 'finished' is not allowed/],
      [['component', 'X', '--parent', 'api', '--sprint', '15'], /should look like S15/],
      [['component', 'X', '--parent', 'api', '--signature', 's'], /only for planned-fn/],
      [['component', 'X', '--parent', 'api', '--status', 'done'], /needs an owner/],
      [['component', 'X', '--parent', 'api', '--yes', '--description', 'a\nb'], /line breaks/],
    ];
    for (const [args, re] of cases) {
      const r = await add(...args);
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
      expect(r.stdout).toBe('');
    }
    expect(planBytes().equals(before)).toBe(true);
  });

  it('--status in-progress without a link is refused by the gate (scan is forced); with a real link it passes', async () => {
    const bad = await add('component', 'Billing', '--parent', 'api', '--status', 'in-progress', '--yes');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('error: new-findings:');
    expect(bad.stderr).toContain('missing-code');
    expect(reparse().elements.find(e => e.id === 'app.api.Billing')).toBeUndefined();
    const ok = await add('component', 'Billing', '--parent', 'api', '--status', 'in-progress', '--link', 'src/billing.ts', '--yes');
    expect(ok.code).toBe(0);
    const el = reparse().elements.find(e => e.id === 'app.api.Billing')!;
    expect(el.metadata.status).toBe('in-progress');
    expect(el.links[0].path).toBe('src/billing.ts');
  });

  it('--link: a missing file or function is refused; a function link adds the claim-mode note', async () => {
    const before = planBytes();
    const noFile = await add('component', 'Billing', '--parent', 'api', '--link', 'src/nope.ts', '--yes');
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toContain('link target does not exist: src/nope.ts');
    const noFn = await add('component', 'Billing', '--parent', 'api', '--link', 'src/billing.ts#nope', '--yes');
    expect(noFn.code).toBe(1);
    expect(noFn.stderr).toContain("function 'nope' not found in src/billing.ts");
    expect(planBytes().equals(before)).toBe(true);
    const fn = await add('component', 'Billing', '--parent', 'api', '--link', 'src/billing.ts#chargeCard');
    expect(fn.code).toBe(0);
    expect(fn.stdout).toContain('note: this function link switches the whole plan to claim mode');
    expect(fn.stdout).toContain(`+        link ${linkBilling}#chargeCard`);
  });

  it('planned-fn under a component writes kind function with signature, no uid', async () => {
    const r = await add('planned-fn', 'chargeCard', '--parent', 'auth', '--signature', "chargeCard(id: string): void", '--status', 'planned', '--purpose', "it's \\ ok", '--yes');
    expect(r.code).toBe(0);
    const el = reparse().elements.find(e => e.id === 'app.api.auth.chargecard' || e.id === 'app.api.auth.chargeCard')!;
    expect(el.kind).toBe('function');
    expect(el.title).toBe('chargeCard');
    expect(el.metadata).toMatchObject({ status: 'planned', signature: 'chargeCard(id: string): void', purpose: "it's \\ ok" });
    expect(el.metadata.uid).toBeUndefined();
  });

  it('--json prints exactly one object; --id and --title are honoured; container under a system', async () => {
    const r = await add('container', 'Worker', '--parent', 'app', '--id', 'jobs', '--title', 'Job Worker', '--description', 'runs "jobs"', '--tech', 'Node', '--json');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, command: 'add', dryRun: true, written: false, error: null, target: { fqn: 'app.jobs', kind: 'container' } });
    expect(out.target.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.files[0].diff).toContain("jobs = container 'Job Worker'");
    expect(r.stderr).toBe('');
    await add('container', 'Worker', '--parent', 'app', '--id', 'jobs', '--title', 'Job Worker', '--description', 'runs "jobs"', '--tech', 'Node', '--yes');
    expect(reparse().elements.find(e => e.id === 'app.jobs')).toMatchObject({ title: 'Job Worker', description: 'runs "jobs"', technology: 'Node' });
  });

  it('a plan file outside .c4mp/ is refused (dry run too) without --force', async () => {
    const outside = makeRepo('c4mp-add-out-', {});
    try {
      fs.mkdirSync(path.join(outside.root, 'docs'));
      const file = path.join(outside.root, 'docs', 'x.c4');
      fs.writeFileSync(file, PLAN);
      const args = ['plan', 'add', 'component', 'Billing', '--parent', 'api', '--repo', outside.root];
      const dry = await runPlanCli(args);
      expect(dry.code).toBe(1);
      expect(dry.stderr).toContain('error: outside-c4pm: outside .c4mp/ (use --force): docs/x.c4');
      expect((await runPlanCli([...args, '--yes'])).code).toBe(1);
      expect(fs.readFileSync(file, 'utf-8')).toBe(PLAN);
      expect((await runPlanCli([...args, '--yes', '--force'])).code).toBe(0);
      expect(fs.readFileSync(file, 'utf-8')).toContain('Billing = component');
    } finally {
      fs.rmSync(outside.root, { recursive: true, force: true });
    }
  });

  it('b210: store > record > field > nested field, --meta repeatable; storage parents enforced; plan show names the word', async () => {
    const run = async (...a: string[]) => { const r = await add(...a, '--yes'); expect(r.stderr).toBe(''); expect(r.code).toBe(0); return r; };
    await run('store', 'Main DB', '--tech', 'postgres', '--parent', 'api');
    await run('record', 'customers', '--parent', 'app.api.Main_DB');
    await run('field', 'id', '--parent', 'app.api.Main_DB.customers', '--meta', 'type=uuid', '--meta', 'pk=true');
    await run('field', 'address', '--parent', 'app.api.Main_DB.customers', '--meta', 'type=json');
    await run('field', 'city', '--parent', 'app.api.Main_DB.customers.address', '--meta', 'index.by_city=city');
    const els = reparse().elements;
    const byId = (id: string) => els.find(e => e.id === `app.${id}`)!;
    expect(byId('api.Main_DB')).toMatchObject({ kind: 'store', technology: 'postgres', parent: 'app.api' });
    expect(byId('api.Main_DB.customers').kind).toBe('record');
    expect(byId('api.Main_DB.customers.id').metadata).toMatchObject({ type: 'uuid', pk: 'true' });
    expect(byId('api.Main_DB.customers.address.city')).toMatchObject({ kind: 'field', parent: 'app.api.Main_DB.customers.address' });
    expect(byId('api.Main_DB.customers.address.city').metadata['index.by_city']).toBe('city');
    expect(byId('api.Main_DB.customers.id').metadata.uid).toMatch(/^[0-9a-f-]{36}$/);
    const shown = runCli(['plan', 'show', 'app.api.Main_DB.customers.id', '--repo', repo.root]);
    expect(shown.stdout).toContain('as:        column');
    const json = runCli(['plan', 'show', 'app.api.Main_DB.customers.id', '--json', '--repo', repo.root]);
    expect(JSON.parse(json.stdout).as).toBe('column');

    for (const [kind, parent] of [['record', 'api'], ['field', 'api'], ['store', 'app.api.Main_DB.customers'], ['store', 'auth'], ['record', 'app.api.Main_DB.customers']]) {
      const r = await add(kind, 'X', '--parent', parent, '--yes');
      expect([kind, parent, r.code]).toEqual([kind, parent, 1]);
      expect(r.stderr).toContain(`a ${kind} goes under`);
    }
  });

  it('b266: command (and subcommand), flag, arg, options, route, body, param (with meta), tool: each added under its parent', async () => {
    const run = async (...a: string[]) => { const r = await add(...a, '--yes'); expect(r.stderr).toBe(''); expect(r.code).toBe(0); return r; };
    await run('command', 'plan', '--parent', 'api');
    await run('command', 'show', '--title', 'plan show', '--parent', 'app.api.plan');
    await run('options', 'Output', '--parent', 'app.api.plan.show');
    await run('flag', 'json', '--title=--json', '--parent', 'app.api.plan.show.Output');
    await run('flag', 'file', '--title=--file', '--parent', 'app.api.plan.show');
    await run('arg', 'target', '--title', '<target>', '--parent', 'app.api.plan.show');
    await run('route', 'get', '--title', 'GET /orders/:id', '--parent', 'api', '--meta', 'method=GET');
    await run('param', 'id', '--parent', 'app.api.get', '--meta', 'in=path', '--meta', 'type=uuid');
    await run('body', 'Body', '--parent', 'app.api.get');
    await run('param', 'sku', '--parent', 'app.api.get.Body', '--meta', 'type=string');
    await run('tool', 'find_product', '--parent', 'api');
    await run('param', 'query', '--parent', 'app.api.find_product');
    const els = reparse().elements;
    const byId = (id: string) => els.find(e => e.id === `app.api.${id}`)!;
    expect(['plan', 'plan.show', 'plan.show.Output', 'plan.show.Output.json', 'plan.show.file', 'plan.show.target', 'get', 'get.id', 'get.Body', 'get.Body.sku', 'find_product', 'find_product.query'].map(i => byId(i).kind))
      .toEqual(['command', 'command', 'options', 'flag', 'flag', 'arg', 'route', 'param', 'body', 'param', 'tool', 'param']);
    expect(byId('plan.show')).toMatchObject({ title: 'plan show', parent: 'app.api.plan' });
    expect(byId('plan.show.Output.json').title).toBe('--json');
    expect(byId('get').metadata).toMatchObject({ method: 'GET' });
    expect(byId('get.id').metadata).toMatchObject({ in: 'path', type: 'uuid' });
    expect(byId('get.Body.sku').parent).toBe('app.api.get.Body');
    expect(byId('plan').metadata.uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('b210: --meta must be key=value, not a duplicate and not a reserved key', async () => {
    const before = planBytes();
    for (const [bad, text] of [['status', 'is not key=value'], ['=x', 'is not key=value'], ['uid=1', "cannot set 'uid'"], ['owner=K', 'use --owner'], ['bad key=1', 'invalid metadata key']]) {
      const r = await add('store', 'S', '--parent', 'api', '--meta', bad, '--yes');
      expect([bad, r.code]).toEqual([bad, 1]);
      expect(r.stderr).toContain(text);
    }
    const dup = await add('store', 'S', '--parent', 'api', '--meta', 'a=1', '--meta', 'a=2', '--yes');
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("given twice");
    expect(planBytes().equals(before)).toBe(true);
  });

  it('no plan: exit 1 with the generate-c4 hint, nothing created', async () => {
    const none = makeRepo('c4mp-add-none-', {});
    try {
      const listed = listing(none.root);
      const r = await runPlanCli(['plan', 'add', 'component', 'X', '--parent', 'api', '--repo', none.root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan');
      expect(listing(none.root)).toEqual(listed);
    } finally {
      fs.rmSync(none.root, { recursive: true, force: true });
    }
  });
});
