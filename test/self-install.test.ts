import { runInstall, runUninstall, isCompiledBinary, upsertBlock, removeBlock, pathBlock } from '../src/selfInstall';
import type { InstallEnv } from '../src/selfInstall';

// P22-install: all effects are faked: an in-memory file map, recorded commands, scripted answers.

interface Fake {
  env: InstallEnv;
  files: Map<string, string>;
  dirs: Set<string>;
  modes: Map<string, number>;
  runs: string[];
  out: string[];
  err: string[];
  asked: string[];
  /** Files that are symlinks: link path -> real path. */
  links: Map<string, string>;
  /** Folders the user cannot write. */
  readOnly: Set<string>;
}

interface MakeOpts {
  answer?: boolean;
  versions?: Record<string, string>;
  /** Typed answers to prompt(), in order. */
  typed?: string[];
}

function make(over: Partial<InstallEnv> = {}, opts: MakeOpts = {}): Fake {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const modes = new Map<string, number>();
  const links = new Map<string, string>();
  const readOnly = new Set<string>();
  const f: Fake = { files, dirs, modes, runs: [], out: [], err: [], asked: [], links, readOnly, env: undefined as unknown as InstallEnv };
  f.env = {
    platform: 'linux',
    home: '/home/user',
    execPath: '/dl/c4mp-linux',
    scriptPath: '/$bunfs/root/c4mp',
    env: { PATH: '/usr/bin', SHELL: '/bin/bash' },
    isTTY: true,
    version: '2.0.0',
    ask: async q => (f.asked.push(q), opts.answer ?? true),
    prompt: async q => (f.asked.push(q), opts.typed?.shift() ?? ''),
    run: (cmd, args) => {
      f.runs.push([cmd, ...args].join(' '));
      if (args[0] === '--version') {
        const v = opts.versions?.[cmd];
        return v === 'FAIL' ? { status: null, stdout: '' } : { status: 0, stdout: (v ?? '') + '\n' };
      }
      return { status: 0, stdout: '' };
    },
    fs: {
      mkdirp: d => void dirs.add(d),
      exists: p => files.has(p) || links.has(p) || dirs.has(p),
      isFile: p => files.has(p),
      realpath: p => links.get(p) ?? p,
      canWrite: d => !readOnly.has(d),
      copyFile: (a, b) => void files.set(b, `copy-of:${a}`),
      rename: (a, b) => {
        if (links.has(a)) {
          links.set(b, links.get(a)!);
          links.delete(a);
          return;
        }
        files.set(b, files.get(a)!);
        files.delete(a);
        if (modes.has(a)) modes.set(b, modes.get(a)!);
        modes.delete(a);
      },
      chmod: (p, m) => void modes.set(p, m),
      unlink: p => void (files.delete(p), links.delete(p)),
      symlink: (t, p) => void links.set(p, t.startsWith('/') ? t : p.slice(0, p.lastIndexOf('/') + 1) + t),
      isSymlink: p => links.has(p),
      readText: p => files.get(p)!,
      writeText: (p, t) => void files.set(p, t),
    },
    out: l => void f.out.push(l),
    err: l => void f.err.push(l),
    ...over,
  };
  return f;
}

const BIN = '/home/user/.local/bin/c4mp';
const ALIAS = '/home/user/.local/bin/c4pm';

