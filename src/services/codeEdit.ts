/**
 * Phase 32 (ED-2, b669): the code edit service behind `c4pm edit replace / insert / remove`. It finds an element by
 * name (the target syntax of `show`), builds the new file text with the edit engine (src/edit/), refuses an edit that
 * adds parse errors (D6) and writes only with `yes`, after checking that the file did not change since it was read.
 * Decisions: D3 command name, D4 uncommitted changes allowed with a note, D5 `replace` = the lines `show` prints,
 * `remove` also takes the annotation and bare `export` lines above (Document/Roadmap/Phase32/PHASE_32_PLAN.md).
 * ED-3 (b670): a test case target is its whole `it(...)` statement, `insert --into` also takes a describe, and removing
 * a test case also removes the one plan `test` block whose `case` names it (D7: the plan stays in step).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type Parser from 'tree-sitter';
import { EditError } from '../edit/errors';
import type { EditErrorCode } from '../edit/errors';
import { elementSpan, removalSpan, testStatementSpan } from '../edit/span';
import type { ElementSpan, LineRange } from '../edit/span';
import { insertAfter, insertBefore, removeLines, replaceLines } from '../edit/textOps';
import { parseErrorCount } from '../edit/parseCheck';
import { unifiedDiff } from '../c4/textDiff';
import { parseLink } from '../plan/links';
import { getHandlers, handlerFor } from '../languages';
import { markTestCases, testCasePattern } from '../languages/testCases';
import { TEST_NAME_SEP } from '../languages/typescript/tests';
import { outlineFor } from '../parseCache';
import { testFileMatcher } from '../importer/testMatch';
import { openProject } from '../scan/project';
import { resolveInsideRepo } from '../query/show';
import { QueryError } from '../query/errors';
import { gitBin } from '../util/gitBin';
import { writeAtomic } from '../util/fsAtomic';
import { splitLines } from '../util/text';
import { testCaseId } from '../util/testIds';
import { cmdError, failedReport, loadPlanState, runWrite } from './planState';
import type { PlanState, WriteReport, WriteSpec } from './planState';
import { removeTestEdit, writeSpecOf } from './planOps';
import type { PlanEdit } from './planOps';
import type { C4pmConfig, CodeElement, FileOutline, LanguageHandler } from '../types';
import { CMD_NAME } from '../constants';

export type CodeEditOp = 'replace' | 'insert' | 'remove';
export type CodeEditWhere = 'after' | 'before' | 'into';

export interface CodeEditRequest {
  op: CodeEditOp;
  /** `path#name` as `show` takes it: `src/a.ts#fn`, `src/a.ts#Class.method`, `test/a.test.ts#describe › it` (or ` > `). */
  target: string;
  /** The new lines (replace, insert), inserted as given. */
  text?: string;
  /** insert only: below the element, above it (above its doc comment and decorators), or at the end of a class body. */
  where?: CodeEditWhere;
}

export interface CodeEditPlan {
  /** Repo-relative path, `/` separators. */
  file: string;
  /** The real absolute path that is read and written. */
  absFile: string;
  oldText: string;
  newText: string;
  /** The dry-run report (the code diff, then the plan diffs; notes of both). `ok: false` when the plan part is refused. */
  report: WriteReport;
  /** remove of a test case that a plan `test` block names: that block goes too (D7). Absent otherwise. */
  planSync?: PlanTestSync;
}

/** D7: the plan `test` block that a removed test case takes with it (built and dry-run checked by planCodeEdit). */
export interface PlanTestSync {
  state: PlanState;
  edit: PlanEdit;
  /** The plan element that holds the block, and the block's name. */
  holder: { el: string; test: string };
}

/** The plan write of commitCodeEdit; a parameter so a test can make it fail (the rolled-back path). */
export type PlanWriter = (spec: WriteSpec) => WriteReport;

