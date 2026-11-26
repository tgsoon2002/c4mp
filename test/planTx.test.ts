import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluatePlanEdit, commitPlanEdit } from '../src/c4/planTx';
import { INVALID_META_HEADS } from '../src/c4/validate';
import { parsePlan } from '../src/plan/parser';
import { requireProject } from '../src/outputs';
import type { Snapshot } from '../src/types';

// P18-T2: the gate (evaluatePlanEdit) and the writer (commitPlanEdit).
const UID = '00000000-0000-4000-8000-000000000001';
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      auth = component 'Auth' {",
  '        metadata {',
  `          uid '${UID}'`,
  "          layout '10,20,30,40'",
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const F = 'plan/a.c4';
const run = (oldText: string, newText: string, scan?: (p: any) => Snapshot) =>
  evaluatePlanEdit({ repoRoot: '/nowhere', oldTexts: new Map([[F, oldText]]), newTexts: new Map([[F, newText]]), scan });

const setAuth = (text: string, line: string) => text.replace("          layout '10,20,30,40'\n", `          layout '10,20,30,40'\n          ${line}\n`);

describe('evaluatePlanEdit', () => {
  it('a clean edit passes and carries one diff', () => {
    const r = run(PLAN, setAuth(PLAN, "status 'planned'"));
    expect(r.refused).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].diff).toContain("+          status 'planned'");
    expect(r.after.elements.find(e => e.id === 'app.api.auth')!.metadata.status).toBe('planned');
  });

  it('an unterminated string is a new parse issue: refused', () => {
    const r = run(PLAN, setAuth(PLAN, "owner 'K"));
    expect(r.refused).toBe(true);
    expect(r.newIssues.length).toBeGreaterThan(0);
  });

  it('a bogus status is a new warning: refused', () => {
    const r = run(PLAN, setAuth(PLAN, "status 'bogus'"));
    expect(r.refused).toBe(true);
    expect(r.newFindings.map(f => f.rule)).toContain('invalid-metadata');
  });

  it('a pre-existing warning is not new, a fixed one is listed', () => {
    const bad = setAuth(PLAN, "status 'bogus'");
    const other = bad.replace("system 'App'", "system 'App2'");
    const same = run(bad, other);
    expect(same.newFindings.filter(f => f.rule === 'invalid-metadata')).toEqual([]);
    expect(same.refused).toBe(false);
    const fixed = run(bad, setAuth(PLAN, "status 'done'\n          owner 'K'"));
    expect(fixed.refused).toBe(false);
    expect(fixed.fixedFindings.map(f => f.rule)).toEqual(['invalid-metadata']);
  });

  it('a title edit on an element with an old invalid-metadata warning is not refused (title is not part of the key)', () => {
    const bad = setAuth(PLAN, "status 'bogus'");
    const r = run(bad, bad.replace("component 'Auth'", "component 'Authentication'"));
    expect(r.newFindings.filter(f => f.rule === 'invalid-metadata')).toEqual([]);
    expect(r.refused).toBe(false);
    // a different problem on the renamed element is still new
    const worse = run(bad, bad.replace("component 'Auth'", "component 'Authentication'").replace("status 'bogus'", "status 'done'"));
    expect(worse.newFindings.map(f => f.message).join('|')).toContain('done but has no owner');
  });

  it('an existing parse issue does not block an unrelated edit (line shift ignored)', () => {
    const broken = PLAN.replace("model {\n", "model {\n  ??? junk\n");
    const r = run(broken, "// header\n" + broken);
    expect(r.after.issues.length).toBe(r.before.issues.length);
    expect(r.newIssues).toEqual([]);
    expect(r.newFindings).toEqual([]);
    expect(r.refused).toBe(false);
  });

  it('changing or removing a uid / layout line is refused', () => {
    const uidChanged = run(PLAN, PLAN.replace(UID, '00000000-0000-4000-8000-000000000002'));
    expect(uidChanged.refused).toBe(true);
    expect(uidChanged.reasons.join('\n')).toMatch(/protected line changed/);
    const layoutGone = run(PLAN, PLAN.replace("          layout '10,20,30,40'\n", ''));
    expect(layoutGone.refused).toBe(true);
  });

  it('adding a new uid line elsewhere is allowed', () => {
    const r = run(PLAN, PLAN.replace("      auth = component 'Auth' {", "      auth = component 'Auth' {\n        metadata { uid '00000000-0000-4000-8000-000000000009' }"));
    expect(r.reasons.filter(x => /protected/.test(x))).toEqual([]);
  });

  it('losing an element, dropping a file or creating a file is refused', () => {
    expect(run(PLAN, PLAN.replace("    api = container 'Api' {", "    api = bogus {")).reasons.join('\n')).toMatch(/lost|parse issue/);
    const dropped = evaluatePlanEdit({ repoRoot: '/nowhere', oldTexts: new Map([[F, PLAN]]), newTexts: new Map(), });
    expect(dropped.refused).toBe(true);
    const created = evaluatePlanEdit({ repoRoot: '/nowhere', oldTexts: new Map([[F, PLAN]]), newTexts: new Map([[F, PLAN], ['plan/b.c4', 'model {}\n']]) });
    expect(created.refused).toBe(true);
    expect(created.reasons.join('\n')).toMatch(/new file/);
  });

  it('remove: an element lost by the edit passes the gate only when listed in allowLost', () => {
    const removed = PLAN.replace(
      `      auth = component 'Auth' {\n        metadata {\n          uid '${UID}'\n          layout '10,20,30,40'\n        }\n      }\n`, '');
    expect(removed).not.toBe(PLAN);
    const gate = (allowLost?: string[]) =>
      evaluatePlanEdit({ repoRoot: '/nowhere', oldTexts: new Map([[F, PLAN]]), newTexts: new Map([[F, removed]]), allowLost });
    expect(gate().reasons).toContain('element lost by the edit: app.api.auth');
    expect(gate(['app.api.other']).refused).toBe(true);   // only the listed id is allowed
    const ok = gate(['app.api.auth']);
    expect(ok.reasons).toEqual([]);
    expect(ok.refused).toBe(false);
  });

  it('full mode (scan callback): a new info finding is listed but does not refuse', () => {
    const emptySnapshot = { system: { id: 'app' }, files: [], fileEdges: [], componentEdges: [], containers: [], components: [] } as unknown as Snapshot;
    const scan = jest.fn(() => emptySnapshot);
    const withFn = PLAN.replace(
      "      auth = component 'Auth' {",
      "      auth = component 'Auth' {\n        plan_fn = function 'planFn' {\n          metadata { status 'planned' }\n        }",
    );
    const r = run(PLAN, withFn, scan);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(r.newFindings.map(f => f.rule)).toContain('missing-signature');
    expect(r.newFindings.every(f => f.severity === 'info')).toBe(true);
    expect(r.refused).toBe(false);
  });
});

