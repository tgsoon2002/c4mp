/**
 * b405 MV-2 (Document/Roadmap/PLAN_MOVE.md 1.3): the wireframe side of `plan move` and `plan rename`. Pure: the caller
 * reads `<plan folder>/io/<screen fqn>.html` and writes the edits (commitPlanEdit). Refs are relative to their screen
 * (wireframeRefs.ts), so a moved or renamed screen (or container) only changes the file NAME. A ref is rewritten only
 * when its part moves inside its screen; a part that leaves its screen, or a ref written with an entity, is listed, never edited.
 */
import * as path from 'path';
import type { FqnMap, Plan, WireframeEdit } from '../types';
import { scanWireRefSpans } from './wireframeHtml';
import { refFor, resolveWireRef } from './wireframeRefs';

/** A ref the move does not edit: its part left the screen, or the ref is written with a character reference. `file` = the name after the move. */
export interface WireframeMention { file: string; line: number; ref: string; reason: 'left-screen' | 'encoded' }

export type WireframeMoves =
  | { ok: true; edits: WireframeEdit[]; mentions: WireframeMention[] }
  | { ok: false; problems: string[] };

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

/**
 * Edits that make the wireframes follow a move. `files`: key = screen fqn in `before`, value = its repo-relative file and text.
 * `before` / `after` = the plan around the move; `exists(file)` = something is at that repo-relative path. A screen whose
 * new file name is taken is refused (all collisions listed, nothing else returned).
 */
export function planWireframeMoves(
  files: Map<string, { file: string; text: string }>,
  before: Plan, after: Plan, m: FqnMap, exists: (file: string) => boolean,
): WireframeMoves {
  const edits: WireframeEdit[] = [];
  const mentions: WireframeMention[] = [];
  const problems: string[] = [];
  for (const [screen, { file, text }] of files) {
    const nowScreen = m.map.get(screen) ?? screen;
    const to = nowScreen === screen ? file : path.posix.join(path.posix.dirname(file), `${nowScreen}.html`);
    if (to !== file && exists(to)) { problems.push(`wireframe collision: io/${nowScreen}.html exists`); continue; }

    const splices: { start: number; end: number; ref: string }[] = [];
    for (const span of scanWireRefSpans(text)) {
      const part = resolveWireRef(before, screen, span.ref).fqn;
      const nowPart = part === null ? undefined : m.map.get(part);
      if (nowPart === undefined) continue;
      const line = lineAt(text, span.start);
      if (!nowPart.startsWith(nowScreen + '.')) { mentions.push({ file: to, line, ref: span.ref, reason: 'left-screen' }); continue; }
      // a dotted ref keeps the full path from the screen; a bare id stays the shortest ref (refFor)
      const ref = span.ref.includes('.') ? nowPart.slice(nowScreen.length + 1) : refFor(after, nowScreen, nowPart);
      if (ref === null || ref === span.ref) continue;
      if (span.raw !== span.ref) { mentions.push({ file: to, line, ref: span.ref, reason: 'encoded' }); continue; }
      splices.push({ start: span.start, end: span.end, ref });
    }
    let newText = text;
    for (const s of splices.reverse()) newText = newText.slice(0, s.start) + s.ref + newText.slice(s.end);
    if (to !== file || newText !== text) edits.push({ from: file, to, oldText: text, newText });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, edits, mentions };
}
