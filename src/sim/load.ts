import * as fs from 'fs';
import * as path from 'path';
import type { ProjectPaths, SimFileIssue, SimItem } from '../types';
import { parseSim, SIM_ID_RE } from './parse';
import { log } from '../log';

/** `<projectDir>/sim`, next to `board/`: inside `.c4pm/`, so it is committed. */
export function simDirFor(paths: ProjectPaths): string {
  return path.join(paths.projectDir, 'sim');
}

/** `<projectDir>/sim/<id>.json`: one file per s-item. */
export function simFileFor(paths: ProjectPaths, id: string): string {
  return path.join(simDirFor(paths), `${id}.json`);
}

export interface LoadedSims {
  /** Every s-item that parsed without an issue, by number (s-2 before s-10). */
  items: SimItem[];
  /** id -> the exact text read, for every readable `s-<N>.json` (the writer refuses when a file changed since). */
  texts: Map<string, string>;
  /** Per file; a file with an issue is not in `items`. */
  issues: SimFileIssue[];
  /** Tolerated oddities (unknown keys): data was kept; never block a write. */
  notes: SimFileIssue[];
  /** Every `s-<N>` file name, broken or unreadable ones too, by number: minting takes max N + 1 over these. */
  fileIds: string[];
  /** The sim folder when it exists; null when the repo has no project or no sim folder. */
  dir: string | null;
}

const simNumber = (id: string): number => Number(SIM_ID_RE.exec(id)?.[1] ?? 0);
const byNumber = (a: string, b: string): number => simNumber(a) - simNumber(b);

/**
 * Read-only: every `sim/s-<N>.json` of `project` (the caller found the project). Never creates a folder or a file.
 * No project or no folder -> nothing. Files that are not `.json` are ignored; a `.json` whose name is not `s-<N>.json`
 * is an issue. A broken or unreadable file is an issue of that file only: the others still load.
 */
export function loadSims(project: ProjectPaths | null): LoadedSims {
  const out: LoadedSims = { items: [], texts: new Map(), issues: [], notes: [], fileIds: [], dir: null };
  if (!project) return out;
  const dir = simDirFor(project);
  if (!fs.existsSync(dir)) return out;
  out.dir = dir;

  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch (err) {
    out.issues.push({ file: '', message: `cannot read ${dir}: ${(err as Error).message}` });
    return out;
  }
  const ids: string[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (SIM_ID_RE.test(id)) ids.push(id);
    else out.issues.push({ file: name, message: 'file name must be s-<N>.json (file skipped)' });
  }
  ids.sort(byNumber);
  out.fileIds = ids;

  for (const id of ids) {
    const name = `${id}.json`;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (err) {
      log('sim', 'loadSims read failed', { file: name, error: (err as Error).message });
      out.issues.push({ file: name, message: `cannot read ${path.join(dir, name)}: ${(err as Error).message}` });
      continue;
    }
    out.texts.set(id, text);
    const parsed = parseSim(text, name);
    out.issues.push(...parsed.issues);
    out.notes.push(...parsed.notes);
    if (parsed.data) out.items.push(parsed.data);
  }
  log('sim', 'loadSims', { files: ids.length, items: out.items.length, issues: out.issues.length });
  return out;
}
