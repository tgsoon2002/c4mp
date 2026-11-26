import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext, openQueryBase, queryBaseOf } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { findElements, outlineFile } from '../src/query/find';
import { ownerByPathClaims, ownerOf, ownerOfPath, explainOwner } from '../src/query/owner';
import { showTarget } from '../src/query/show';

const FIX = path.join(__dirname, 'fixtures');

function catchQueryError(fn: () => unknown): QueryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QueryError);
    return err as QueryError;
  }
  throw new Error('expected QueryError');
}

describe('ownerOf / explainOwner', () => {
  let level4: QueryContext;
  let phofast: QueryContext;
  let sample: QueryContext;

  beforeAll(() => {
    level4 = loadQueryContext(path.join(FIX, 'level4'));
    phofast = loadQueryContext(path.join(FIX, 'phofast'));
    sample = loadQueryContext(path.join(FIX, 'sample'));
  });

  it('fixtures are in the mode the tests rely on', () => {
    expect(level4.claimMode).toBe(true);
    // Differs from the plan row: phofast links are line ranges (#L7-L14), so it is folder mode.
    expect(phofast.claimMode).toBe(false);
    expect(sample.claimMode).toBe(false);
  });

  /** Every function of ctx: explainOwner must agree with ownerOf. Returns how many were checked. */
  function checkAll(ctx: QueryContext): number {
    let checked = 0;
    for (const f of ctx.snapshot.files) {
      for (const e of f.elements) {
        const owner = ownerOf(ctx, f.file, e.name);
        const why = explainOwner(ctx, f.file, e.name);
        if (!ctx.claimMode) {
          expect(why).toEqual({ mode: 'folder-mode' });
        } else if (owner.kind === 'component') {
          const el = ctx.plan!.elements.find((x) => x.id === owner.id)!;
          expect(why.mode).toBe('claim');
          expect(why.claim?.elementId).toBe(owner.id);
          expect(el.links.map((l) => l.raw)).toContain(why.claim?.link);
          expect(why.claim?.planFile).toBe(el.source.file);
        } else {
          expect(why).toEqual({ mode: 'claim', auto: owner.kind });
        }
        checked++;
      }
    }
    return checked;
  }

  it('level4: explainOwner agrees with ownerOf on every function', () => {
    expect(checkAll(level4)).toBeGreaterThan(0);
  });

  it('phofast: explainOwner agrees with ownerOf on every function', () => {
    expect(checkAll(phofast)).toBeGreaterThan(0);
  });

  it('level4 claim mode: function claim, title from the plan', () => {
    const owner = ownerOf(level4, 'src/built.ts', 'buildInvoice');
    expect(owner.kind).toBe('component');
    const el = level4.plan!.elements.find((e) => e.id === owner.id)!;
    expect(owner.title).toBe(el.title);
    const why = explainOwner(level4, 'src/built.ts', 'buildInvoice');
    expect(why.mode).toBe('claim');
    expect(why.claim?.kind).toBe('function');
    expect(why.claim?.link).toContain('built.ts#buildInvoice');
    expect(why.claim?.planFile).toBe(el.source.file);
  });

  it('claim mode without name: file-level owner is a known ref', () => {
    const f = level4.snapshot.files[0];
    const owner = ownerOf(level4, f.file);
    expect(['component', 'shared', 'unassigned']).toContain(owner.kind);
    expect(owner.id).toBe(level4.ownership!.fileOwner?.[f.file] ?? f.componentId);
  });

  it('claim mode unclaimed function: auto kinds carry fixed ids', () => {
    for (const f of level4.snapshot.files) {
      for (const e of f.elements) {
        const owner = ownerOf(level4, f.file, e.name);
        if (owner.kind === 'shared') expect(owner).toEqual({ id: 'shared-auto', title: 'Shared', kind: 'shared' });
        if (owner.kind === 'unassigned') expect(owner.id).toBe('unassigned');
      }
    }
  });

  it('folder mode (sample): owner is the file component, explain says folder-mode', () => {
    const f = sample.snapshot.files.find((x) => x.elements.length > 0)!;
    const comp = sample.snapshot.components.find((c) => c.id === f.componentId)!;
    expect(ownerOf(sample, f.file)).toEqual({ id: comp.id, title: comp.name, kind: 'component' });
    expect(ownerOf(sample, f.file, f.elements[0].name).id).toBe(comp.id);
    expect(explainOwner(sample, f.file, f.elements[0].name)).toEqual({ mode: 'folder-mode' });
  });

  it('claim mode on a temp repo: specificity, plan-order tie, unassigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-owner-'));
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('src/a.ts', "import { shared } from './b';\nexport function f1() { return shared(); }\nexport function f2() { return 2; }\n");
    write('src/b.ts', 'export function shared() { return 1; }\n');
    write('src/sub/c.ts', 'export function lonely() { return 3; }\n');
    write('other/d.ts', 'export function loose() { return 4; }\n');
    write(
      'c4/plan.c4',
      [
        'specification {',
        '  element component',
        '}',
        'model {',
        "  alpha = component 'Alpha' {",
        '    link ../src/',
        '  }',
        "  beta = component 'Beta' {",
        '    link ../src/',
        '    link ../src/a.ts',
        '  }',
        "  gamma = component 'Gamma' {",
        '    link ../src/a.ts#f1',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const ctx = loadQueryContext(dir);
    expect(ctx.claimMode).toBe(true);

    // function claim beats file claim and folder claims
    expect(ownerOf(ctx, 'src/a.ts', 'f1')).toEqual({ id: 'gamma', title: 'Gamma', kind: 'component' });
    expect(explainOwner(ctx, 'src/a.ts', 'f1').claim).toEqual({
      kind: 'function', link: '../src/a.ts#f1', path: 'src/a.ts#f1', planFile: 'c4/plan.c4', elementId: 'gamma',
    });
    // file claim (beta) beats folder claims
    expect(explainOwner(ctx, 'src/a.ts', 'f2').claim).toMatchObject({ kind: 'file', elementId: 'beta', link: '../src/a.ts', path: 'src/a.ts' });
    // two folder claims tie: alpha appears first in ctx.claims
    expect(explainOwner(ctx, 'src/b.ts', 'shared').claim).toMatchObject({ kind: 'folder', elementId: 'alpha', path: 'src/' });
    expect(ownerOf(ctx, 'src/sub/c.ts', 'lonely').id).toBe('alpha');
    // unclaimed and not imported by an owned file
    expect(ownerOf(ctx, 'other/d.ts', 'loose')).toEqual({ id: 'unassigned', title: 'Unassigned', kind: 'unassigned' });
    expect(explainOwner(ctx, 'other/d.ts', 'loose')).toEqual({ mode: 'claim', auto: 'unassigned' });
    // every function: explain equals owner
    for (const f of ctx.snapshot.files) {
      for (const e of f.elements) {
        const owner = ownerOf(ctx, f.file, e.name);
        const why = explainOwner(ctx, f.file, e.name);
        expect(why.claim?.elementId ?? why.auto).toBe(owner.kind === 'component' ? owner.id : owner.kind);
      }
    }
  });

  // b665: the plan sits outside the scanned folder (main checkout: .c4pm/projects/<p>/plan/ with --repo Project), so the link
  // text is `../../../Project/src/...`; claim.path is the repo-relative claim, claim.link stays the raw plan text.
  it('claim.path is repo-relative when the plan lives outside the scanned folder', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-owner-deep-'));
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
      fs.writeFileSync(path.join(top, rel), text);
    };
    write('Project/src/a.ts', 'export function f1() { return 1; }\nexport function f2() { return 2; }\n');
    write('Project/src/lib/b.ts', 'export function g() { return 3; }\n');
    write('arch/deep/plan/plan.c4', [
      'specification {', '  element component', '}', 'model {',
      "  one = component 'One' {", '    link ../../../Project/src/a.ts#f1', '  }',
      "  two = component 'Two' {", '    link ../../../Project/src/a.ts', '  }',
      "  lib = component 'Lib' {", '    link ../../../Project/src/lib/', '  }',
      '}', '',
    ].join('\n'));
    try {
      const ctx = loadQueryContext(path.join(top, 'Project'), { cli: { architectureDir: '../arch/deep/plan' } });
      expect(ctx.claimMode).toBe(true);
      expect(explainOwner(ctx, 'src/a.ts', 'f1').claim).toMatchObject({
        kind: 'function', path: 'src/a.ts#f1', link: '../../../Project/src/a.ts#f1',
      });
      expect(explainOwner(ctx, 'src/a.ts', 'f2').claim).toMatchObject({ kind: 'file', path: 'src/a.ts' });
      expect(explainOwner(ctx, 'src/lib/b.ts', 'g').claim).toMatchObject({ kind: 'folder', path: 'src/lib/' });
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  });

  // STOR-4 (b336): the owner of any path. A scanned file as ownerOf; a file the scan does not walk (a .sql migration) by the
  // folder / file claims (most specific, then plan order); no claim or folder mode: unassigned.
  it('ownerOfPath: scanned = ownerOf; unscanned by path claims; else unassigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ownerpath-'));
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('src/a.ts', 'export function f() { return 1; }\n');
    write('db/init.sql', 'CREATE TABLE t (id int);\n');
    write('c4/plan.c4', [
      'specification {', '  element component', '}', 'model {',
      "  logic = component 'Logic' {", '    link ../src/a.ts#f', '  }',
      "  alpha = component 'Alpha' {", '    link ../db/', '  }',
      "  beta = component 'Beta' {", '    link ../db/', '    link ../db/init.sql', '  }',
      "  gamma = component 'Gamma' {", '    link ../db/', '  }',
      '}', '',
    ].join('\n'));
    try {
      const ctx = loadQueryContext(dir);
      expect(ctx.claimMode).toBe(true);
      expect(ownerOfPath(ctx, 'src/a.ts')).toEqual(ownerOf(ctx, 'src/a.ts'));
      expect(ownerOfPath(ctx, 'db/init.sql')).toEqual({ id: 'beta', title: 'Beta', kind: 'component' });   // file beats folder
      expect(ownerOfPath(ctx, 'db/other.sql').id).toBe('alpha');                                           // folder tie: plan order
      expect(ownerOfPath(ctx, 'migrations/x.sql')).toEqual({ id: 'unassigned', title: 'Unassigned', kind: 'unassigned' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const f = sample.snapshot.files[0];
    expect(ownerOfPath(sample, f.file)).toEqual(ownerOf(sample, f.file));
    expect(ownerOfPath(sample, 'db/init.sql')).toEqual({ id: 'unassigned', title: 'Unassigned', kind: 'unassigned' });
  });

  // b683: the plan view and the path-claim owner need no scan; the scan reuses the view; folder mode has no claims.
  it('planView and ownerByPathClaims: no scan, same owner as ownerOfPath, view reused by the scan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-planview-'));
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('src/a.ts', 'export function f() { return 1; }\n');
    write('db/init.sql', 'CREATE TABLE t (id int);\n');
    write('db/notes.json', '{}\n');
    write('c4/plan.c4', [
      'specification {', '  element component', '}', 'model {',
      "  logic = component 'Logic' {", '    link ../src/a.ts#f', '  }',
      "  alpha = component 'Alpha' {", '    link ../db/', '  }',
      "  beta = component 'Beta' {", '    link ../db/', '    link ../db/init.sql', '  }',
      "  gamma = component 'Gamma' {", '    link ../db/', '  }',
      '}', '',
    ].join('\n'));
    try {
      const base = { ...openQueryBase(dir), full: (): never => { throw new Error('the scan must not run'); } };
      const view = base.planView();
      expect(view.claimMode).toBe(true);
      expect(base.planView()).toBe(view);
      expect(ownerByPathClaims(view, 'db/init.sql')).toEqual({ id: 'beta', title: 'Beta', kind: 'component' });
      expect(ownerByPathClaims(view, 'db/notes.json').id).toBe('alpha');
      expect(ownerByPathClaims(view, 'x.json')).toEqual({ id: 'unassigned', title: 'Unassigned', kind: 'unassigned' });

      const ctx = loadQueryContext(dir);
      expect(ownerByPathClaims(ctx, 'db/init.sql')).toEqual(ownerOfPath(ctx, 'db/init.sql'));
      expect(queryBaseOf(ctx).planView()).toBe(ctx);

      const b = openQueryBase(dir);
      const v = b.planView();
      expect(b.full().plan).toBe(v.plan);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(ownerByPathClaims(openQueryBase(path.join(FIX, 'sample')).planView(), 'package.json'))
      .toEqual({ id: 'unassigned', title: 'Unassigned', kind: 'unassigned' });
  });

  // b705 (b509 regression): folder mode gives a test file outside every component the owner 'unassigned' (T26-14b);
  // ownerOf and every query on top of it must return the auto ref, not throw "not a component of the snapshot".
  it('folder mode: a test file alone in its folder is unassigned, and find / outline / show do not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-owner-folder-'));
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('src/a.py', 'def check_x():\n    pass\n');
    write('tests/test_x.py', 'def test_x():\n    pass\n');
    try {
      const ctx = loadQueryContext(dir, { cli: { languages: ['python'] } });
      expect(ctx.claimMode).toBe(false);
      const unassigned = { id: 'unassigned', title: 'Unassigned', kind: 'unassigned' };
      expect(ownerOf(ctx, 'tests/test_x.py')).toEqual(unassigned);
      expect(ownerOf(ctx, 'tests/test_x.py', 'test_x')).toEqual(unassigned);
      expect(ownerOfPath(ctx, 'tests/test_x.py')).toEqual(unassigned);
      expect(ownerOf(ctx, 'src/a.py').kind).toBe('component');
      const hits = findElements(ctx, { query: 'test_x' }).results;
      expect(hits.map((r) => r.owner)).toContainEqual(unassigned);
      expect(outlineFile(ctx, 'tests/test_x.py').elements[0].owner).toEqual(unassigned);
      expect(showTarget(ctx, 'tests/test_x.py#test_x').owner).toEqual(unassigned);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown file / function throw not-found', () => {
    expect(catchQueryError(() => ownerOf(sample, 'nope.ts')).code).toBe('not-found');
    expect(catchQueryError(() => ownerOf(level4, 'src/built.ts', 'nope')).code).toBe('not-found');
    expect(catchQueryError(() => explainOwner(level4, 'src/built.ts', 'nope')).code).toBe('not-found');
  });
});
