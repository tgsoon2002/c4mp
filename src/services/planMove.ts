/**
 * b405 MV-3 (Document/Roadmap/PLAN_MOVE.md sections 4, 5; section 10 layer CORRECTION): the service behind
 * `c4pm plan move` and `c4pm plan rename`. It runs the pure engine (c4/planMove.ts), reads the wireframe files of the
 * screens the edit touches and plans their renames (c4/wireframeMove.ts), builds the postcondition (5.3), and lists the
 * mentions of the old fqns outside the plan. It writes nothing: the CLI hands the result to the write gate (runWrite).
 * L3: the command file (src/cli/moveCmd.ts, L4) only parses options, resolves targets and prints, so no new L4 -> L1/L2
 * import is needed. Imports nothing from src/cli/ (that would be an upward import).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { C4pmConfig, Plan, PlanElement, ProjectPaths } from '../types';
import { log } from '../log';
import { localId } from '../names';
import { parsePlanTexts } from '../plan/parser';
import { planMove, planRenameEl } from '../c4/planMove';
import type { MoveResult } from '../c4/planMove';
import { planWireframeMoves } from '../c4/wireframeMove';
import type { WireframeMention } from '../c4/wireframeMove';
import type { FqnMap, WireframeEdit } from '../types';
import { unifiedDiff } from '../c4/textDiff';
import { sourceFiles } from '../scan/sourceFiles';
import { SEARCH_EXTENSIONS, SEARCH_MAX_FILE_BYTES, SEARCH_TEXT_MAX } from '../query/search';

const TAG = 'planMoveService';

/** The loaded plan the service works on (the CLI's PlanState has these fields). */
export interface MoveInput {
  repoRoot: string;
  plan: Plan;
  /** Repo-relative plan file -> text as read from disk. */
  texts: Map<string, string>;
  /** Absolute plan folder (its `io/` holds the wireframes); null when the plan came from the repo-wide fallback. */
  planDir: string | null;
  project: ProjectPaths | null;
  config: Pick<C4pmConfig, 'ignore' | 'languages'>;
}

/** A wireframe file the edit renames and/or rewrites, with the diff of its text (empty when only the name changes). */
export type WireframeChange = WireframeEdit & { diff: string };

export type MoveEditResult =
  | { ok: false; problems: string[] }
  | {
      ok: true;
      /** Every plan file with its new text. */
      newTexts: Map<string, string>;
      /** The plan parsed from newTexts. */
      after: Plan;
      /** Old fqn -> new fqn of every moved element (roots and descendants); empty for a same-parent move. */
      moved: Map<string, string>;
      roots: { from: string; to: string }[];
      wireframes: WireframeChange[];
      /** Reference tokens rewritten per plan file (files with none left out). */
      rewritten: { file: string; count: number }[];
      /** One sentence each: engine notes (comments above, empty extends, layout, shared ids, bare refs) and wireframe refs not edited. */
      notes: string[];
      /** Postcondition (5.3) on the edited plan: in memory and again on the plan re-read from disk. String = failure reason. */
      post: (plan: Plan) => string | null;
    };

const parentOf = (fqn: string): string | null => (fqn.includes('.') ? fqn.slice(0, fqn.lastIndexOf('.')) : null);
const isUnder = (ref: string, root: string): boolean => ref === root || ref.startsWith(root + '.');
const linkKey = (e: PlanElement) => JSON.stringify(e.links.map(l => [l.path, l.name, l.lines?.start ?? null, l.lines?.end ?? null]));
const metaKey = (e: PlanElement) => JSON.stringify(Object.entries(e.metadata).sort(([a], [b]) => a.localeCompare(b)));

/**
 * 5.3: every moved element sits once at its new fqn and never at its old one, with the same kind, title, description,
 * technology, metadata and links, under the mapped parent; element count equal; relation multiset equal after mapping
 * both ends with `mapRef` (the same rule the engine used).
 */
