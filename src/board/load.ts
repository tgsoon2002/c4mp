import * as fs from 'fs';
import * as path from 'path';
import type { BoardFile, ParseIssue, ProjectPaths } from '../types';
import { parseBoard } from './parse';
import { log } from '../log';

/** `<projectDir>/board/board.json`: inside `.c4pm/`, so it is committed (the `C4PM/` export folder self-ignores). */
export function boardFileFor(paths: ProjectPaths): string {
  return path.join(paths.projectDir, 'board', 'board.json');
}

export interface LoadedBoard {
  data: BoardFile | null;
  issues: ParseIssue[];
  /** Tolerated oddities (unknown item keys): data was kept; shown as `board-parse` warnings, never block a write. */
  notes: ParseIssue[];
  /** Absolute path of the board file; null when the repo has no project or no board file. */
  path: string | null;
}

/**
 * Read-only: parses the board file of `project` (the caller found the project). Never creates a folder or a file.
 * No project or no file -> `{data: null, issues: [], path: null}`. A file that cannot be read -> `data: null` plus one issue.
 */
export function loadBoard(project: ProjectPaths | null): LoadedBoard {
  if (!project) return { data: null, issues: [], notes: [], path: null };
  const file = boardFileFor(project);
  if (!fs.existsSync(file)) return { data: null, issues: [], notes: [], path: null };

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('board', 'loadBoard read failed', { file, error: (err as Error).message });
    return { data: null, issues: [{ file: '', line: 0, message: `cannot read ${file}: ${(err as Error).message}` }], notes: [], path: file };
  }
  const parsed = parseBoard(text);
  return { data: parsed.data, issues: parsed.issues, notes: parsed.notes, path: file };
}
