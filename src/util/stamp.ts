import { createHash } from 'crypto';

/**
 * Phase 30 (SV5, b792): the "changed since read" stamp of a set of texts. sha1 hex of the (name, text) pairs sorted by
 * name, each written as `name NUL text NUL`; a null text (a missing file) is written as `NUL missing`. The order the
 * pairs come in does not matter. One stamp for one kind of input, by convention:
 * - the plan: every plan file (repo-relative path -> text), e.g. `textStamp(planTexts)`;
 * - the board: `textStamp([['board', boardText]])`.
 */
export function textStamp(parts: Iterable<[string, string | null]>): string {
  const sorted = [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha1');
  for (const [name, text] of sorted) hash.update(name).update('\0').update(text === null ? '\0missing' : text).update('\0');
  return hash.digest('hex');
}
