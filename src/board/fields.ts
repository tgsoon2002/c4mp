/**
 * P16-B42: ONE place for the rules of the item fields that `board add`, `board set` and the bulk add share:
 * description, docs, outcome, size, sprint, priority. Pure (no fs); each check returns an error text or null so the
 * single-item CLI can refuse and the bulk add can collect problems.
 */
import type { BoardDoc } from '../types';
import { BOARD_DESCRIPTION_MAX, BOARD_KINDS, BOARD_OUTCOME_MAX, BOARD_SIZES, BOARD_STATUSES, PLAN_PRIORITIES } from '../constants';
import { boardDocProblem } from './docs';

/** Sprint format: the same rule as src/c4/validate.ts (`S15`). */
export const SPRINT_RE = /^S\d+$/;

export function descriptionProblem(v: string): string | null {
  if (v.trim() === '') return 'description must not be empty (use none to clear it)';
  return v.length > BOARD_DESCRIPTION_MAX ? `description is ${v.length} characters, the limit is ${BOARD_DESCRIPTION_MAX} (put long text in a document and add it with --doc)` : null;
}
export function outcomeProblem(v: string): string | null {
  if (v.trim() === '') return 'outcome must not be empty (use none to clear it)';
  return v.length > BOARD_OUTCOME_MAX ? `outcome is ${v.length} characters, the limit is ${BOARD_OUTCOME_MAX}` : null;
}
export const sizeProblem = (v: string): string | null => (BOARD_SIZES.includes(v) ? null : `size '${v}' should be one of ${BOARD_SIZES.join(', ')}`);
export const sprintProblem = (v: string): string | null => (SPRINT_RE.test(v) ? null : `sprint '${v}' should look like S15`);
export const priorityProblem = (v: string): string | null => (PLAN_PRIORITIES.includes(v) ? null : `priority '${v}' should be one of ${PLAN_PRIORITIES.join(', ')}`);
/** b709: kind and status, shared by board add, set, list (`--kind 'x' ...` via flagProblem) and the bulk add. */
export const kindProblem = (v: string): string | null => (BOARD_KINDS.includes(v) ? null : `kind '${v}' should be one of ${BOARD_KINDS.join(', ')}`);
export const statusProblem = (v: string): string | null => (BOARD_STATUSES.includes(v) ? null : `status '${v}' should be one of ${BOARD_STATUSES.join(', ')}`);
/** A field problem as the CLI says it for the option of the same name: `kind 'x' ...` -> `--kind 'x' ...`; null stays null. */
export const flagProblem = (problem: string | null): string | null => (problem === null ? null : `--${problem}`);

/**
 * `--doc` values -> specs. Each value may be a comma list; a comma only splits where the next piece starts with
 * `path:` or `url:` (optionally after `Label=`), so commas inside a label or a url query survive.
 */
export function splitDocSpecs(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) for (const piece of v.split(/,(?=\s*(?:[^,=:]+=)?(?:path|url):)/)) if (piece.trim() !== '') out.push(piece.trim());
  return out;
}

/** One spec: `path:docs/x.md`, `url:https://...`, with an optional `Label=` in front. */
export function parseDocSpec(spec: string): { doc: BoardDoc } | { error: string } {
  const m = /^(?:([^=:][^=]*?)=)?(path|url):(.*)$/.exec(spec.trim());
  if (!m) return { error: `doc '${spec}' should look like path:docs/x.md, url:https://... or Label=path:docs/x.md` };
  const doc: BoardDoc = {};
  if (m[1] !== undefined && m[1].trim() !== '') doc.label = m[1].trim();
  doc[m[2] as 'path' | 'url'] = m[3].trim();
  const problem = boardDocProblem(doc);
  return problem ? { error: `doc '${spec}': ${problem}` } : { doc };
}

/** Same document twice (same path or url) is stored once. */
export function sameDoc(a: BoardDoc, b: BoardDoc): boolean {
  return a.path !== undefined ? a.path === b.path : a.url === b.url;
}

export function docText(d: BoardDoc): string {
  return `${d.label !== undefined ? `${d.label}=` : ''}${d.path !== undefined ? `path:${d.path}` : `url:${d.url}`}`;
}

/**
 * b440: an old description plus added text, ONE blank line between them. No old text (undefined or only white space)
 * = the added text alone. Leading blank lines and trailing white space of `added` are dropped; the old text keeps its
 * own leading white space. Pure.
 */
export function joinDescription(old: string | undefined, added: string, mode: 'append' | 'prepend'): string {
  const add = added.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  const base = (old ?? '').replace(/\s+$/, '');
  if (base.trim() === '') return add;
  return mode === 'append' ? `${base}\n\n${add}` : `${add}\n\n${base}`;
}

/**
 * b441: the one rule for adding to and removing from a list field of an item (tags, dependsOn, docs). Drops every value
 * of `remove`, then appends each value of `add` not yet present (kept once, order kept). `missing` = values of `remove`
 * the list did not hold; `clash` = values both added and removed. Pure; `same` defaults to ===.
 */
export function editList<T>(current: readonly T[], add: readonly T[], remove: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): { list: T[]; missing: T[]; clash: T[] } {
  const has = (xs: readonly T[], v: T): boolean => xs.some((x) => same(x, v));
  const list = current.filter((v) => !has(remove, v));
  for (const v of add) if (!has(list, v)) list.push(v);
  return { list, missing: remove.filter((v) => !has(current, v)), clash: add.filter((v) => has(remove, v)) };
}