function postconditionOf(before: Plan, m: FqnMap, roots: { from: string; to: string }[], mapRef: (ref: string) => string): (plan: Plan) => string | null {
  const relKey = (from: string, to: string, label: string | null) => JSON.stringify([from, to, label]);
  const relsBefore = before.relations.map(r => relKey(mapRef(r.from), mapRef(r.to), r.label)).sort();
  const targets = new Set(m.map.values());
  return plan => {
    if (plan.elements.length !== before.elements.length) return `the edit changed the number of elements (${before.elements.length} -> ${plan.elements.length})`;
    for (const e of before.elements) {
      const now = m.map.get(e.id);
      if (now === undefined) continue;
      const at = plan.elements.filter(a => a.id === now);
      if (at.length !== 1) return `${now} should exist exactly once after the edit, found ${at.length}`;
      if (!targets.has(e.id) && plan.elements.some(a => a.id === e.id)) return `${e.id} still exists after the edit`;
      const a = at[0];
      const root = roots.find(r => r.from === e.id);
      const parent = root ? parentOf(root.to) : e.parent === null ? null : mapRef(e.parent);
      if (a.kind !== e.kind || a.title !== e.title || a.description !== e.description || a.technology !== e.technology) {
        return `${now} differs from ${e.id} (kind, title, description or technology)`;
      }
      if (metaKey(a) !== metaKey(e) || linkKey(a) !== linkKey(e)) return `${now} differs from ${e.id} (metadata or links)`;
      if (a.parent !== parent) return `${now} is under ${a.parent ?? 'the model'}, wanted ${parent ?? 'the model'}`;
    }
    const relsAfter = plan.relations.map(r => relKey(r.from, r.to, r.label)).sort();
    if (JSON.stringify(relsAfter) !== JSON.stringify(relsBefore)) return 'the relations after the edit differ from the relations before it (ends mapped)';
    return null;
  };
}

/** Lstat-guarded read of `<planDir>/io/<fqn>.html`: null when absent, a problem string when it is not a plain readable file. */
function readWireframe(abs: string, shown: string): { text: string } | { problem: string } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return { problem: `wireframe ${shown} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; move it by hand first` };
  try {
    return { text: fs.readFileSync(abs, 'utf-8') };
  } catch (e) {
    return { problem: `wireframe ${shown} cannot be read: ${(e as Error).message}` };
  }
}

const FQN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const mentionNote = (w: WireframeMention): string =>
  `wireframe ${w.file}:${w.line} ref '${w.ref}' ${w.reason === 'left-screen' ? 'now names a part outside its screen' : 'is written with a character reference'}: not edited`;

/** Engine result -> wireframes, after-plan, postcondition (shared by move and rename). */
function finish(input: MoveInput, r: MoveResult, mapRef: (ref: string) => string): MoveEditResult {
  if (!r.ok) return r;
  const after = parsePlanTexts(input.repoRoot, r.newTexts);
  const roots = r.roots.map(x => ({ from: x.from, to: x.to }));
  const m = r.fqnMap;
  const notes = r.notes.map(n => n.text);

  // Wireframes: every screen (or other element) that is mapped itself or holds a mapped part; only existing files.
  const files = new Map<string, { file: string; text: string }>();
  const problems: string[] = [];
  const ioDir = input.planDir === null ? null : path.join(input.planDir, 'io');
  const rel = (abs: string) => path.relative(input.repoRoot, abs).split(path.sep).join('/');
  if (ioDir !== null && m.map.size > 0) {
    const mapped = [...m.map.keys()];
    for (const e of input.plan.elements) {
      if (!FQN_NAME_RE.test(e.id) || !mapped.some(k => isUnder(k, e.id))) continue;
      const abs = path.join(ioDir, `${e.id}.html`);
      const got = readWireframe(abs, `io/${e.id}.html`);
      if (got === null) continue;
      if ('problem' in got) problems.push(got.problem);
      else files.set(e.id, { file: rel(abs), text: got.text });
    }
  }
  const exists = (file: string): boolean => {
    try {
      fs.lstatSync(path.resolve(input.repoRoot, file));
      return true;
    } catch {
      return false;
    }
  };
  const wf = files.size === 0 ? { ok: true as const, edits: [], mentions: [] } : planWireframeMoves(files, input.plan, after, m, exists);
  if (!wf.ok) problems.push(...wf.problems);
  if (problems.length > 0 || !wf.ok) return { ok: false, problems };
  notes.push(...wf.mentions.map(mentionNote));

  return {
    ok: true, newTexts: r.newTexts, after, moved: m.map, roots, rewritten: r.rewritten, notes,
    wireframes: wf.edits.map(w => ({ ...w, diff: unifiedDiff(w.to, w.oldText, w.newText) })),
    post: postconditionOf(input.plan, m, roots, mapRef),
  };
}

