/** Ordinal string comparison for sort(): by UTF-16 code unit, no locale (same result on every machine). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split text into lines. Default (keepEol true): each line keeps its own line ending, so `\r\n` survives and
 * joining the pieces gives the text back; '' gives []. With keepEol false: split on CRLF/LF, line endings dropped,
 * and the empty piece after a final newline is dropped (same rule as languages/typescript/outline.ts lineCount).
 */
export function splitLines(text: string, opts?: { keepEol?: boolean }): string[] {
  if (text.length === 0) return [];
  if (opts?.keepEol ?? true) return text.split(/(?<=\n)/);
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Edit distance (insert, delete, replace = 1 each). Moved from util/lookup.ts (b219). */
export function levenshtein(a: string, b: string): number {
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * b219: the one choice `input` most likely meant, or undefined. Compared lower-case; the closest by levenshtein wins
 * (ties: first in `choices`) when its distance is <= max(1, floor(input.length / 3)); otherwise a choice that starts
 * with the input (input of 3+ characters). An exact case-insensitive match is returned too ('Tags' -> 'tags').
 */
export function didYouMean(input: string, choices: readonly string[]): string | undefined {
  const q = input.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of choices) {
    const d = levenshtein(q, c.toLowerCase());
    if (d < bestDist) { best = c; bestDist = d; }
  }
  if (best !== undefined && bestDist <= Math.max(1, Math.floor(q.length / 3))) return best;
  return q.length >= 3 ? choices.find((c) => c.toLowerCase().startsWith(q)) : undefined;
}

/** b440: a Commander camelCase option key as the flag the user types: `appendDescriptionFile` -> `--append-description-file`. */
export function optionFlag(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
