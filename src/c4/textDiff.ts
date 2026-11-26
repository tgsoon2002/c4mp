import { splitLines } from '../util/text';

const CONTEXT = 3;
const MAX_CELLS = 25_000_000;   // LCS table limit; above it the changed middle is shown as one replace

export type Op ={ t: ' ' | '-' | '+'; line: string };

/** Edit script between two line arrays: common prefix and suffix trimmed, LCS on the middle. */
function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i] });

  if (am.length * bm.length > MAX_CELLS) {
    for (const l of am) ops.push({ t: '-', line: l });
    for (const l of bm) ops.push({ t: '+', line: l });
  } else {
    // lcs[i][j] = LCS length of am[i..] and bm[j..]
    const n = am.length;
    const m = bm.length;
    const lcs: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ t: ' ', line: am[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', line: am[i] }); i++; }
      else { ops.push({ t: '+', line: bm[j] }); j++; }
    }
    while (i < n) { ops.push({ t: '-', line: am[i++] }); }
    while (j < m) { ops.push({ t: '+', line: bm[j++] }); }
  }

  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', line: a[i] });
  return ops;
}

/**
 * Render an edit script as a unified diff (3 lines of context, `--- a/<file>` / `+++ b/<file>`).
 * '' when no op changes anything. Hunks whose context touches or overlaps are merged.
 */
export function renderUnified(file: string, ops: Op[]): string {
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.t !== ' ') changed.push(i); });
  if (changed.length === 0) return '';

  // cumulative line counts: oldBefore[i] = old lines consumed by ops[0..i)
  const oldBefore: number[] = [0];
  const newBefore: number[] = [0];
  for (const o of ops) {
    oldBefore.push(oldBefore[oldBefore.length - 1] + (o.t === '+' ? 0 : 1));
    newBefore.push(newBefore[newBefore.length - 1] + (o.t === '-' ? 0 : 1));
  }

  const groups: { first: number; last: number }[] = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g && i - g.last - 1 <= 2 * CONTEXT) g.last = i;
    else groups.push({ first: i, last: i });
  }

  const show = (l: string) => (l.endsWith('\n') ? l : l + '\n\\ No newline at end of file\n');
  let out = `--- a/${file}\n+++ b/${file}\n`;
  for (const g of groups) {
    const start = Math.max(0, g.first - CONTEXT);
    const end = Math.min(ops.length - 1, g.last + CONTEXT);
    const oldLen = oldBefore[end + 1] - oldBefore[start];
    const newLen = newBefore[end + 1] - newBefore[start];
    const oldStart = oldLen === 0 ? oldBefore[start] : oldBefore[start] + 1;
    const newStart = newLen === 0 ? newBefore[start] : newBefore[start] + 1;
    out += `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`;
    for (let i = start; i <= end; i++) out += ops[i].t + show(ops[i].line);
  }
  return out;
}

/** Generic unified diff of two texts, empty string when they are equal. */
export function unifiedDiff(file: string, oldText: string, newText: string): string {
  if (oldText === newText) return '';
  return renderUnified(file, diffOps(splitLines(oldText), splitLines(newText)));
}
