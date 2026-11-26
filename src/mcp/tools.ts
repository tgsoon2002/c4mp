/**
 * P15-T7a: the MCP tools backed by the query layer (find, show, outline, deps, calls, callers). One registry entry per tool.
 * Result text = the same JSON the CLI prints with `--json` (formatJson of the same query function's result);
 * a QueryError becomes an isError result whose text is errorJson. Read-only (Decision 1), except T6b's two sim writes.
 * P15-T7d: `check` and `status` (their own scan, like the CLI commands).
 * P15-T7b3: `view_path` (where the exported view page is and when it was written; no scan, no writes).
 * T26-11: `plan_show` (one plan element with its tests, as `c4pm plan show <target> --json`).
 * T6 (b702): `sim_list` / `sim_show` (the s-items, as `c4pm sim list|show --json`; a refusal is the CLI's
 * `{ok: false, command, error}` with isError). b784: the plan for names = planNoScan (the CLI's, no scan), not ctx.plan:
 * the MCP command's --ignore reaches that plan's .c4 discovery, so it could name fewer elements than the CLI; the
 * refusal = simReadError (the CLI's object).
 * T6b (b768): `sim_apply` / `sim_remove`, the only MCP tools that write (K 2026-11-15 Q5): through Simulation editing
 * (applySimFile, removeSim; only `.c4pm/projects/<id>/sim/`), dry run unless `yes: true`; the reply = simWriteJson,
 * the object of `c4pm sim apply|remove --json`.
 * The QueryContext lives in a closure and is rebuilt when the tree changed (Decision 3).
 */
import type { C4pmConfig, Severity } from '../types';
import { viewPageInfo } from '../scan/project';
import { planNoScan } from '../scan/planScan';
import { CMD_NAME, DATA_DIR, LEGACY_DATA_DIR, MIN_SEVERITIES } from '../constants';
import { loadQueryContext } from '../query/context';
import type { QueryContext } from '../query/context';
import { isStale, withFingerprint } from '../scan/fingerprint';
import { QueryError } from '../query/errors';
import { findElements, outlineFile, ROW_KINDS } from '../query/find';
import type { RowKind } from '../query/find';
import { showTarget } from '../query/show';
import { planShowJson, showPlanElement } from '../query/planShow';
import { searchContent } from '../query/search';
import { depsOf } from '../query/deps';
import { callersOf, callsOf } from '../query/calls';
import { formatJson, errorJson } from '../query/format';
import { runCheck } from '../query/check';
import { runStatus } from '../query/status';
import { listSims, showSim, simReadError, simWriteJson } from '../query/sim';
import { thrownOutcome } from '../query/guardedWrite';
import { applySimFile, removeSim } from '../services/simEdit';
import type { SimOpOutcome } from '../services/simEdit';
import type { ToolDef } from './server';

type Args = Record<string, unknown>;

/** One tool minus the context plumbing: `run` gets a fresh context and returns the object to print. */
interface QueryTool {
  name: string;
  description: string;
  inputSchema: object;
  run(ctx: QueryContext, args: Args): object;
}

function stringArg(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new QueryError('invalid', `${key} must be a string`);
  return v;
}

/** Number argument; undefined when absent. A non-number becomes NaN, which the query layer rejects as `invalid` (as the CLI does). */
function numberArg(args: Args, key: string): number | undefined {
  const v = args[key];
  return v === undefined ? undefined : Number(v);
}

