/**
 * b456 (SR1): the ONE table of renamed plan words, per plan standard version (Document/PLAN-STANDARD.md PS-3.11d).
 * Readers map an old word to the current one (the parser for kinds, the ack matcher for rule ids); writers write the
 * current word; `c4pm plan upgrade` rewrites old kind words in .c4 text. A later rename adds one row; nothing else changes.
 * Imports nothing.
 */

export interface StandardStep {
  /** The PLAN-STANDARD version that introduced the new words. */
  version: string;
  /** Old kind word -> new kind word. */
  kinds?: Record<string, string>;
  /** Old check-rule id -> new rule id. */
  rules?: Record<string, string>;
}

/** Oldest first. */
export const STANDARD_STEPS: StandardStep[] = [
  { version: '1.9', kinds: { layer: 'subregion' }, rules: { 'layer-misplaced': 'subregion-misplaced' } },
  { version: '1.10' },   // simulation files (chapter 10): no plan word renamed (old sim view words: src/sim/parse.ts OLD_VIEW_WORDS)
  { version: '1.11' },   // person shape (person | robot): no plan word renamed
  { version: '1.12' },   // component role (foundation): no plan word renamed
];

/** The plan standard the current writers follow (PLAN-STANDARD.md line 3; a test pins the two together). */
export const PLAN_STANDARD_VERSION = '1.12';

/** `word` after every step of `steps` that renames it (a -> b -> c across steps). Unknown words come back unchanged. */
export function canonicalWith(steps: StandardStep[], pick: (s: StandardStep) => Record<string, string> | undefined, word: string): string {
  let w = word;
  for (const s of steps) {
    const table = pick(s);
    if (table && Object.prototype.hasOwnProperty.call(table, w)) w = table[w];
  }
  return w;
}

/** The current kind word for `word` (`layer` -> `subregion`); any other word unchanged. */
export const canonicalKind = (word: string): string => canonicalWith(STANDARD_STEPS, (s) => s.kinds, word);

/** The current check-rule id for `id` (`layer-misplaced` -> `subregion-misplaced`); any other id unchanged. */
export const canonicalRule = (id: string): string => canonicalWith(STANDARD_STEPS, (s) => s.rules, id);

/** Old kind words of every step (for `plan upgrade` and messages). */
export const oldKindWords = (): string[] => STANDARD_STEPS.flatMap((s) => Object.keys(s.kinds ?? {}));
