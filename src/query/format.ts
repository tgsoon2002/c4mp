/**
 * P15-T5a: pure output formatting for the query layer (Decision 4).
 * Text: compact, readable, columns separated by two spaces. JSON: exactly one object, the result itself.
 * No I/O, no process access, no console output: callers print the returned strings.
 */
import type { PlanFinding } from '../types';
import type { QueryError } from './errors';
import type { CallRef, CallersResult, CallsResult } from './calls';
import type { DepsResult, DepsEdge, DepsImportLine, DepsCompareRow } from './deps';
import type { FileOutlineResult, FindResult, OutlineElement, Row } from './find';
import type { OwnerExplanation, OwnerRef } from './owner';
import type { SearchResult } from './search';
import type { ShowResult } from './show';
import type { ShownTestRef, ShownTestsReport } from './itemTests';
import type { PathEnd, PlanPathResult } from './planPath';
import { CMD_NAME } from '../constants';

const SEP = '  ';

/** `[Owner title]` column. */
function ownerCol(owner: OwnerRef): string {
  return `[${owner.title}]`;
}

/** `10-23` (or `10` for a one-line element). */
function span(start: number, end: number): string {
  return end > start ? `${start}-${end}` : `${start}`;
}

/** Short text for why an owner was chosen (the `(how)` part of the show header). */
export function formatHow(how: OwnerExplanation): string {
  if (how.mode === 'folder-mode') return 'folder-mode';
  if (how.claim) return `claim ${how.claim.kind} ${how.claim.path}`;
  return how.auto ? `claim auto ${how.auto}` : 'claim';
}

function rowText(r: Row): string {
  if (r.kind === 'file' || r.startLine === undefined || r.endLine === undefined) {
    return [`${r.path}`, 'file', ownerCol(r.owner)].join(SEP);
  }
  const cols = [`${r.path}:${span(r.startLine, r.endLine)}`, r.kind, r.name, ownerCol(r.owner)];
  if (r.stub) cols.push(r.stub);
  return cols.join(SEP);
}

/** `find` result as text: one row per hit; a hint line when truncated; `no results` when empty. */
export function formatFind(r: FindResult): string {
  if (r.results.length === 0) return 'no results';
  const lines = r.results.map(rowText);
  if (r.truncated) lines.push(`... truncated, showing ${r.results.length} of ${r.total}; raise --limit (max 100) or narrow the query`);
  return lines.join('\n');
}

/** `search` result as text: hits grouped by file (`line: text  (function)  [owner]`, context lines as `line- text`), then the counts. */
export function formatSearch(r: SearchResult): string {
  const out: string[] = [];
  let current = '';
  for (const h of r.results) {
    if (h.file !== current) {
      current = h.file;
      out.push(h.file);
    }
    const before = h.before ?? [];
    before.forEach((t, i) => out.push(`${SEP}${h.line - before.length + i}- ${t}`));
    const cols = [`${h.line}: ${h.text}`];
    if (h.function) cols.push(`(${h.function})`);
    if (h.owner) cols.push(`[${h.owner}]`);
    out.push(SEP + cols.join(SEP));
    (h.after ?? []).forEach((t, i) => out.push(`${SEP}${h.line + 1 + i}- ${t}`));
  }
  if (out.length === 0) out.push('no results');
  if (r.truncated) out.push(`... truncated, showing ${r.results.length} of ${r.total}; raise --max or narrow the query`);
  const skipped = r.filesSkipped.binary + r.filesSkipped.tooBig;
  out.push(`${r.total} hits in ${r.filesSearched} files searched, ${skipped} skipped (${r.filesSkipped.binary} binary, ${r.filesSkipped.tooBig} too big)`);
  return out.join('\n');
}

function outlineLines(els: OutlineElement[], depth: number, out: string[]): void {
  const pad = SEP.repeat(depth + 1);
  for (const e of els) {
    const cols = [span(e.startLine, e.endLine), e.kind, e.name, ownerCol(e.owner)];
    if (e.stub) cols.push(e.stub);
    out.push(pad + cols.join(SEP));
    if (e.children) outlineLines(e.children, depth + 1, out);
  }
}

