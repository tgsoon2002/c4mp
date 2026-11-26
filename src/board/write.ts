import * as fs from 'fs';
import * as path from 'path';
import type { BoardFile, ParseIssue, ProjectPaths } from '../types';
import { isAutoWritable } from '../c4/writeGuard';
import { boardFileFor } from './load';
import { parseBoard } from './parse';
import { serializeBoard } from './serialize';
import { log, timed } from '../log';
import { writeAtomic } from '../util/fsAtomic';
import { CMD_NAME } from '../constants';

const TAG = 'board-write';

/** Raised when the board file cannot be edited or a write was refused/rolled back. `issues` holds the parse issues, if any. */
export class BoardWriteError extends Error {
  issues: ParseIssue[];
  constructor(message: string, issues: ParseIssue[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  ${i.message}`).join('\n')}` : message);
    this.name = 'BoardWriteError';
    this.issues = issues;
  }
}

export interface BoardWritePlan {
  path: string;
  /** Current file text; null when there is no file yet. */
  before: string | null;
  after: string;
  changed: boolean;
}

/**
 * Read the board file of `project` for editing (the caller found the project; without one it shows the `c4pm init`
 * hint). No file yet -> an EMPTY board file. A file with ANY parse issue throws: the parser drops what it cannot
 * read, so writing that result back would lose data silently.
 */
export function loadBoardForEdit(project: ProjectPaths): { data: BoardFile; text: string | null } {
  const file = boardFileFor(project);
  if (!fs.existsSync(file)) return { data: { schemaVersion: 1, boards: [] }, text: null };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BoardWriteError(`cannot read ${file}: ${(err as Error).message}`);
  }
  const parsed = parseBoard(text);
  if (parsed.data === null || parsed.issues.length > 0) {
    throw new BoardWriteError(`${file} has problems; fix them by hand before ${CMD_NAME} edits it (nothing was changed):`, parsed.issues);
  }
  return { data: parsed.data, text };
}

/** The file text now, or null when there is no file. */
function readBoardText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * What a write would do. Writes nothing. `loadedText` is the exact text `loadBoardForEdit` returned for this edit
 * (null = there was no file); it becomes `before`, so `applyBoardWrite` can refuse when the file changed since.
 * Omitted: the file as it is now.
 */
export function planBoardWrite(project: ProjectPaths, next: BoardFile, loadedText?: string | null): BoardWritePlan {
  const file = boardFileFor(project);
  const before = loadedText === undefined ? readBoardText(file) : loadedText;
  const after = serializeBoard(next);
  return { path: file, before, after, changed: before !== after };
}

/**
 * Write the planned text. Refuses unless the path is the project's board file AND inside the auto-writable area
 * (`.c4pm/`). The caller makes `.c4pm/` ready first (ensureInternalDirFor, when `changed`). Afterwards the whole
 * file is re-read and parsed; on any issue the old text is restored (or the new file removed) and a BoardWriteError
 * is thrown. Nothing is written when `changed` is false.
 */
export function applyBoardWrite(project: ProjectPaths, plan: BoardWritePlan): void {
  if (plan.path !== boardFileFor(project) || !isAutoWritable(project, plan.path)) {
    throw new BoardWriteError(`refusing to write ${plan.path}: ${CMD_NAME} writes the board only to ${boardFileFor(project)}`);
  }
  if (!plan.changed) return;
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  if (readBoardText(plan.path) !== plan.before) {
    throw new BoardWriteError(`${plan.path} changed since it was read; nothing was written. Run the command again.`);
  }
  timed('write board', () => writeAtomic(plan.path, plan.after));

  const check = parseBoard(fs.readFileSync(plan.path, 'utf8'));
  if (check.data === null || check.issues.length > 0) {
    if (plan.before === null) fs.rmSync(plan.path, { force: true });
    else timed('write board', () => writeAtomic(plan.path, plan.before as string));
    log(TAG, 'rolled back', { path: plan.path, issues: check.issues.length });
    throw new BoardWriteError('rolled back: the edited board file would not parse, nothing was changed:', check.issues);
  }
  log(TAG, 'written', { path: plan.path });
}
