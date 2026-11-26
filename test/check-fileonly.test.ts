import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { checkPlan } from '../src/c4/check';
import type { Plan, PlanElement, PlanLink } from '../src/types';

// P14-T28b: how `check` treats file-only files (languages ['typescript','files'], e.g. .java).
// Plans are built directly (same PlanElement shape as test/check.test.ts) over a tmp tree, because
// the files must exist on disk for runSnapshot and for resolveLinks' existence check.

function link(raw: string, p: string, name: string | null): PlanLink {
  return { raw, path: p, name, lines: null, title: null };
}

function component(id: string, links: PlanLink[]): PlanElement {
  return {
    id,
    kind: 'component',
    title: id,
    description: null,
    technology: null,
    links,
    metadata: {},
    parent: null,
    source: { file: 'test.c4', line: 1 },
  };
}

function planOf(elements: PlanElement[]): Plan {
  return { files: ['test.c4'], elements, relations: [], issues: [] };
}

describe('check on file-only files', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-check-fileonly-'));
    fs.mkdirSync(path.join(repo, 'svc'));
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'svc', 'A.java'), 'class A {\n  void run() {}\n}\n');
    fs.writeFileSync(path.join(repo, 'lib', 'B.java'), 'class B {}\n');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const scan = (plan: Plan) =>
    runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript', 'files'] }, plan });

  it('a function claim on a file-only file is broken-function (the file has no parsed functions)', () => {
    const plan = planOf([component('app.svc', [link('./svc/A.java#run', 'svc/A.java', 'run')])]);
    const findings = checkPlan(plan, scan(plan), repo);

    const broken = findings.filter((f) => f.rule === 'broken-function');
    expect(broken).toHaveLength(1);
    expect(broken[0].id).toBe('app.svc');
    expect(broken[0].message).toContain('run');
    expect(broken[0].message).toContain('svc/A.java');
  });

  it('folder-mode plan: a file-only file no element claims is unplanned-code; a claimed one is not', () => {
    const plan = planOf([component('app.svc', [link('./svc/', 'svc/', null)])]);
    const findings = checkPlan(plan, scan(plan), repo);

    const unplanned = findings.filter((f) => f.rule === 'unplanned-code').map((f) => f.id);
    expect(unplanned).toEqual(['lib/B.java']);
  });
});