/** `outline` result as text: header `path  N lines` (+ flags), then the element tree, children indented. */
export function formatOutline(r: FileOutlineResult): string {
  const head = [r.path, `${r.lineCount} lines`];
  if (r.parseError) head.push('parse error');
  if (r.fileOnly) head.push('file only');
  const out = [head.join(SEP)];
  if (r.elements.length === 0) out.push(`${SEP}no elements`);
  else outlineLines(r.elements, 0, out);
  return out.join('\n');
}

/**
 * `show` result as text: header `path:start-end  kind  name  [owner]  (how)  stub`, then each code line
 * prefixed with its line number right-aligned to the widest number. Truncated adds a last hint line.
 */
export function formatShow(r: ShowResult): string {
  const kind = r.targetKind === 'element' ? (r.elementKind ?? 'element') : r.targetKind;
  const head = [r.endLine >= r.startLine ? `${r.path}:${span(r.startLine, r.endLine)}` : r.path, kind];
  if (r.name) head.push(r.name);
  head.push(ownerCol(r.owner));
  if (r.how) head.push(`(${formatHow(r.how)})`);
  if (r.stub) head.push(r.stub);
  const out = [head.join(SEP)];
  const width = String(r.startLine + Math.max(r.code.length - 1, 0)).length;
  r.code.forEach((line, i) => {
    out.push(`${SEP}${String(r.startLine + i).padStart(width)}${SEP}${line}`);
  });
  if (r.truncated) out.push(`... truncated, ${r.totalLines} lines in total`);
  if (r.tests) out.push(...formatTestsBlock(r.tests, { more: '--json lists every test' }));
  return out.join('\n');
}

function edgeLines(title: string, edges: (DepsEdge & { imports?: DepsImportLine[] })[]): string[] {
  if (edges.length === 0) return [`${title}: none`];
  const out = [`${title}:`];
  for (const e of edges) {
    out.push(`${SEP}${e.id}${SEP}${e.title}${SEP}x${e.weight}`);
    // b467 (--files): the import lines behind the arrow, indented under it
    for (const i of e.imports ?? []) {
      out.push(`${SEP}${SEP}${i.file}:${i.line}${SEP}-> ${i.target}${i.names.length ? ` { ${i.names.join(', ')} }` : ''}`);
    }
  }
  return out;
}
/** b468: `deps --compare` rows of one direction: + new, - gone, ~ changed; the unchanged ones only counted. */
function compareLines(title: string, rows: DepsCompareRow[]): string[] {
  const shown = rows.filter((r) => r.status !== 'same');
  const same = rows.length - shown.length;
  const tail = same > 0 ? `${same} unchanged` : '';
  if (shown.length === 0) return [`${title} (was -> now): ${rows.length === 0 ? 'none' : `no change (${tail})`}`];
  const mark = { new: '+', gone: '-', changed: '~', same: '=' } as const;
  return [
    `${title} (was -> now):`,
    ...shown.map((r) => `${SEP}${mark[r.status]} ${r.id}${SEP}${r.title}${SEP}${r.before} -> ${r.after}${r.status === 'changed' ? '' : `${SEP}${r.status}`}`),
    ...(tail ? [`${SEP}${tail}`] : []),
  ];
}

