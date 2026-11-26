/**
 * P15-T5b: CLI front door of the query layer (find, show, outline, deps); P15-T7c adds `mcp` (the same tools over stdio).
 * Read-only (Decision 1): nothing is written, not even `.c4mp/` (the MCP server has two write tools, sim_apply and
 * sim_remove, T6b: only `.c4mp/projects/<id>/sim/`, dry run unless yes). Thin wrappers: loadQueryContext ->
 * the src/query function -> format*. Output: text by default, `--json` = exactly one JSON object on stdout.
 * Errors: text on stderr, `process.exitCode = 1`. Never `process.exit` (it can truncate piped stdout).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import type { C4pmConfig } from './types';
import { CMD_NAME, TOOL_VERSION } from './constants';
import { createMcpServer } from './mcp/server';
import { buildTools } from './mcp/tools';
import { withFingerprint } from './scan/fingerprint';
import { addRepo, addScanOptions, addExamples, numberOpt } from './cliHelp';
import { loadQueryContext, openQueryBase } from './query/context';
import type { QueryBase, QueryContext } from './query/context';
import { QueryError } from './query/errors';
import { findElements, outlineFile, ROW_KINDS } from './query/find';
import type { RowKind } from './query/find';
import { showTarget } from './query/show';
import { searchContent } from './query/search';
import { depsOf } from './query/deps';
import { callersOf, callsOf } from './query/calls';
import { planPath } from './query/planPath';
import { registerPlanCommand } from './cli/planGroup';
import { formatFind, formatOutline, formatShow, formatDeps, formatCalls, formatCallers, formatSearch, formatError, formatJson, formatPlanPath } from './query/format';

type Opts = Record<string, unknown>;

export interface QueryCliDeps {
  /** Turns the shared option values (--lang, --ignore, --tests) into config overrides (bin/cli.ts buildCliConfig). */
  buildCliConfig: (opts: Opts) => Partial<C4pmConfig>;
}

/**
 * Run one query: load the context, call `run`, print text or one JSON object.
 * A QueryError prints `error: <code>: <message>` (+ candidates) on stderr and sets exit code 1; stdout stays empty.
 */
function runQuery<T extends object>(
  opts: Opts,
  deps: QueryCliDeps,
  run: (ctx: QueryContext) => T,
  format: (result: T) => string,
): void {
  runBaseQuery(opts, deps, (base) => run(base.full()), format);
}

/**
 * b680: runQuery for a query that may answer before the scan (search, show): `run` gets a QueryBase (repo root and
 * config) and calls `full()` only when it needs the scan. Same output, errors and exit code as runQuery.
 */
