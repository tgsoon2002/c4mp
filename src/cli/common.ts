/**
 * P18-T10: shared helpers of the plan-editing commands (tree, unplanned, add, set, link, relate).
 * One place prints the result (D15); loading the plan, resolving a target and the write gate (D12, the dry run / --yes
 * write of D13: runWrite) are the Plan editing service's (src/services/planState.ts, b462, b472). Command files only
 * build the edit.
 * Output rules: text results on stdout, text errors on stderr (`error: <code>: <message>`), `--json` = exactly one
 * JSON object on stdout. Exit codes 0/1 (D14), set with process.exitCode, never process.exit (it can truncate pipes).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { cmdError } from '../services/planState';
import { newProjectBesideOthers } from '../scan/project';
import type { NewProjectBesideOthers } from '../scan/project';
import type { Candidate, CmdError, Opts, WriteReport } from '../services/planState';
import type { BoardItem, C4pmConfig, PlanFinding, ViewName } from '../types';
import { CMD_NAME, LEGACY_CMD_NAME, VIEW_NAMES } from '../constants';
import { noteOnce } from '../env';
import { failureCode, guardedWriteJson, thrownOutcome } from '../query/guardedWrite';
import type { GuardedOutcome } from '../query/guardedWrite';

// b462: the error shape lives with the Plan editing service (src/services/planState.ts); the commands keep importing it here.
export { cmdError };
export type { Candidate, CmdError, ErrorCode } from '../services/planState';
// b472: the write gate and its report shape moved to the Plan editing service; the commands keep importing them here.
export { CLAIM_SWITCH_NOTE, CLAIM_SWITCH_NEXT_STEP, failedReport, runWrite } from '../services/planState';
export type { Mention, TargetInfo, WireframeChange, WriteReport, WriteSpec } from '../services/planState';
// b477: the options type, the report target and the text-copy helper moved to the Plan editing service with the edit builders.
export { targetInfoOf, withText } from '../services/planState';
export type { Opts } from '../services/planState';

/** Deps handed in by bin/cli.ts (same pattern as registerQueryCommands). */
export interface PlanEditDeps {
  /** Turns the shared option values (--lang, --ignore, --tests) into config overrides (bin/cli.ts buildCliConfig). */
  buildCliConfig: (opts: Opts) => Partial<C4pmConfig>;
}

// b566: one text for "no plan" (defined with plan show in the Query layer); the commands keep importing it here.
export { NO_PLAN_MESSAGE } from '../query/planShow';

/** Printed by the read commands when the repo has no board file. */
export const NO_BOARD_MESSAGE = 'no board file (c4mp board add --repo R --title T --kind task --yes to start one)';

/** One text line for an item: `b12  bug  in-progress  K  Fix header  due 2026-10-30  [api, billing]  -> 2 links`. */
export function formatBoardItemLine(i: BoardItem): string {
  const parts = [i.id, i.kind || '-', i.status || '-'];
  if (i.owner !== undefined) parts.push(i.owner);
  parts.push(i.title);
  if (i.due !== undefined) parts.push(`due ${i.due}`);
  if (i.tags.length > 0) parts.push(`[${i.tags.join(', ')}]`);
  if (i.links.length > 0) parts.push(`-> ${i.links.length} link${i.links.length === 1 ? '' : 's'}`);
  return parts.join('  ');
}

/** b273: the three view names; the list lives in src/constants.ts (Foundation, used by src/sim too), re-exported here so callers stay. */
export { VIEW_NAMES };

/** b273: add `--view <view>` to a command (D6). Read it back with parseView. */
export const addViewOption = (cmd: Command): Command =>
  cmd.option('--view <view>', 'arch (default), io (screens, flows) or storage (stores, records, fields)');

/** b273: the view named by --view; arch when absent. A bad value is returned as a CmdError 'invalid' (the caller reports it). */
export function parseView(opts: Opts): ViewName | CmdError {
  const v = opts.view;
  if (v === undefined) return 'arch';
  if (typeof v === 'string' && (VIEW_NAMES as string[]).includes(v)) return v as ViewName;
  return cmdError('invalid', `unknown --view '${String(v)}'; use ${VIEW_NAMES.join(', ')}`);
}

