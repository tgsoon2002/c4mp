/**
 * b456 (SR1): `c4pm plan upgrade`, the pure text step. Rewrites the old kind words of one .c4 file to the current plan
 * standard (src/plan/renames.ts: today `layer` -> `subregion`). Only token positions are touched (the offset scanner of
 * editMeta.ts, token-for-token equal to the lexer), so strings, comments, descriptions and element ids never change.
 * L2: imports the scanner (same folder) and the renames table (L1).
 */
import { scanPlanTokens } from './editMeta';
import { canonicalKind, oldKindWords } from '../plan/renames';

/** One rewritten word: its line, the old and the new word, and where it stood (element kind or specification). */
export interface UpgradeChange { line: number; from: string; to: string; what: 'kind' | 'specification' }

/**
 * The text with every old kind word in a kind position replaced by its current word (canonicalKind, so a later a -> b -> c
 * chain goes straight to c), and the list of changes in line order. A kind position is an ident right after `=`
 * (`x = layer 'X'`), or an ident right after the word `element` inside a `specification { }` block. Anything else
 * (an id named `layer`, a string, a comment, a metadata value) is left as written. No change: the same text, [].
 */
export function upgradePlanText(text: string): { text: string; changes: UpgradeChange[] } {
  const old = new Set(oldKindWords());
  const { toks } = scanPlanTokens(text);
  const edits: { start: number; end: number; change: UpgradeChange }[] = [];
  let depth = 0;
  let specDepth = -1;   // brace depth inside the specification block; -1 = not in one
  toks.forEach((t, i) => {
    const prev = i > 0 ? toks[i - 1] : undefined;
    if (t.type === 'lbrace') {
      depth++;
      if (specDepth < 0 && prev?.type === 'ident' && prev.value === 'specification') specDepth = depth;
      return;
    }
    if (t.type === 'rbrace') {
      if (depth === specDepth) specDepth = -1;
      depth = Math.max(0, depth - 1);
      return;
    }
    if (t.type !== 'ident' || !old.has(t.value) || prev === undefined) return;
    const kindPos = prev.type === 'equals';
    const specPos = specDepth >= 0 && prev.type === 'ident' && prev.value === 'element';
    if (!kindPos && !specPos) return;
    const to = canonicalKind(t.value);
    if (to === t.value) return;
    edits.push({ start: t.start, end: t.end, change: { line: t.line, from: t.value, to, what: kindPos ? 'kind' : 'specification' } });
  });
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.change.to + out.slice(e.end);
  return { text: out, changes: edits.map((e) => e.change) };
}