/** `deps` result as text: header, uses / used by (--files: with the import lines), declared plan relations, unresolved relations, then (--compare) was -> now. */
export function formatDeps(r: DepsResult): string {
  const out = [[r.id, r.level, r.title, `(resolved from ${r.resolvedFrom})`].join(SEP)];
  out.push(...edgeLines('uses', r.usesFiles ?? r.uses), ...edgeLines('used by', r.usedByFiles ?? r.usedBy));
  if (r.declared.length > 0) {
    out.push('declared:');
    for (const d of r.declared) {
      out.push(`${SEP}${d.from} -> ${d.to}${d.label ? `${SEP}"${d.label}"` : ''}${SEP}${d.source.file}:${d.source.line}`);
    }
  }
  if (r.unresolvedDeclared.length > 0) {
    out.push('unresolved:');
    for (const u of r.unresolvedDeclared) out.push(`${SEP}${u.from} -> ${u.to}${SEP}${u.reason}`);
  }
  if (r.compare) {
    const c = r.compare;
    const at = [c.entry.id, c.entry.commit ? c.entry.commit.slice(0, 7) : 'no git', (c.entry.commitDate ?? '').slice(0, 10)].filter(Boolean).join(', ');
    out.push(`compare: ${c.ref} (${at}) -> now`, ...compareLines('uses', c.uses), ...compareLines('used by', c.usedBy));
  }
  return out.join('\n');
}

function refLines(title: string, refs: CallRef[]): string[] {
  if (refs.length === 0) return [`${title}: none`];
  // b682 (callers): `file:line:column` of the first call site, then `(also line:column, ...)` for the other sites
  const at = (r: CallRef): string => `${r.file}:${r.line}${r.column !== undefined ? `:${r.column}` : ''}`;
  const also = (r: CallRef): string =>
    r.sites && r.sites.length > 1 ? `${SEP}(also ${r.sites.slice(1).map((s) => `${s.line}:${s.column}`).join(', ')})` : '';
  return [`${title}:`, ...refs.map((r) => `${SEP}${at(r)}${SEP}${r.name}${also(r)}`)];
}

/** `calls` result as text: target header, the traced callees, then the untraced / external counts. */
export function formatCalls(r: CallsResult): string {
  const out = [`${r.target.file}:${r.target.line}${SEP}${r.target.name}`, ...refLines('calls', r.calls)];
  out.push(`unresolved: ${r.unresolved}${SEP}external: ${r.external}`);
  return out.join('\n');
}

/** `callers` result as text: target header, the traced callers, then the count of possible untraced callers. */
export function formatCallers(r: CallersResult): string {
  const out = [`${r.target.file}:${r.target.line}${SEP}${r.target.name}`, ...refLines('callers', r.callers)];
  out.push(`unresolved: ${r.unresolved}`);
  return out.join('\n');
}

/** b469: `plan path` result as text: the two ends with their layers, the layers between, the route, the suggested commands. */
export function formatPlanPath(r: PlanPathResult): string {
  const short = (id: string): string => (r.container && id.startsWith(r.container + '.') ? id.slice(r.container.length + 1) : id);
  const end = (e: PathEnd): string =>
    `${e.function ? `${e.function.file}#${e.function.name} in ` : ''}${e.id}` +
    (e.layerTitle !== null && e.rank !== null ? ` (${e.layerTitle}, ${e.rank + 1}/${r.layers})` : '');
  const head = `${end(r.from)} -> ${end(r.to)}: ${r.direction}` +
    (r.direction === 'down' ? `, ${r.between.length} layer${r.between.length === 1 ? '' : 's'} between` : '');
  const out = [head];
  if (r.note) out.push(r.note);
  if (r.between.length > 0) {
    out.push('between:');
    const width = Math.max(...r.between.map((b) => b.layerTitle.length));
    for (const b of r.between) {
      const what = b.missing
        ? `no component calls it${b.candidates.length > 0 ? `: put a planned-fn in ${b.candidates.map(short).join(' or ')}` : ''}`
        : b.callers.map((c) => `${short(c.component)} already calls it (x${c.weight})`).join(', ');
      out.push(`${SEP}${b.layerTitle.padEnd(width)}${SEP}${what}`);
    }
  }
  if (r.route.length > 0) out.push(`route: ${r.route.map(short).join(' -> ')}`);
  if (r.suggestions.length > 0) {
    out.push('suggest:');
    for (const s of r.suggestions) out.push(`${SEP}${s.command}`, `${SEP}${SEP}${s.note}`);
  }
  return out.join('\n');
}