describe('install and uninstall: the c4pm alias beside c4mp', () => {
  it('linux: installs c4mp and a c4pm symlink to it; the old c4pm copies in other folders are still offered', async () => {
    const f = make({ env: { PATH: '/usr/local/bin:/usr/bin', SHELL: '/bin/bash' } }, { versions: { '/usr/local/bin/c4pm': '0.9.1' } });
    f.files.set('/usr/local/bin/c4pm', 'old');
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.files.get(BIN)).toBe('copy-of:/dl/c4mp-linux');
    expect(f.links.get(ALIAS)).toBe(BIN);
    expect(f.out).toContain(`linked ${ALIAS} to c4mp (the c4pm alias)`);
    expect(f.out.join('\n')).toContain('/usr/local/bin/c4pm  version 0.9.1');
    expect(f.files.get('/usr/local/bin/c4pm-0.9.1')).toBe('old');   // --yes: backed up under its own name
    expect([...f.links.keys(), ...f.files.keys()].filter(k => k.includes('.new-'))).toEqual([]);
  });

  it('a second run changes nothing and a real old c4pm left in the folder is never overwritten', async () => {
    const f = make({}, { versions: { [BIN]: '2.0.0', [ALIAS]: '0.9.1' } });
    f.files.set(BIN, 'bin');
    f.links.set(ALIAS, BIN);
    expect(await runInstall(f.env, { yes: true, noPath: true })).toBe(0);
    expect(f.out.some(l => l.startsWith('would '))).toBe(false);

    const g = make({}, { versions: { [BIN]: '2.0.0', [ALIAS]: '0.9.1' } });
    g.files.set(BIN, 'bin');
    g.files.set(ALIAS, 'old real c4pm');
    await runInstall(g.env, { yes: true, noPath: true, old: 'leave' });
    expect(g.files.get(ALIAS)).toBe('old real c4pm');
    expect(g.out.join('\n')).toContain('not making the c4pm alias');
  });

  it('win32: the alias is a copy of the exe beside c4mp.exe', async () => {
    const dir = 'C:\\Users\\user\\AppData\\Local\\Programs\\c4mp';
    const f = make({ platform: 'win32', home: 'C:\\Users\\user', localAppData: 'C:\\Users\\user\\AppData\\Local', execPath: 'C:\\dl\\c4mp-win.exe', scriptPath: 'B:\\~BUN\\root\\c4mp.exe', env: { PATH: 'C:\\Windows' } });
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.files.get(`${dir}\\c4pm.exe`)).toBe(`copy-of:${dir}\\c4mp.exe`);
    expect([...f.files.keys()].filter(k => k.includes('.new-'))).toEqual([]);
  });

  it('uninstall removes both names, but not a different real c4pm next to a live c4mp', async () => {
    const f = make({ env: { PATH: '/usr/bin', SHELL: '/bin/bash' } });
    f.files.set(BIN, 'bin');
    f.links.set(ALIAS, BIN);
    expect(await runUninstall(f.env, { yes: true })).toBe(0);
    expect(f.files.has(BIN)).toBe(false);
    expect(f.links.has(ALIAS)).toBe(false);

    const g = make();
    g.files.set(BIN, 'bin');
    g.files.set(ALIAS, 'somebody else');
    await runUninstall(g.env, { yes: true });
    expect(g.files.has(BIN)).toBe(false);
    expect(g.files.get(ALIAS)).toBe('somebody else');

    const old = make();   // an old install left a plain c4pm and no c4mp: that goes too
    old.files.set(ALIAS, 'plain old');
    await runUninstall(old.env, { yes: true });
    expect(old.files.has(ALIAS)).toBe(false);
  });

  it('a PATH block written under the old c4pm marker is replaced and removed', async () => {
    const oldBlock = '# >>> c4pm >>>\nexport PATH="/home/user/.local/bin:$PATH"\n# <<< c4pm <<<';
    const text = `export A=1\n\n${oldBlock}\n`;
    expect(upsertBlock(text, pathBlock('/x'))).toBe('export A=1\n\n' + pathBlock('/x') + '\n');
    expect(removeBlock(text, '/home/user/.local/bin')).toBe('export A=1\n');
  });
});

