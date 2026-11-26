import * as fs from 'fs';
import * as path from 'path';
import { emitResult, emitError, runWrite, withText, formatErrorText } from '../src/cli/common';
import { loadPlanState, resolveTarget } from '../src/services/planState';
import type { WriteReport } from '../src/cli/common';
import { setElementMetadata } from '../src/c4/editMeta';
import { makeRepo, listing } from './helpers/planEditHarness';

// P18-T10: shared helpers of the plan-edit commands.
const UID_A = '00000000-0000-4000-8000-000000000001';
const UID_B = '00000000-0000-4000-8000-000000000002';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    web = container 'Web' {",
  "      auth = component 'Auth' {",
  `        metadata { uid '${UID_A}' }`,
  '      }',
  '    }',
  "    api = container 'Api' {",
  "      auth2 = component 'Auth' {",
  `        metadata { uid '${UID_B}' }`,
  '      }',
  "      plain = component 'Plain'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

let repo: ReturnType<typeof makeRepo>;
beforeEach(() => { repo = makeRepo('c4pm-common-', { 'a.c4': PLAN }); });
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const load = () => loadPlanState(repo.root)!;

describe('loadPlanState', () => {
  it('loads plan, texts and project; null when there is no .c4 file; writes nothing', () => {
    const before = listing(repo.root);
    const s = load();
    expect(s.c4Files).toHaveLength(1);
    expect(s.texts.get(s.c4Files[0])).toBe(PLAN);
    expect(s.plan.elements.length).toBeGreaterThan(3);
    expect(s.project).not.toBeNull();
    expect(listing(repo.root)).toEqual(before);
    const empty = makeRepo('c4pm-common-empty-', {});
    expect(loadPlanState(empty.root)).toBeNull();
    fs.rmSync(empty.root, { recursive: true, force: true });
  });
  it('a repo that is not a folder throws', () => {
    expect(() => loadPlanState(path.join(repo.root, 'nope'))).toThrow(/not a directory/);
  });
});

describe('resolveTarget', () => {
  it.each([
    ['uid', UID_A, 'app.web.auth'],
    ['fqn', 'app.api.auth2', 'app.api.auth2'],
    ['local id', 'plain', 'app.api.plain'],
  ])('one match by %s', (_n, q, fqn) => {
    const r = resolveTarget(load(), q);
    expect(r.ok && r.el.id).toBe(fqn);
  });
  it('none: not-found with the closest ids', () => {
    const r = resolveTarget(load(), 'Autx');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not-found');
      expect(r.error.message).toBe("no element matches 'Autx'");
      expect(r.error.candidates!.length).toBeGreaterThan(0);
    }
  });
  it('ambiguous title: lists uid, fqn, title; hint when some element has no uid', () => {
    const r = resolveTarget(load(), 'Auth');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ambiguous');
      expect(r.error.message).toBe("'Auth' matches 2 elements, use a uid:");
      expect(formatErrorText(r.error)).toContain(`  ${UID_A}  app.web.auth  Auth`);
    }
  });
  it('planned code is found only with codeToo', () => {
    const text = PLAN.replace("      plain = component 'Plain'", "      plain = component 'Plain' {\n        plan_fn = function 'planFn'\n      }");
    fs.writeFileSync(repo.files['a.c4'], text);
    expect(resolveTarget(load(), 'app.api.plain.plan_fn').ok).toBe(false);
    const r = resolveTarget(load(), 'app.api.plain.plan_fn', { codeToo: true });
    expect(r.ok && r.el.kind).toBe('function');
  });
});

describe('emitResult / emitError', () => {
  const report: WriteReport = {
    ok: true, command: 'set', dryRun: true, written: false, target: { uid: UID_A, fqn: 'app.web.auth', kind: 'component' },
    files: [{ file: 'x.c4', diff: '--- a\n+++ b\n' }], findings: { new: [], fixed: [] }, notes: ['n1'], error: null,
  };
  const capture = (fn: () => number) => {
    const out: string[] = []; const err: string[] = [];
    const l = console.log; const e = console.error;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
    let code: number;
    try { code = fn(); } finally { console.log = l; console.error = e; }
    return { out: out.join('\n'), err: err.join('\n'), code };
  };
  it('--json prints exactly the D15 keys as one object', () => {
    const r = capture(() => emitResult({ json: true }, report));
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.out)).sort()).toEqual(
      ['command', 'dryRun', 'error', 'files', 'findings', 'notes', 'ok', 'target', 'written'],
    );
    expect(Object.keys(JSON.parse(r.out).findings)).toEqual(['new', 'fixed']);
  });
  it('text: dry run line on stdout, exit 0; failed report goes to stderr with exit 1', () => {
    const ok = capture(() => emitResult({}, report));
    expect(ok.out).toContain('dry run: nothing written. Add --yes to apply.');
    expect(ok.out).toContain('note: n1');
    const many = Array.from({ length: 12 }, (_, i) => ({ severity: 'info' as const, rule: 'shared-auto', id: `f${i}`, message: 'm' }));
    const long = capture(() => emitResult({}, { ...report, findings: { new: many, fixed: [] } }));
    expect(long.out).toContain('  ... 2 more (use --json for all)');
    expect(long.out).not.toContain('f11');
    const bad = capture(() => emitResult({}, { ...report, ok: false, error: { code: 'invalid', message: 'bad value' } }));
    expect(bad.code).toBe(1);
    expect(bad.out).toBe('');
    expect(bad.err).toBe('error: invalid: bad value\nnote: n1');   // notes follow a failure too
    const j = capture(() => emitError({ json: true }, 'tree', { code: 'not-found', message: 'm' }));
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toEqual({ ok: false, command: 'tree', error: { code: 'not-found', message: 'm' } });
  });
});

