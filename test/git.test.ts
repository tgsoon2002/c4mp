import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { listCommits, exportCommit, currentBranch, commitInfo } from '../src/history/git';

describe('git', () => {
  it('commitInfo: HEAD equals the newest listCommits entry; an unknown ref (no ORIG_HEAD yet) is null; no repo throws', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));
    const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nogit-'));
    try {
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });
      expect(commitInfo(tempRepo, 'HEAD')).toBeNull(); // no commit yet
      for (const v of ['v1', 'v2']) {
        fs.writeFileSync(path.join(tempRepo, 'a.txt'), v);
        execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'commit', '-m', v], { stdio: 'ignore' });
      }
      const commits = listCommits(tempRepo);
      expect(commitInfo(tempRepo, 'HEAD')).toEqual(commits[commits.length - 1]);
      expect(commitInfo(tempRepo, commits[0].commit)).toEqual(commits[0]);
      expect(commitInfo(tempRepo, 'ORIG_HEAD')).toBeNull();
      expect(commitInfo(tempRepo, 'no-such-branch')).toBeNull();
      expect(() => commitInfo(noRepo, 'HEAD')).toThrow('Not a git repository');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(noRepo, { recursive: true, force: true });
    }
  });

  it('listCommits: creates temp git repo with 2 commits, returns oldest first', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));

    try {
      // Initialize repo
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });

      // First commit with fixed date
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v1');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v1'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z'
        }
      });

      // Second commit with different date
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v2');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v2'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-02T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-02T10:00:00Z'
        }
      });

      // Test listCommits
      const commits = listCommits(tempRepo);
      expect(commits).toHaveLength(2);

      // Oldest first
      expect(commits[0].subject).toBe('v1');
      expect(commits[1].subject).toBe('v2');

      // Dates are correct (both should start with date)
      expect(commits[0].date).toMatch(/^2026-01-01T/);
      expect(commits[1].date).toMatch(/^2026-01-02T/);

      // Depths increase
      expect(commits[0].depth).toBe(1);
      expect(commits[1].depth).toBe(2);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  /** Every path under dir (relative, '/'-separated, sorted): the export must leave exactly the commit's tree. */
  const treeOf = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split(path.sep).join('/')).sort();

  it('exportCommit: exports first commit to another temp dir, repo unchanged, no tar file left (b637)', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));
    // A private parent, so "nothing else next to the export dir" can be checked exactly.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-parent-'));
    const tempExport = fs.mkdtempSync(path.join(parent, 'c4pm-export-'));

    try {
      // Initialize repo
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });

      // First commit with fixed date: a file at the root and one in a sub dir
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v1');
      fs.mkdirSync(path.join(tempRepo, 'sub'));
      fs.writeFileSync(path.join(tempRepo, 'sub', 'b.txt'), 'b1');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt', 'sub/b.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v1'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z'
        }
      });

      // Second commit with different content
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v2');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v2'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-02T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-02T10:00:00Z'
        }
      });

      // Get the first commit
      const commits = listCommits(tempRepo);
      const firstCommit = commits[0].commit;

      // Export the first commit
      exportCommit(tempRepo, firstCommit, tempExport);

      // Verify exported content is "v1", the commit's files only: no tar in the dest, nothing next to it
      const exportedContent = fs.readFileSync(path.join(tempExport, 'a.txt'), 'utf8');
      expect(exportedContent).toBe('v1');
      expect(fs.readFileSync(path.join(tempExport, 'sub', 'b.txt'), 'utf8')).toBe('b1');
      expect(treeOf(tempExport)).toEqual(['a.txt', 'sub', 'sub/b.txt']);
      expect(fs.readdirSync(parent)).toEqual([path.basename(tempExport)]);

      // Verify repo's working tree is still "v2"
      const repoContent = fs.readFileSync(path.join(tempRepo, 'a.txt'), 'utf8');
      expect(repoContent).toBe('v2');

      // Verify repo has no uncommitted changes
      const status = execFileSync('git', ['-C', tempRepo, 'status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      expect(status).toBe('');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('exportCommit: a bad commit or a non-repo throws and leaves no tar file (b637)', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));
    const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nogit-'));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-parent-'));
    const tempExport = fs.mkdtempSync(path.join(parent, 'c4pm-export-'));
    try {
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v1');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v1'], { stdio: 'ignore' });

      expect(() => exportCommit(tempRepo, 'no-such-commit', tempExport)).toThrow(/git.* archive --format=tar no-such-commit/);
      expect(() => exportCommit(noRepo, 'HEAD', tempExport)).toThrow(`Not a git repository: ${noRepo}`);
      expect(treeOf(tempExport)).toEqual([]);
      expect(fs.readdirSync(parent)).toEqual([path.basename(tempExport)]);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(noRepo, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('listCommits: throws for non-git repo', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nogit-'));

    try {
      expect(() => listCommits(tempDir)).toThrow('Not a git repository');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('listCommits: respects max option', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));

    try {
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });

      // Create 3 commits
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(tempRepo, 'a.txt'), `v${i + 1}`);
        execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tempRepo, 'commit', '-m', `v${i + 1}`], {
          stdio: 'ignore',
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: `2026-01-0${i + 1}T10:00:00Z`,
            GIT_COMMITTER_DATE: `2026-01-0${i + 1}T10:00:00Z`
          }
        });
      }

      // Test max option - should return only the newest 1
      const commits = listCommits(tempRepo, { max: 1 });
      expect(commits).toHaveLength(1);
      expect(commits[0].subject).toBe('v3');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('currentBranch: returns branch name or null for detached HEAD', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-git-'));

    try {
      execFileSync('git', ['-C', tempRepo, 'init'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'config', 'user.name', 't'], { stdio: 'ignore' });

      // Create a commit on main
      fs.writeFileSync(path.join(tempRepo, 'a.txt'), 'v1');
      execFileSync('git', ['-C', tempRepo, 'add', 'a.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', tempRepo, 'commit', '-m', 'v1'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z'
        }
      });

      // Check branch name (should be master or main, but at least not null)
      const branch = currentBranch(tempRepo);
      expect(branch).not.toBeNull();
      expect(typeof branch).toBe('string');
      expect(branch).not.toBe('HEAD');
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });
});