describe('install: fresh', () => {
  it.each([
    ['linux', '/home/user/.local/bin/c4mp', false, '/home/user/.bashrc'],
    ['darwin', '/home/user/.local/bin/c4mp', true, '/home/user/.bashrc'],
  ] as const)('%s: copies, chmod 755, quarantine only on darwin, adds PATH block', async (platform, target, darwin, rc) => {
    const f = make({ platform });
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.files.get(target)).toBe('copy-of:/dl/c4mp-linux');
    expect([...f.modes.values()]).toEqual([0o755]);
    expect(f.runs.some(r => r.startsWith('xattr -d com.apple.quarantine'))).toBe(darwin);
    expect(f.files.get(rc)).toBe(pathBlock('/home/user/.local/bin') + '\n');
    expect(f.out).toContain(`copied /dl/c4mp-linux to ${target}`);
    expect(f.dirs.has('/home/user/.local/bin')).toBe(true);
    expect([...f.files.keys()].filter(k => k.includes('.new-'))).toEqual([]);
  });

  it('win32: default target under LOCALAPPDATA, no chmod, PowerShell adds the user PATH', async () => {
    const f = make({
      platform: 'win32',
      home: 'C:\\Users\\user',
      localAppData: 'C:\\Users\\user\\AppData\\Local',
      execPath: 'C:\\dl\\c4mp-win.exe',
      scriptPath: 'B:\\~BUN\\root\\c4mp.exe',
      env: { PATH: 'C:\\Windows' },
    });
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.files.has('C:\\Users\\user\\AppData\\Local\\Programs\\c4mp\\c4mp.exe')).toBe(true);
    expect(f.modes.size).toBe(0);
    expect(f.runs.some(r => r.startsWith('xattr'))).toBe(false);
    expect(f.runs.some(r => r.includes('SetEnvironmentVariable') && r.includes('Programs\\c4mp'))).toBe(true);
  });

  it('win32 without PowerShell prints manual steps and still installs', async () => {
    const f = make({ platform: 'win32', home: 'C:\\u', execPath: 'C:\\dl\\c4mp.exe', env: { PATH: '' }, run: () => ({ status: null, stdout: '' }) });
    expect(await runInstall(f.env, { yes: true, dir: 'C:\\tools' })).toBe(0);
    expect(f.files.has('C:\\tools\\c4mp.exe')).toBe(true);
    expect(f.out.some(l => l.includes('PowerShell was not found'))).toBe(true);
  });

  it('--dir overrides the folder', async () => {
    const f = make();
    await runInstall(f.env, { yes: true, dir: '~/bin' });
    expect(f.files.has('/home/user/bin/c4mp')).toBe(true);
  });
});

describe('install: existing binary', () => {
  it('same version: changes nothing but still offers the PATH step', async () => {
    const f = make({}, { versions: { [BIN]: '2.0.0' } });
    f.files.set(BIN, 'old');
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.out[0]).toMatch(/^Already installed: same version/);
    expect(f.files.get(BIN)).toBe('old');
    expect(f.files.get('/home/user/.bashrc')).toContain('# >>> c4mp >>>');
  });

  it('same version and folder already on PATH: nothing to do, nothing asked', async () => {
    const f = make({ env: { PATH: '/usr/bin:/home/user/.local/bin/', SHELL: '/bin/zsh' } }, { versions: { [BIN]: '2.0.0' } });
    f.files.set(BIN, 'old');
    f.links.set(ALIAS, BIN);
    expect(await runInstall(f.env, {})).toBe(0);
    expect(f.asked).toEqual([]);
    expect(f.files.size).toBe(1);
  });

  it('different version: shows old and new, asks, replaces on yes, keeps on no', async () => {
    const yes = make({}, { versions: { [BIN]: '1.0.0' } });
    yes.files.set(BIN, 'old');
    await runInstall(yes.env, { noPath: true });
    expect(yes.out).toContain('Existing c4mp version: 1.0.0');
    expect(yes.out).toContain('This binary version: 2.0.0');
    expect(yes.asked).toEqual(['Replace existing c4mp 1.0.0 with 2.0.0? [y/N] ']);
    expect(yes.files.get(BIN)).toBe('copy-of:/dl/c4mp-linux');

    const no = make({}, { versions: { [BIN]: '1.0.0' }, answer: false });
    no.files.set(BIN, 'old');
    expect(await runInstall(no.env, { noPath: true })).toBe(0);
    expect(no.files.get(BIN)).toBe('old');
    expect(no.out).toContain('Nothing changed.');
  });
});

