import * as path from 'path';
import type { FqnMap, Plan, PlanElement } from '../types';
import { log } from '../log';
import { isReservedId, localId } from '../names';
import { splitLines } from '../util/text';
import { IDENT_RE } from './editAdd';
import { linesInsideStrings, locateElement, locateExtendBlocks, locateRefs, type BlockSpans } from './editMeta';
import { parentKindsOf } from '../plan/kinds';
import { parseC4 } from '../plan/parser';
import { blockSpan } from './removeScope';
import { childIndentation, insertChildBlock, textCursor } from './textEdit';

/**
 * b405 (Document/Roadmap/PLAN_MOVE.md section 1.2): the pure engine of `plan move` and `plan rename`.
 * Texts in, texts + old->new fqn map + notes out; no file I/O, no gate (planTx), no CLI.
 * Element blocks move as whole lines; every relation end and `extend` target that names a moved fqn (or one of its
 * descendants) is rewritten in every plan text. Strings and comments are never tokens, so they are never rewritten.
 */

const TAG = 'planMove';

/** Something the user should know; `text` is a whole sentence, `file:line` is where to look in the NEW texts. */
export interface MoveNote {
  kind: 'comment-above' | 'empty-extend' | 'layout-kept' | 'local-id-shared' | 'bare-ref' | 'same-parent';
  file: string;
  line: number;
  text: string;
}

export type MoveResult =
  | { ok: false; problems: string[] }       // ALL problems, not the first (all-or-nothing)
  | {
      ok: true;
      newTexts: Map<string, string>;        // every input file (changed or not)
      fqnMap: FqnMap;
      roots: { from: string; to: string; fromFile: string; toFile: string }[];
      notes: MoveNote[];
      rewritten: { file: string; count: number }[];   // reference tokens rewritten per file (files with none left out)
    };


