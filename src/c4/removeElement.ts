import type { Plan } from '../types';
import { log } from '../log';
import { planRemovalScope, type RemovalRelation } from './removeScope';
import { renderUnified, type Op } from './textDiff';
import { splitLines } from '../util/text';

const TAG = 'remove';

export interface RemovalFile {
  file: string;
  oldText: string;
  newText: string;
  diff: string;   // unified diff, '' when nothing in this file changed
}

export type RemovalResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      blocked: true;                                       // children live in an extend block elsewhere: no diff
      block: { file: string; startLine: number; endLine: number };
      removedElements: string[];
      relations: RemovalRelation[];
      otherFileChildren: string[];                         // remove these first
    }
  | {
      ok: true;
      blocked: false;
      files: RemovalFile[];
      removedElements: string[];
      relations: RemovalRelation[];                        // all relations that mention the element, removed or not
      otherFileChildren: [];
    };

/**
 * Unified diff for deleting whole lines. `deleted` = 0-based line indexes (out-of-range ones are ignored).
 * Same rendering as unifiedDiff (textDiff.ts), but the edit script is known, so no LCS is needed.
 */
export function unifiedDeleteDiff(file: string, lines: string[], deleted: Set<number>): string {
  return renderUnified(file, lines.map((line, i): Op => ({ t: deleted.has(i) ? '-' : ' ', line })));
}

/**
 * Delete one plan element's lines (and optionally the plain relation lines that mention it). Pure: nothing is written.
 * `texts` key = repo-relative plan file (same string as PlanElement.source.file).
 * Only whole lines are deleted; all other bytes stay identical (no blank-line cleanup).
 * A relation line that is also the first line of a plan element (relation and bodiless element on one line) is not deleted.
 */
export function planRemoval(texts: Map<string, string>, plan: Plan, fqn: string, opts?: { relations?: boolean }): RemovalResult {
  const s = planRemovalScope(texts, plan, fqn);
  if (!s.ok) return s;
  if (s.blocked) {
    log(TAG, 'removal blocked', { fqn, otherFileChildren: s.otherFileChildren });
    return { ok: true, blocked: true, block: s.block, removedElements: s.removedElements, relations: s.relations, otherFileChildren: s.otherFileChildren };
  }

  const del = new Map<string, Set<number>>();   // file -> 0-based line indexes
  const mark = (file: string, line: number) => {
    const set = del.get(file) ?? new Set<number>();
    set.add(line - 1);
    del.set(file, set);
  };
  for (let ln = s.block.startLine; ln <= s.block.endLine; ln++) mark(s.block.file, ln);
  if (opts?.relations) {
    for (const r of s.relations) {
      if (r.insideBlock || r.manual) continue;
      if (plan.elements.some(e => e.source.file === r.file && e.source.line === r.line)) continue;
      mark(r.file, r.line);
    }
  }

  const files: RemovalFile[] = [];
  const names = [...del.keys()].sort((a, b) => (a === s.block.file ? -1 : b === s.block.file ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const file of names) {
    const oldText = texts.get(file);
    if (oldText === undefined) return { ok: false, reason: `no text for ${file}` };
    const lines = splitLines(oldText);
    const set = del.get(file)!;
    if (Math.max(...set) >= lines.length) return { ok: false, reason: `line out of range in ${file}` };
    const newText = lines.filter((_, i) => !set.has(i)).join('');
    files.push({ file, oldText, newText, diff: unifiedDeleteDiff(file, lines, set) });
  }
  log(TAG, 'removal planned', { fqn, files: files.map(f => f.file), withRelations: !!opts?.relations });
  return { ok: true, blocked: false, files, removedElements: s.removedElements, relations: s.relations, otherFileChildren: [] };
}
