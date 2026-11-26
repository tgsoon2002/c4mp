import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { TOOL_VERSION } from '../constants';
import { SnapshotMeta, GitInfo } from '../types';
import { log } from '../log';
import { gitBin } from '../util/gitBin';
import { nearestAnchor, soleProjectId } from '../paths';

/** The repo's identity: absolute path and name (package.json name, else folder basename). */
export interface RepoIdentity {
  repoPath: string;
  repoName: string;
  /** Where repoName came from: the package.json "name", or the folder basename (no package.json name). */
  nameSource: 'package.json' | 'basename';
}

/**
 * The repoPath / repoName half of readMeta, without any git call: for callers that need only the name or the path
 * (project id, store lookups). readMeta uses it too, so both give the same values.
 */
export function readRepoIdentity(repoRoot: string): RepoIdentity {
  const repoPath = path.resolve(repoRoot);

  // Determine repoName
  let repoName: string;
  let nameSource: 'package.json' | 'basename';
  try {
    const packageJsonPath = path.join(repoPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (typeof packageJson.name === 'string') {
      repoName = packageJson.name;
      nameSource = 'package.json';
    } else {
      repoName = path.basename(repoPath);
      nameSource = 'basename';
    }
  } catch {
    repoName = path.basename(repoPath);
    nameSource = 'basename';
  }
  if (nameSource === 'basename') {
    // No package.json name, and repoPath is the folder that holds .c4pm (the git root): the one project folder names
    // the project (Phase 34 F2). A folder below it keeps its own name. nearestAnchor logs nothing (this runs at CLI
    // registration time, before debug output is routed).
    if (nearestAnchor(repoPath) === repoPath) {
      const sole = soleProjectId(repoPath);
      if (sole) repoName = sole;
    }
  }
  log('meta', 'repoName', { source: nameSource });
  return { repoPath, repoName, nameSource };
}

export interface ReadMetaOptions {
  // false: no git calls, git is null (for a caller that sets meta.git itself). Default true.
  git?: boolean;
}

export function readMeta(repoRoot: string, now?: Date, opts: ReadMetaOptions = {}): SnapshotMeta {
  const { repoPath, repoName } = readRepoIdentity(repoRoot);

  // Determine git info
  let git: GitInfo | null = null;
  if (opts.git === false) {
    log('meta', 'git skipped (the caller sets meta.git)');
  } else try {
    const commit = execFileSync(gitBin(), ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const branch = execFileSync(gitBin(), ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const date = execFileSync(gitBin(), ['-C', repoPath, 'log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const depth = Number(execFileSync(gitBin(), ['-C', repoPath, 'rev-list', '--count', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim());
    git = { commit, branch, date, depth };
    log('meta', 'git', { commit, branch, date, depth });
  } catch {
    log('meta', 'git none');
  }

  const createdAt = (now ?? new Date()).toISOString();

  return {
    tool: TOOL_VERSION,
    repoPath,
    repoName,
    createdAt,
    git
  };
}