// --- output --------------------------------------------------------------------------------------------------

const candidateLine = (c: Candidate): string => `  ${c.uid ?? '(no uid)'}  ${c.fqn}  ${c.title}`;
const MAX_FINDING_LINES = 10;
const findingLine =(f: PlanFinding): string => `  ${f.severity} ${f.rule} ${f.id}: ${f.message}`;

/** Text form of an error: first line `error: <code>: <message>`, then candidates and the hint. A long refusal reason list is capped. */
export function formatErrorText(e: CmdError): string {
  let message = e.message;
  if (e.code === 'new-findings') {
    const parts = message.split('\n');
    if (parts.length - 1 > MAX_FINDING_LINES) {
      message = [...parts.slice(0, MAX_FINDING_LINES + 1), `  ... ${parts.length - 1 - MAX_FINDING_LINES} more (use --json for all)`].join('\n');
    }
  }
  const lines = [`error: ${e.code}: ${message}`];
  for (const c of e.candidates ?? []) lines.push(candidateLine(c));
  if (e.hint) lines.push(e.hint);
  return lines.join('\n');
}

/** Error of a command that has no WriteReport (tree, unplanned): text on stderr, or one JSON object on stdout. */
export function emitError(opts: Opts, command: string, error: CmdError): number {
  if (opts.json) console.log(JSON.stringify({ ok: false, command, error }, null, 2));
  else console.error(formatErrorText(error));
  return 1;
}

const MAX_REASON_LINES = 10;

// T5b: the outcome shape and its JSON object live in the Query layer (src/query/guardedWrite.ts), shared with MCP (T6b).
export type { GuardedOutcome } from '../query/guardedWrite';

/** Print one failure (text: `error: <code>: <message>` + capped reasons on stderr; json: one object on stdout) and return exit code 1. */
export function emitFailure(opts: Opts, command: string, message: string, reasons: string[] = []): number {
  if (opts.json) {
    console.log(JSON.stringify(guardedWriteJson(command, { error: message, reasons }, opts.yes === true), null, 2));
    return 1;
  }
  const lines = [`error: ${failureCode(message)}: ${message}`, ...reasons.slice(0, MAX_REASON_LINES).map((r) => `  - ${r}`)];
  if (reasons.length > MAX_REASON_LINES) lines.push(`  ... ${reasons.length - MAX_REASON_LINES} more (use --json for all)`);
  console.error(lines.join('\n'));
  return 1;
}

/**
 * b723: a write command caught a throw: print it through emitFailure (the first line is the message, later lines are
 * reasons) and return the exit code 1. Used by runGuardedWrite and the plan / snapshot commands of bin/cli.ts.
 */
export function emitThrown(opts: Opts, command: string, err: unknown): number {
  const { error, reasons } = thrownOutcome(err);
  return emitFailure(opts, command, error, reasons);
}

/**
 * Run one guarded write (`op` gets the repo root and --yes; it runs the operation and writes only with --yes) and print
 * the dry run or what was written: text, or with --json one object `{ok, command, dryRun, written, file, changes, minted?, error}`.
 * Returns the exit code (never process.exit). Any refusal, unreadable file, concurrent change or rollback becomes one failure report (exit 1).
 */
export function runGuardedWrite(opts: Opts, command: string, op: (repo: string, yes: boolean) => GuardedOutcome): number {
  try {
    const repoRoot = path.resolve(opts.repo as string);
    const yes = opts.yes === true;
    const outcome = op(repoRoot, yes);
    if ('error' in outcome) return emitFailure(opts, command, outcome.error, outcome.reasons);
    if (opts.json) {
      console.log(JSON.stringify(guardedWriteJson(command, outcome, yes), null, 2));
      return 0;
    }
    if (!outcome.changed) {
      console.log('nothing to change');
      return 0;
    }
    for (const l of outcome.result.lines) console.log(l);
    console.log(yes ? `written: ${outcome.file}` : 'dry run: nothing written. Add --yes to apply.');
    return 0;
  } catch (err) {
    return emitThrown(opts, command, err);
  }
}

