import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext, openQueryBase } from '../src/query/context';
import { QueryError } from '../src/query/errors';
import { showTarget } from '../src/query/show';

const FIX = path.join(__dirname, 'fixtures');
const SERVICE = 'api/src/services/orderService.ts';

function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-show-'));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  return fs.realpathSync(dir);
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

/** Lines `a..b` (1-based) of a file, same as `sed -n 'a,bp'`. */
function lines(file: string, a: number, b: number): string[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(a - 1, b);
}

describe('showTarget', () => {
  let repo: string;
  let outside: string;
  let ctx: ReturnType<typeof loadQueryContext>;
  const file = (rel: string): string => path.join(repo, rel);

  beforeAll(() => {
    repo = copyFixture('sample');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-show-out-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const SECRET = 1;\n');
    // 500-line file for truncation, CRLF file for line-ending handling.
    fs.writeFileSync(file('api/src/big.ts'), Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    fs.writeFileSync(file('api/src/crlf.ts'), 'export function a() {\r\n  return 1;\r\n}\r\n');
    ctx = loadQueryContext(repo);
  });

  it('shows a function with the exact lines of the file', () => {
    const el = ctx.snapshot.files.find((f) => f.file === 'api/src/lib/log.ts')!.elements[0];
    const r = showTarget(ctx, `api/src/lib/log.ts#${el.name}`);
    expect(r.targetKind).toBe('element');
    expect(r.name).toBe(el.name);
    expect(r.elementKind).toBe(el.kind);
    expect(r.startLine).toBe(el.startLine);
    expect(r.endLine).toBe(el.endLine);
    expect(r.code).toEqual(lines(file('api/src/lib/log.ts'), el.startLine, el.endLine));
    expect(r.truncated).toBe(false);
    expect(r.owner.id).toBeTruthy();
    expect(r.how).toEqual({ mode: 'folder-mode' });
  });

  it('shows a method (Class.method)', () => {
    const r = showTarget(ctx, `${SERVICE}#OrderService.create`);
    expect(r.elementKind).toBe('method');
    expect(r.startLine).toBe(6);
    expect(r.code).toEqual(lines(file(SERVICE), r.startLine, r.endLine));
    expect(r.code[0]).toContain('create(');
  });

  it('a class range includes its methods', () => {
    const r = showTarget(ctx, `${SERVICE}#OrderService`);
    expect(r.elementKind).toBe('class');
    expect(r.code.join('\n')).toContain('create(');
    expect(r.code.join('\n')).toContain('static find');
  });

  it('shows a line range, clamped to the end of file', () => {
    const r = showTarget(ctx, `${SERVICE}#L4-L8`);
    expect(r).toMatchObject({ targetKind: 'range', startLine: 4, endLine: 8 });
    expect(r.code).toEqual(lines(file(SERVICE), 4, 8));
    expect(r.how).toBeUndefined();
    const beyond = showTarget(ctx, `${SERVICE}#L15-L999`);
    expect(beyond.endLine).toBe(beyond.totalLines);
    expect(beyond.truncated).toBe(false);
    expect(showTarget(ctx, `${SERVICE}#L3`).code).toEqual(lines(file(SERVICE), 3, 3));
  });

  it('shows a whole file and does not count the trailing newline', () => {
    const r = showTarget(ctx, SERVICE);
    expect(r).toMatchObject({ targetKind: 'file', startLine: 1 });
    expect(r.totalLines).toBe(fs.readFileSync(file(SERVICE), 'utf8').split('\n').length - 1);
    expect(r.code).toHaveLength(r.totalLines);
    expect(r.endLine).toBe(r.totalLines);
  });

  it('normalises CRLF', () => {
    const r = showTarget(ctx, 'api/src/crlf.ts');
    expect(r.code).toEqual(['export function a() {', '  return 1;', '}']);
  });

  it('truncates at maxLines (default and explicit, max 400)', () => {
    const def = showTarget(ctx, 'api/src/big.ts');
    expect(def.code).toHaveLength(400);
    expect(def).toMatchObject({ truncated: true, totalLines: 500, startLine: 1, endLine: 400 });
    expect(showTarget(ctx, 'api/src/big.ts', { maxLines: 1000 }).code).toHaveLength(400);
    const few = showTarget(ctx, 'api/src/big.ts#L10-L50', { maxLines: 5 });
    expect(few).toMatchObject({ truncated: true, startLine: 10, endLine: 14 });
    expect(few.code).toEqual(lines(file('api/src/big.ts'), 10, 14));
    expect(showTarget(ctx, 'api/src/big.ts#L10-L14', { maxLines: 5 }).truncated).toBe(false);
  });

  it.each([0, -1, 1.5, NaN])('rejects maxLines %p', (n) => {
    expect(catchQueryError(() => showTarget(ctx, SERVICE, { maxLines: n })).code).toBe('invalid');
  });

  it.each([
    ['relative ../', '../../etc/hosts'],
    ['absolute path', '/etc/hosts'],
    ['dot-dot inside', 'api/../../x'],
    ['absolute with fragment', '/etc/hosts#L1-L2'],
    ['URL', 'https://example.com/x.ts'],
  ])('refuses %s as out-of-repo', (_n, target) => {
    const err = catchQueryError(() => showTarget(ctx, target));
    expect(err.code).toBe('out-of-repo');
  });

  it('refuses a symlink that now points outside the repo', () => {
    const link = file('api/src/lib/log.ts');
    const saved = fs.readFileSync(link);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(outside, 'secret.ts'), link);
    try {
      const err = catchQueryError(() => showTarget(ctx, 'api/src/lib/log.ts'));
      expect(err.code).toBe('out-of-repo');
      expect(err.message).not.toContain('SECRET');
    } finally {
      fs.unlinkSync(link);
      fs.writeFileSync(link, saved);
    }
  });

  it.each([
    ['ignored folder', 'node_modules/ignored/index.js'],
    ['yaml file', 'api/config.yml'],
    ['.d.ts file', 'api/src/types.d.ts'],
    ['folder', 'api/src/'],
    ['unknown file', 'api/src/nope.ts'],
  ])('not-found: %s', (_n, target) => {
    expect(catchQueryError(() => showTarget(ctx, target)).code).toBe('not-found');
  });

  it('not-found for an unknown name, invalid for bad input', () => {
    expect(catchQueryError(() => showTarget(ctx, `${SERVICE}#nope`)).code).toBe('not-found');
    expect(catchQueryError(() => showTarget(ctx, `${SERVICE}#L0`)).code).toBe('invalid');
    expect(catchQueryError(() => showTarget(ctx, `${SERVICE}#L9-L3`)).code).toBe('invalid');
    expect(catchQueryError(() => showTarget(ctx, `${SERVICE}#L500`)).code).toBe('invalid');
    expect(catchQueryError(() => showTarget(ctx, '')).code).toBe('invalid');
    expect(catchQueryError(() => showTarget(ctx, '#OrderService')).code).toBe('invalid');
  });

  it('stale scan: file shorter than a recorded element is scan-failed, deleted file too', () => {
    const p = file('api/src/lib/log.ts');
    const saved = fs.readFileSync(p);
    const el = ctx.snapshot.files.find((f) => f.file === 'api/src/lib/log.ts')!.elements[0];
    try {
      fs.writeFileSync(p, '\n');
      expect(catchQueryError(() => showTarget(ctx, `api/src/lib/log.ts#${el.name}`)).code).toBe('scan-failed');
      fs.unlinkSync(p);
      expect(catchQueryError(() => showTarget(ctx, 'api/src/lib/log.ts')).code).toBe('scan-failed');
    } finally {
      fs.writeFileSync(p, saved);
    }
  });

  it('Python getter + setter of one name: the name shows the getter, name#2 the setter (b138), a range either', () => {
    const py = copyFixture('pyshop');
    fs.writeFileSync(
      path.join(py, 'shop', 'dup.py'),
      [
        'class Box:',
        '    @property',
        '    def size(self):',
        '        return self._s',
        '',
        '    @size.setter',
        '    def size(self, v):',
        '        self._s = v',
        '',
      ].join('\n'),
    );
    const pctx = loadQueryContext(py, { cli: { languages: ['python'] } });
    const shown = (t: string) => {
      const r = showTarget(pctx, `shop/dup.py#${t}`);
      return [r.name, r.startLine, r.endLine, r.code[r.code.length - 1].trim()];
    };
    expect(shown('Box.size')).toEqual(['Box.size', 2, 4, 'return self._s']);
    expect(shown('Box.size#2')).toEqual(['Box.size#2', 6, 8, 'self._s = v']);
    expect(shown('L2-L4')).toEqual([undefined, 2, 4, 'return self._s']);
  });

  it('b680: a file no reader takes is refused without the scan, same error; out-of-repo first; a source file still scans', () => {
    fs.writeFileSync(file('notes.txt'), 'x\n');
    const noScan = { ...openQueryBase(repo), full: (): never => { throw new Error('the scan must not run'); } };
    for (const target of ['notes.txt', 'notes.txt#L1-L2', 'api/src/nope.yml']) {
      const lazy = catchQueryError(() => showTarget(noScan, target));
      const built = catchQueryError(() => showTarget(ctx, target));
      expect([lazy.code, lazy.message]).toEqual([built.code, built.message]);
      expect(lazy.code).toBe('not-found');
    }
    expect(catchQueryError(() => showTarget(noScan, '../x.json')).code).toBe('out-of-repo');
    expect(showTarget(noScan, 'package.json').targetKind).toBe('file');   // b683: a structure file, no scan
    expect(() => showTarget(noScan, SERVICE)).toThrow('the scan must not run');
    expect(showTarget(openQueryBase(repo), SERVICE)).toEqual(showTarget(ctx, SERVICE));
  });
});

describe('showTarget: nested function (b782)', () => {
  it('shows outer.inner; the bare name is not-found', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-show-n-')));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/n.ts'),
      'export function outer(): number {\n  function inner(b: number): number {\n    return b * 2;\n  }\n  return inner(1);\n}\n',
    );
    const nctx = loadQueryContext(dir);
    expect(showTarget(nctx, 'src/n.ts#outer.inner')).toMatchObject({
      path: 'src/n.ts', targetKind: 'element', name: 'outer.inner', elementKind: 'function', startLine: 2, endLine: 4,
      code: ['  function inner(b: number): number {', '    return b * 2;', '  }'],
    });
    const err = catchQueryError(() => showTarget(nctx, 'src/n.ts#inner'));
    expect(err.code).toBe('not-found');
    expect(err.message).toBe("No function, class or method 'inner' in 'src/n.ts'");
  });
});
