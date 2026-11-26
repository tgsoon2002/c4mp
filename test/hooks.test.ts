import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hookBlock, installHooks, uninstallHooks } from '../src/hooks';
import { HOOK_BEGIN, HOOK_END, LEGACY_HOOK_BEGIN, LEGACY_HOOK_END } from '../src/constants';

describe('hooks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-hooks-test-'));
    // Initialize a git repo
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('hookBlock', () => {
    it.each(['post-commit', 'post-merge'] as const)('%s: root target, no store, no fallback', kind => {
      const block = hookBlock(kind, { targetRel: '' });
      expect(block.startsWith(HOOK_BEGIN)).toBe(true);
      expect(block.endsWith(HOOK_END)).toBe(true);
      expect(block).toContain('TARGET="$ROOT"\n');
      expect(block).toContain(`$C4 hook ${kind} --repo "$TARGET" \${HEAD_SHA:+--head "$HEAD_SHA"}`);
      expect(block).toContain(' >/dev/null 2>&1 & ) || true');
      expect(block).not.toContain('--store');
      expect(block).not.toContain('node ');
      expect(block).toContain('|| true');
    });

    it.each(['post-commit', 'post-merge'] as const)('%s: subfolder target, store, fallback', kind => {
      const block = hookBlock(kind, { targetRel: 'Project', store: '/s/store', cliFallback: '/opt/c4mp/cli.js' });
      expect(block).toContain('TARGET="$ROOT/Project"');
      expect(block).toContain(`hook ${kind} --repo "$TARGET" --store "/s/store"`);
      expect(block).toContain('elif [ -f "/opt/c4mp/cli.js" ]; then C4="node /opt/c4mp/cli.js"');
    });

    const HEAD_LINE = 'HEAD_SHA="$(git rev-parse -q --verify HEAD 2>/dev/null)"';
    const ORIG_LINE = 'ORIG_SHA="$(git rev-parse -q --verify ORIG_HEAD 2>/dev/null)"';
    const HEAD_ARG = '${HEAD_SHA:+--head "$HEAD_SHA"}';
    const ORIG_ARG = '${ORIG_SHA:+--orig-head "$ORIG_SHA"}';

    it('prints the exact block for a sample (post-commit: HEAD only)', () => {
      expect(hookBlock('post-commit', { targetRel: 'code' })).toBe(
        [
          HOOK_BEGIN,
          '# Added by `c4mp install-hooks`. Remove with `c4mp uninstall-hooks`. Never blocks git.',
          'ROOT="$(git rev-parse --show-toplevel)"',
          'TARGET="$ROOT/code"',
          HEAD_LINE,
          'if command -v c4mp >/dev/null 2>&1; then C4="c4mp"; elif command -v c4pm >/dev/null 2>&1; then C4="c4pm"; else C4=""; fi',
          `[ -n "$C4" ] && ( $C4 hook post-commit --repo "$TARGET" ${HEAD_ARG} >/dev/null 2>&1 & ) || true`,
          HOOK_END,
        ].join('\n'),
      );
    });

    it('prints the exact block for a sample (post-merge: HEAD and ORIG_HEAD, after --store)', () => {
      expect(hookBlock('post-merge', { targetRel: '', store: '/s' })).toBe(
        [
          HOOK_BEGIN,
          '# Added by `c4mp install-hooks`. Remove with `c4mp uninstall-hooks`. Never blocks git.',
          'ROOT="$(git rev-parse --show-toplevel)"',
          'TARGET="$ROOT"',
          HEAD_LINE,
          ORIG_LINE,
          'if command -v c4mp >/dev/null 2>&1; then C4="c4mp"; elif command -v c4pm >/dev/null 2>&1; then C4="c4pm"; else C4=""; fi',
          `[ -n "$C4" ] && ( $C4 hook post-merge --repo "$TARGET" --store "/s" ${HEAD_ARG} ${ORIG_ARG} >/dev/null 2>&1 & ) || true`,
          HOOK_END,
        ].join('\n'),
      );
    });

    it('post-commit has no ORIG_HEAD line or argument', () => {
      const block = hookBlock('post-commit', { targetRel: '' });
      expect(block).not.toContain('ORIG_HEAD');
      expect(block).not.toContain('--orig-head');
    });

    /** Run the block with sh (after `sh -n`) and a stand-in c4mp that writes its arguments; returns them. */
    async function argsOfBlock(kind: 'post-commit' | 'post-merge', cmd = 'c4mp'): Promise<string[]> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-hooksh-'));
      try {
        const out = path.join(dir, 'args.txt');
        fs.writeFileSync(path.join(dir, cmd), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.tmp" && mv "${out}.tmp" "${out}"\n`);
        fs.chmodSync(path.join(dir, cmd), 0o755);
        const script = path.join(dir, 'hook.sh');
        fs.writeFileSync(script, hookBlock(kind, { targetRel: '' }) + '\n');
        execFileSync('sh', ['-n', script]);
        // the old-name run keeps PATH to the stand-in plus system folders, so a real c4mp on this machine cannot win
        const searchPath = cmd === 'c4mp' ? `${dir}:${process.env.PATH}` : `${dir}:/usr/bin:/bin:/usr/local/bin`;
        execFileSync('sh', [script], { cwd: tempDir, stdio: 'ignore', env: { ...process.env, PATH: searchPath } });
        // the block starts c4mp in the background, and macOS can hold a new process for seconds: wait for its file
        const deadline = Date.now() + 90000;
        while (!fs.existsSync(out) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
        return fs.readFileSync(out, 'utf8').trim().split('\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const commitTwice = () => {
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'one'], { cwd: tempDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'two'], { cwd: tempDir, stdio: 'ignore' });
    };
    const rev = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: tempDir, encoding: 'utf8' }).trim();

    it.each(['post-commit', 'post-merge'] as const)('%s: sh passes the shas it read as --head / --orig-head', async kind => {
      commitTwice();
      execFileSync('git', ['update-ref', 'ORIG_HEAD', 'HEAD~1'], { cwd: tempDir, stdio: 'ignore' });
      const want = ['hook', kind, '--repo', fs.realpathSync(tempDir), '--head', rev('HEAD')];
      if (kind === 'post-merge') want.push('--orig-head', rev('HEAD~1'));
      expect(await argsOfBlock(kind)).toEqual(want);
    }, 120000);

    it('post-merge with no ORIG_HEAD: sh passes --head only', async () => {
      commitTwice();
      expect(await argsOfBlock('post-merge')).toEqual(['hook', 'post-merge', '--repo', fs.realpathSync(tempDir), '--head', rev('HEAD')]);
    }, 120000);

    it('falls back to the old c4pm command when c4mp is not on PATH', async () => {
      commitTwice();
      expect(await argsOfBlock('post-commit', 'c4pm')).toEqual(['hook', 'post-commit', '--repo', fs.realpathSync(tempDir), '--head', rev('HEAD')]);
    }, 120000);

    it('no commit yet (no HEAD): sh passes neither', async () => {
      expect(await argsOfBlock('post-merge')).toEqual(['hook', 'post-merge', '--repo', fs.realpathSync(tempDir)]);
    }, 120000);

    it.each(['"', '$', '`'])('rejects forbidden char %s in every field', ch => {
      expect(() => hookBlock('post-commit', { targetRel: `a${ch}b` })).toThrow(/forbidden characters/);
      expect(() => hookBlock('post-commit', { targetRel: '', store: `/a${ch}b` })).toThrow(/forbidden characters/);
      expect(() => hookBlock('post-commit', { targetRel: '', cliFallback: `/a${ch}b` })).toThrow(/forbidden characters/);
    });
  });

  describe('installHooks', () => {
    it('creates both hook files when missing', () => {
      const store = '/tmp/store';
      const paths = installHooks(tempDir, { store });

      expect(paths).toHaveLength(2);
      expect(paths).toEqual(
        expect.arrayContaining([
          path.join(tempDir, '.git/hooks/post-commit'),
          path.join(tempDir, '.git/hooks/post-merge'),
        ])
      );

      // Check files exist
      for (const hookPath of paths) {
        expect(fs.existsSync(hookPath)).toBe(true);
        const stats = fs.statSync(hookPath);
        expect((stats.mode & 0o111) !== 0).toBe(true); // executable
      }
    });

    it('includes shebang and correct blocks', () => {
      const store = '/tmp/store';
      installHooks(tempDir, { store });

      const postCommitPath = path.join(tempDir, '.git/hooks/post-commit');
      const content = fs.readFileSync(postCommitPath, 'utf8');

      expect(content.substring(0, 9)).toBe('#!/bin/sh');
      expect(content).toContain(HOOK_BEGIN);
      expect(content).toContain(HOOK_END);
      expect(content).toContain(`hook post-commit --repo "$TARGET" --store "${store}"`);
    });

    it('is idempotent (installing twice produces identical files)', () => {
      const store = '/tmp/store';
      const paths1 = installHooks(tempDir, { store });
      const contents1 = paths1.map(p => fs.readFileSync(p, 'utf8'));

      const paths2 = installHooks(tempDir, { store });
      const contents2 = paths2.map(p => fs.readFileSync(p, 'utf8'));

      expect(contents1).toEqual(contents2);
    });

    it('replaces a block installed before 0.8.0 (no shas) with the new one, keeping the rest', () => {
      const hookPath = path.join(tempDir, '.git/hooks/post-merge');
      // written by an older version: the c4pm markers and the c4pm text (still recognised as ours)
      const oldBlock = [
        LEGACY_HOOK_BEGIN,
        '# Added by `c4pm install-hooks`. Remove with `c4pm uninstall-hooks`. Never blocks git.',
        'ROOT="$(git rev-parse --show-toplevel)"',
        'TARGET="$ROOT"',
        'if command -v c4pm >/dev/null 2>&1; then C4="c4pm"; else C4=""; fi',
        '[ -n "$C4" ] && ( $C4 hook post-merge --repo "$TARGET" >/dev/null 2>&1 & ) || true',
        LEGACY_HOOK_END,
      ].join('\n');
      fs.writeFileSync(hookPath, `#!/bin/sh\necho before\n${oldBlock}\necho after\n`, 'utf8');

      installHooks(tempDir);

      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toBe(`#!/bin/sh\necho before\n${hookBlock('post-merge', { targetRel: '' })}\necho after\n`);
      expect(content.split(HOOK_BEGIN)).toHaveLength(2);
      expect(content).toContain('--orig-head "$ORIG_SHA"');
    });

    it('preserves existing content when no marker is present', () => {
      const store = '/tmp/store';
      const hookPath = path.join(tempDir, '.git/hooks/post-commit');

      // Write existing hook
      fs.writeFileSync(hookPath, '#!/bin/sh\necho mine\n', 'utf8');

      installHooks(tempDir, { store });

      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('echo mine');
      expect(content).toContain(HOOK_BEGIN);
      expect(content).toContain(HOOK_END);
    });

    it('throws for non-git repository', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-not-git-'));
      try {
        expect(() => installHooks(nonGitDir, { store: '/tmp/store' })).toThrow(/not a git repository/i);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('throws for bad store path', () => {
      expect(() => installHooks(tempDir, { store: '/path/with"quote' })).toThrow(/forbidden characters/);
      expect(() => installHooks(tempDir, { store: '/path/with$var' })).toThrow(/forbidden characters/);
      expect(() => installHooks(tempDir, { store: '/path/with`cmd`' })).toThrow(/forbidden characters/);
    });
  });

  describe('uninstallHooks', () => {
    it('removes installer-created hook files', () => {
      const store = '/tmp/store';
      const paths = installHooks(tempDir, { store });

      const removed = uninstallHooks(tempDir);
      expect(removed).toHaveLength(2);

      // Files should be deleted
      for (const hookPath of paths) {
        expect(fs.existsSync(hookPath)).toBe(false);
      }
    });

    it('removes a block an older version wrote (c4pm markers), keeping the rest', () => {
      const hookPath = path.join(tempDir, '.git/hooks/post-commit');
      const oldBlock = [LEGACY_HOOK_BEGIN, '# Added by `c4pm install-hooks`.', 'C4="c4pm"', LEGACY_HOOK_END].join('\n');
      fs.writeFileSync(hookPath, `#!/bin/sh\necho mine\n\n${oldBlock}\n`, 'utf8');

      expect(uninstallHooks(tempDir)).toContain(hookPath);

      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('echo mine');
      expect(content).not.toContain('c4pm');
    });

    it('preserves existing content when removing marker', () => {
      const store = '/tmp/store';
      const hookPath = path.join(tempDir, '.git/hooks/post-commit');

      // Install first
      installHooks(tempDir, { store });

      // Add more content after the block
      let content = fs.readFileSync(hookPath, 'utf8');
      content += '\necho after\n';
      fs.writeFileSync(hookPath, content, 'utf8');

      // Uninstall
      uninstallHooks(tempDir);

      // File should exist and contain the added content
      expect(fs.existsSync(hookPath)).toBe(true);
      const remaining = fs.readFileSync(hookPath, 'utf8');
      expect(remaining).toContain('echo after');
      expect(remaining).not.toContain(HOOK_BEGIN);
    });

    it('preserves existing content before the block', () => {
      const store = '/tmp/store';
      const hookPath = path.join(tempDir, '.git/hooks/post-commit');

      // Write existing hook with content before
      fs.writeFileSync(hookPath, '#!/bin/sh\necho before\n', 'utf8');

      // Install
      installHooks(tempDir, { store });

      // Verify content before is there
      let content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('echo before');

      // Uninstall
      uninstallHooks(tempDir);

      // File should exist and contain the original content
      expect(fs.existsSync(hookPath)).toBe(true);
      const remaining = fs.readFileSync(hookPath, 'utf8');
      expect(remaining).toContain('echo before');
      expect(remaining).not.toContain(HOOK_BEGIN);
    });

    it('throws for non-git repository', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-not-git-'));
      try {
        expect(() => uninstallHooks(nonGitDir)).toThrow(/not a git repository/i);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('handles install and uninstall of mixed hooks', () => {
      const store = '/tmp/store';
      const postCommitPath = path.join(tempDir, '.git/hooks/post-commit');
      const postMergePath = path.join(tempDir, '.git/hooks/post-merge');

      // Pre-create post-merge with existing content
      fs.writeFileSync(postMergePath, '#!/bin/sh\necho mine\n', 'utf8');

      // Install
      installHooks(tempDir, { store });

      // Verify post-merge contains both old and new content
      let content = fs.readFileSync(postMergePath, 'utf8');
      expect(content).toContain('echo mine');
      expect(content).toContain(HOOK_BEGIN);

      // Uninstall
      uninstallHooks(tempDir);

      // post-commit should be deleted (only had our block)
      expect(fs.existsSync(postCommitPath)).toBe(false);

      // post-merge should exist with only old content
      expect(fs.existsSync(postMergePath)).toBe(true);
      const remaining = fs.readFileSync(postMergePath, 'utf8');
      expect(remaining).toContain('echo mine');
      expect(remaining).not.toContain(HOOK_BEGIN);
    });
  });
});