/** Error text for stderr: `error: <code>: <message>` then one candidate per line. Code and message verbatim. */
export function formatError(e: Pick<QueryError, 'code' | 'message' | 'candidates'>): string {
  const lines = [`error: ${e.code}: ${e.message}`];
  if (e.candidates) for (const c of e.candidates) lines.push(`${SEP}${c}`);
  return lines.join('\n');
}

/** The `--json` object of any query result: the result itself (one plain object, nothing added or dropped). */
export function jsonOf<T extends object>(result: T): T {
  return result;
}

/** `--json` stdout text: exactly one single-line JSON object. */
export function formatJson(result: object): string {
  return JSON.stringify(result);
}

/** JSON form of a QueryError (for callers that report errors as JSON, e.g. MCP): code, message, candidates kept. */
export function errorJson(e: Pick<QueryError, 'code' | 'message' | 'candidates'>): {
  error: { code: string; message: string; candidates?: string[] };
} {
  return { error: { code: e.code, message: e.message, ...(e.candidates ? { candidates: [...e.candidates] } : {}) } };
}

/** Default number of tests each list of the text output shows. */
export const TESTS_TEXT_LIMIT = 10;

const runText = (t: ShownTestRef): string =>
  t.run ? (t.run.cwd === '.' ? t.run.command : `cd ${t.run.cwd} && ${t.run.command}`) : `no run command: ${t.noRun ?? 'no runner'}`;

/**
 * T26-11: text lines of a tests report (plan show, show): a count line, then `to run`, `to write` and `touching`, each
 * test with file:line, name, [level target] and its run command on the next line. Each list shows `limit` tests (all
 * with `limit` Infinity) and says how many more there are; `more` tells how to see them (e.g. `--all`).
 */
export function formatTestsBlock(r: ShownTestsReport, o: { limit?: number; more: string }): string[] {
  const limit = o.limit ?? TESTS_TEXT_LIMIT;
  const { run, toWrite, touches } = r.counts;
  if (run + toWrite + touches === 0) return ['tests:     none'];
  const lines = [`tests:     ${run} to run, ${toWrite} to write, ${touches} touching`];
  const list = <T>(title: string, items: T[], show: (t: T) => string[]): void => {
    if (items.length === 0) return;
    lines.push(`  ${title}:`);
    for (const t of items.slice(0, limit)) lines.push(...show(t));
    if (items.length > limit) lines.push(`    ... ${items.length - limit} more (${o.more})`);
  };
  const testLines = (t: ShownTestRef): string[] => [
    `    ${t.file}:${t.line}  ${t.name || '(whole file)'}  [${t.level} ${t.target}]`,
    `      ${runText(t)}`,
  ];
  list('to run', r.run, testLines);
  list('to write', r.toWrite, (t) => [`    ${t.name}  [${t.parent}]  ${t.source.file}:${t.source.line}`]);
  list('touching', r.touches, testLines);
  return lines;
}

/**
 * `check` findings as text: a header line with the repo name and the counts by severity, then one line per finding
 * (severity padded to 9, rule padded to at least 16 with one space after it, id, two spaces, message).
 */
export function formatFindings(findings: PlanFinding[], repoName: string): string {
  const critical = findings.filter(f => f.severity === 'critical').length;
  const warning = findings.filter(f => f.severity === 'warning').length;
  const info = findings.filter(f => f.severity === 'info').length;

  const header = `${CMD_NAME} check · ${repoName} · ${findings.length} findings (${critical} critical, ${warning} warning, ${info} info)`;

  const lines = [header];
  for (const f of findings) {
    const severityPadded = f.severity.padEnd(9);
    // Ensure at least one space between rule and id; pad to at least 16 for compatibility
    const rulePadWidth = Math.max(16, f.rule.length + 1);
    const rulePadded = f.rule.padEnd(rulePadWidth);
    lines.push(`${severityPadded}${rulePadded}${f.id}  ${f.message}`);
  }

  return lines.join('\n');
}
