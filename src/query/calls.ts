import { EDGE_KINDS, MODULE_CALLER, callIndex } from '../callGraph/callResolve';
import type { Snapshot } from '../types';
import type { QueryContext } from './context';
import { QueryError } from './errors';

/**
 * One end of a call edge. `calls`: where the callee is defined. `callers` (b682): the caller's first call site of the
 * target (`line` and the UTF-16 `column` of the called name), and `sites` = every call site of that caller, in order.
 */
export interface CallRef {
  name: string;
  file: string;
  line: number;
  column?: number;
  resolved: true;
  sites?: { line: number; column: number }[];
}

export interface CallsTarget { name: string; file: string; line: number; }

export interface CallsResult {
  target: CallsTarget;
  calls: CallRef[];
  /** Calls in the body that could not be traced to a function of the repo (counted, never guessed). */
  unresolved: number;
  /** Calls to external packages and JS builtins: not edges. */
  external: number;
}

export interface CallersResult {
  target: CallsTarget;
  callers: CallRef[];
  /** Untraceable calls anywhere whose last name segment equals the target's: possible callers. */
  unresolved: number;
}

/**
 * The function a user means: `path#name`, or a bare `name` / `Class.method` found in exactly one file.
 * `path#<module>` is the per-file pseudo caller of calls outside any named function.
 */
function resolveTarget(ctx: QueryContext, input: string): CallsTarget {
  const text = (input ?? '').trim();
  if (text === '') throw new QueryError('invalid', 'function must not be empty');
  const hash = text.indexOf('#');
  const wantFile = hash >= 0 ? text.slice(0, hash) : null;
  const name = hash >= 0 ? text.slice(hash + 1) : text;

  const hits: CallsTarget[] = [];
  for (const f of ctx.snapshot.files) {
    if (wantFile !== null && f.file !== wantFile) continue;
    if (name === MODULE_CALLER) {
      if (wantFile !== null) hits.push({ name, file: f.file, line: 1 });
      continue;
    }
    for (const e of f.elements) if (EDGE_KINDS.includes(e.kind) && e.name === name) hits.push({ name, file: f.file, line: e.startLine });
  }
  if (hits.length === 0 && wantFile === null && name !== MODULE_CALLER) {
    const dotted = `.${name}`;
    for (const f of ctx.snapshot.files) for (const e of f.elements) if (EDGE_KINDS.includes(e.kind) && e.name.endsWith(dotted)) hits.push({ name: e.name, file: f.file, line: e.startLine });
  }
  if (hits.length === 0) {
    throw new QueryError('not-found', `no function or method matches "${input}"; use find to look it up (path#name picks a file)`);
  }
  if (hits.length > 1) {
    throw new QueryError('ambiguous', `"${input}" matches ${hits.length} functions; use path#name`, hits.map((h) => `${h.file}#${h.name}`));
  }
  return hits[0];
}

function byRef(a: CallRef, b: CallRef): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Functions the target calls (traced ones, once each), plus counts of untraced and external calls in its body. */
export function callsOf(ctx: QueryContext, input: string): CallsResult {
  const idx = callIndex(ctx.snapshot);
  const target = resolveTarget(ctx, input);
  const seen = new Map<string, CallRef>();
  let unresolved = 0, external = 0;
  for (const s of idx.sites) {
    if (s.file !== target.file || s.caller !== target.name) continue;
    const v = s.verdict;
    if (v.kind === 'unresolved') unresolved++;
    else if (v.kind === 'external') external++;
    else if (!seen.has(`${v.file}#${v.name}`)) {
      seen.set(`${v.file}#${v.name}`, { name: v.name, file: v.file, line: idx.elements.get(`${v.file}#${v.name}`)!.startLine, resolved: true });
    }
  }
  return { target, calls: [...seen.values()].sort(byRef), unresolved, external };
}

/** Functions that call the target (once each, at their first call site, with every site), plus how many untraced calls elsewhere could be calls to it. */
export function callersOf(ctx: QueryContext, input: string): CallersResult {
  const idx = callIndex(ctx.snapshot);
  const target = resolveTarget(ctx, input);
  const last = target.name.slice(target.name.lastIndexOf('.') + 1);
  const byCaller = new Map<string, { name: string; file: string; sites: { line: number; column: number }[] }>();
  let unresolved = 0;
  for (const s of idx.sites) {
    const v = s.verdict;
    if (v.kind === 'unresolved') {
      if (s.callee !== null && s.callee.slice(s.callee.lastIndexOf('.') + 1) === last) unresolved++;
    } else if (v.kind === 'edge' && v.file === target.file && v.name === target.name) {
      const key = `${s.file}#${s.caller}`;
      const entry = byCaller.get(key) ?? { name: s.caller, file: s.file, sites: [] };
      entry.sites.push(s.at ?? { line: s.line, column: 1 });
      byCaller.set(key, entry);
    }
  }
  const callers = [...byCaller.values()].map(({ name, file, sites }): CallRef => {
    sites.sort((a, b) => a.line - b.line || a.column - b.column);
    return { name, file, line: sites[0].line, column: sites[0].column, resolved: true, sites };
  });
  return { target, callers: callers.sort(byRef), unresolved };
}

/** Totals over the whole scan, for measuring how much of the code the call graph covers. */
export function callStats(snapshot: Snapshot): { sites: number; edge: number; external: number; unresolved: number } {
  const t = { sites: 0, edge: 0, external: 0, unresolved: 0 };
  for (const s of callIndex(snapshot).sites) {
    t.sites++;
    t[s.verdict.kind]++;
  }
  return t;
}