/** T4a (b698): one repo code file read and parsed once (readFileOutline). */
export interface FileRead {
  /** Repo-relative path, `/` separators. */
  rel: string;
  /** The real absolute path that was read. */
  absFile: string;
  code: string;
  handler: LanguageHandler;
  tree: Parser.Tree;
  outline: FileOutline;
}

/** One file read and parsed once, with the element name of the target: what every edit op starts from. */
interface ParsedTarget extends FileRead {
  name: string;
  lines: string[];
}

const commandOf = (op: CodeEditOp): string => `edit ${op}`;

/** A query-layer refusal (containment, unreadable file) as an edit error. */
function editErrorOf(e: QueryError): EditError {
  const code: EditErrorCode = e.code === 'scan-failed' || e.code === 'not-found' ? 'not-found' : e.code === 'ambiguous' ? 'ambiguous' : 'invalid';
  return new EditError(code, e.message);
}

/** Steps 1-4 of planCodeEdit: config, target split, containment, handler, role and the one parse. */
function readTarget(repoRoot: string, cli: Partial<C4pmConfig>, target: string): ParsedTarget {
  const { config } = openProject(repoRoot, cli);
  if (typeof target !== 'string' || target.trim() === '') throw new EditError('invalid', 'Target is empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new EditError('invalid', `Target '${target}' is not a repository path`);
  const link = parseLink(target, '_.c4');
  if (link.lines) throw new EditError('invalid', `Target '${target}' names lines; ${CMD_NAME} edit takes <path>#<name>`);
  if (!link.name) throw new EditError('invalid', `Target '${target}' has no #name; ${CMD_NAME} edit takes <path>#<name>`);
  const rel = link.path;
  if (rel.trim() === '') throw new EditError('invalid', `Target '${target}' has no file path`);
  const file = parseRepoFile(repoRoot, config, rel, target);
  return { ...file, name: link.name, lines: splitLines(file.code, { keepEol: false }) };
}

/**
 * T4a (b698): one repo-relative code file read and parsed once (steps 1-4 of planCodeEdit without the target split):
 * config, language handler, containment, the role and the one parse. Shared by `c4pm edit` and sim `path#name` targets.
 * Refuses (EditError) a language c4pm does not read, a path outside the repo and a file it cannot read (not-found).
 * A file with syntax errors still parses (tree-sitter): its outline holds what could be read.
 */
export function readFileOutline(repoRoot: string, cli: Partial<C4pmConfig>, rel: string): FileRead {
  const { config } = openProject(repoRoot, cli);
  return parseRepoFile(repoRoot, config, rel, rel);
}

/** The body of readFileOutline once the config is open; `target` names the file in the refusals (readTarget passes `path#name`). */
function parseRepoFile(repoRoot: string, config: C4pmConfig, rel: string, target: string): FileRead {
  const handler = handlerFor(rel, getHandlers(config.languages));
  if (!handler) {
    const ext = path.extname(rel) || path.basename(rel);
    throw new EditError('invalid', `${CMD_NAME} cannot edit ${ext} files (languages: ${config.languages.join(', ')}; see --lang)`);
  }
  let absFile: string;
  try {
    absFile = resolveInsideRepo({ repoRoot }, rel, target);
  } catch (e) {
    if (e instanceof QueryError) throw editErrorOf(e);
    throw e;
  }
  const code = fs.readFileSync(absFile, 'utf8');
  const role = testFileMatcher(config.tests)(rel) ? 'test' : undefined;
  const tree = handler.parse(code, rel);
  const outline = outlineFor(handler, tree, rel, code, role);
  const pattern = role === 'test' ? testCasePattern(handler.id) : undefined;
  if (pattern) markTestCases(outline, code, pattern);
  return { rel, absFile, code, handler, tree, outline };
}

const isBlank = (lines: string[], line: number): boolean => line >= 1 && line <= lines.length && lines[line - 1].trim() === '';
const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The lines a `remove` takes: the removal span (D5), plus blank lines so the neighbours stay tidy:
 * - the span is the last thing of the file, or of its block (the next line is less indented, as a closing `});` or
 *   `}`): the blank lines just above it go too, and at the end of the file the blank lines after it, so the file ends
 *   with exactly one newline (none if it had none) and no block ends in a blank line;
 * - the span is the first thing of its block (the line above is less indented, as `describe('x', () => {`): the blank
 *   lines just after it go too, so no block starts with a blank line;
 * - else, when the lines just before and just after are both blank, the blank line after, so one blank line stays.
 */
function removeRange(span: LineRange, lines: string[]): LineRange {
  const wide = removalSpan(span, lines);
  const own = indentOf(lines[wide.start - 1]);
  const lessIndented = (line: number): boolean => line >= 1 && line <= lines.length && !isBlank(lines, line) && indentOf(lines[line - 1]) < own;
  let lastText = lines.length;
  while (lastText > 0 && isBlank(lines, lastText)) lastText--;
  const atEnd = wide.end >= lastText;
  if (atEnd || lessIndented(wide.end + 1)) {
    let start = wide.start;
    while (start > 1 && isBlank(lines, start - 1)) start--;
    return { start, end: atEnd ? lines.length : wide.end };
  }
  if (lessIndented(wide.start - 1)) {
    let end = wide.end;
    while (end < lines.length && isBlank(lines, end + 1)) end++;
    return { start: wide.start, end };
  }
  return isBlank(lines, wide.start - 1) && isBlank(lines, wide.end + 1) ? { start: wide.start, end: wide.end + 1 } : wide;
}

/** `describe > it` read as `describe › it`, as elementSpan reads a name. */
const asTestName = (name: string): string => name.split(' > ').join(TEST_NAME_SEP);

/** The span an edit works on: the element's lines; a test case widened to its whole `it(...)` statement (TS/JS). */
function targetSpan(t: ParsedTarget): ElementSpan {
  const span = elementSpan(t.outline, t.lines, t.name);
  return span.element.kind === 'test' ? { ...testStatementSpan(t.tree, span.element), element: span.element } : span;
}

/** `insert --into`: a describe block (its whole `describe(...)` statement) or a class. */
function intoSpan(t: ParsedTarget): LineRange {
  const name = asTestName(t.name);
  const blocks = (t.outline.testBlocks ?? []).filter(b => b.kind === 'describe' && b.name === name);
  if (blocks.length > 1) {
    throw new EditError('ambiguous', `describe '${name}' appears ${blocks.length} times in '${t.rel}'`, blocks.map(b => `${b.startLine}-${b.endLine}`));
  }
  if (blocks.length === 1) return testStatementSpan(t.tree, blocks[0]);
  let span: ElementSpan;
  try {
    span = elementSpan(t.outline, t.lines, t.name);
  } catch (e) {
    if (e instanceof EditError && e.code === 'not-found') throw new EditError('not-found', `No class or describe '${t.name}' in '${t.rel}'`);
    throw e;
  }
  if (span.element.kind !== 'class') {
    throw new EditError('invalid', `--into needs a class or a describe; '${span.element.name}' is a ${span.element.kind}`);
  }
  return span;
}

/** Step 5: the new file text, and the element it edits (null for `insert --into`, whose target may be a describe). */
function newTextOf(t: ParsedTarget, req: CodeEditRequest): { text: string; element: CodeElement | null } {
  if (req.op === 'remove') {
    const span = targetSpan(t);
    const r = removeRange(span, t.lines);
    return { text: removeLines(t.code, r.start, r.end), element: span.element };
  }
  const text = req.text ?? '';
  if (text.trim() === '') throw new EditError('invalid', `edit ${req.op} needs new text${req.op === 'replace' ? ' (to delete, use edit remove)' : ''}`);
  if (req.op === 'insert' && req.where === 'into') {
    // At the end of the body: above the last line of the class (or of the describe statement).
    return { text: insertBefore(t.code, intoSpan(t).end, text), element: null };
  }
  const span = targetSpan(t);
  if (req.op === 'replace') return { text: replaceLines(t.code, span.start, span.end, text), element: span.element };
  switch (req.where) {
    case 'after':
      return { text: insertAfter(t.code, span.end, text), element: span.element };
    case 'before':
      // Above the element's doc comment and decorators, which belong to it (D5).
      return { text: insertBefore(t.code, removalSpan(span, t.lines).start, text), element: span.element };
    default:
      throw new EditError('invalid', 'edit insert needs exactly one of --after, --before, --into');
  }
}

/**
 * D7: the plan `test` block whose `case` is `caseId`, as a plan edit that removes it, with the dry run of the write
 * gate. Null with no plan or no such block. Throws EditError 'ambiguous' when more than one block names the case
 * (candidates `<element> '<test>'`), or when the plan edit cannot be built.
 */
function planTestSyncOf(repoRoot: string, cli: Partial<C4pmConfig>, caseId: string): { sync: PlanTestSync; dry: WriteReport } | null {
  const state = loadPlanState(repoRoot, cli);
  if (!state) return null;
  const holders = state.plan.elements.flatMap(el => (el.tests ?? []).filter(t => t.case === caseId).map(t => ({ el: el.id, test: t.name })));
  if (holders.length === 0) return null;
  if (holders.length > 1) {
    throw new EditError(
      'ambiguous',
      `${holders.length} plan test blocks name the case ${caseId}, nothing written; keep one (${CMD_NAME} plan remove <element> --test <name>)`,
      holders.map(h => `${h.el} '${h.test}'`),
    );
  }
  const holder = holders[0];
  const built = removeTestEdit(state, holder.el, holder.test);
  if (!built.ok) {
    const code: EditErrorCode = built.error.code === 'not-found' || built.error.code === 'ambiguous' ? built.error.code : 'invalid';
    throw new EditError(code, `the plan test block '${holder.test}' of ${holder.el} cannot be removed: ${built.error.message}`);
  }
  const dry = runWrite(writeSpecOf(commandOf('remove'), { yes: false }, state, built.edit));
  return { sync: { state, edit: built.edit, holder }, dry };
}

/** The code report with a plan write report folded in: the plan diffs after the code diff, the notes of both, the plan verdict. */
function withPlanReport(code: WriteReport, plan: WriteReport, note: string): WriteReport {
  return {
    ...code,
    ok: code.ok && plan.ok,
    files: [...code.files, ...plan.files],
    findings: plan.findings,
    notes: [...code.notes, note, ...plan.notes],
    error: code.error ?? plan.error,
  };
}

/** D4: a note when the file has uncommitted git changes; none outside a git repo or on any git error. */
function uncommittedNote(repoRoot: string, rel: string): string | null {
  try {
    const out = execFileSync(gitBin(), ['-C', repoRoot, 'status', '--porcelain', '--', rel], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() !== '' ? `${rel} has uncommitted changes` : null;
  } catch {
    return null;
  }
}

/**
 * Build one code edit without writing: the new text, its diff and notes. Throws EditError ('invalid', 'not-found',
 * 'ambiguous', 'parse-worse'); other throws (config, unreadable repo) pass through.
 */
export function planCodeEdit(repoRoot: string, cli: Partial<C4pmConfig>, req: CodeEditRequest): CodeEditPlan {
  const t = readTarget(repoRoot, cli, req.target);
  const { text: newText, element } = newTextOf(t, req);
  const added = parseErrorCount(t.handler.parse(newText, t.rel)) - parseErrorCount(t.tree);
  if (added > 0) {
    throw new EditError('parse-worse', `the edit adds ${added} parse error${added === 1 ? '' : 's'} to ${t.rel}, nothing written`);
  }
  const notes: string[] = [];
  const dirty = uncommittedNote(repoRoot, t.rel);
  if (dirty) notes.push(dirty);
  const command = commandOf(req.op);
  let report: WriteReport = {
    ok: true, command, dryRun: true, written: false, target: null,
    files: [{ file: t.rel, diff: unifiedDiff(t.rel, t.code, newText) }],
    findings: { new: [], fixed: [] }, notes, error: null, headline: `${command} ${req.target}`,
  };
  // D7: a removed test case takes the plan test block that names it (a replace keeps the name: no plan change).
  const synced = req.op === 'remove' && element?.kind === 'test' ? planTestSyncOf(repoRoot, cli, testCaseId(t.rel, element.name)) : null;
  if (synced) {
    const { holder } = synced.sync;
    report = withPlanReport(report, synced.dry, `the plan test block '${holder.test}' of ${holder.el} names this case: it is removed too`);
  }
  return { file: t.rel, absFile: t.absFile, oldText: t.code, newText, report, ...(synced ? { planSync: synced.sync } : {}) };
}

/**
 * Write a planned edit: refused as planned when its dry run was, and refused ('changed') when the file is no longer
 * the text the plan was built from. With a plan sync (D7) the code is written first, then the plan through the write
 * gate (`writePlan`, default runWrite); when the plan write fails the old code is put back ('rolled-back').
 */
export function commitCodeEdit(plan: CodeEditPlan, writePlan: PlanWriter = runWrite): WriteReport {
  if (!plan.report.ok) return { ...plan.report, dryRun: false, written: false };
  let now: string | null;
  try {
    now = fs.readFileSync(plan.absFile, 'utf8');
  } catch {
    now = null;
  }
  if (now !== plan.oldText) {
    return {
      ...plan.report, ok: false, dryRun: false, written: false, files: [],
      error: cmdError('changed', `${plan.file} changed on disk since it was read, nothing written`),
    };
  }
  writeAtomic(plan.absFile, plan.newText);
  const codeReport: WriteReport = { ...plan.report, dryRun: false, written: true };
  if (!plan.planSync) return codeReport;
  const { state, edit } = plan.planSync;
  let planReport: WriteReport;
  try {
    planReport = writePlan(writeSpecOf(plan.report.command, { yes: true }, state, edit));
  } catch (err) {
    planReport = failedReport(plan.report.command, { yes: true }, cmdError('invalid', err instanceof Error ? err.message : String(err)));
  }
  if (planReport.ok && planReport.written) return { ...codeReport, findings: planReport.findings };
  const planReason = planReport.error ? `${planReport.error.code}: ${planReport.error.message}` : 'the plan was not written';
  let restored = `${plan.file} was put back, nothing written`;
  let written = false;
  try {
    writeAtomic(plan.absFile, plan.oldText);
  } catch (err) {
    restored = `putting ${plan.file} back failed too (${err instanceof Error ? err.message : String(err)}): the code edit stays`;
    written = true;
  }
  return {
    ...codeReport, ok: false, written,
    notes: [...codeReport.notes, ...planReport.notes],
    error: cmdError('rolled-back', `the plan write failed (${planReason}); ${restored}`),
  };
}

/** A failed report of an edit error; ambiguous candidates ("start-end") go into the notes. */
export function editErrorReport(command: string, opts: { yes?: boolean }, e: EditError): WriteReport {
  const report = failedReport(command, opts, cmdError(e.code, e.message));
  if (e.candidates && e.candidates.length > 0) report.notes.push(`candidates: ${e.candidates.join(', ')}`);
  return report;
}

/** Plan, then commit with `yes`; an EditError becomes a failed report (exit 1). */
export function runCodeEdit(repoRoot: string, cli: Partial<C4pmConfig>, req: CodeEditRequest, opts: { yes?: boolean }): WriteReport {
  let plan: CodeEditPlan;
  try {
    plan = planCodeEdit(repoRoot, cli, req);
  } catch (e) {
    if (e instanceof EditError) return editErrorReport(commandOf(req.op), opts, e);
    throw e;
  }
  return opts.yes === true ? commitCodeEdit(plan) : plan.report;
}