// b304 (S9): a title edit of an element that already carries an invalid-metadata finding is never refused, one case per head.
describe('evaluatePlanEdit: a title edit keeps an old invalid-metadata finding (INVALID_META_HEADS)', () => {
  const plan = (on: 'auth' | 'core' | 'home' | 'bot', line: string) => {
    const meta = (id: string) => `        metadata { ${id === on ? line : "owner 'K'"} }`;
    return ['model {', "  app = system 'App' {",
      "    api = container 'Api' {", "      auth = component 'Auth' {", meta('auth'), '      }',
      "      core = layer 'Core' {", meta('core'), '      }', '    }',
      "    web = container 'Web' {", "      home = screen 'Home' {", meta('home'), '      }', '    }',
      '  }', "  bot = person 'Bot' {", meta('bot').slice(4), '  }', '}', ''].join('\n');   // C1 C2 (b834): a person for the shape heads
  };
  const CASES: [string, 'auth' | 'core' | 'home' | 'bot', string][] = [
    ['unknown status', 'auth', "status 'bogus'"],
    ['unknown priority', 'auth', "priority 'urgent'"],
    ["sprint '", 'auth', "sprint 'x'"],
    ['done but', 'auth', "status 'done'"],
    ["uid '", 'auth', "uid 'nope'"],
    ["tag '", 'auth', "tags 'Billing'"],
    ['shared is only', 'auth', "shared 'true'"],
    ["shared '", 'core', "shared 'yes'"],
    ["viewport '", 'home', "viewport '00x00'"],
    ['shape is only', 'auth', "shape 'robot'"],
    ["shape '", 'bot', "shape 'android'"],
    ['role is only', 'home', "role 'foundation'"],   // home is a screen
    ["role '", 'auth', "role 'base'"],
  ];
  const TITLES = { auth: 'Auth', core: 'Core', home: 'Home', bot: 'Bot' };

  it('has one case per head', () => {
    expect(CASES.map(c => c[0])).toEqual([...INVALID_META_HEADS]);
  });

  it.each(CASES)('head %p: the old finding stays old after a title edit', (head, on, line) => {
    const bad = plan(on, line);
    const title = TITLES[on];
    const renamed = bad.replace(`'${title}' {`, `'${title} renamed' {`);
    expect(renamed).not.toBe(bad);
    const r = run(bad, renamed);
    expect(r.findingsBefore.filter(f => f.rule === 'invalid-metadata').map(f => f.message))
      .toEqual([expect.stringMatching(new RegExp(`^${title}: ${head}`))]);
    expect(r.findingsAfter.filter(f => f.rule === 'invalid-metadata').map(f => f.message))
      .toEqual([expect.stringMatching(new RegExp(`^${title} renamed: ${head}`))]);
    expect(r.newFindings.filter(f => f.rule === 'invalid-metadata')).toEqual([]);
    expect(r.reasons).toEqual([]);
    expect(r.refused).toBe(false);
  });
});

