import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { userCacheRoot, repoCacheDir } from '../src/util/userCache';

// QS-2: where c4pm keeps its per-user cache (D1), and C4PM_CACHE_DIR=<path>|off (D2).

describe('userCacheRoot', () => {
  const home = '/home/user';
  it.each<[string, NodeJS.ProcessEnv, NodeJS.Platform, string | null]>([
    ['darwin', {}, 'darwin', '/home/user/Library/Caches/c4mp'],
    ['linux without XDG', {}, 'linux', '/home/user/.cache/c4mp'],
    ['linux with XDG', { XDG_CACHE_HOME: '/xdg' }, 'linux', '/xdg/c4mp'],
    ['win32 without LOCALAPPDATA', {}, 'win32', path.join(home, 'AppData', 'Local', 'c4mp', 'Cache')],
    ['win32 with LOCALAPPDATA', { LOCALAPPDATA: '/lad' }, 'win32', path.join('/lad', 'c4mp', 'Cache')],
    ['C4PM_CACHE_DIR=/x', { C4PM_CACHE_DIR: '/x', XDG_CACHE_HOME: '/xdg' }, 'linux', path.resolve('/x')],
    ['C4PM_CACHE_DIR=off', { C4PM_CACHE_DIR: 'off' }, 'darwin', null],
  ])('%s', (_name, env, platform, expected) => {
    expect(userCacheRoot(env, platform, home)).toBe(expected);
  });
});

describe('repoCacheDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-uc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('same folder (and its symlink) gives one dir under the root; two folders differ; off gives null', () => {
    const env = { C4PM_CACHE_DIR: path.join(tmp, 'cache') };
    const a = path.join(tmp, 'repoA');
    const b = path.join(tmp, 'repoB');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.symlinkSync(a, path.join(tmp, 'linkA'));
    const dirA = repoCacheDir(a, env);
    expect(dirA).toMatch(/[/\\]repoA-[0-9a-f]{16}$/);
    expect(path.dirname(dirA!)).toBe(path.resolve(env.C4PM_CACHE_DIR));
    expect(repoCacheDir(a, env)).toBe(dirA);
    expect(repoCacheDir(path.join(tmp, 'linkA'), env)).toBe(dirA);
    expect(repoCacheDir(b, env)).not.toBe(dirA);
    expect(repoCacheDir(a, { C4PM_CACHE_DIR: 'off' })).toBeNull();
  });
});
