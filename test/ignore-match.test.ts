import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIgnoreMatcher } from '../src/ignoreMatch';
import { listSourceFiles } from '../src/importer/walk';
import { SOURCE_EXTENSIONS, languageIgnorePatterns } from '../src/languages/registry';
import { listC4Files } from '../src/plan/files';
import { findPlanFiles } from '../src/plan/files';
import { loadConfig } from '../src/config';
import { CONFIG_FILE } from '../src/constants';

describe('createIgnoreMatcher', () => {
  it.each([
    ['dist', 'dist', true],
    ['dist', 'dist/a/b.ts', true],       // directory prefix
    ['dist', 'distance/a.ts', false],    // not a plain string prefix
    ['./src/gen/', 'src/gen/x.ts', true], // normalized like config
    ['src/a.ts', 'src/a.ts', true],      // exact file path
    ['src/a.ts', 'src/b.ts', false],
    ['**/*.test.ts', 'a.test.ts', true],
    ['**/*.test.ts', 'src/deep/a.test.ts', true],
    ['**/*.test.ts', 'src/a.ts', false],
    ['src/*/gen', 'src/x/gen/f.ts', true],
    ['src/*/gen', 'src/x/y/gen/f.ts', false], // * does not cross '/'
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'abc.ts', false],
    ['**/__tests__', 'src/__tests__/a.ts', true],
  ])('pattern %s vs %s -> %s', (pattern, rel, expected) => {
    expect(createIgnoreMatcher([pattern]).matches(rel)).toBe(expected);
  });

  it('reports patterns that matched nothing', () => {
    const m = createIgnoreMatcher(['dist', 'nope', '**/*.zzz']);
    m.matches('dist/a.ts');
    expect(m.unmatched()).toEqual(['nope', '**/*.zzz']);
  });
});

describe('ignore applied by walk, .c4 discovery, config', () => {
  let root: string;
  const write = (rel: string) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ignore-'));
    ['src/a.ts', 'src/a.test.ts', 'src/gen/g.ts', 'lib/b.ts', 'lib/b.test.ts', 'src/x.c4', 'lib/skip/y.c4'].forEach(write);
    delete process.env.C4PM_IGNORE;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.C4PM_IGNORE;
  });

  it('walk: prefix, file path and glob; reports unmatched', () => {
    let unmatched: string[] = [];
    const files = listSourceFiles(root, {
      extensions: SOURCE_EXTENSIONS,
      ignore: ['src/gen', 'lib/b.ts', '**/*.test.ts', 'nothing'],
      onUnmatchedIgnore: (p) => { unmatched = p; },
    });
    expect(files).toEqual(['src/a.ts']);
    expect(unmatched).toEqual(['nothing']);
  });

  it('.c4 discovery honours ignore (listC4Files and findPlanFiles)', () => {
    expect(listC4Files(root, { ignore: ['lib/skip'] })).toEqual(['src/x.c4']);
    expect(listC4Files(root, { ignore: ['**/*.c4'] })).toEqual([]);
    expect(findPlanFiles(root, { ignore: ['lib/skip'] }).files).toEqual(['src/x.c4']);
    expect(findPlanFiles(root, null).files).toEqual(['lib/skip/y.c4', 'src/x.c4']);
  });

  it('keeps glob patterns from env and config.json', () => {
    process.env.C4PM_IGNORE = '**/*.test.ts,src/gen';
    expect(loadConfig(root).ignore).toEqual(['**/*.test.ts', 'src/gen']);
    delete process.env.C4PM_IGNORE;
    fs.writeFileSync(path.join(root, CONFIG_FILE),JSON.stringify({ ignore: ['**/*.test.ts'] }));
    expect(loadConfig(root).ignore).toEqual(['**/*.test.ts']);
  });
});

describe('language default ignores in the walk', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-langignore-'));
    for (const rel of ['src/a.cs', 'src/bin/b.cs', 'src/obj/c.cs', 'cmake-build-debug/d.cpp', 'lib/cmake-build-x/e.cpp', 'mine/f.cs', 'src/g.cpp']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), '');
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const walk = (o: object) => listSourceFiles(root, { extensions: ['.cs', '.cpp'], ...o });

  it('skips bin/obj only with csharp and cmake-build-* only with cpp', () => {
    expect(walk({})).toEqual(['cmake-build-debug/d.cpp', 'lib/cmake-build-x/e.cpp', 'mine/f.cs', 'src/a.cs', 'src/bin/b.cs', 'src/g.cpp', 'src/obj/c.cs']);
    expect(walk({ languageIgnores: languageIgnorePatterns(['csharp']) })).toEqual(['cmake-build-debug/d.cpp', 'lib/cmake-build-x/e.cpp', 'mine/f.cs', 'src/a.cs', 'src/g.cpp']);
    expect(walk({ languageIgnores: languageIgnorePatterns(['cpp']) })).toEqual(['mine/f.cs', 'src/a.cs', 'src/bin/b.cs', 'src/g.cpp', 'src/obj/c.cs']);
  });

  it('combines with the user ignore and never warns about unmatched defaults', () => {
    const unmatched: string[][] = [];
    const files = walk({ languageIgnores: languageIgnorePatterns(['csharp', 'cpp']), ignore: ['mine'], onUnmatchedIgnore: (p: string[]) => unmatched.push(p) });
    expect(files).toEqual(['src/a.cs', 'src/g.cpp']);
    expect(unmatched).toEqual([]);
  });
});