// MV-2 (PLAN_MOVE.md 3, 7.2): app.api.auth (uid, layout) with its planned function login (no uid) moves to app.web.
describe('evaluatePlanEdit with a move map', () => {
  const G = 'plan/b.c4';
  const AUTH = (uid = UID, extra: string[] = []) => [
    "      auth = component 'Auth' {",
    '        metadata {',
    `          uid '${uid}'`,
    "          layout '10,20,30,40'",
    ...extra,
    '        }',
    "        login = function 'login' {",
    "          metadata { status 'planned' }",
    '        }',
    '      }',
  ];
  const two = (api: string[], web: string[]) => ['model {', "  app = system 'App' {", "    api = container 'Api' {", ...api, '    }',
    "    web = container 'Web' {", ...web, '    }', '  }', '}', ''].join('\n');
  const EMPTY = 'model {\n}\n';
  const extendWeb = (body: string[]) => ['model {', '  extend app.web {', ...body, '  }', '}', ''].join('\n');
  const MAP = new Map([['app.api.auth', 'app.web.auth'], ['app.api.auth.login', 'app.web.auth.login']]);
  const ROWS = [{ from: 'app.api.auth', to: 'app.web.auth', uid: UID }, { from: 'app.api.auth.login', to: 'app.web.auth.login', uid: null }];
  const bogus = ["          status 'bogus'"];
  const stubScan = () => ({ system: { id: 'app' }, files: [], fileEdges: [], componentEdges: [], containers: [], components: [] } as unknown as Snapshot);
  const gate = (before: Record<string, string>, after: Record<string, string>, moved?: Map<string, string>, scan?: (p: any) => Snapshot) =>
    evaluatePlanEdit({ repoRoot: '/nowhere', oldTexts: new Map(Object.entries(before)), newTexts: new Map(Object.entries(after)), moved, scan });

  // last column: findings the plan had before the move, by rule (they must come back at the new fqn, neither new nor fixed)
  it.each<[string, Record<string, string>, Record<string, string>, ((p: any) => Snapshot) | undefined, string[]]>([
    ['same file', { [F]: two(AUTH(), []) }, { [F]: two([], AUTH()) }, undefined, []],
    ['to another file (uid and layout lines change file)', { [F]: two(AUTH(), []), [G]: EMPTY }, { [F]: two([], []), [G]: extendWeb(AUTH()) }, undefined, []],
    ['old warning at the moved id (fast mode)', { [F]: two(AUTH(UID, bogus), []) }, { [F]: two([], AUTH(UID, bogus)) }, undefined, ['invalid-metadata']],
    ['old info findings at the moved ids (--check)', { [F]: two(AUTH(), []) }, { [F]: two([], AUTH()) }, stubScan, ['missing-signature']],
  ])('passes, reported as moved: %s', (_name, before, after, scan, oldRules) => {
    const r = gate(before, after, MAP, scan);
    expect(r.reasons).toEqual([]);
    expect(r.refused).toBe(false);
    expect(r.moved).toEqual(ROWS);
    for (const rule of oldRules) expect(r.findingsBefore.map(f => f.rule)).toContain(rule);
    expect(r.newFindings).toEqual([]);
    expect(r.fixedFindings).toEqual([]);
  });

  it.each<[string, string, Map<string, string> | undefined, string[]]>([
    ['uid differs at the new fqn', two([], AUTH('00000000-0000-4000-8000-000000000002')), MAP,
      ['moved element not found: app.api.auth -> app.web.auth']],
    ['lost, not in the map: hint names the new fqn of its uid', two([], AUTH()), new Map(),
      ['element lost by the edit: app.api.auth (its uid is now on app.web.auth; use c4pm plan move)', 'element lost by the edit: app.api.auth.login']],
    ['no map: the reasons of every other command', two([], AUTH()), undefined,
      ['element lost by the edit: app.api.auth', 'element lost by the edit: app.api.auth.login']],
  ])('refused: %s', (_name, after, moved, expected) => {
    const r = gate({ [F]: two(AUTH(), []) }, { [F]: after }, moved);
    expect(r.refused).toBe(true);
    expect(r.reasons.filter(x => /^(moved element|element lost)/.test(x))).toEqual(expected);
  });
});

