import * as fs from 'fs';
import * as path from 'path';
import type { ProjectPaths, SimFileIssue, SimItem } from '../types';
import { isAutoWritable } from '../c4/writeGuard';
import { simDirFor, simFileFor } from './load';
import { parseSim, SIM_ID_RE } from './parse';
import { serializeSim } from './serialize';
import { commitFileSet } from '../util/fsCommit';
import type { FileChange } from '../util/fsCommit';
import { log, timed } from '../log';
import { CMD_NAME } from '../constants';

const TAG = 'sim-write';

/** Raised when s-item files cannot be written or a write was refused/rolled back. `issues` holds the parse issues, if any (shape of BoardWriteError). */
export class SimWriteError extends Error {
  issues: SimFileIssue[];
  constructor(message: string, issues: SimFileIssue[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  ${i.file}: ${i.message}`).join('\n')}` : message);
    this.name = 'SimWriteError';
    this.issues = issues;
  }
}

/** One s-item to write: `next` = its new content (null = remove the file); `loadedText` = the exact text loadSims read (null = a new file). */
export interface SimChange {
  id: string;
  next: SimItem | null;
  loadedText: string | null;
}

export interface SimWritePlan {
  /** One entry per change, in the order given. `after` null = the file is removed; `changed` false = left alone. */
  files: { path: string; before: string | null; after: string | null; changed: boolean }[];
}

/**
 * What a write would do, per file. Writes nothing. Each change goes to `simFileFor(project, id)`; `before` is the text
 * the edit was based on, so applySimWrites can refuse when a file changed since. Throws SimWriteError for a bad id
 * (not s-<N>: it would name a path outside sim/), an id given twice, or `next.id` other than `id`.
 */
export function planSimWrites(project: ProjectPaths, changes: SimChange[]): SimWritePlan {
  const seen = new Set<string>();
  const files = changes.map((c) => {
    if (!SIM_ID_RE.test(c.id)) throw new SimWriteError(`'${c.id}' is not an s-item id s-<N>; nothing was written`);
    if (seen.has(c.id)) throw new SimWriteError(`${c.id} is changed twice in one write; nothing was written`);
    seen.add(c.id);
    if (c.next && c.next.id !== c.id) throw new SimWriteError(`the content for ${c.id} has id '${c.next.id}'; nothing was written`);
    const after = c.next ? serializeSim(c.next) : null;
    return { path: simFileFor(project, c.id), before: c.loadedText, after, changed: c.loadedText !== after };
  });
  return { files };
}

/** True when `file` is `<sim dir>/s-<N>.json` of `project` and inside the auto-writable area (`.c4pm/`). */
function isSimFile(project: ProjectPaths, file: string): boolean {
  const id = path.basename(file, '.json');
  return SIM_ID_RE.test(id) && file === simFileFor(project, id) && isAutoWritable(project, file);
}

/**
 * b899: files written in the SAME set as the s-items (the plan files a sim write changes). The caller gated them;
 * `verify` checks each written extra file (the s-items keep their parse check). Not guarded as sim files.
 */
export interface SimWriteExtra {
  files: FileChange[];
  verify: (file: string, text: string) => string | null;
}

/**
 * Write the planned files as one change (commitFileSet): refused unless every path is a `sim/s-<N>.json` of the project
 * inside `.c4pm/` (the caller makes `.c4pm/` ready first: ensureInternalDirFor, when a file changes; the sim folder is
 * made here). Refused when any file changed since it was read (or a new one was created meanwhile). Every written file
 * is re-read and must parse without an issue; else every file gets its old text back. Throws SimWriteError; writes
 * nothing when no file is `changed`. b899: `extra` files go in the same set (all or nothing).
 */
export function applySimWrites(project: ProjectPaths, plan: SimWritePlan, extra?: SimWriteExtra): void {
  for (const f of plan.files) {
    if (!isSimFile(project, f.path)) {
      throw new SimWriteError(`refusing to write ${f.path}: ${CMD_NAME} writes s-items only to ${path.join(simDirFor(project), 's-<N>.json')}`);
    }
  }
  const simChanges = plan.files.filter((f) => f.changed).map(({ path: p, before, after }) => ({ path: p, before, after }));
  const extraChanges = (extra?.files ?? []).filter((f) => f.after !== f.before);
  const changes = [...simChanges, ...extraChanges];
  if (changes.length === 0) return;
  if (simChanges.some((f) => f.after !== null)) fs.mkdirSync(simDirFor(project), { recursive: true });

  let issues: SimFileIssue[] = [];
  const simVerify = (file: string, text: string): string | null => {
    const parsed = parseSim(text, path.basename(file));
    if (parsed.issues.length === 0) return null;
    issues = parsed.issues;
    return `would not parse (${parsed.issues.length} issue${parsed.issues.length === 1 ? '' : 's'})`;
  };
  const extraPaths = new Set(extraChanges.map((f) => f.path));
  const verify = (file: string, text: string): string | null => (extraPaths.has(file) ? extra!.verify(file, text) : simVerify(file, text));
  const result = timed('write sims', () => commitFileSet(changes, verify));
  if (result.ok) {
    log(TAG, 'written', { files: changes.length });
    return;
  }
  log(TAG, result.reason, { detail: result.detail });
  if (result.reason === 'changed') throw new SimWriteError(`${result.detail}; nothing was written. Run the command again.`);
  throw new SimWriteError(`rolled back: ${result.detail}; nothing was changed`, issues);
}
