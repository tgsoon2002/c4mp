import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../log';
import { gitBin } from '../util/gitBin';

export interface CommitInfo {
  commit: string;
  date: string;
  subject: string;
  depth: number;
}

/** The `git log` format both readers parse: sha, committer date (ISO), subject, separated by \x1f. */
const LOG_FORMAT = '--format=%H%x1f%cI%x1f%s';

/** One LOG_FORMAT line as a CommitInfo (depth from `git rev-list --count`); null when the line is not in that form. */
function parseLogLine(repo: string, line: string): CommitInfo | null {
  const parts = line.split('\x1f');
  if (parts.length !== 3) {
    return null;
  }
  const commit = parts[0];
  const depth = Number(execFileSync(gitBin(), ['-C', repo, 'rev-list', '--count', commit], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim());
  return {
    commit,
    date: parts[1],
    subject: parts[2],
    depth
  };
}

export function listCommits(repo: string, opts?: { max?: number; since?: string }): CommitInfo[] {
  const args = ['-C', repo, 'log', '--first-parent', LOG_FORMAT];

  if (opts?.max) {
    args.push(`-n`, `${opts.max}`);
  }

  if (opts?.since) {
    args.push(`--since=${opts.since}`);
  }

  try {
    const output = execFileSync(gitBin(), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (!output.trim()) {
      return [];
    }

    const lines = output.trim().split('\n');
    const commits: CommitInfo[] = lines
      .map(line => parseLogLine(repo, line))
      .filter((c): c is CommitInfo => c !== null);

    // Reverse to get oldest first
    commits.reverse();

    log('git', 'listCommits', { repo, count: commits.length, oldest: commits[0]?.commit, newest: commits[commits.length - 1]?.commit });

    return commits;
  } catch (err) {
    const errObj = err as any;
    const message = errObj?.message || '';
    const stderr = errObj?.stderr?.toString() || '';
    if (message.includes('fatal:') || stderr.includes('fatal:') || stderr.includes('not a git repository')) {
      log('git', 'listCommits error', { repo, error: 'not a git repository' });
      throw new Error(`Not a git repository: ${repo}`);
    }
    throw err;
  }
}

/**
 * The CommitInfo of one ref (HEAD, ORIG_HEAD, a branch, a sha): the same fields listCommits gives. null when the ref
 * names no commit (no ORIG_HEAD yet, HEAD of a repo without commits). The ref is resolved first with
 * `git rev-parse --verify --quiet <ref>^{commit}` (exit 1, no output = no such commit); any other git failure
 * (not a git repository, git missing) is thrown.
 */
export function commitInfo(repo: string, ref: string): CommitInfo | null {
  const resolved = spawnSync(gitBin(), ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (resolved.error) throw resolved.error;
  if (resolved.status === 1 && !resolved.stdout.trim()) {
    log('git', 'commitInfo unresolved', { repo, ref });
    return null;
  }
  if (resolved.status !== 0) {
    const stderr = resolved.stderr.trim();
    throw new Error(stderr.includes('not a git repository') ? `Not a git repository: ${repo}` : `git rev-parse ${ref} failed: ${stderr}`);
  }
  const sha = resolved.stdout.trim();
  const line = execFileSync(gitBin(), ['-C', repo, 'log', '-1', LOG_FORMAT, sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const info = parseLogLine(repo, line);
  if (!info) throw new Error(`git log -1 ${sha}: unexpected output '${line}'`);
  log('git', 'commitInfo', { repo, ref, commit: info.commit.slice(0, 7), depth: info.depth });
  return info;
}

/**
 * Write the tree of `commit` into destDir. The `git archive` tar goes to a temp file inside destDir (git's stdout is
 * that file's fd, so the tar never sits in node memory: a ~100 MB Buffer per commit was given back only when the
 * event loop turned, b637/b638), `tar -xf` extracts it, and the tar file is removed in every case. Being inside
 * destDir, a run killed mid-export leaves it to the caller's cleanup of destDir (history: the 24 h c4pm-export-* sweep).
 * git or tar failing throws; a non-repo throws `Not a git repository: <repo>`.
 */
export function exportCommit(repo: string, commit: string, destDir: string): void {
  const tarFile = path.join(destDir, `.c4pm-archive-${crypto.randomBytes(6).toString('hex')}.tar`);
  try {
    const fd = fs.openSync(tarFile, 'wx');
    try {
      execFileSync(gitBin(), ['-C', repo, 'archive', '--format=tar', commit], {
        stdio: ['ignore', fd, 'pipe']
      });
    } finally {
      fs.closeSync(fd);
    }

    execFileSync('tar', ['-xf', tarFile, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    log('git', 'exportCommit', { repo, commit: commit.slice(0, 7), destDir });
  } catch (err) {
    const message = (err as Error)?.message || '';
    if (message.includes('not a git repository')) {
      throw new Error(`Not a git repository: ${repo}`);
    }
    throw err;
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
}

export function currentBranch(repo: string): string | null {
  try {
    const branch = execFileSync(gitBin(), ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (branch === 'HEAD') {
      log('git', 'currentBranch', { repo, branch: null });
      return null;
    }

    log('git', 'currentBranch', { repo, branch });
    return branch;
  } catch {
    log('git', 'currentBranch error', { repo });
    return null;
  }
}