describe('runWrite', () => {
  const setStatus = (value: string) => {
    const s = load();
    const file = s.c4Files[0];
    const r = setElementMetadata(s.texts.get(file)!, 'app.web.auth', 'status', value);
    return { s, file, newTexts: withText(s, file, r.text) };
  };
  const spec = (value: string, opts: Record<string, unknown>, post: (p: any) => string | null = () => null) => {
    const { s, newTexts } = setStatus(value);
    return runWrite({ command: 'set', opts, state: s, target: null, newTexts, post });
  };

  it('dry run: report with diff, disk untouched; --yes writes; post failure on disk rolls back', () => {
    const bytes = fs.readFileSync(repo.files['a.c4']);
    const dry = spec('planned', {});
    expect(dry).toMatchObject({ ok: true, dryRun: true, written: false });
    expect(dry.files[0].diff).toContain("+        metadata { uid '00000000-0000-4000-8000-000000000001' status 'planned' }");
    expect(fs.readFileSync(repo.files['a.c4']).equals(bytes)).toBe(true);

    let n = 0;
    const rolled = spec('planned', { yes: true }, () => (++n === 2 ? 'disk differs' : null));
    expect(rolled.ok).toBe(false);
    expect(rolled.error).toMatchObject({ code: 'rolled-back' });
    expect(rolled.error!.message).toContain('disk differs');
    expect(fs.readFileSync(repo.files['a.c4']).equals(bytes)).toBe(true);

    const done = spec('planned', { yes: true });
    expect(done).toMatchObject({ ok: true, written: true, dryRun: false });
    expect(fs.readFileSync(repo.files['a.c4'], 'utf-8')).toContain("status 'planned'");
  });

  it('a refusal lists the reasons and writes nothing; a dry run that would be refused fails too', () => {
    const bytes = fs.readFileSync(repo.files['a.c4']);
    const r = spec('bogus', { yes: true });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('new-findings');
    expect(r.error!.message).toMatch(/new warning invalid-metadata app\.web\.auth: Auth: unknown status 'bogus'/);
    expect(r.findings.new).toHaveLength(1);
    expect(spec('bogus', {}).ok).toBe(false);
    expect(fs.readFileSync(repo.files['a.c4']).equals(bytes)).toBe(true);
  });

  it('no change: ok, note, nothing to write', () => {
    const s = load();
    const r = runWrite({ command: 'set', opts: { yes: true }, state: s, target: null, newTexts: new Map(s.texts), post: () => null });
    expect(r).toMatchObject({ ok: true, written: false });
    expect(r.notes).toContain('no change');
  });

  it('a plan file outside .c4pm/ is refused (dry run too) unless --force', () => {
    const outsideDir = path.join(repo.root, 'docs');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'x.c4'), PLAN);
    fs.rmSync(repo.files['a.c4']);
    const s = load();
    expect(s.c4Files[0]).toBe('docs/x.c4');
    const edit = (opts: Record<string, unknown>) => runWrite({
      command: 'set', opts, state: s, target: null, post: () => null,
      newTexts: withText(s, 'docs/x.c4', setElementMetadata(PLAN, 'app.web.auth', 'status', 'planned').text),
    });
    expect(edit({}).error).toMatchObject({ code: 'outside-c4pm' });
    expect(edit({ yes: true }).error).toMatchObject({ code: 'outside-c4pm' });
    expect(fs.readFileSync(path.join(outsideDir, 'x.c4'), 'utf-8')).toBe(PLAN);
    expect(edit({ yes: true, force: true }).written).toBe(true);
  });
});