const orList = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const lineOf = (text: string, off: number): number => (text.slice(0, off).match(/\n/g) ?? []).length + 1;
const lineCount = (text: string): number => (text.match(/\n/g) ?? []).length;
const isUnder = (ref: string, root: string): boolean => ref === root || ref.startsWith(root + '.');
// A link the parser resolves against the .c4 file's folder (links.ts parseLink): not a URL, not an absolute path.
const isRelativeLink = (raw: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:\/\//.test(raw) && !raw.startsWith('/') && (raw.startsWith('./') || raw.startsWith('../') || !raw.includes(':'));
// A whole-line comment (`//`, or a line of a `/* */` block).
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/** Old -> new map of the given roots and all their descendants (prefix rule). Pairs with old === new are ignored. */
export function fqnMapOf(plan: Plan, roots: [old: string, now: string][]): FqnMap {
  // Longest root first, so a ref is mapped by the most specific root (roots of one command are disjoint anyway).
  const pairs = roots.filter(([o, n]) => o !== n).sort((a, b) => b[0].length - a[0].length);
  const rewrite = (ref: string): string | null => {
    for (const [o, n] of pairs) if (isUnder(ref, o)) return n + ref.slice(o.length);
    return null;
  };
  const map = new Map<string, string>();
  for (const e of plan.elements) {
    const now = rewrite(e.id);
    if (now !== null) map.set(e.id, now);
  }
  return { map, rewrite };
}

function rewriteRefsCounted(
  texts: Map<string, string>,
  m: FqnMap,
  bare?: { oldId: string; newId: string },
): { texts: Map<string, string>; rewritten: { file: string; count: number }[] } {
  const out = new Map<string, string>();
  const rewritten: { file: string; count: number }[] = [];
  for (const [file, text] of texts) {
    const refs = locateRefs(text);
    // Callers refuse unterminated texts first (section 5.1); reaching this is a caller bug, not a user error.
    if (refs === null) throw new Error(`cannot edit ${file}: unterminated string`);
    let t = text;
    let count = 0;
    for (const r of [...refs].reverse()) {   // from the end of the file, so earlier offsets stay valid
      const now = m.rewrite(r.value) ?? (bare && r.role !== 'extend' && r.value === bare.oldId ? bare.newId : null);
      if (now === null || now === r.value) continue;
      t = t.slice(0, r.start) + now + t.slice(r.end);
      count++;
    }
    out.set(file, t);
    if (count > 0) rewritten.push({ file, count });
  }
  return { texts: out, rewritten };
}

/**
 * Rewrite every `extend` target and relation end that names a mapped fqn (or a descendant of one), in all texts.
 * `bare` (rename only): a relation end written as the bare old id is rewritten to the new id; the caller passes it
 * only when that id is unique in the old plan. Throws for a text with an unterminated string (callers refuse it first).
 */
export function rewriteRefs(texts: Map<string, string>, m: FqnMap, bare?: { oldId: string; newId: string }): Map<string, string> {
  return rewriteRefsCounted(texts, m, bare).texts;
}

function byIdOf(plan: Plan): Map<string, PlanElement[]> {
  const byId = new Map<string, PlanElement[]>();
  for (const e of plan.elements) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  return byId;
}

/** The single element with this fqn, or null with a problem pushed (unknown / declared twice). */
function single(byId: Map<string, PlanElement[]>, fqn: string, what: string, problems: string[]): PlanElement | null {
  const els = byId.get(fqn) ?? [];
  if (els.length === 0) problems.push(`unknown ${what} ${fqn}`);
  if (els.length > 1) problems.push(`${fqn} is declared twice; fix duplicate-fqn first`);
  return els.length === 1 ? els[0] : null;
}

function unterminatedFiles(texts: Map<string, string>): string[] {
  return [...texts].filter(([, t]) => locateRefs(t) === null).map(([f]) => f);
}

/** The nearest container at or above fqn (else the top ancestor): the scope in which `plan show <id>` must be unique. */
function scopeOf(byId: Map<string, PlanElement[]>, fqn: string): string {
  let cur = fqn;
  for (;;) {
    const el = byId.get(cur)?.[0];
    if (!el || el.kind === 'container' || el.parent === null) return cur;
    cur = el.parent;
  }
}

/** Notes for other elements under the same container that already use this local id (S16). */
function sharedIdNotes(plan: Plan, byId: Map<string, PlanElement[]>, m: FqnMap, newFqn: string, scopeFrom: string): MoveNote[] {
  const scope = scopeOf(byId, scopeFrom);
  const id = localId(newFqn);
  return plan.elements
    .filter(e => !m.map.has(e.id) && e.id !== newFqn && e.id.startsWith(scope + '.') && localId(e.id) === id)
    .map(e => ({
      kind: 'local-id-shared' as const, file: e.source.file, line: e.source.line,
      text: `${newFqn} shares its id '${id}' with ${e.id}: \`plan show ${id}\` becomes ambiguous`,
    }));
}

/** Problems for mapped fqns that already exist and are not moved away themselves. */
function takenProblems(byId: Map<string, PlanElement[]>, m: FqnMap): string[] {
  const out: string[] = [];
  for (const now of new Set(m.map.values())) {
    const hit = byId.get(now)?.[0];
    if (hit && !m.map.has(now)) out.push(`${now} already exists (${hit.kind} '${hit.title}')`);
  }
  return out;
}

/** Lines startLine..endLine of text, re-indented from the block's own indent to `kid`, line ends `eol`. */
function reindent(text: string, startLine: number, endLine: number, kid: string, eol: string): string {
  const inString = linesInsideStrings(text);
  if (inString === null) throw new Error('unterminated string');   // planMove refuses such texts first
  const lines = splitLines(text);
  const content = (ln: number) => (lines[ln - 1] ?? '').replace(/\r?\n$/, '');
  const old = /^[ \t]*/.exec(content(startLine))![0];
  let out = '';
  for (let ln = startLine; ln <= endLine; ln++) {
    const c = content(ln);
    const keep = inString.has(ln) || c.trim() === '' || !c.startsWith(old);
    // the break before a line that starts inside a string belongs to the string: keep it byte-equal
    const end = inString.has(ln + 1) ? (lines[ln - 1] ?? '').slice(c.length) : eol;
    out += (keep ? c : kid + c.slice(old.length)) + end;
  }
  return out;
}

interface MoveRoot {
  el: PlanElement;
  to: string;
  same: boolean;                                        // already under the parent: moved to the end, fqn unchanged
  span: { file: string; startLine: number; endLine: number };
}
interface Landing { file: string; extendIndex: number | null; kid: string }   // extendIndex null = the declaration

/**
 * Pure engine of `plan move`: validate every root (all problems listed), cut each root's block (whole lines), insert
 * the blocks at the END of the new parent (rule L: a block of the parent in the root's own file, the last one, else
 * the parent's declaration), several roots in argument order, then rewrite every reference. Comment lines directly
 * above a block stay where they are (note). `texts` key = repo-relative plan file (PlanElement.source.file).
 */
export function planMove(texts: Map<string, string>, plan: Plan, req: { roots: string[]; parent: string }): MoveResult {
  const problems: string[] = [];
  const byId = byIdOf(plan);
  const broken = unterminatedFiles(texts);
  problems.push(...broken.map(f => `cannot edit ${f}: unterminated string`));
  const parentEl = single(byId, req.parent, 'parent', problems);

  const roots: MoveRoot[] = [];
  req.roots.forEach((r, i) => {
    if (req.roots.indexOf(r) !== i) { problems.push(`${r} is named twice`); return; }
    const el = single(byId, r, 'element', problems);
    if (!el) return;
    const outer = req.roots.find(b => b !== r && isUnder(r, b));
    if (outer) problems.push(`${r} is inside ${outer}, which also moves`);
    if (isUnder(req.parent, r)) problems.push(`cannot move ${r} into itself or its descendant ${req.parent}`);
    if (parentEl) {
      const parents = parentKindsOf(el.kind);
      if (parents === null) problems.push(`a ${el.kind} has no parent rule, so ${r} cannot be moved`);
      else if (parents.length === 0) problems.push(`a ${el.kind} is a top-level element and has no parent; use plan rename to change its id`);
      else if (!parents.includes(parentEl.kind)) problems.push(`a ${el.kind} goes under a ${orList(parents)}, but '${req.parent}' is a ${parentEl.kind}`);
    }
    const span = blockSpan(texts, plan, r);
    if (!span.ok) { problems.push(`${r}: ${span.reason}`); return; }
    const same = el.parent === req.parent;
    roots.push({ el, to: same ? r : `${req.parent}.${localId(r)}`, same, span });
  });

  const target = new Map<string, string>();
  for (const r of roots.filter(x => !x.same)) {
    const first = target.get(r.to);
    if (first !== undefined) problems.push(`${first} and ${r.el.id} would both become ${r.to}`);
    else target.set(r.to, r.el.id);
  }
  const fqnMap = fqnMapOf(plan, roots.map(r => [r.el.id, r.to]));
  problems.push(...takenProblems(byId, fqnMap));

  // Rule L, located in the ORIGINAL texts (the child indent `kid` too, so a block that was the parent's only child
  // keeps its indent when it goes back to the end).
  const inMoved = (file: string, line: number) =>
    roots.some(r => r.span.file === file && line >= r.span.startLine && line <= r.span.endLine);
  const indentOf = (text: string, s: BlockSpans) => childIndentation(textCursor(text), s.idStart,
    s.firstBodyStart !== null && s.firstBodyLine !== null ? { start: s.firstBodyStart, line: s.firstBodyLine } : null, s.openLine).kid;
  const landings = new Map<MoveRoot, Landing>();
  if (parentEl && broken.length === 0) {
    for (const r of roots) {
      const own = texts.get(r.span.file)!;
      const cands: { s: BlockSpans; extendIndex: number | null }[] = [];
      const decl = locateElement(own, req.parent);
      if (decl && !inMoved(r.span.file, decl.idLine)) cands.push({ s: decl, extendIndex: null });
      locateExtendBlocks(own, req.parent).filter(b => !inMoved(r.span.file, lineOf(own, b.idStart)))
        .forEach((s, extendIndex) => cands.push({ s, extendIndex }));
      const last = cands.sort((a, b) => b.s.idStart - a.s.idStart)[0];
      if (last) { landings.set(r, { file: r.span.file, extendIndex: last.extendIndex, kid: indentOf(own, last.s) }); continue; }
      const file = parentEl.source.file;
      const text = texts.get(file);
      const s = text === undefined ? null : locateElement(text, req.parent);
      if (!s || text === undefined) { problems.push(`cannot locate ${req.parent} in ${file}`); continue; }
      landings.set(r, { file, extendIndex: null, kid: indentOf(text, s) });
    }
  }

  // Q3: links travel verbatim, so a block with relative links must stay in its folder.
  for (const [r, l] of landings) {
    const dir = path.posix.dirname(r.span.file);
    if (dir === path.posix.dirname(l.file)) continue;
    const n = [r.el, ...plan.elements.filter(e => isUnder(e.id, r.el.id) && e !== r.el && inMoved(e.source.file, e.source.line))]
      .filter(e => e.source.file === r.span.file)
      .reduce((sum, e) => sum + e.links.filter(k => isRelativeLink(k.raw)).length, 0);
    if (n > 0) problems.push(`${n} links of ${r.el.id} are relative to ${dir}; move within the same folder`);
  }

  if (problems.length > 0) {
    log(TAG, 'move refused', { roots: req.roots, parent: req.parent, problems: problems.length });
    return { ok: false, problems };
  }

  // Cut: delete every root's lines (whole lines only, as planRemoval).
  const del = new Map<string, Set<number>>();   // file -> 0-based line indexes
  for (const r of roots) {
    const set = del.get(r.span.file) ?? new Set<number>();
    for (let ln = r.span.startLine; ln <= r.span.endLine; ln++) set.add(ln - 1);
    del.set(r.span.file, set);
  }
  const work = new Map(texts);
  for (const [file, set] of del) work.set(file, splitLines(texts.get(file)!).filter((_, i) => !set.has(i)).join(''));

  // Insert: one block of all roots that share a landing block (argument order), files edited from the end.
  const groups = new Map<string, { landing: Landing; roots: MoveRoot[] }>();
  for (const r of roots) {
    const l = landings.get(r)!;
    const key = `${l.file}\n${l.extendIndex ?? 'decl'}`;
    const g = groups.get(key) ?? { landing: l, roots: [] };
    g.roots.push(r);
    groups.set(key, g);
  }
  const inserted = new Map<string, { line: number; added: number }[]>();   // file -> insertions, in cut-text lines
  for (const file of new Set([...groups.values()].map(g => g.landing.file))) {
    let text = work.get(file)!;
    const located = [...groups.values()].filter(g => g.landing.file === file).map(g => ({
      g, s: g.landing.extendIndex === null ? locateElement(text, req.parent) : locateExtendBlocks(text, req.parent)[g.landing.extendIndex] ?? null,
    }));
    located.sort((a, b) => (b.s ? b.s.close ?? b.s.headerEnd : 0) - (a.s ? a.s.close ?? a.s.headerEnd : 0));
    for (const { g, s } of located) {
      const done = s ? insertChildBlock(text, s, ({ eol }) =>
        g.roots.map(r => reindent(texts.get(r.span.file)!, r.span.startLine, r.span.endLine, g.landing.kid, eol)).join('')) : null;
      if (!s || !done || !done.changed) return { ok: false, problems: [`could not insert under ${req.parent} in ${file} (text not editable)`] };
      const at = s.close !== null ? s.closeLine! : lineOf(text, s.headerEnd);
      inserted.set(file, [...(inserted.get(file) ?? []), { line: at, added: lineCount(done.text) - lineCount(text) }]);
      text = done.text;
    }
    work.set(file, text);
  }

  const { texts: newTexts, rewritten } = rewriteRefsCounted(work, fqnMap);
  const notes = moveNotes(texts, newTexts, plan, byId, fqnMap, roots, landings, req.parent, del, inserted);
  log(TAG, 'move planned', { roots: roots.length, parent: req.parent, mapped: fqnMap.map.size, rewritten: rewritten.length, notes: notes.length });
  return {
    ok: true, newTexts, fqnMap, notes, rewritten,
    roots: roots.map(r => ({ from: r.el.id, to: r.to, fromFile: r.span.file, toFile: landings.get(r)!.file })),
  };
}

function moveNotes(
  texts: Map<string, string>, newTexts: Map<string, string>, plan: Plan, byId: Map<string, PlanElement[]>, m: FqnMap,
  roots: MoveRoot[], landings: Map<MoveRoot, Landing>, parent: string,
  del: Map<string, Set<number>>, inserted: Map<string, { line: number; added: number }[]>,
): MoveNote[] {
  const notes: MoveNote[] = [];
  const after = new Map<string, PlanElement>();
  for (const [file, text] of newTexts) for (const e of parseC4(text, file).elements) if (!after.has(e.id)) after.set(e.id, e);
  // An unmoved original line -> its line in the new text (cut lines above it, inserted lines above it).
  const mapLine = (file: string, line: number): number => {
    const cut = [...(del.get(file) ?? [])].filter(i => i < line - 1).length;
    const l = line - cut;
    return l + (inserted.get(file) ?? []).filter(x => x.line < l).reduce((s, x) => s + x.added, 0);
  };
  const unchanged = [...texts].every(([f, t]) => newTexts.get(f) === t);

  for (const r of roots) {
    const at = after.get(r.to);
    const file = at?.source.file ?? landings.get(r)!.file;
    const line = at?.source.line ?? 0;
    if (r.same) {
      notes.push({
        kind: 'same-parent', file, line,
        text: unchanged ? `${r.el.id} is already the last child of ${parent}: no change` : `${r.el.id} already under ${parent}: moved to the end`,
      });
    }
    const lines = splitLines(texts.get(r.span.file)!);
    let top = r.span.startLine;
    while (top > 1 && isCommentLine(lines[top - 2]) && !roots.some(o => o.span.file === r.span.file && top - 1 >= o.span.startLine && top - 1 <= o.span.endLine)) top--;
    if (top < r.span.startLine) {
      const stays = mapLine(r.span.file, top);
      notes.push({ kind: 'comment-above', file: r.span.file, line: stays, text: `comment above ${r.el.id} stays at ${r.span.file}:${stays}` });
    }
    if (!r.same) notes.push(...sharedIdNotes(plan, byId, m, r.to, parent));
  }

  for (const [old, now] of m.map) {
    const was = byId.get(old)?.[0];
    const at = after.get(now);
    if (!was || was.metadata.layout === undefined || !at) continue;
    notes.push({ kind: 'layout-kept', file: at.source.file, line: at.source.line, text: `${now} keeps its saved layout, which was relative to its old parent` });
  }

  const seen = new Set<string>();
  for (const r of roots) {
    const p = r.el.parent;
    if (r.same || p === null || seen.has(`${r.span.file}\n${p}`)) continue;
    seen.add(`${r.span.file}\n${p}`);
    const empty = (t: string) => locateExtendBlocks(t, p).filter(b => b.firstBodyStart === null);
    const before = empty(texts.get(r.span.file)!).length;
    const now = newTexts.get(r.span.file)!;
    const left = empty(now);
    if (left.length <= before) continue;
    for (const b of left) {
      const line = lineOf(now, b.idStart);
      notes.push({ kind: 'empty-extend', file: r.span.file, line, text: `extend ${p} at ${r.span.file}:${line} has no element left (kept)` });
    }
  }
  return notes;
}

/**
 * Pure engine of `plan rename`: the id token of the element is replaced, then every reference to it or a descendant
 * is rewritten (as planMove step 6). A relation end written as the bare old id is rewritten only when exactly one
 * element of the old plan has that id; otherwise it is listed (note bare-ref). Same id: ok, nothing changes.
 */
export function planRenameEl(texts: Map<string, string>, plan: Plan, req: { fqn: string; newId: string }): MoveResult {
  const problems: string[] = [];
  const byId = byIdOf(plan);
  const broken = unterminatedFiles(texts);
  problems.push(...broken.map(f => `cannot edit ${f}: unterminated string`));
  if (!IDENT_RE.test(req.newId)) problems.push(`invalid id '${req.newId}': letters, digits, _ and -, starting with a letter or _`);
  const el = single(byId, req.fqn, 'element', problems);
  if (!el) return { ok: false, problems };

  const file = el.source.file;
  const text = texts.get(file);
  const spans = text === undefined ? null : locateElement(text, req.fqn);
  const oldId = localId(req.fqn);
  if (text === undefined || !spans) {
    if (!broken.includes(file)) problems.push(`cannot locate ${req.fqn} in ${file}`);
    return { ok: false, problems };
  }
  const token = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(text.slice(spans.idStart))?.[0] ?? '';
  if (token !== oldId) problems.push(`${req.fqn}: its id is written as '${token}' (with a dot); rename it by hand`);
  const inExtend = el.parent !== null && locateExtendBlocks(text, el.parent)
    .some(b => b.open! < spans.idStart && (b.close === null || spans.idStart < b.close));
  const atTop = el.parent === null || inExtend;
  if (isReservedId(req.newId, atTop)) {
    problems.push(`'${req.newId}' is a keyword in ${atTop ? 'a model or extend block' : 'an element body'}; pick another id`);
  }
  const newFqn = el.parent === null ? req.newId : `${el.parent}.${req.newId}`;
  const fqnMap = fqnMapOf(plan, [[req.fqn, newFqn]]);
  problems.push(...takenProblems(byId, fqnMap));
  if (problems.length > 0) {
    log(TAG, 'rename refused', { fqn: req.fqn, newId: req.newId, problems: problems.length });
    return { ok: false, problems };
  }
  const roots = [{ from: req.fqn, to: newFqn, fromFile: file, toFile: file }];
  if (newFqn === req.fqn) return { ok: true, newTexts: new Map(texts), fqnMap, roots, notes: [], rewritten: [] };

  const renamed = new Map(texts).set(file, text.slice(0, spans.idStart) + req.newId + text.slice(spans.idStart + oldId.length));
  const notes: MoveNote[] = [];
  const holders = plan.elements.filter(e => localId(e.id) === oldId).length;
  // A top-level fqn has no dot: its references are full fqns, the map rewrites them.
  const bareOk = el.parent !== null && holders === 1;
  const { texts: newTexts, rewritten } = rewriteRefsCounted(renamed, fqnMap, bareOk ? { oldId, newId: req.newId } : undefined);
  if (el.parent !== null && !bareOk) {
    for (const [f, t] of newTexts) {
      for (const r of locateRefs(t)!) {
        if (r.role === 'extend' || r.value !== oldId) continue;
        notes.push({ kind: 'bare-ref', file: f, line: r.line, text: `bare reference '${oldId}' at ${f}:${r.line} not rewritten: ${holders} elements have the id '${oldId}'` });
      }
    }
  }
  if (el.parent !== null) notes.push(...sharedIdNotes(plan, byId, fqnMap, newFqn, el.parent));
  log(TAG, 'rename planned', { fqn: req.fqn, to: newFqn, mapped: fqnMap.map.size, rewritten: rewritten.length, notes: notes.length });
  return { ok: true, newTexts, fqnMap, roots, notes, rewritten };
}