/** Print a write result (text or the D15 JSON) and return the exit code (0 ok, 1 anything else). */
export function emitResult(opts: Opts, r: WriteReport): number {
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  if (!r.ok && r.error) {
    console.error([formatErrorText(r.error), ...r.notes.map(n => `note: ${n}`)].join('\n'));
    return 1;
  }
  const out: string[] = [];
  out.push(r.headline ?? `${r.command}${r.target ? ` ${r.target.fqn}${r.target.uid ? `  (uid ${r.target.uid})` : ''}` : ''}`);
  for (const f of r.files) out.push(f.diff.replace(/\n$/, ''));
  out.push(...moveLines(r));
  for (const [label, list] of [['new findings', r.findings.new], ['fixed findings', r.findings.fixed]] as const) {
    if (list.length === 0) continue;
    out.push(`${label}:`);
    out.push(...list.slice(0, MAX_FINDING_LINES).map(findingLine));
    if (list.length > MAX_FINDING_LINES) out.push(`  ... ${list.length - MAX_FINDING_LINES} more (use --json for all)`);
  }
  if (r.mentions && r.mentions.length > 0) {
    out.push('mentions outside the plan (not edited):');
    out.push(...r.mentions.slice(0, MAX_MENTION_LINES).map(m => `  ${m.file}:${m.line}  ${m.fqn}${m.item ? `  (${m.item})` : ''}`));
    if (r.mentions.length > MAX_MENTION_LINES) out.push(`  ... ${r.mentions.length - MAX_MENTION_LINES} more (use --json for all)`);
  }
  for (const n of r.notes) out.push(`note: ${n}`);
  if (r.written) out.push(`written: ${[...r.files.map(f => f.file), ...(r.wireframes ?? []).map(w => w.to)].join(', ')}`);
  else if (r.files.length > 0 || (r.wireframes ?? []).length > 0) out.push('dry run: nothing written. Add --yes to apply.');
  console.log(out.join('\n'));
  return 0;
}

const MAX_MENTION_LINES = 20;
const fileName = (f: string) => f.slice(f.lastIndexOf('/') + 1);

/**
 * plan move / rename text lines after the .c4 diffs: wireframe diffs, one line per moved ROOT (descendants counted),
 * wireframe renames, and the rewritten reference counts. Nothing for other commands.
 */
function moveLines(r: WriteReport): string[] {
  const out: string[] = [];
  for (const w of r.wireframes ?? []) if (w.diff !== '') out.push(w.diff.replace(/\n$/, ''));
  const moved = r.moved ?? [];
  const verb = r.command === 'rename' ? 'renamed' : 'moved';
  for (const m of moved) {
    if (moved.some(o => o !== m && m.from.startsWith(o.from + '.'))) continue;   // a descendant of another row
    const inside = moved.filter(o => o.from.startsWith(m.from + '.')).length;
    out.push(`${verb} ${m.from} -> ${m.to}${m.uid ? `  (uid ${m.uid})` : ''}${inside > 0 ? `  with ${inside} inside` : ''}`);
  }
  for (const w of r.wireframes ?? []) {
    if (w.from !== w.to) out.push(`renamed io/${fileName(w.from)} -> io/${fileName(w.to)}`);
  }
  const rewritten = r.rewritten ?? [];
  if (rewritten.length > 0) {
    const total = rewritten.reduce((s, x) => s + x.count, 0);
    const per = rewritten.map(x => `${fileName(x.file)} ${x.count}`).join(', ');
    out.push(`references rewritten: ${total} in ${rewritten.length} file${rewritten.length === 1 ? '' : 's'} (${per})`);
  }
  return out;
}

/**
 * Run `fn` with console.log sent to stderr: log() (src/log.ts) prints debug lines to stdout when C4MP_DEBUG is set,
 * and stdout must carry only the result.
 */
export function withQuietLogs<T>(fn: () => T): T {
  const stdoutLog = console.log;
  console.log = console.error;
  try {
    return fn();
  } finally {
    console.log = stdoutLog;
  }
}