describe('install: consent and guards', () => {
  it('no terminal and no --yes: asks nothing, writes nothing, exit 1', async () => {
    const f = make({ isTTY: false });
    expect(await runInstall(f.env, {})).toBe(1);
    expect(f.asked).toEqual([]);
    expect(f.files.size).toBe(0);
    expect(f.err.join('\n')).toContain('--yes');
  });

  it('prints the plan as would-lines before asking', async () => {
    const f = make();
    await runInstall(f.env, {});
    expect(f.out.filter(l => l.startsWith('would '))[0]).toContain('would create');
    expect(f.out.some(l => l.startsWith('would copy'))).toBe(true);
    expect(f.asked).toEqual(['Proceed? [y/N] ']);
  });

  it('running under node refuses', async () => {
    const f = make({ execPath: '/usr/local/bin/node', scriptPath: '/src/bin/cli.js' });
    expect(await runInstall(f.env, { yes: true })).toBe(1);
    expect(f.err).toEqual(['install works from the single-file binary; from source use npm link']);
    expect(f.files.size).toBe(0);
  });

  it.each([
    ['/usr/bin/node', undefined, false],
    ['C:\\Program Files\\nodejs\\NODE.EXE', 'C:\\x\\cli.js', false],
    ['/opt/c4mp', '/src/cli.ts', false],
    ['/dl/c4mp', '/$bunfs/root/c4mp', true],
    ['/dl/renamed-tool', undefined, true],
  ])('isCompiledBinary(%s, %s) = %s', (exec, script, want) => {
    expect(isCompiledBinary(exec, script)).toBe(want);
  });
});

