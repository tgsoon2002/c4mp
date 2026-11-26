/**
 * b405 MV-3 (Document/Roadmap/PLAN_MOVE.md section 4): `c4mp plan move <element>... --parent <p>` and
 * `c4mp plan rename <element> <new id>`. This file only parses options, resolves the targets and prints; the work
 * (engine, wireframes, postcondition, mentions) is the L3 service src/services/planMove.ts, the write is runWrite.
 * Every reference and wireframe file follows; strings, comments, docs and the board are listed, never edited.
 * Layers (PLAN_MOVE.md section 10 CORRECTION): bin/cli.ts hands the service in (`MoveDeps.planMove`), so src/cli
 * imports nothing from src/services (no new folder cycle) and nothing new from src/c4 (no new skip-layer import).
 */
import type { Command } from 'commander';
import { addExamples, addRepo, addScanOptions } from '../cliHelp';
import {
  NO_PLAN_MESSAGE, cmdError, emitResult, failedReport, runAction, runWrite, targetInfoOf, withQuietLogs,
} from './common';
import type { Mention, Opts, PlanEditDeps, TargetInfo, WireframeChange, WriteReport } from './common';
import { loadPlanState, resolveTarget } from '../services/planState';
import type { PlanState } from '../services/planState';
import { planGroup } from './planGroup';
import { writeSpecOf } from '../services/planOps';
import type { Plan } from '../types';

/** What the move service returns for one command (src/services/planMove.ts MoveEditResult). */
export type MoveBuild =
  | { ok: false; problems: string[] }
  | {
      ok: true;
      newTexts: Map<string, string>;
      after: Plan;
      moved: Map<string, string>;
      roots: { from: string; to: string }[];
      wireframes: WireframeChange[];
      rewritten: { file: string; count: number }[];
      notes: string[];
      post: (plan: Plan) => string | null;
    };

/** The service behind both commands (src/services/planMove.ts). */
export interface PlanMoveService {
  moveEdit(state: PlanState, roots: string[], parent: string): MoveBuild;
  renameEdit(state: PlanState, fqn: string, newId: string): MoveBuild;
  findMentions(state: PlanState, oldRoots: string[], newTexts: Map<string, string>, wireframes: WireframeChange[]): { mentions: Mention[] };
}

export interface MoveDeps extends PlanEditDeps { planMove: PlanMoveService }

type Built = Extract<MoveBuild, { ok: true }>;

/** Gate + write (runWrite), then the mentions of the old root fqns (unless --no-mentions). */
function writeMove(deps: MoveDeps, command: string, opts: Opts, state: PlanState, target: TargetInfo, built: Built, headline?: string): WriteReport {
  const report = runWrite(writeSpecOf(command, opts, state, {
    target, newTexts: built.newTexts, after: built.after, post: built.post, notes: built.notes,
    needsScan: false, lost: [], linkChecks: [], moved: built.moved, wireframes: built.wireframes,
    report: { ...(headline !== undefined ? { headline } : {}), rewritten: built.rewritten },
  }));
  if (!report.ok || opts.mentions === false) return report;
  const oldRoots = built.roots.filter(r => r.from !== r.to).map(r => r.from);
  const { mentions } = deps.planMove.findMentions(state, oldRoots, built.newTexts, built.wireframes);
  return { ...report, mentions, mentionsTotal: mentions.length };
}

const refused = (verb: string, problems: string[]) => cmdError('invalid', `cannot ${verb}, nothing written:\n  - ${problems.join('\n  - ')}`);

function runMove(targets: string[], opts: Opts, deps: MoveDeps): WriteReport {
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('move', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const parent = resolveTarget(state, opts.parent as string, { codeToo: true });
  if (!parent.ok) return failedReport('move', opts, { ...parent.error, message: `--parent: ${parent.error.message}` });
  const target = targetInfoOf(parent.el);
  const roots: string[] = [];
  for (const t of targets) {
    const r = resolveTarget(state, t, { codeToo: true });
    if (!r.ok) return failedReport('move', opts, r.error, target);
    roots.push(r.el.id);
  }
  const built = deps.planMove.moveEdit(state, roots, parent.el.id);
  if (!built.ok) return failedReport('move', opts, refused('move', built.problems), target);
  const n = roots.length;
  const headline = `move ${n} element${n === 1 ? '' : 's'} to ${parent.el.id}${target.uid ? `  (uid ${target.uid})` : ''}`;
  return writeMove(deps, 'move', opts, state, target, built, headline);
}

function runRename(targetArg: string, newId: string, opts: Opts, deps: MoveDeps): WriteReport {
  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return failedReport('rename', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const el = resolveTarget(state, targetArg, { codeToo: true });
  if (!el.ok) return failedReport('rename', opts, el.error);
  const target = targetInfoOf(el.el);
  const built = deps.planMove.renameEdit(state, el.el.id, newId);
  if (!built.ok) return failedReport('rename', opts, refused('rename', built.problems), target);
  return writeMove(deps, 'rename', opts, state, target, built);
}

/** Options every write command has, plus --no-mentions. */
function writeOptions(cmd: Command): Command {
  return addScanOptions(
    addRepo(cmd)
      .option('--yes', 'write the change; without it only the diff is printed')
      .option('--force', 'also write plan files outside .c4mp/ and C4MP/')
      .option('--check', 'gate with the full check (scans the code; slower)')
      .option('--json', 'print one JSON object instead of text')
      .option('--no-mentions', 'skip the search for mentions of the old ids outside the plan (docs, board, comments)'),
    ['lang', 'ignore', 'tests'],
  );
}

/** `plan move` and `plan rename`, under `c4mp plan` only (new commands: no old top-level name to keep). */
export function registerMoveCommands(program: Command, deps: MoveDeps): void {
  const group = planGroup(program);
  const move = writeOptions(
    group.command('move').arguments('<elements...>').description(
      'Move plan elements to the end of a new parent; every reference and wireframe file follows; code never moves; all or nothing. ' +
        'Elements and parent are found by uid, fqn, id or name; several elements land in the order given. ' +
        'Mentions in docs, the board, comments and strings are listed, never edited. Dry run unless --yes',
    ),
  )
    .requiredOption('--parent <target>', '(required) uid, fqn, id or name of the new parent')
    .action((elements: string[], opts: Opts) => {
      runAction(opts, 'move', () => emitResult(opts, withQuietLogs(() => runMove(elements, opts, deps))));
    });
  addExamples(move, [
    'c4mp plan move app.api.orders --parent app.api.logic --repo .           dry run',
    'c4mp plan move orders billing --parent logic --repo . --yes',
    'c4mp plan move 3f2a... --parent 9b1c... --repo . --json --no-mentions',
  ]);

  const rename = writeOptions(
    group.command('rename').arguments('<element> <new-id>').description(
      'Give a plan element a new id; every reference and wireframe file follows; code never moves. ' +
        'The element is found by uid, fqn, id or name. ' +
        'Mentions in docs, the board, comments and strings are listed, never edited. Dry run unless --yes',
    ),
  ).action((element: string, newId: string, opts: Opts) => {
    runAction(opts, 'rename', () => emitResult(opts, withQuietLogs(() => runRename(element, newId, opts, deps))));
  });
  addExamples(rename, [
    'c4mp plan rename app.api.orders ordering --repo .                       dry run',
    'c4mp plan rename 3f2a... ordering --repo . --yes',
  ]);
}