/** `plan move`: the roots (fqns, in command-line order) go to the end of `parent` (fqn). */
export function moveEdit(input: MoveInput, roots: string[], parent: string): MoveEditResult {
  const r = planMove(input.texts, input.plan, { roots, parent });
  log(TAG, 'move', { roots: roots.length, parent, ok: r.ok });
  // a bare relation end keeps its meaning after a move (the local id does not change), so only the prefix rule maps
  return finish(input, r, ref => (r.ok ? r.fqnMap.rewrite(ref) ?? ref : ref));
}

/** `plan rename`: element `fqn` gets the local id `newId`. */
export function renameEdit(input: MoveInput, fqn: string, newId: string): MoveEditResult {
  const r = planRenameEl(input.texts, input.plan, { fqn, newId });
  log(TAG, 'rename', { fqn, newId, ok: r.ok });
  // the engine rewrites a bare end equal to the old id only when exactly one element has that id (planMove.ts step 7)
  const oldId = localId(fqn);
  const el = input.plan.elements.find(e => e.id === fqn);
  const bareOk = !!el && el.parent !== null && input.plan.elements.filter(e => localId(e.id) === oldId).length === 1;
  return finish(input, r, ref => (r.ok ? r.fqnMap.rewrite(ref) ?? (bareOk && ref === oldId ? newId : ref) : ref));
}

// --- mentions --------------------------------------------------------------------------------------------------

/** A line outside the plan's references that still names an old fqn. `item` = the board item id around a board line. */
export interface Mention { file: string; line: number; fqn: string; text: string; item?: string }

export interface MentionsResult {
  mentions: Mention[];
  /** Files over SEARCH_MAX_FILE_BYTES that were not read. */
  skipped: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cut = (line: string) => {
  const t = line.trim();
  return t.length > SEARCH_TEXT_MAX ? t.slice(0, SEARCH_TEXT_MAX) : t;
};

/** Board item id of a board JSON line: the nearest `"id": "..."` line above it that is not indented deeper. */
function boardItemAt(lines: string[], i: number): string | undefined {
  const indent = (s: string) => /^\s*/.exec(s)![0].length;
  const own = indent(lines[i]);
  for (let j = i; j >= 0; j--) {
    const m = /^\s*"id":\s*"([^"]+)"/.exec(lines[j]);
    if (m && indent(lines[j]) <= own) return m[1];
  }
  return undefined;
}

/** Repo-relative file -> text of every wireframe as the edit leaves it: `<planDir>/io/*.html` with the edits applied. */
function wireframeTextsAfter(input: MoveInput, edits: WireframeEdit[]): Map<string, string> {
  const out = new Map<string, string>();
  if (input.planDir === null) return out;
  const ioDir = path.join(input.planDir, 'io');
  const gone = new Set(edits.map(e => e.from));
  const names = fs.existsSync(ioDir) && fs.lstatSync(ioDir).isDirectory() ? fs.readdirSync(ioDir).filter(n => n.endsWith('.html')).sort() : [];
  for (const n of names) {
    const abs = path.join(ioDir, n);
    const file = path.relative(input.repoRoot, abs).split(path.sep).join('/');
    const got = gone.has(file) ? null : readWireframe(abs, `io/${n}`);
    if (got !== null && 'text' in got) out.set(file, got.text);
  }
  for (const e of edits) out.set(e.to, e.newText);
  return out;
}