describe('PATH step', () => {
  it('folder already on PATH: no profile touched', async () => {
    const f = make({ env: { PATH: '/home/user/.local/bin:/usr/bin', SHELL: '/bin/zsh' } });
    await runInstall(f.env, { yes: true });
    expect([...f.files.keys()]).toEqual([BIN]);
  });

  it('--no-path skips it', async () => {
    const f = make();
    await runInstall(f.env, { yes: true, noPath: true });
    expect([...f.files.keys()]).toEqual([BIN]);
  });

  it('zsh writes ~/.zshrc; the block is added once and replaced, not duplicated', async () => {
    const f = make({ env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } });
    f.files.set('/home/user/.zshrc', 'export A=1\n');
    await runInstall(f.env, { yes: true });
    const first = f.files.get('/home/user/.zshrc')!;
    expect(first.startsWith('export A=1\n')).toBe(true);
    expect(first.match(/# >>> c4mp >>>/g)).toHaveLength(1);

    f.files.delete(BIN);
    await runInstall(f.env, { yes: true }); // again: block already there
    expect(f.files.get('/home/user/.zshrc')).toBe(first);

    await runInstall(f.env, { yes: true, dir: '/opt/c4' }); // folder changed: replaced
    const third = f.files.get('/home/user/.zshrc')!;
    expect(third.match(/# >>> c4mp >>>/g)).toHaveLength(1);
    expect(third).toContain('"/opt/c4:$PATH"');
    expect(third).not.toContain('.local/bin');
  });

  it('macOS bash also updates an existing ~/.bash_profile, never creates it', async () => {
    const f = make({ platform: 'darwin' });
    await runInstall(f.env, { yes: true });
    expect(f.files.has('/home/user/.bash_profile')).toBe(false);
    const g = make({ platform: 'darwin' });
    g.files.set('/home/user/.bash_profile', '# mine\n');
    await runInstall(g.env, { yes: true });
    expect(g.files.get('/home/user/.bash_profile')).toContain('# >>> c4mp >>>');
    expect(g.files.has('/home/user/.bashrc')).toBe(true);
  });

  it('unknown shell: prints the line, writes no profile', async () => {
    const f = make({ env: { PATH: '/usr/bin', SHELL: '/usr/bin/fish' } });
    await runInstall(f.env, { yes: true });
    expect([...f.files.keys()]).toEqual([BIN]);
    expect(f.out.join('\n')).toContain('export PATH="/home/user/.local/bin:$PATH"');
  });
});

// b938: other c4mp copies (an older one earlier on PATH hid the installed one).
describe('install: other copies', () => {
  const OLD = '/usr/local/bin/c4mp';
  const RC = '/home/user/.bashrc';
  /** The installed c4mp 2.0.0 is in ~/.local/bin, which is not on PATH; an old copy is on PATH. */
  function scenario(o: MakeOpts & { over?: Partial<InstallEnv> } = {}): Fake {
    const { over, ...mo } = o;
    const f = make({ env: { PATH: '/usr/local/bin:/usr/bin', SHELL: '/bin/bash' }, ...over }, { versions: { [BIN]: '2.0.0', [OLD]: '0.9.0' }, ...mo });
    f.files.set(BIN, 'new');
    f.links.set(ALIAS, BIN);   // the c4pm alias is already beside c4mp
    f.files.set(OLD, 'old');
    return f;
  }

  it('same version run still finds the hiding copy: backs it up, PATH block at the end, says what runs next', async () => {
    const f = scenario();
    f.files.set(RC, 'export A=1\n');
    expect(await runInstall(f.env, { yes: true })).toBe(0);
    expect(f.files.has(OLD)).toBe(false);
    expect(f.files.get('/usr/local/bin/c4mp-0.9.0')).toBe('old');
    expect(f.files.get(RC)).toBe('export A=1\n\n' + pathBlock('/home/user/.local/bin') + '\n');
    expect(f.out).toContain('Open a new terminal so the PATH change takes effect.');
    expect(f.out[f.out.length - 1]).toBe('The shell will run /home/user/.local/bin/c4mp (c4mp 2.0.0)');
  });

  it('backup name: -2 when c4mp-<version> is taken; unreadable version becomes unknown', async () => {
    const f = scenario({ versions: { [BIN]: '2.0.0', [OLD]: 'FAIL' } });
    f.files.set('/usr/local/bin/c4mp-unknown', 'x');
    await runInstall(f.env, { yes: true, noPath: true });
    expect(f.out.join('\n')).toContain('version unknown');
    expect(f.files.get('/usr/local/bin/c4mp-unknown-2')).toBe('old');
    expect(f.files.get('/usr/local/bin/c4mp-unknown')).toBe('x');
  });

  it('--old remove deletes it; --old leave keeps it but still puts the folder first and warns', async () => {
    const rm = scenario();
    await runInstall(rm.env, { yes: true, old: 'remove', noPath: true });
    expect(rm.files.has(OLD)).toBe(false);
    expect([...rm.files.keys()].some(k => k.startsWith('/usr/local/bin/c4mp-'))).toBe(false);

    const keep = scenario();
    await runInstall(keep.env, { yes: true, old: 'leave' });
    expect(keep.files.get(OLD)).toBe('old');
    expect(keep.files.get(RC)).toContain('# >>> c4mp >>>');
    expect(keep.out[keep.out.length - 1]).toBe('The shell will run /home/user/.local/bin/c4mp (c4mp 2.0.0)');

    const noPath = scenario();
    await runInstall(noPath.env, { yes: true, old: 'leave', noPath: true });
    expect(noPath.files.has(RC)).toBe(false);
    expect(noPath.out[noPath.out.length - 1]).toContain('The shell will run /usr/local/bin/c4mp (c4mp 0.9.0)  (this is not');
  });

  it('asks per copy: r, b, anything else leaves', async () => {
    const f = make(
      { env: { PATH: '/a:/b:/c:/home/user/.local/bin', SHELL: '/bin/bash' } },
      { versions: { '/a/c4mp': '1.0.0', '/b/c4mp': '1.1.0', '/c/c4mp': '1.2.0', [BIN]: '2.0.0' }, typed: ['r', 'B', 'x'] },
    );
    for (const p of ['/a/c4mp', '/b/c4mp', '/c/c4mp', BIN]) f.files.set(p, p);
    await runInstall(f.env, {});
    expect(f.files.has('/a/c4mp')).toBe(false);
    expect(f.files.get('/b/c4mp-1.1.0')).toBe('/b/c4mp');
    expect(f.files.get('/c/c4mp')).toBe('/c/c4mp');
    expect(f.asked.filter(q => q.includes('[r]emove / [b]ack up / [l]eave'))).toHaveLength(3);
    expect(f.asked[f.asked.length - 1]).toBe('Proceed? [y/N] ');
  });

  it('finds copies in /usr/local/bin and /opt/homebrew/bin even when not on PATH; one per real file', async () => {
    const f = make({ env: { PATH: '/x:/y:/usr/bin', SHELL: '/bin/bash' } }, { versions: { '/x/c4mp': '1.0.0', '/y/c4mp': '1.0.0', '/opt/homebrew/bin/c4mp': '3.0.0' } });
    f.files.set('/shared/c4mp', 'same');
    f.links.set('/x/c4mp', '/shared/c4mp');
    f.links.set('/y/c4mp', '/shared/c4mp');
    f.files.set('/opt/homebrew/bin/c4mp', 'hb');
    await runInstall(f.env, { yes: true, old: 'leave', noPath: true });
    const list = f.out.filter(l => /^ {2}\/.*version /.test(l));
    expect(list).toEqual(['  /x/c4mp  version 1.0.0', '  /opt/homebrew/bin/c4mp  version 3.0.0  (not on PATH)']);
  });

  it('unwritable folder: prints the sudo command, changes nothing there; Homebrew copy: prints brew uninstall, untouched', async () => {
    const f = scenario({ typed: [] });
    f.readOnly.add('/usr/local/bin');
    f.files.set('/opt/homebrew/Cellar/c4mp/0.8.0/bin/c4mp', 'cellar');
    f.links.set('/opt/homebrew/bin/c4mp', '/opt/homebrew/Cellar/c4mp/0.8.0/bin/c4mp');
    f.env.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin';
    expect(await runInstall(f.env, { yes: true, noPath: true })).toBe(0);
    const out = f.out.join('\n');
    expect(out).toContain('run it yourself: sudo mv /usr/local/bin/c4mp /usr/local/bin/c4mp-0.9.0');
    expect(out).toContain('managed by Homebrew; run: brew uninstall c4mp');
    expect(f.files.get(OLD)).toBe('old');
    expect(f.links.get('/opt/homebrew/bin/c4mp')).toBe('/opt/homebrew/Cellar/c4mp/0.8.0/bin/c4mp');
    expect(f.out.some(l => l.startsWith('would back up') || l.startsWith('would remove'))).toBe(false);

    const rm = scenario();
    rm.readOnly.add('/usr/local/bin');
    await runInstall(rm.env, { yes: true, old: 'remove', noPath: true });
    expect(rm.out.join('\n')).toContain('sudo rm /usr/local/bin/c4mp');
    expect(rm.files.get(OLD)).toBe('old');
  });

  it('no terminal and no --yes: prints the findings and the commands, changes nothing', async () => {
    const f = scenario({ over: { isTTY: false } });
    expect(await runInstall(f.env, {})).toBe(1); // the PATH step needs consent
    const out = f.out.join('\n');
    expect(out).toContain('to back up /usr/local/bin/c4mp: mv /usr/local/bin/c4mp /usr/local/bin/c4mp-0.9.0');
    expect(out).toContain('to remove /usr/local/bin/c4mp: rm /usr/local/bin/c4mp');
    expect(f.files.get(OLD)).toBe('old');
    expect(f.files.has(RC)).toBe(false);
    expect(f.asked).toEqual([]);

    const g = scenario({ over: { isTTY: false } });
    expect(await runInstall(g.env, { noPath: true })).toBe(0); // nothing to change: findings only
    expect(g.files.get(OLD)).toBe('old');
  });

  it('--old without --yes still asks once to proceed; a bad --old value is refused', async () => {
    const f = scenario({ answer: false });
    await runInstall(f.env, { old: 'backup', noPath: true });
    expect(f.asked).toEqual(['Proceed? [y/N] ']);
    expect(f.files.get(OLD)).toBe('old');
    expect(f.out).toContain('Nothing changed.');
    const bad = scenario();
    expect(await runInstall(bad.env, { yes: true, old: 'delete' as never })).toBe(1);
    expect(bad.err[0]).toContain('--old takes remove, backup, leave');
  });

  it('an existing PATH block in the middle of the profile moves to the end', async () => {
    const f = make({ env: { PATH: '/usr/bin', SHELL: '/bin/bash' } });
    f.files.set(RC, `export A=1\n\n${pathBlock('/old/dir')}\nexport B=2\n`);
    await runInstall(f.env, { yes: true });
    expect(f.files.get(RC)).toBe(`export A=1\nexport B=2\n\n${pathBlock('/home/user/.local/bin')}\n`);
    expect(upsertBlock(f.files.get(RC)!, pathBlock('/home/user/.local/bin'))).toBe(f.files.get(RC));
  });

  it('win32: lists other copies, renames and removes nothing', async () => {
    const f = make({ platform: 'win32', home: 'C:\\u', localAppData: 'C:\\u\\L', execPath: 'C:\\dl\\c4mp.exe', env: { PATH: 'C:\\old;C:\\Windows' } });
    f.files.set('C:\\old\\c4mp.exe', 'old');
    await runInstall(f.env, { yes: true, old: 'remove' });
    expect(f.files.get('C:\\old\\c4mp.exe')).toBe('old');
    expect(f.out.join('\n')).toContain('remove or rename it by hand');
    expect(f.files.has('C:\\u\\L\\Programs\\c4mp\\c4mp.exe')).toBe(true);
  });
});

describe('block helpers', () => {
  it('removeBlock restores the original text and ignores a block for another folder', () => {
    const base = 'export A=1\n';
    const withBlock = upsertBlock(base, pathBlock('/x'));
    expect(removeBlock(withBlock, '/x')).toBe(base);
    expect(removeBlock(withBlock, '/other')).toBe(withBlock);
  });
});

describe('uninstall', () => {
  it('removes only the binary and the block', async () => {
    const f = make({ env: { PATH: '/usr/bin', SHELL: '/bin/bash' } });
    f.files.set(BIN, 'bin');
    f.files.set('/home/user/.local/bin/other', 'keep');
    f.files.set('/home/user/.bashrc', upsertBlock('export A=1\n', pathBlock('/home/user/.local/bin')));
    expect(await runUninstall(f.env, { yes: true })).toBe(0);
    expect(f.files.has(BIN)).toBe(false);
    expect(f.files.get('/home/user/.local/bin/other')).toBe('keep');
    expect(f.files.get('/home/user/.bashrc')).toBe('export A=1\n');
    expect(f.out).toContain(`removed ${BIN}`);
  });

  it('refuses a target that is not a file', async () => {
    const f = make();
    f.dirs.add(BIN);
    expect(await runUninstall(f.env, { yes: true })).toBe(1);
    expect(f.dirs.has(BIN)).toBe(true);
  });

  it('no terminal and no --yes: refuses, removes nothing', async () => {
    const f = make({ isTTY: false });
    f.files.set(BIN, 'bin');
    expect(await runUninstall(f.env, {})).toBe(1);
    expect(f.files.has(BIN)).toBe(true);
  });

  it('works when the running binary is the installed one (posix); skips on Windows', async () => {
    const f = make({ execPath: BIN });
    f.files.set(BIN, 'bin');
    expect(await runUninstall(f.env, { yes: true })).toBe(0);
    expect(f.files.has(BIN)).toBe(false);

    const w = make({ platform: 'win32', home: 'C:\\u', localAppData: 'C:\\u\\L', execPath: 'C:\\u\\L\\Programs\\c4mp\\c4mp.exe', env: { PATH: '' } });
    w.files.set('C:\\u\\L\\Programs\\c4mp\\c4mp.exe', 'bin');
    expect(await runUninstall(w.env, { yes: true })).toBe(1);
    expect(w.files.size).toBe(1);
    expect(w.out.join('\n')).toContain('running exe cannot be deleted');
  });
});