const QUERY_TOOLS: QueryTool[] = [
  {
    name: 'find',
    description:
      'Find functions, classes, methods, types, test cases, files and records (tables of the plan stores) by name. ' +
      'Case-insensitive substring of the name or the file path; each hit has file, lines, kind and owning component.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of an element name or a file path' },
        kind: { type: 'string', enum: [...ROW_KINDS], description: 'Only this kind' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Most hits to return' },
      },
      required: ['query'],
    },
    run: (ctx, a) =>
      findElements(ctx, { query: stringArg(a, 'query'), kind: a.kind as RowKind | undefined, limit: numberArg(a, 'limit') }),
  },
  {
    name: 'search',
    description:
      'Search the text of the files (source, html, css, md, json, yaml, templates) for an error message or a UI label. ' +
      'Literal, case-insensitive by default. Each hit has file, line, text, enclosing function and owner. ' +
      'Skips binary files, files over 1 MB and ignored folders; the result counts hits, files searched and files skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (a pattern when regex is true)' },
        regex: { type: 'boolean', default: false, description: 'Treat query as a regular expression' },
        case: { type: 'boolean', default: false, description: 'Case-sensitive' },
        ext: { type: 'array', items: { type: 'string' }, description: 'Only these extensions, e.g. [".html", ".css"]' },
        max: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Most hits to return' },
        context: { type: 'integer', minimum: 0, maximum: 10, default: 0, description: 'Lines around each hit' },
      },
      required: ['query'],
    },
    run: (ctx, a) =>
      searchContent(ctx, {
        query: stringArg(a, 'query'),
        regex: a.regex === true,
        caseSensitive: a.case === true,
        ext: Array.isArray(a.ext) ? a.ext.map(String) : undefined,
        max: numberArg(a, 'max'),
        context: numberArg(a, 'context'),
      }),
  },
  {
    name: 'show',
    description:
      'Return the source of a function, a line range or a whole file. Target is path, path#name, path#Class.method, ' +
      'path#L10 or path#L10-L20; a .json, .md or .c4 file also path#a › b (a key, heading or plan element), a plan file ' +
      'also outside the repo (the path plan_show gives); other files only when scanned and inside the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'path, path#name, path#Class.method, path#L10 or path#L10-L20, or path#a › b for a .json, .md or .c4 file' },
        max_lines: { type: 'integer', minimum: 1, maximum: 400, default: 400, description: 'Most lines to return' },
      },
      required: ['target'],
    },
    run: (ctx, a) => showTarget(ctx, stringArg(a, 'target'), { maxLines: numberArg(a, 'max_lines') }),
  },
  {
    name: 'plan_show',
    description:
      'One plan element (container, subregion, component, function, store, record, ...) by uid, fqn, local id or name: its plan fields; ' +
      'for a store what its reader finds (code); for a record the code record it matches (record: file, lines, its fields with ' +
      'type, pk, nullable, FK table.column, on delete, the plan field each matches, and the field differences); ' +
      'and, for a c-item of the map, its tests: run (attached to it or below it, each with level, target, file, line and ' +
      'a run command {command, cwd}), toWrite (test blocks of the plan no test case matches yet) and touches (attached ' +
      'elsewhere, reaching it).',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Plan element: uid, fqn, local id or name' } },
      required: ['target'],
    },
    run: (ctx, a) => planShowJson(showPlanElement(ctx, stringArg(a, 'target'))),
  },
  {
    name: 'outline',
    description:
      'List every function, class and method of one scanned file. Methods are nested under their class; ' +
      'functions declared inside a function are nested under it as outer.inner; ' +
      'each shows lines and owning component. A file only a storage reader reads (a .sql migration of a plan store) ' +
      'lists its records (tables) with their fields (columns). A .json file lists its keys (array elements that are ' +
      'objects as [i]), a .md file its headings, a .c4 file its plan elements and test blocks (kinds key, heading, the ' +
      'plan kind, test), named a › b.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative path of a scanned source file, a migration file, or a .json, .md or .c4 file' } },
      required: ['path'],
    },
    run: (ctx, a) => outlineFile(ctx, stringArg(a, 'path')),
  },
  {
    name: 'deps',
    description:
      'Show what a container, subregion or component uses and what uses it, plus declared plan relations. ' +
      'Id is a uid, id, fqn, local id or title. files: true adds usesFiles / usedByFiles, each arrow with the import ' +
      'lines behind it ({file, line, spec, kind, target, names}). compare: a stored snapshot ref adds compare, per ' +
      'target box the weight then -> now (new, gone, changed, same); old files are mapped onto today\'s plan boxes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container, subregion or component: uid, id, fqn, local id or title' },
        files: { type: 'boolean', description: 'Add the import lines behind each arrow (usesFiles, usedByFiles)' },
        compare: {
          type: 'string',
          description: 'Stored snapshot ref (latest, prev, oldest, an id, a commit prefix, YYYY-MM-DD): the arrows then -> now',
        },
      },
      required: ['id'],
    },
    run: (ctx, a) =>
      depsOf(ctx, stringArg(a, 'id'), { files: a.files === true, compare: typeof a.compare === 'string' ? a.compare : undefined }),
  },
  {
    name: 'calls',
    description:
      'List the functions a function or method calls: {target, calls: [{name, file, line, resolved}], unresolved, external}. ' +
      'Only traced calls are listed (same file, imported from a repo file, method of a known class or namespace); ' +
      'unresolved and external calls are counted, never guessed.',
    inputSchema: {
      type: 'object',
      properties: { function: { type: 'string', description: 'path#name, or a function / Class.method name found in one file' } },
      required: ['function'],
    },
    run: (ctx, a) => callsOf(ctx, stringArg(a, 'function')),
  },
  {
    name: 'callers',
    description:
      'List the functions that call a function or method: {target, callers: [{name, file, line, column, resolved, sites}], ' +
      'unresolved}. One entry per caller: line and column are its first call site of the function (1-based; column in ' +
      'UTF-16 units, at the called name), sites every call site of that caller. ' +
      '<module> is the caller of calls outside any named function. unresolved counts untraced calls of the same name ' +
      'elsewhere (possible callers).',
    inputSchema: {
      type: 'object',
      properties: { function: { type: 'string', description: 'path#name, or a function / Class.method name found in one file' } },
      required: ['function'],
    },
    run: (ctx, a) => callersOf(ctx, stringArg(a, 'function')),
  },
];