function runBaseQuery<T extends object>(
  opts: Opts,
  deps: QueryCliDeps,
  run: (base: QueryBase) => T,
  format: (result: T) => string,
): void {
  try {
    // log() (src/log.ts) prints debug lines with console.log, i.e. to stdout, when C4MP_DEBUG is set.
    // Send them to stderr while the query runs so stdout carries only the result (one JSON object with --json).
    const stdoutLog = console.log;
    let result: T;
    console.log = console.error;
    try {
      result = run(openQueryBase(path.resolve(opts.repo as string), { cli: deps.buildCliConfig(opts) }));
    } finally {
      console.log = stdoutLog;
    }
    console.log(opts.json ? formatJson(result) : format(result));
  } catch (err) {
    if (err instanceof QueryError) {
      console.error(formatError(err));
    } else {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

/** Shared tail of every query command: --repo (required), --lang, --ignore, --tests, --json. */
function withCommon(cmd: Command): Command {
  return addScanOptions(addRepo(cmd), ['lang', 'ignore', 'tests']).option('--json', 'print one JSON object instead of text');
}

/**
 * P15-T7c: `c4mp mcp` serves the query tools over stdio (JSON-RPC, one message per line) until stdin closes.
 * Decision 11: stdout carries only protocol messages. C4MP_DEBUG is removed (log() would print to stdout), scans are
 * already quiet, serve() sends console.log to stderr. A missing repo or an invalid config is reported on stderr with
 * exit code 1 before anything is served (the first context is built here and handed to the tools, so it is not wasted).
 */
function registerMcpCommand(program: Command, deps: QueryCliDeps): void {
  const mcpCmd = addScanOptions(addRepo(program.command('mcp')), ['lang', 'ignore', 'tests']).description(
    'Serve the code-query tools (find, show, outline, deps, calls, callers, ...) to an AI client over MCP (stdio). ' +
      'Read-only except sim_apply and sim_remove, which write only .c4mp/projects/<id>/sim/ and only with yes true. ' +
      'Reads JSON-RPC lines on stdin, answers on stdout, logs on stderr; ' +
      'stops when stdin closes. Start it from the client config, not by hand',
  );
  mcpCmd.action(async (opts: Opts) => {
    delete process.env.C4MP_DEBUG;
    delete process.env.C4MP_DEBUG;
    delete process.env.C4PM_DEBUG;
    const repoRoot = path.resolve(opts.repo as string);
    try {
      if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
        throw new Error(`repo is not a directory: ${repoRoot}`);
      }
      const cli = deps.buildCliConfig(opts);
      const ctx = withFingerprint(loadQueryContext(repoRoot, { cli }));
      const server = createMcpServer({ name: CMD_NAME, version: TOOL_VERSION.split('@')[1], tools: buildTools(repoRoot, cli, ctx) });
      await server.serve(process.stdin, process.stdout);
    } catch (err) {
      console.error(err instanceof QueryError ? formatError(err) : `error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
  addExamples(mcpCmd, [
    'c4mp mcp --repo .                           stdio server for this folder',
    'c4mp mcp --repo . --lang typescript,python',
    '.mcp.json: {"mcpServers":{"c4mp":{"command":"c4mp",',
    '  "args":["mcp","--repo","."]}}}',
  ]);
}

/** b469: `c4mp plan path <from> <to>` (no hidden top-level alias: a new command). Read-only. */
function registerPlanPathCommand(program: Command, deps: QueryCliDeps): void {
  registerPlanCommand(program, { name: 'path', args: '<from> <to>', noAlias: true }, (cmd) => addExamples(
    withCommon(cmd.description(
      'The layer-by-layer route from a component to a target (a component, or a function: path#name or a name found in ' +
        'one file), by the plan\'s subregion order (first declared = top). Lists the layers between, the components there ' +
        'that already call the target (from the code), and where a planned function is missing, as ready-made ' +
        '`c4mp plan add planned-fn <name> ...` commands (replace <name>). Read-only: writes nothing',
    )).action((from: string, to: string, opts: Opts) => runQuery(opts, deps, (ctx) => planPath(ctx, from, to), formatPlanPath)),
    [
      'c4mp plan path app.api.cli app.api.store --repo .     components',
      'c4mp plan path Cli src/store/db.ts#save --repo .       a function target',
      'c4mp plan path app.api.cli app.api.store --repo . --json',
    ],
  ));
}

export function registerQueryCommands(program: Command, deps: QueryCliDeps): void {
  const findCmd = withCommon(
    program
      .command('find <query>')
      .description(
        'Find functions, classes, methods, types, test cases, files and records (tables of the plan stores) by name. ' +
          'Case-insensitive substring of the name or the file path; each hit shows file, lines, kind and owning component. ' +
          'Read-only: scans live and writes nothing. A query starting with - needs -- before it',
      ),
  )
    .option('--kind <kind>', `only this kind: ${ROW_KINDS.join(', ')}`)
    .option('--limit <n>', 'most hits to return (1-100, default 20)')
    .action((query: string, opts: Opts) =>
      runQuery(opts, deps, (ctx) => findElements(ctx, { query, kind: opts.kind as RowKind | undefined, limit: numberOpt(opts.limit) }), formatFind),
    );

  const searchCmd = withCommon(
    program
      .command('search <text>')
      .description(
        'Search the text of the files (source, html, css, md, json, yaml, templates ...) for an error message or a UI label. ' +
          'Literal and case-insensitive by default; each hit shows file, line, the line, the enclosing function and the owner. ' +
          'Skips binary files, files over 1 MB and ignored folders. Read-only: writes nothing. A text starting with - needs -- before it',
      ),
  )
    .option('--regex', 'treat the text as a regular expression')
    .option('--case', 'case-sensitive')
    .option('--ext <list>', 'only these extensions, comma separated (e.g. .html,.css)')
    .option('--max <n>', 'most hits to return (1-1000, default 50)')
    .option('--context <n>', 'lines around each hit (0-10, default 0)')
    .action((text: string, opts: Opts) =>
      runBaseQuery(
        opts,
        deps,
        (base) =>
          searchContent(base, {
            query: text,
            regex: opts.regex === true,
            caseSensitive: opts.case === true,
            ext: typeof opts.ext === 'string' ? opts.ext.split(',') : undefined,
            max: numberOpt(opts.max),
            context: numberOpt(opts.context),
          }),
        formatSearch,
      ),
    );

  const showCmd = withCommon(
    program
      .command('show <target>')
      .description(
        'Print the source of a function, a line range or a whole file. ' +
          'Target is path, path#name, path#Class.method, path#L10 or path#L10-L20 (same as plan links); ' +
          'a .json, .md or .c4 file also path#a › b (a key, heading or plan element; > works for ›), a plan file also outside the repo; ' +
          'other files only when scanned and inside the repo. Read-only: writes nothing',
      ),
  )
    .option('--max-lines <n>', 'most lines to print (1-400, default 400)')
    .action((target: string, opts: Opts) =>
      runBaseQuery(opts, deps, (base) => showTarget(base, target, { maxLines: numberOpt(opts.maxLines) }), formatShow),
    );

  const outlineCmd = withCommon(
    program
      .command('outline <file>')
      .description(
        'List every function, class and method of one file. ' +
          'Methods are nested under their class; each shows lines and owning component. A migration file of a plan store ' +
          '(.sql) lists its records (tables) with their fields (columns). ' +
          'A .json file lists its keys (array elements that are objects as [i]), ' +
          'a .md file its headings, a .c4 file its plan elements and test blocks, named a › b. Read-only: writes nothing',
      ),
  ).action((file: string, opts: Opts) =>
    runBaseQuery(opts, deps, (base) => outlineFile(base, file), formatOutline),
  );

  const depsCmd = addScanOptions(withCommon(
    program
      .command('deps <element>')
      .description(
        'Show what a container or component uses and what uses it. ' +
          'Element is a uid, id, fqn, local id or title; arrows and weights are the ones in the map, plus declared plan relations. ' +
          'Read-only: writes nothing',
      ),
  ), ['store'])
    .option('--files', 'under each arrow, the import lines behind it: file:line -> target file { imported names }')
    .option(
      '--compare <ref>',
      'per target box, the weight at a stored snapshot (latest, prev, oldest, an id, a commit prefix, YYYY-MM-DD) -> now; ' +
        'the old files are mapped onto today\'s plan boxes (a box new since then shows 0 -> n); needs c4mp history or snapshot --save',
    )
    .action((element: string, opts: Opts) =>
      runQuery(
        opts,
        deps,
        (ctx) => depsOf(ctx, element, { files: opts.files === true, compare: opts.compare as string | undefined }),
        formatDeps,
      ),
    );

  const callsCmd = withCommon(
    program
      .command('calls <function>')
      .description(
        'List the functions a function or method calls. Function is path#name, or a name found in one file. ' +
          'Traced calls only (same file, imported from a repo file, method of a known class or namespace); ' +
          'the rest is counted as unresolved or external, never guessed. Read-only: writes nothing',
      ),
  ).action((fn: string, opts: Opts) => runQuery(opts, deps, (ctx) => callsOf(ctx, fn), formatCalls));

  const callersCmd = withCommon(
    program
      .command('callers <function>')
      .description(
        'List the functions that call a function or method. Function is path#name, or a name found in one file. ' +
          'Traced calls only; "unresolved" counts untraced calls of the same name elsewhere (possible callers). ' +
          'Each caller once, at file:line:column of its first call site, "(also line:column, ...)" for its other sites. ' +
          'Calls outside any named function belong to <module>. Read-only: writes nothing',
      ),
  ).action((fn: string, opts: Opts) => runQuery(opts, deps, (ctx) => callersOf(ctx, fn), formatCallers));

  registerMcpCommand(program, deps);
  registerPlanPathCommand(program, deps);

  addExamples(findCmd, [
    'c4mp find createOrder --repo .              find by name',
    'c4mp find orders --repo . --kind file       only files',
    'c4mp find --repo . --limit 5 -- -helper     query starting with - (options first)',
    'c4mp find Order --repo . --json',
  ]);
  addExamples(searchCmd, [
    'c4mp search "Payment declined" --repo .     find an error message or label',
    'c4mp search "decl.*ed" --repo . --regex --ext .html,.ts',
    'c4mp search Payment --repo . --case --context 2 --max 10',
    'c4mp search Payment --repo . --json',
  ]);
  addExamples(showCmd, [
    'c4mp show src/orders.ts#createOrder --repo .',
    'c4mp show src/orders.ts#Order.total --repo .',
    'c4mp show src/orders.ts#L10-L40 --repo .    a line range',
    'c4mp show src/orders.ts --repo . --max-lines 50',
    'c4mp show "layers.json#folders › src/edit" --repo .   a JSON key',
  ]);
  addExamples(outlineCmd, [
    'c4mp outline src/orders.ts --repo .',
    'c4mp outline guide/ai.md --repo .            the headings of a Markdown file',
    'c4mp outline src/orders.ts --repo . --json',
  ]);
  addExamples(callsCmd, [
    'c4mp calls src/orders.ts#createOrder --repo .',
    'c4mp calls Order.total --repo . --json',
  ]);
  addExamples(callersCmd, [
    'c4mp callers src/orders.ts#createOrder --repo .',
    'c4mp callers createOrder --repo . --json',
  ]);
  addExamples(depsCmd, [
    'c4mp deps Api --repo .                      container: roll-up of its components',
    'c4mp deps app.api.orders --repo .',
    'c4mp deps app.api.orders --repo . --files   the import lines behind each arrow',
    'c4mp deps app.api.orders --repo . --compare prev  previous snapshot -> now',
    'c4mp deps Orders --repo . --json',
  ]);
}