describe('commitPlanEdit', () => {
  let tmp: string;
  let planFile: string;
  const rel = (p: string) => path.relative(tmp, p).split(path.sep).join('/');

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-tx-')));
    fs.mkdirSync(path.join(tmp, '.git'));
    const planDir = requireProject(tmp).planDir;
    fs.mkdirSync(planDir, { recursive: true });
    planFile = path.join(planDir, 'a.c4');
    fs.writeFileSync(planFile, PLAN);
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const listing = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        out.push(rel(p) + ':' + (n.isFile() ? fs.statSync(p).size : 'd'));
        if (n.isDirectory()) walk(p);
      }
    };
    walk(tmp);
    return out.sort();
  };

  it('writes inside the plan folder and runs the postcondition on the re-read plan', () => {
    const file = rel(planFile);
    const next = setAuth(PLAN, "status 'planned'");
    const res = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: false,
      files: [{ file, oldText: PLAN, newText: next }],
      reparse: () => parsePlan(tmp, [file]),
      post: plan => (plan.elements.find(e => e.id === 'app.api.auth')?.metadata.status === 'planned' ? null : 'status missing'),
    });
    expect(res).toEqual({ ok: true });
    expect(fs.readFileSync(planFile, 'utf-8')).toBe(next);
  });

  it('a file outside .c4pm/ is refused and nothing is written, even for the other files', () => {
    const outsideDir = path.join(tmp, 'docs');
    fs.mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'x.c4');
    fs.writeFileSync(outside, PLAN);
    const before = listing();
    const bytesOutside = fs.readFileSync(outside);
    const bytesPlan = fs.readFileSync(planFile);
    const res = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: false,
      files: [
        { file: rel(planFile), oldText: PLAN, newText: PLAN + '// x\n' },
        { file: rel(outside), oldText: PLAN, newText: PLAN + '// x\n' },
      ],
      reparse: () => { throw new Error('must not be called'); },
      post: () => null,
    });
    expect(res).toMatchObject({ ok: false, reason: 'outside-c4pm' });
    expect(listing()).toEqual(before);
    expect(fs.readFileSync(outside).equals(bytesOutside)).toBe(true);
    expect(fs.readFileSync(planFile).equals(bytesPlan)).toBe(true);
    // force allows the outside .c4 file
    const forced = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: true,
      files: [{ file: rel(outside), oldText: PLAN, newText: PLAN + '// x\n' }],
      reparse: () => parsePlan(tmp, [rel(outside)]), post: () => null,
    });
    expect(forced).toEqual({ ok: true });
  });

  it('a non-.c4 file is never written, not even with force', () => {
    const txt = path.join(path.dirname(planFile), 'notes.txt');
    fs.writeFileSync(txt, 'hello');
    const res = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: true,
      files: [{ file: rel(txt), oldText: 'hello', newText: 'bye' }],
      reparse: () => { throw new Error('must not be called'); }, post: () => null,
    });
    expect(res).toMatchObject({ ok: false, reason: 'outside-c4pm' });
    expect(fs.readFileSync(txt, 'utf-8')).toBe('hello');
  });

  it('a failing postcondition restores the old bytes', () => {
    const file = rel(planFile);
    const bytes = fs.readFileSync(planFile);
    const res = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: false,
      files: [{ file, oldText: PLAN, newText: PLAN + '// x\n' }],
      reparse: () => parsePlan(tmp, [file]),
      post: () => 'postcondition failed',
    });
    expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
    expect((res as { detail: string }).detail).toContain('postcondition failed');
    expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);
  });

  it('rollback does not rewrite a file that was never modified (no misleading RESTORE FAILED)', () => {
    const second = path.join(path.dirname(planFile), 'b.c4');
    fs.writeFileSync(second, PLAN);
    fs.chmodSync(second, 0o444);   // its write fails; it was never changed, so restore must leave it alone
    const bytes = fs.readFileSync(planFile);
    try {
      const res = commitPlanEdit({
        repoRoot: tmp, project: requireProject(tmp), force: false,
        files: [
          { file: rel(planFile), oldText: PLAN, newText: PLAN + '// x\n' },
          { file: rel(second), oldText: PLAN, newText: PLAN + '// x\n' },
        ],
        reparse: () => parsePlan(tmp, [rel(planFile)]), post: () => null,
      });
      expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
      expect((res as { detail: string }).detail).not.toContain('RESTORE FAILED');
      expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);
      expect(fs.readFileSync(second, 'utf-8')).toBe(PLAN);
    } finally {
      fs.chmodSync(second, 0o644);
    }
  });

  it('a write that fails leaves the old file whole and no temp file (atomic: temp + rename)', () => {
    const file = rel(planFile);
    const bytes = fs.readFileSync(planFile);
    const before = listing();
    // the folder is read-only: the file itself is writable, but the temp file cannot be created. The error surfaces as rolled-back.
    const dir = path.dirname(planFile);
    fs.chmodSync(dir, 0o555);
    try {
      const res = commitPlanEdit({
        repoRoot: tmp, project: requireProject(tmp), force: false,
        files: [{ file, oldText: PLAN, newText: PLAN + '// x\n' }],
        reparse: () => { throw new Error('must not be called'); }, post: () => null,
      });
      expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
      // b723: writeAtomic names the plan file, not its temp file
      expect((res as { detail: string }).detail).toMatch(/^cannot write .*: permission denied/);
      expect((res as { detail: string }).detail).not.toContain('.tmp');
      expect((res as { detail: string }).detail).not.toContain('RESTORE FAILED');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);
    expect(listing()).toEqual(before);
  });

  describe('wireframe files (plan move / rename)', () => {
    let ioDir: string;
    let oldHtml: string;
    let newHtml: string;
    beforeEach(() => {
      ioDir = path.join(path.dirname(planFile), 'io');
      fs.mkdirSync(ioDir);
      oldHtml = path.join(ioDir, 'app.web.home.html');
      newHtml = path.join(ioDir, 'app.web.start.html');
      fs.writeFileSync(oldHtml, 'OLD');
    });
    const NEXT = PLAN + '// moved\n';
    const commit = (wireframes: { from: string; to: string; oldText: string; newText: string }[], post: () => string | null = () => null, dir: string | null = ioDir) =>
      commitPlanEdit({
        repoRoot: tmp, project: requireProject(tmp), force: false, ioDir: dir ?? undefined,
        files: [{ file: rel(planFile), oldText: PLAN, newText: NEXT }], wireframes,
        reparse: () => parsePlan(tmp, [rel(planFile)]), post,
      });
    const rename = () => ({ from: rel(oldHtml), to: rel(newHtml), oldText: 'OLD', newText: 'NEW' });

    it('renames and rewrites the file with the .c4 edit', () => {
      expect(commit([rename()])).toEqual({ ok: true });
      expect(fs.readFileSync(newHtml, 'utf-8')).toBe('NEW');
      expect(fs.existsSync(oldHtml)).toBe(false);
      expect(fs.readFileSync(planFile, 'utf-8')).toBe(NEXT);
    });

    it('a failing postcondition removes the new file and restores the old one and the .c4', () => {
      const before = listing();
      const res = commit([rename()], () => 'postcondition failed');
      expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
      expect((res as { detail: string }).detail).not.toContain('RESTORE FAILED');
      expect(listing()).toEqual(before);
      expect(fs.readFileSync(oldHtml, 'utf-8')).toBe('OLD');
      expect(fs.readFileSync(planFile, 'utf-8')).toBe(PLAN);
    });

    it.each<[string, () => { edit: ReturnType<typeof rename>; dir?: string | null }, string, RegExp]>([
      ['new name taken (collision)', () => { fs.writeFileSync(newHtml, 'TAKEN'); return { edit: rename() }; }, 'rolled-back', /collision: .*app\.web\.start\.html/],
      ['old file changed on disk', () => { fs.writeFileSync(oldHtml, 'EDITED'); return { edit: rename() }; }, 'rolled-back', /changed on disk/],
      ['target outside io/', () => ({ edit: { ...rename(), to: rel(path.join(ioDir, '..', 'x.html')) } }), 'outside-c4pm', /not a wireframe file/],
      ['name that is no fqn', () => ({ edit: { ...rename(), to: rel(path.join(ioDir, 'a b.html')) } }), 'outside-c4pm', /not a wireframe file/],
      ['old file is a symbolic link', () => {
        const real = path.join(tmp, 'real.html');
        fs.renameSync(oldHtml, real);
        fs.symlinkSync(real, oldHtml);
        return { edit: rename() };
      }, 'outside-c4pm', /not a wireframe file/],
      ['no io folder given', () => ({ edit: rename(), dir: null }), 'outside-c4pm', /not a wireframe file/],
    ])('refused, nothing written: %s', (_name, setup, reason, detail) => {
      const s = setup();
      const before = listing();
      const res = commit([s.edit], () => null, s.dir === undefined ? ioDir : s.dir);
      expect(res).toMatchObject({ ok: false, reason });
      expect((res as { detail: string }).detail).toMatch(detail);
      expect(listing()).toEqual(before);
      expect(fs.readFileSync(planFile, 'utf-8')).toBe(PLAN);
    });
  });

  describe('a create edit (W9 plan wireframe: a new file, no .c4 change)', () => {
    let ioDir: string;
    let html: string;
    beforeEach(() => {
      ioDir = path.join(path.dirname(planFile), 'io');
      html = path.join(ioDir, 'app.web.home.html');
    });
    const commit = (post: () => string | null = () => null) =>
      commitPlanEdit({
        repoRoot: tmp, project: requireProject(tmp), force: false, ioDir, files: [],
        wireframes: [{ from: rel(html), to: rel(html), oldText: '', newText: 'NEW', create: true }],
        reparse: () => parsePlan(tmp, [rel(planFile)]), post,
      });

    it('writes the file and makes io/ when it is missing', () => {
      expect(commit()).toEqual({ ok: true });
      expect(fs.readFileSync(html, 'utf-8')).toBe('NEW');
    });

    it.each([['io/ missing', false], ['io/ there', true]])('a failing postcondition removes the file and the io/ it made (%s)', (_name, hadIo) => {
      if (hadIo) fs.mkdirSync(ioDir);
      const before = listing();
      const res = commit(() => 'postcondition failed');
      expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
      expect((res as { detail: string }).detail).toBe('postcondition failed');
      expect(listing()).toEqual(before);
      expect(fs.existsSync(ioDir)).toBe(hadIo);
    });

    it('a create over an existing file is refused before writing', () => {
      fs.mkdirSync(ioDir);
      fs.writeFileSync(html, 'OLD');
      const before = listing();
      const res = commit();
      expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
      expect((res as { detail: string }).detail).toMatch(/^nothing written: .*app\.web\.home\.html exists/);
      expect(listing()).toEqual(before);
      expect(fs.readFileSync(html, 'utf-8')).toBe('OLD');
    });

    it('a rewrite (no create) still needs io/ to exist', () => {
      const res = commitPlanEdit({
        repoRoot: tmp, project: requireProject(tmp), force: false, ioDir, files: [],
        wireframes: [{ from: rel(html), to: rel(html), oldText: '', newText: 'NEW' }],
        reparse: () => parsePlan(tmp, [rel(planFile)]), post: () => null,
      });
      expect(res).toMatchObject({ ok: false, reason: 'outside-c4pm', detail: expect.stringMatching(/not a wireframe file/) });
      expect(fs.existsSync(ioDir)).toBe(false);
    });
  });

  it('a file changed on disk since it was read: nothing is written', () => {
    const file = rel(planFile);
    fs.writeFileSync(planFile, PLAN + '// edited by someone\n');
    const bytes = fs.readFileSync(planFile);
    const res = commitPlanEdit({
      repoRoot: tmp, project: requireProject(tmp), force: false,
      files: [{ file, oldText: PLAN, newText: PLAN + '// x\n' }],
      reparse: () => parsePlan(tmp, [file]), post: () => null,
    });
    expect(res).toMatchObject({ ok: false, reason: 'rolled-back' });
    expect(fs.readFileSync(planFile).equals(bytes)).toBe(true);
  });
});
