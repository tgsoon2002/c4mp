import * as fs from 'fs';
import { runPlanCli, makeRepo, listing } from './helpers/planEditHarness';
import { parsePlan } from '../src/plan/parser';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';

// P18-T14: `c4pm plan set`, in-process on a tmp repo with a hand-written plan.
const UID_API = '00000000-0000-4000-8000-000000000001';
const UID_AUTH = '00000000-0000-4000-8000-000000000002';
const UID_AUTH2 = '00000000-0000-4000-8000-000000000003';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  '      metadata {',
  `        uid '${UID_API}'`,
  "        layout '1,2,3,4'",
  '      }',
  "      auth = component 'Auth' {",
  '        metadata {',
  `          uid '${UID_AUTH}'`,
  '        }',
  "        plan_fn = function 'planFn' {",
  "          metadata { status 'planned' }",
  '        }',
  '      }',
  '    }',
  "    web = container 'Web' {",
  "      auth2 = component 'Auth' { metadata { uid '" + UID_AUTH2 + "' } }",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
beforeEach(() => { repo = makeRepo('c4pm-set-', { 'a.c4': PLAN }); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const set = (...args: string[]) => runPlanCli(['plan', 'set', ...args, '--repo', repo.root]);
const text = () => fs.readFileSync(repo.files['a.c4'], 'utf-8');
const reparse = () => parsePlan(repo.root, findPlanFiles(repo.root, loadConfig(repo.root, {})).files);
const el = (id: string) => reparse().elements.find(e => e.id === id)!;
/** Lines that differ between old and new text (multiset difference both ways). */
function changedLines(a: string, b: string): { removed: string[]; added: string[] } {
  const count = (s: string) => s.split('\n').reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const ca = count(a); const cb = count(b);
  const diff = (x: Map<string, number>, y: Map<string, number>) =>
    [...x].flatMap(([l, n]) => Array<string>(Math.max(0, n - (y.get(l) ?? 0))).fill(l));
  return { removed: diff(ca, cb), added: diff(cb, ca) };
}

describe('c4pm plan set', () => {
  it('dry run leaves bytes identical and prints the diff', async () => {
    const before = fs.readFileSync(repo.files['a.c4']);
    const listed = listing(repo.root);
    const dry = await set('app.api.auth', 'status=planned', 'owner=K');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
    expect(listing(repo.root)).toEqual(listed);
  });

  it('--yes writes status, owner, priority quoted; only the intended lines change; uid and layout untouched', async () => {
    const r = await set('app.api.auth', 'status=planned', 'owner=K', 'priority=high', '--yes');
    expect(r.code).toBe(0);
    expect(el('app.api.auth').metadata).toMatchObject({ status: 'planned', owner: 'K', priority: 'high', uid: UID_AUTH });
    const d = changedLines(PLAN, text());
    expect(d.removed).toEqual([]);
    expect(d.added.map(l => l.trim()).sort()).toEqual(["owner 'K'", "priority 'high'", "status 'planned'"]);
    expect(text()).toContain(`uid '${UID_AUTH}'`);
    expect(text()).toContain("layout '1,2,3,4'");
  });

  it('refusals: bad status, done without owner, uid, layout, sprint 15, unknown key, empty value, no =, duplicate key', async () => {
    const before = fs.readFileSync(repo.files['a.c4']);
    const cases: [string[], RegExp][] = [
      [['api', 'status=finished'], /status 'finished' is not allowed \(use planned, in-progress, done, abandoned\)/],
      [['api', 'status=done'], /needs an owner/],
      [['api', 'uid=x'], /uid cannot be changed with set/],
      [['api', 'layout=1,2,3,4'], /layout cannot be changed with set/],
      [['api', 'sprint=15'], /should look like S15/],
      [['api', 'shape=android'], /shape 'android' is not allowed \(use person, robot\)/],
      [['api', 'shape=robot'], /shape is only for a person, not a container/],   // C1 C2 (b834): the gate refuses the new warning
      [['api', 'role=base'], /role 'base' is not allowed \(use foundation\)/],   // b908
      [['api', 'role=foundation'], /role is only for a component, not a container/],   // b908: the gate refuses the new warning
      [['api', '--unset', 'uid'], /uid cannot be removed with set/],
      [['api', '--unset', 'title'], /--unset takes a metadata key/],
      [['api', 'owner=A', '--unset', 'owner'], /given twice/],
      [['api'], /give key=value pairs or --unset <key>/],
      [['api', 'color=red'], /unknown key 'color'\. Allowed: status, owner/],
      [['api', 'stauts=done'], /unknown key 'stauts', did you mean 'status'\? Allowed: status, owner/],   // b219
      [['api', 'owner='], /owner must not be empty/],
      [['api', 'owner'], /is not key=value/],
      [['api', 'owner=A', 'owner=B'], /given twice/],
      [['app.web.nope', 'owner=A'], /no element matches/],
    ];
    for (const [args, re] of cases) {
      const r = await set(...args, '--yes');
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 1, err: expect.stringMatching(re) });
      expect(r.stdout).toBe('');
    }
    expect(fs.readFileSync(repo.files['a.c4']).equals(before)).toBe(true);
  });

  it('C1 C2 (b834): shape=robot on a person writes the metadata line shape \'robot\'', async () => {
    const r0 = makeRepo('c4pm-set-shape-', { 'a.c4': PLAN.replace('model {', "model {\n  bot = person 'Bot' {\n  }") });
    try {
      const r = await runPlanCli(['plan', 'set', 'bot', 'shape=robot', '--repo', r0.root, '--yes']);
      expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: '' });
      expect(fs.readFileSync(r0.files['a.c4'], 'utf-8')).toMatch(/bot = person 'Bot' \{\n\s+metadata \{\n\s+shape 'robot'\n/);
    } finally {
      fs.rmSync(r0.root, { recursive: true, force: true });
    }
  });

  it('b908: role=foundation on a component, then --unset role gives back the bytes', async () => {
    const r = await set('app.api.auth', 'role=foundation', '--yes');
    expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: '' });
    expect(el('app.api.auth').metadata.role).toBe('foundation');
    expect(changedLines(PLAN, text())).toEqual({ removed: [], added: ["          role 'foundation'"] });
    const u = await set('app.api.auth', '--unset', 'role', '--yes');
    expect({ code: u.code, err: u.stderr }).toEqual({ code: 0, err: '' });
    expect(text()).toBe(PLAN);
  });

  it('b908: --unset of a key the element lacks is no change; a dry run prints the removed line', async () => {
    const none = await set('app.api.auth', '--unset', 'role', '--yes');
    expect(none.code).toBe(0);
    expect(text()).toBe(PLAN);
    expect((await set('app.api.auth', 'priority=high', '--yes')).code).toBe(0);
    const written = text();
    const dry = await set('app.api.auth', '--unset', 'priority');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^-\s+priority 'high'$/m);
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(text()).toBe(written);
  });

  it('b908: removing the last key of a metadata block removes the block', async () => {
    const r0 = makeRepo('c4pm-set-unset-', { 'a.c4': PLAN.replace("auth2 = component 'Auth' {", "auth3 = component 'Solo' { metadata { role 'foundation' } }\n      auth2 = component 'Auth' {") });
    try {
      const r = await runPlanCli(['plan', 'set', 'app.web.auth3', '--unset', 'role', '--repo', r0.root, '--yes']);
      expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: '' });
      const out = fs.readFileSync(r0.files['a.c4'], 'utf-8');
      expect(out).toContain("auth3 = component 'Solo'");
      expect(out).not.toMatch(/auth3[^\n]*metadata|role/);
    } finally {
      fs.rmSync(r0.root, { recursive: true, force: true });
    }
  });

  it('status=done with owner= in the same call is accepted by the rules, then the gate wants real code (scan forced)', async () => {
    const r = await set('app.api.auth', 'status=done', 'owner=K', '--yes');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: new-findings:');
    expect(r.stderr).toContain('missing-code');
    expect(text()).toBe(PLAN);
  });

  it('values with quote, backslash and "=" round-trip; the written line is always key \'value\'', async () => {
    const r = await set('app.api.auth', "description=It's a \\ path = ok", 'title=Auth "core"', 'technology=Node=20', 'owner=O\'Neil\\', '--yes');
    expect(r.code).toBe(0);
    const e = el('app.api.auth');
    expect(e).toMatchObject({ title: 'Auth "core"', description: "It's a \\ path = ok", technology: 'Node=20' });
    expect(e.metadata.owner).toBe("O'Neil\\");
    expect(text()).toContain("owner 'O\\'Neil\\\\'");
  });

  it('ambiguous target lists uids; a planned function can be set; a same value is "no change" (exit 0, no write)', async () => {
    const amb = await set('Auth', 'owner=K', '--yes');
    expect(amb.code).toBe(1);
    expect(amb.stderr).toContain("'Auth' matches 2 elements, use a uid:");
    expect(amb.stderr).toContain(UID_AUTH);
    expect(amb.stderr).toContain(UID_AUTH2);
    const fn = await set('app.api.auth.plan_fn', 'status=abandoned', 'signature=planFn(): void', '--yes');
    expect(fn.code).toBe(0);
    expect(el('app.api.auth.plan_fn').metadata).toMatchObject({ status: 'abandoned', signature: 'planFn(): void' });
    const mtime = fs.statSync(repo.files['a.c4']).mtimeMs;
    const same = await set('app.api.auth.plan_fn', 'status=abandoned', '--yes');
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('note: no change');
    expect(fs.statSync(repo.files['a.c4']).mtimeMs).toBe(mtime);
  });

  it('a title edit on an element that already has an invalid-metadata warning is not refused (finding 2)', async () => {
    fs.writeFileSync(repo.files['a.c4'], PLAN.replace("metadata { status 'planned' }", "metadata { status 'bogus' }"));
    const r = await set('app.api.auth.plan_fn', 'title=planFn2', '--yes');
    expect(r.code).toBe(0);
    expect(el('app.api.auth.plan_fn').title).toBe('planFn2');
    // but fixing nothing and adding a second problem is still refused
    const bad = await set('app.api.auth.plan_fn', 'priority=urgent', '--yes');
    expect(bad.code).toBe(1);
  });

  it('--json: one object with the D15 keys', async () => {
    const r = await set('app.api.auth', 'owner=K', '--json');
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual(['command', 'dryRun', 'error', 'files', 'findings', 'notes', 'ok', 'target', 'written']);
    expect(out).toMatchObject({ ok: true, dryRun: true, written: false, target: { uid: UID_AUTH, fqn: 'app.api.auth', kind: 'component' } });
    const bad = await set('app.api.auth', 'uid=x', '--json');
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).error.code).toBe('invalid');
    expect(bad.stderr).toBe('');
  });
});
