import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext, fileOf, elementsOf } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { errorJson, formatError } from '../src/query/format';
import { readerExtensions } from '../src/schema/readers';

const FIX = path.join(__dirname, 'fixtures');

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qctx-'));
  for (const [rel, text] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text);
  }
  return dir;
}

/** Sorted "relpath:mtimeMs" lines of every entry under dir. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      out.push(`${path.relative(dir, fp)}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(fp);
    }
  };
  walk(dir);
  return out.sort();
}

function catchQueryError(fn: () => unknown): QueryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QueryError);
    return err as QueryError;
  }
  throw new Error('expected QueryError');
}

describe('loadQueryContext', () => {
  it('folder mode (sample): no plan, no ownership', () => {
    const ctx = loadQueryContext(path.join(FIX, 'sample'));
    expect(ctx.plan).toBeNull();
    expect(ctx.ownership).toBeNull();
    expect(ctx.claimMode).toBe(false);
    expect(ctx.claims).toEqual([]);
    expect(ctx.planIssues).toEqual([]);
    expect(ctx.snapshot.files.length).toBeGreaterThan(0);
    expect(ctx.builtAt).toBe(ctx.snapshot.meta.createdAt);
    expect(ctx.fingerprint).toBe('');
    expect(ctx.extraExtensions).toEqual(readerExtensions());   // STOR-4 (A17): the storage readers' files, for the fingerprint
  });

  it('claim mode (level4): claims and ownership present', () => {
    const ctx = loadQueryContext(path.join(FIX, 'level4'));
    expect(ctx.plan).not.toBeNull();
    expect(ctx.claimMode).toBe(true);
    expect(ctx.claims.some((c) => c.kind === 'function')).toBe(true);
    expect(ctx.ownership).not.toBeNull();
  });

  it('plan with only file/line links (phofast): plan set, ownership null', () => {
    const ctx = loadQueryContext(path.join(FIX, 'phofast'));
    expect(ctx.plan).not.toBeNull();
    expect(ctx.claimMode).toBe(false);
    expect(ctx.ownership).toBeNull();
  });

  it('temp repo with no .c4pm and a file-link .c4: works, writes nothing', () => {
    const dir = tempRepo({
      'src/a.ts': 'export function a(): number { return 1; }\n',
      'plan.c4': "model {\n  sys = system 'S' {\n    c = component 'C' {\n      link ./src/a.ts 'a'\n    }\n  }\n}\n",
    });
    const before = listing(dir);
    const ctx = loadQueryContext(dir);
    expect(ctx.plan).not.toBeNull();
    expect(ctx.claimMode).toBe(false);
    expect(ctx.ownership).toBeNull();
    expect(fs.existsSync(path.join(dir, '.c4pm'))).toBe(false);
    expect(listing(dir)).toEqual(before);
  });

  it('plan issues are returned, not thrown', () => {
    const dir = tempRepo({
      'src/a.ts': 'export function a(): number { return 1; }\n',
      'plan.c4': 'this is not valid c4 @@@ {{{\n',
    });
    const ctx = loadQueryContext(dir);
    expect(ctx.plan).not.toBeNull();
    expect(ctx.planIssues).toBe(ctx.plan!.issues);
  });

  it('invalid .c4pm/config.json becomes scan-failed', () => {
    const dir = tempRepo({
      'src/a.ts': 'export const a = 1;\n',
      '.c4pm/config.json': '{ not json',
    });
    const err = catchQueryError(() => loadQueryContext(dir));
    expect(err.code).toBe('scan-failed');
    expect(err.message.length).toBeGreaterThan(0);
  });

  // b504: the internal collectCalls option; Plan editing's remove passes 'tests' (the scan the page build makes).
  it.each([
    ['default: the calls of every file', undefined, ['src/a.test.ts', 'src/a.ts']],
    ["'tests': the calls of the test files only", 'tests' as const, ['src/a.test.ts']],
  ])('collectCalls %s', (_name, collectCalls, files) => {
    const dir = tempRepo({
      'src/a.ts': 'export function a(): number { return b(); }\nfunction b(): number { return 1; }\n',
      'src/a.test.ts': "import { a } from './a';\nit('a', () => { a(); });\n",
    });
    const ctx = loadQueryContext(dir, collectCalls ? { collectCalls } : {});
    expect(ctx.snapshot.calls?.map((c) => c.file)).toEqual(files);
  });

  it('unknown language becomes scan-failed', () => {
    const dir = tempRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const err = catchQueryError(() => loadQueryContext(dir, { cli: { languages: ['cobol'] } }));
    expect(err.code).toBe('scan-failed');
    expect(err.message).toMatch(/cobol/);
  });

  // b728: scan-failed keeps the original error (and its stack) as `cause`; the printed error stays code + message.
  it('scan-failed keeps the original error as cause; formatError and errorJson are unchanged', () => {
    const dir = tempRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const err = catchQueryError(() => loadQueryContext(dir, { cli: { languages: ['cobol'] } }));
    const cause = (err as QueryError & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(QueryError);
    expect((cause as Error).message).toBe(err.message);
    expect((cause as Error).stack).toContain((cause as Error).message);
    expect(formatError(err)).toBe(`error: scan-failed: ${err.message}`);
    expect(errorJson(err)).toEqual({ error: { code: 'scan-failed', message: err.message } });
  });
});

describe('fileOf / elementsOf', () => {
  const ctx = loadQueryContext(path.join(FIX, 'level4'));

  it('fileOf matches the exact path only', () => {
    const f = ctx.snapshot.files.find((x) => x.elements.length > 0)!;
    expect(fileOf(ctx, f.file)).toBe(f);
    expect(fileOf(ctx, f.file + 'x')).toBeUndefined();
    expect(fileOf(ctx, path.basename(f.file))).toBe(f.file === path.basename(f.file) ? f : undefined);
  });

  it('elementsOf returns all elements with the name, none when absent', () => {
    const f = ctx.snapshot.files.find((x) => x.elements.length > 0)!;
    const name = f.elements[0].name;
    const expected = f.elements.filter((e) => e.name === name);
    expect(elementsOf(ctx, f, name)).toEqual(expected);
    expect(elementsOf(ctx, f, '__nope__')).toEqual([]);
  });
});
