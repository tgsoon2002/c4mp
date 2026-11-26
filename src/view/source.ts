import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { log } from '../log';
import { gitBin } from '../util/gitBin';

/**
 * Read a function/method's source lines straight from the repo on disk.
 * 1-based, inclusive range. Never throws: a stale line range or a file
 * that moved since the snapshot was taken must not crash view generation.
 */
export function readFunctionSource(repoRoot: string, file: string, startLine: number, endLine: number): string[] {
  const result = sliceLines(readFileLines(repoRoot, file), startLine, endLine);
  log('source', 'readFunctionSource', { repoRoot, file, startLine, endLine, linesReturned: result.length });
  return result;
}

/**
 * Read a source file once and split it into lines, for callers that take many
 * ranges from one file (sliceLines). Null when the file is not readable; never throws.
 */
export function readFileLines(repoRoot: string, file: string): string[] | null {
  try {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
  } catch (err) {
    log('source', 'readFileLines error: file not readable', { repoRoot, file, error: (err as Error)?.message });
    return null;
  }
}

/**
 * Lines startLine..endLine (1-based, inclusive; endLine clamped to the file) of a
 * readFileLines result. [] for a missing file, an invalid range or a startLine
 * past the end: a stale line range must not crash view generation.
 */
export function sliceLines(lines: string[] | null, startLine: number, endLine: number): string[] {
  if (lines === null) return [];
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    log('source', 'sliceLines error: invalid range', { startLine, endLine });
    return [];
  }
  if (startLine > lines.length) {
    log('source', 'sliceLines error: startLine out of range', { startLine, endLine, lineCount: lines.length });
    return [];
  }
  // slice end is exclusive; endLine is inclusive 1-based -> slice to endLine (clamped)
  return lines.slice(startLine - 1, Math.min(endLine, lines.length));
}

/**
 * Read a component/file's recent git history. Mirrors history/git.ts's
 * execFileSync-with-arg-array pattern: never a shell string. Not a git
 * repo, no history for the file, or git failing for any reason -> [],
 * logged, never thrown (view generation must not crash over this).
 */
export function readComponentHistory(
  repoRoot: string,
  filePath: string,
  limit?: number
): { commit: string; date: string; message: string }[] {
  const max = limit ?? 5;
  const args = [
    '-C', repoRoot,
    'log',
    '--follow',
    '-n', `${max}`,
    '--format=%H|%ad|%s',
    '--date=short',
    '--',
    filePath,
  ];

  let output: string;
  try {
    output = execFileSync(gitBin(), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log('source', 'readComponentHistory error', { repoRoot, filePath, error: (err as Error)?.message });
    return [];
  }

  if (!output.trim()) {
    log('source', 'readComponentHistory: no history', { repoRoot, filePath });
    return [];
  }

  const entries = output
    .trim()
    .split('\n')
    .map((line) => {
      const first = line.indexOf('|');
      const second = line.indexOf('|', first + 1);
      if (first === -1 || second === -1) return null;
      return {
        commit: line.slice(0, first),
        date: line.slice(first + 1, second),
        message: line.slice(second + 1),
      };
    })
    .filter((e): e is { commit: string; date: string; message: string } => e !== null);

  log('source', 'readComponentHistory', { repoRoot, filePath, count: entries.length });

  return entries;
}

export type ComponentHistoryEntry = ReturnType<typeof readComponentHistory>[number];

/**
 * readComponentHistory with a per-file memo: one `git log --follow` per distinct file, however many components name it.
 * Make one reader per build (never module-level: the memo would grow across scans in a long-lived process). Each call
 * returns fresh entry objects, so no two nodes share an array.
 */
export function componentHistoryReader(repoRoot: string, limit?: number): (filePath: string) => ComponentHistoryEntry[] {
  const memo = new Map<string, ComponentHistoryEntry[]>();
  return (filePath) => {
    let entries = memo.get(filePath);
    if (!entries) {
      entries = readComponentHistory(repoRoot, filePath, limit);
      memo.set(filePath, entries);
    }
    return entries.map((e) => ({ ...e }));
  };
}