/** A failure whose reply text is `body` (isError), not errorJson: a refusal shaped as the CLI prints it with --json (sim tools). */
class ToolError extends Error {
  readonly body: object;

  constructor(body: object) {
    super('tool error');
    this.name = 'ToolError';
    this.body = body;
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/**
 * Result of one tool call: the object as JSON text; a QueryError becomes an isError result whose text is errorJson,
 * a ToolError one whose text is its body.
 */
function reply(run: () => object): { content: { type: string; text: string }[]; isError?: true } {
  try {
    return { content: [{ type: 'text', text: formatJson(run()) }] };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: 'text', text: formatJson(err.body) }], isError: true };
    if (!(err instanceof QueryError)) throw err;
    return { content: [{ type: 'text', text: JSON.stringify(errorJson(err)) }], isError: true };
  }
}

/** A sim read as the CLI's `read` runs it: an unexpected throw (no project, unreadable plan) is an `invalid` refusal. */
function simRead(command: string, body: () => object): object {
  try {
    return body();
  } catch (err) {
    if (err instanceof ToolError || err instanceof QueryError) throw err;
    throw new ToolError(simReadError(command, { error: err instanceof Error ? err.message : String(err) }, 'invalid'));
  }
}

/**
 * T6b (b768): one MCP sim write as the CLI's runGuardedWrite runs it. `yes` (boolean, default false): dry run unless
 * true. `op` is the Simulation editing call (every guard is the service's: only sim/ files, changed since read,
 * exclusive create). The reply = simWriteJson, the CLI's `--json` object; a refusal, or a throw (thrownOutcome, as the
 * CLI's emitThrown), is that object with isError. A `yes` that is not a boolean is a QueryError (invalid), nothing runs.
 */
function simWriteReply(command: string, args: Args, op: (yes: boolean) => SimOpOutcome): object {
  if (args.yes !== undefined && typeof args.yes !== 'boolean') throw new QueryError('invalid', 'yes must be true or false');
  const yes = args.yes === true;
  let outcome: SimOpOutcome;
  try {
    outcome = op(yes);
  } catch (err) {
    outcome = thrownOutcome(err);
  }
  const json = simWriteJson(command, outcome, yes);
  if (!json.ok) throw new ToolError(json);
  return json;
}

/** A tool that reads the repo itself (check, status: their own scan; sim_list, sim_show: no scan; sim_apply, sim_remove: write through Simulation editing) instead of using the cached QueryContext. */
interface RepoTool {
  name: string;
  description: string;
  inputSchema: object;
  run(repoRoot: string, cli: Partial<C4pmConfig>, args: Args): object;
}

const SEVERITIES = MIN_SEVERITIES;

