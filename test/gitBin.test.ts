// b628b: run the real git, not the macOS /usr/bin/git xcrun shim; any other PATH keeps plain 'git'.
import { execFileSync } from 'child_process';
import * as path from 'path';
import { gitBin, resolveGitBin } from '../src/util/gitBin';

const CLT_GIT = '/Library/Developer/CommandLineTools/usr/bin/git';
const join = (...dirs: string[]) => dirs.join(path.delimiter);

describe('resolveGitBin', () => {
  it.each([
    { name: 'linux: plain git, xcrun never asked', platform: 'linux', PATH: join('/usr/bin'), files: ['/usr/bin/git'], xcrun: CLT_GIT, want: 'git', asked: false },
    { name: 'darwin, Homebrew git first: kept', platform: 'darwin', PATH: join('/opt/homebrew/bin', '/usr/bin'), files: ['/opt/homebrew/bin/git', '/usr/bin/git', CLT_GIT], xcrun: CLT_GIT, want: 'git', asked: false },
    { name: 'darwin, no git on PATH: plain git', platform: 'darwin', PATH: join('/opt/homebrew/bin'), files: [], xcrun: CLT_GIT, want: 'git', asked: false },
    { name: 'darwin, /usr/bin shim first: the xcrun path', platform: 'darwin', PATH: join('/opt/homebrew/bin', '/usr/bin/'), files: ['/usr/bin/git', CLT_GIT], xcrun: `${CLT_GIT}\n`, want: CLT_GIT, asked: true },
    { name: 'darwin, xcrun prints nothing: plain git', platform: 'darwin', PATH: join('/usr/bin'), files: ['/usr/bin/git'], xcrun: '\n', want: 'git', asked: true },
    { name: 'darwin, xcrun path missing: plain git', platform: 'darwin', PATH: join('/usr/bin'), files: ['/usr/bin/git'], xcrun: CLT_GIT, want: 'git', asked: true },
    { name: 'darwin, xcrun path relative: plain git', platform: 'darwin', PATH: join('/usr/bin'), files: ['/usr/bin/git', 'bin/git'], xcrun: 'bin/git', want: 'git', asked: true },
  ])('$name', ({ platform, PATH, files, xcrun, want, asked }) => {
    const find = jest.fn((_cmd: string, _args: string[]) => xcrun);
    const got = resolveGitBin({ platform: platform as NodeJS.Platform, path: PATH }, find, (p) => files.includes(p));
    expect(got).toBe(want);
    expect(find.mock.calls).toEqual(asked ? [['xcrun', ['--find', 'git']]] : []);
  });

  it('a throwing xcrun reaches the caller (gitBin logs it and falls back)', () => {
    const find = () => { throw new Error('xcrun: error'); };
    expect(() => resolveGitBin({ platform: 'darwin', path: '/usr/bin' }, find, (p) => p === '/usr/bin/git')).toThrow('xcrun: error');
  });
});

describe('gitBin (live)', () => {
  it('is plain git or an absolute path, the same on every call, and runs', () => {
    const bin = gitBin();
    expect(bin === 'git' || path.isAbsolute(bin)).toBe(true);
    if (process.platform !== 'darwin') expect(bin).toBe('git');
    expect(gitBin()).toBe(bin);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' })).toMatch(/^git version /);
  });
});