/** Run a command body; an unexpected throw prints `error: <message>` (or the JSON error) and sets exit code 1. */
export function runAction(opts: Opts, command: string, body: () => number): void {
  try {
    process.exitCode = body();
  } catch (err) {
    process.exitCode = emitError(opts, command, cmdError('invalid', err instanceof Error ? err.message : String(err)));
  }
}

// --- the --repo check (b564), run once for every command by a preAction hook in bin/cli.ts --------------------

/** Thrown by a preAction check that refused the command and already printed why: bin/cli.ts sets exit code 1 and the action never runs. */
export class CommandRefused extends Error {}

/** Full command name without the program name: `check`, `board list`, `plan show`. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c !== null && c.parent !== null; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** True for a folder (a symlink to one counts); false for a file, a missing path or one that cannot be read. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;   // missing, a file on the way (ENOTDIR), no access: none of them can be a code folder
  }
}

/**
 * b564: a stderr note when --repo would start a new, empty project next to existing ones at the same anchor (for
 * example `--repo .` at the git root when the project lives in `--repo Project`). Never for `init` (it makes one on
 * purpose). Reads only. When the project cannot be resolved here, the command itself reports that error.
 */
export function noteOtherProjects(repo: string): void {
  let found: NewProjectBesideOthers | null;
  try {
    found = withQuietLogs(() => newProjectBesideOthers(path.resolve(repo)));   // C4MP_DEBUG lines must not reach stdout
  } catch {
    return;   // the command resolves the same project and prints the error itself
  }
  if (found === null) return;
  console.error(
    `note: no c4mp project '${found.repoId}' at ${found.anchor} yet; it holds: ${found.others.join(', ')}. ` +
      "Check --repo (the folder that holds that project's package.json or code).",
  );
}

/**
 * b564 (BUG-8 of the 2026-11-13 CLI contract run): the one check of --repo, before a command's action. A --repo that
 * is not an existing folder (missing, a typo, a file) is refused: `error: invalid: --repo is not a directory: <path>`
 * on stderr, or with --json / --format json the error object on stdout; then CommandRefused is thrown so the action
 * never runs (before, read commands exited 0, init created the folder and a write made a phantom project). A real
 * sub-folder of a repo is fine (findAnchor still walks up from it). Commands without --repo pass untouched.
 */
export function checkRepoOption(cmd: Command): void {
  const opts = cmd.opts();
  const repo = opts.repo;
  if (typeof repo !== 'string') return;
  if (!isDirectory(repo)) {
    const json = opts.json === true || opts.format === 'json';
    emitError({ json }, commandPath(cmd), cmdError('invalid', `--repo is not a directory: ${repo}`));
    throw new CommandRefused(`--repo is not a directory: ${repo}`);
  }
  if (cmd.name() !== 'init') noteOtherProjects(repo);
}

/** Phase 32 (ED-2): all of stdin as utf8 text (the new code of `c4mp edit`). The one place a command reads stdin. */
export function readStdinText(): string {
  return fs.readFileSync(0, 'utf8');
}
/**
 * Phase 35 B: when the program was started under the old command name (a c4pm link or copy; argv[1] or the compiled
 * binary's own name), print ONE line on stderr (noteOnce: never on stdout, never with --json, off with C4MP_NO_NOTES=1).
 * Returns true when the old name was used.
 */
export function noteLegacyCommandName(argv: string[] = process.argv, execPath: string = process.execPath): boolean {
  const stem = (p: string | undefined): string =>
    path.win32.basename((p ?? '').replace(/\//g, '\\')).toLowerCase().replace(/\.(exe|cmd|js)$/, '');
  if (stem(argv[1]) !== LEGACY_CMD_NAME && stem(execPath) !== LEGACY_CMD_NAME) return false;
  noteOnce('legacy-command', `${LEGACY_CMD_NAME} is now ${CMD_NAME}; the ${LEGACY_CMD_NAME} command keeps working for now (it goes away in a later version)`);
  return true;
}