const REPO_TOOLS: RepoTool[] = [
  {
    name: 'check',
    description:
      'Check the .c4 plan against the code: the findings (severity, rule, id, message) of `' + CMD_NAME + ' check`, ' +
      'same array as `' + CMD_NAME + ' check --format json`. {"plan": false, "findings": []} when the repo has no .c4 files.',
    inputSchema: {
      type: 'object',
      properties: {
        min_severity: { type: 'string', enum: SEVERITIES, default: 'info', description: 'Hide findings below this level' },
        sprint: { type: 'string', description: 'Only plan items of this sprint' },
      },
    },
    run: (repoRoot, cli, a) => {
      const minSeverity = a.min_severity === undefined ? undefined : stringArg(a, 'min_severity');
      if (minSeverity !== undefined && !SEVERITIES.includes(minSeverity as Severity)) {
        throw new QueryError('invalid', `min_severity must be one of ${SEVERITIES.join(', ')}`);
      }
      const sprint = a.sprint === undefined ? undefined : stringArg(a, 'sprint');
      const result = runCheck(repoRoot, cli, { sprint, minSeverity: minSeverity as Severity | undefined });
      // result.findings already holds plan + board findings (collectFindings), like `c4pm check`.
      return result ? result.findings : { plan: false, findings: [] };
    },
  },
  {
    name: 'status',
    description:
      'Summary of the repo as `' + CMD_NAME + ' status` sees it: snapshot size, stored history, plan findings by severity ' +
      'and the effective config (languages, ignore).',
    inputSchema: { type: 'object', properties: {} },
    run: (repoRoot, cli) => runStatus(repoRoot, cli),
  },
  {
    name: 'sim_list',
    description:
      'The s-items (simulations: flows and journeys) of the repo, as `' + CMD_NAME + ' sim list --json`: {sims, issues, notes}; each ' +
      'sim has id, kind, title, steps (flow) or stages (journey) count, person and file; issues = files that do not parse. ' +
      'Read-only.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['flow', 'journey'], description: 'Only this kind' } },
    },
    run: (repoRoot, _cli, a) => {
      const kind = a.kind === undefined ? undefined : stringArg(a, 'kind');
      return simRead('sim list', () => {
        const listed = listSims(repoRoot, planNoScan(repoRoot), { kind });
        if ('error' in listed) throw new ToolError(simReadError('sim list', listed));
        return listed;
      });
    },
  },
  {
    name: 'sim_show',
    description:
      'One s-item, as `' + CMD_NAME + ' sim show <id> --json`: every step or stage with its targets, call ends and rows records ' +
      'resolved against the plan (kind, fqn, title, uid; a code target path#name as code, a ref nothing names as null). ' +
      'An unknown id is an error (not-found) listing the ids. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The s-item id, e.g. s-1' } },
      required: ['id'],
    },
    run: (repoRoot, _cli, a) => {
      const id = stringArg(a, 'id');
      return simRead('sim show', () => {
        const shown = showSim(repoRoot, planNoScan(repoRoot), id);
        if ('error' in shown) throw new ToolError(simReadError('sim show', shown));
        return shown;
      });
    },
  },
  {
    name: 'sim_apply',
    description:
      'Create or change s-items from one sim apply spec (the content of a `' + CMD_NAME + ' sim apply` file: {sims: [...]}, see ' +
      '"Simulations (s-items)" of the guide), as `' + CMD_NAME + ' sim apply <file> --json`: {ok, command, dryRun, written, file, ' +
      'changes, minted?, error}. Refs are stored as uids; a code path#name not in the plan yet is first added to it (a done function under the component that owns its file, owner from `owner` or that component) in the same write, so it writes ' + DATA_DIR + '/projects/<id>/sim/ (' + LEGACY_DATA_DIR + ' in an old repo) and, then, the plan .c4 files; dry run unless yes is true. A refusal (a bad spec, ' +
      'a ref nothing names) is the same object with ok false, error {code, message, reasons} and isError.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: '{"sims": [...]}: each entry an s-item as in its file; no id = new (next ids), an id replaces that s-item whole' },
        yes: { type: 'boolean', default: false, description: 'Write the change; false (default) = dry run, nothing written' },
        owner: { type: 'string', description: "Owner of code a ref adds to the plan; default: the owning component's owner" },
      },
      required: ['spec'],
    },
    run: (repoRoot, _cli, a) => simWriteReply('sim apply', a, (yes) => applySimFile(repoRoot, a.spec, yes, typeof a.owner === 'string' ? a.owner : undefined)),
  },
  {
    name: 'sim_remove',
    description:
      'Remove one s-item, as `' + CMD_NAME + ' sim remove <id> --json`: {ok, command, dryRun, written, file, changes, error}. ' +
      'Refused (isError) while a journey stage names it, or when the id is unknown (not-found). Writes only ' +
      DATA_DIR + '/projects/<id>/sim/ (' + LEGACY_DATA_DIR + ' in an old repo); dry run unless yes is true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The s-item id, e.g. s-1' },
        yes: { type: 'boolean', default: false, description: 'Write the change; false (default) = dry run, nothing written' },
      },
      required: ['id'],
    },
    run: (repoRoot, _cli, a) => {
      const id = stringArg(a, 'id');
      return simWriteReply('sim remove', a, (yes) => removeSim(repoRoot, id, yes));
    },
  },
];

/** `view_path`: the exported view page of the repo's project, as Project & scan's viewPageInfo answers it (read-only). */
function viewPathTool(repoRoot: string): ToolDef {
  return {
    name: 'view_path',
    description:
      'Where the exported view page (the interactive map of the repo) is, and whether and when it was last written. ' +
      'Does not generate it.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: formatJson(viewPageInfo(repoRoot)) }] }),
  };
}

/**
 * Tools for one repo. The context is built on the first call and rebuilt when the fingerprint says the tree changed.
 * Callers (T7c) pass the same `cli` overrides as the CLI's buildCliConfig, and may pass a context they already built
 * (with its fingerprint, see withFingerprint) so the first call does not scan again.
 */
export function buildTools(repoRoot: string, cli: Partial<C4pmConfig>, initial?: QueryContext): ToolDef[] {
  let ctx: QueryContext | null = initial ?? null;

  const current = (): QueryContext => {
    if (!ctx || isStale(ctx)) ctx = withFingerprint(loadQueryContext(repoRoot, { cli }));
    return ctx;
  };

  const queryTools: ToolDef[] = QUERY_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: (args: Args) => reply(() => t.run(current(), args)),
  }));
  const repoTools: ToolDef[] = REPO_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: (args: Args) => reply(() => t.run(repoRoot, cli, args)),
  }));

  return [...queryTools, viewPathTool(repoRoot), ...repoTools];
}