/**
 * Lines that still name an old root fqn (or a descendant: `<fqn>.x` counts), never edited: the NEW plan texts and
 * wireframe texts (what is left there is in a comment or a string), the board files `<projectDir>/board/*.json`, and
 * the text files under the anchor (scan/sourceFiles.ts with search's extensions: the scan's walk and ignores; plan
 * and wireframe files are read from memory, not from disk). Match: not preceded by `[\w.-]`, not followed by `[\w-]`.
 * Files are repo-relative (may start with `../`), sorted by file then line.
 */
export function findMentions(input: MoveInput, oldRoots: string[], newTexts: Map<string, string>, wireframes: WireframeEdit[]): MentionsResult {
  const roots = [...new Set(oldRoots)].sort((a, b) => b.length - a.length);
  if (roots.length === 0) return { mentions: [], skipped: 0 };
  const wireTexts = wireframeTextsAfter(input, wireframes);
  const re = new RegExp(`(?<![\\w.-])(${roots.map(escapeRe).join('|')})(?![\\w-])`, 'g');
  const mentions: Mention[] = [];
  const rel = (abs: string) => path.relative(input.repoRoot, abs).split(path.sep).join('/');
  const scan = (file: string, text: string, board: boolean) => {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const seen = new Set<string>();
      for (const m of line.matchAll(re)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const item = board ? boardItemAt(lines, i) : undefined;
        mentions.push({ file, line: i + 1, fqn: m[1], text: cut(line), ...(item !== undefined ? { item } : {}) });
      }
    });
  };

  for (const [file, text] of [...newTexts, ...wireTexts]) scan(file, text, false);
  const inMemory = new Set([...newTexts.keys(), ...wireTexts.keys(), ...wireframes.map(w => w.from)].map(f => path.resolve(input.repoRoot, f)));

  let skipped = 0;
  const readSmall = (abs: string): string | null => {
    try {
      if (fs.statSync(abs).size > SEARCH_MAX_FILE_BYTES) { skipped++; return null; }
      const buf = fs.readFileSync(abs);
      return buf.includes(0) ? null : buf.toString('utf8');
    } catch {
      return null;   // vanished or unreadable since the walk: nothing to list
    }
  };
  if (input.project) {
    const dir = path.join(input.project.projectDir, 'board');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort() : [];
    for (const n of names) {
      const abs = path.join(dir, n);
      const text = readSmall(abs);
      if (text !== null) scan(rel(abs), text, true);
    }
  }
  const anchor = input.project?.anchor ?? input.repoRoot;
  // ignore patterns are repo-relative; the walk is anchor-relative
  const repoAt = path.relative(anchor, input.repoRoot).split(path.sep).join('/');
  const ignore = input.config.ignore.map(p => (repoAt === '' ? p : path.posix.join(repoAt, p)));
  const walked = sourceFiles(anchor, { ignore, languages: input.config.languages }, SEARCH_EXTENSIONS);
  for (const f of walked) {
    const abs = path.join(anchor, f);
    if (inMemory.has(abs)) continue;
    const text = readSmall(abs);
    if (text !== null) scan(rel(abs), text, false);
  }
  mentions.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  log(TAG, 'mentions', { roots: roots.length, files: walked.length, mentions: mentions.length, skipped });
  return { mentions, skipped };
}

/** The three entry points as one object, as src/cli/moveCmd.ts takes them (bin/cli.ts hands it in). */
export const planMoveService = { moveEdit, renameEdit, findMentions };
