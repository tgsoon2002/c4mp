/**
 * T5b (b701): `c4mp sim list|show|add|set|remove|step add|set|remove|move|stage add|remove|apply`. One module registers
 * itself with ONE call from bin/cli.ts (after the board commands). Reads go through the Query layer (src/query/sim.ts),
 * writes through Simulation editing (src/services/simEdit.ts, every rule lives there) and are printed by
 * runGuardedWrite (common.ts): dry run unless --yes, `--json` = one object `{ok, command, dryRun, written, file, changes,
 * minted?, error}` (src/query/guardedWrite.ts, the same builder as MCP), errors `error: <code>: <message>` on stderr,
 * exit 1 through process.exitCode, never process.exit.
 * The commander options map 1:1 onto the service's SimFlags keys (camelCase of the flag): target, view, state,
 * caption, duration, rowsFile, callFrom, callTo, callLabel, reply, name, from, channel, flow, outside, goal, title,
 * description, person, kind, to.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { addExamples, addRepo, collectValues as collect } from '../cliHelp';
import { listSims, showSim, simReadError } from '../query/sim';
import type { SimRef, SimShow, SimStageShow, SimStepShow } from '../query/sim';
import { addSim, applySimFile, editSimStage, editSimStep, removeSim, setSim, upgradeSims } from '../services/simEdit';
import type { SimOpOutcome } from '../services/simEdit';
import { planNoScan } from '../scan/planScan';
import { emitError, emitFailure, runGuardedWrite } from './common';
import type { Opts } from './common';

const YES_TEXT = 'write the change; without it only the change is printed';
const JSON_TEXT = 'print one JSON object instead of text';
const NONE_NOTE = ', or none to clear it';
const OWNER_TEXT = "owner of code a ref adds to the plan (a done function under the component that owns its file); default: that component's owner";

const setExit = (code: number): void => { process.exitCode = code; };

/** A whole number typed on the command line (`<n>`, `--at`); a refusal message otherwise. Ranges are the service's. */
function wholeNumber(v: string, what: string): number | string {
  return /^\s*-?\d+\s*$/.test(v) ? Number(v) : `${what} '${v}' must be a whole number`;
}

/** Run one Simulation editing write, printed by runGuardedWrite. `at` = a typed position (or undefined); a bad one is refused before the service runs. */
function simWrite(opts: Opts, command: string, at: { value: string | undefined; what: string }, op: (repo: string, yes: boolean, n: number | null) => SimOpOutcome): number {
  let n: number | null = null;
  if (at.value !== undefined) {
    const parsed = wholeNumber(at.value, at.what);
    if (typeof parsed === 'string') return emitFailure(opts, command, parsed);
    n = parsed;
  }
  return runGuardedWrite(opts, command, (repo, yes) => op(repo, yes, n));
}

const NO_AT = { value: undefined, what: '' };

// ---------- text of list / show ----------

function refText(r: SimRef): string {
  const x = r.resolved;
  if (!x) return `${r.ref} (missing)`;
  if (x.kind === 'code') return `${r.ref} (code)`;
  return r.ref === x.fqn ? `${r.ref} (${x.kind} '${x.title}')` : `${r.ref} (${x.kind} ${x.fqn} '${x.title}')`;
}

function stepFieldLines(s: Partial<Omit<SimStepShow, 'n'>> & { from?: string; channel?: string; goal?: string }, indent: string): string[] {
  const out: string[] = [];
  if (s.goal !== undefined) out.push(`${indent}goal: ${s.goal}`);
  if (s.from !== undefined) out.push(`${indent}from: ${s.from}`);
  if (s.channel !== undefined) out.push(`${indent}channel: ${s.channel}`);
  if (s.call) {
    const c = s.call;
    const parts = [c.from ? `from ${refText(c.from)}` : '', c.to ? `to ${refText(c.to)}` : '', c.label !== undefined ? `label '${c.label}'` : '', c.reply ? 'reply' : ''].filter(Boolean);
    out.push(`${indent}call: ${parts.join(', ') || '(derived)'}`);
  }
  if (s.state !== undefined) out.push(`${indent}state: ${s.state}`);
  for (const r of s.rows ?? []) out.push(`${indent}rows ${refText(r.record)}: ${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`);
  if (s.caption !== undefined) out.push(`${indent}caption: ${s.caption}`);
  if (s.durationSec !== undefined) out.push(`${indent}duration: ${s.durationSec} s`);
  return out;
}

function stageHead(st: SimStageShow): string {
  const name = st.name !== undefined ? ` '${st.name}'` : '';
  if (st.form === 'flow') return `  ${st.n}${name}  flow ${st.flow!.id}${st.flow!.title !== null ? ` ('${st.flow!.title}')` : ' (missing)'}`;
  if (st.form === 'outside') return `  ${st.n}${name}  outside: ${st.outside}`;
  return `  ${st.n}${name}  ${st.view}  ${(st.targets ?? []).map(refText).join(', ')}`;
}

function showLines(s: SimShow): string[] {
  const out = [`${s.id}  ${s.kind}  ${s.title}`, `file:        ${s.file}`];
  if (s.person) out.push(`person:      ${s.person.resolved ? refText(s.person) : s.person.ref}`);   // free text unless it names a plan person
  if (s.description !== undefined) out.push(`description: ${s.description}`);
  if (s.steps) {
    out.push(s.steps.length > 0 ? 'steps:' : `steps:       none yet (c4mp sim step add ${s.id} --target <ref> ...)`);
    for (const st of s.steps) out.push(`  ${st.n}  ${st.view}  ${st.targets.map(refText).join(', ')}`, ...stepFieldLines(st, '       '));
  }
  if (s.stages) {
    out.push(s.stages.length > 0 ? 'stages:' : `stages:      none yet (c4mp sim stage add ${s.id} --outside <text> | --flow <s-id> | --target <ref>)`);
    for (const st of s.stages) out.push(stageHead(st), ...stepFieldLines(st, '       '));
  }
  for (const n of s.notes ?? []) out.push(`note: ${n}`);
  return out;
}

// ---------- read commands ----------

function runList(opts: Opts): number {
  const repoRoot = path.resolve(opts.repo as string);
  const listed = listSims(repoRoot, planNoScan(repoRoot), { kind: typeof opts.kind === 'string' ? opts.kind : undefined });
  if ('error' in listed) return emitError(opts, 'sim list', simReadError('sim list', listed).error);
  if (opts.json) {
    console.log(JSON.stringify(listed, null, 2));
    return 0;
  }
  if (listed.sims.length === 0) {
    console.log(opts.kind !== undefined ? 'no matching s-items' : 'no s-items (c4mp sim add --repo R --kind flow --title T --yes starts one)');
  }
  for (const s of listed.sims) {
    const count = s.kind === 'flow' ? `${s.steps} step${s.steps === 1 ? '' : 's'}` : `${s.stages} stage${s.stages === 1 ? '' : 's'}`;
    console.log([s.id, s.kind, s.title, `(${count})`, ...(s.person ? [`person ${s.person.ref}`] : [])].join('  '));
  }
  for (const [label, list] of [['issues (files not loaded)', listed.issues], ['notes', listed.notes]] as const) {
    if (list.length === 0) continue;
    console.log(`${label}:`);
    for (const i of list) console.log(`  ${i.file ? `${i.file}: ` : ''}${i.message}`);
  }
  return 0;
}

function runShow(id: string, opts: Opts): number {
  const repoRoot = path.resolve(opts.repo as string);
  const shown = showSim(repoRoot, planNoScan(repoRoot), id);
  if ('error' in shown) return emitError(opts, 'sim show', simReadError('sim show', shown).error);
  if (opts.json) console.log(JSON.stringify(shown, null, 2));
  else console.log(showLines(shown).join('\n'));
  return 0;
}

/** `sim apply <file.json>`: read like `board add --from-file` (missing file or bad JSON = one failure), then one guarded write. */
function runApply(file: string, opts: Opts): number {
  const command = 'sim apply';
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return emitFailure(opts, command, `no such file: ${abs}`);
  let spec: unknown;
  try {
    spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return emitFailure(opts, command, `${abs} is not valid JSON (${(err as Error).message})`);
  }
  const owner = typeof opts.owner === 'string' ? opts.owner : undefined;
  return runGuardedWrite(opts, command, (repo, yes) => applySimFile(repo, spec, yes, owner));
}

/** A read command body: an unexpected throw (no project, unreadable plan) becomes `error: invalid: ...`, exit 1. */
function read(opts: Opts, command: string, body: () => number): void {
  try {
    setExit(body());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setExit(emitError(opts, command, simReadError(command, { error: message }, 'invalid').error));
  }
}

// ---------- options shared by step add / step set / stage add ----------

type ReplyForm = 'flag' | 'value';

/** The step flags (target, view, call, state, caption, duration, rows). `set` adds ", or none" to the texts; `reply` is a plain flag on add and `--reply [none]` on set. */
function stepOptions(cmd: Command, mode: 'add' | 'set', reply: ReplyForm, rows = true): Command {
  const none = mode === 'set' ? NONE_NOTE : '';
  cmd
    .option('--target <ref>', `c-item uid, fqn, id or name, or a code target path#name (added to the plan when it is not there); stored as a uid; repeat for several targets${mode === 'set' ? ' (replaces the targets)' : ''}`, collect)
    .option('--owner <name>', OWNER_TEXT)
    .option('--view <view>', `arch, io or storage${mode === 'add' ? ' (default: the view of the first target; a code target is arch)' : ''}`)
    .option('--call-from <ref>', `the arrow's sender: a ref like --target (default: the previous step's lane)${none}`)
    .option('--call-to <ref>', `the arrow's receiver: a ref like --target (default: the first target)${none}`)
    .option('--call-label <text>', `the arrow's label${none}`);
  if (reply === 'flag') cmd.option('--reply', 'the arrow is a reply (a return arrow)');
  else cmd.option('--reply [none]', 'the arrow is a reply; --reply none (or false) clears it');
  cmd
    .option('--state <text>', `the state after this step (free text)${none}`)
    .option('--caption <text>', `1-2 sentences shown with the step${none}`)
    .option('--duration <sec>', `seconds the step shows when the page plays (> 0)${none}`);
  if (rows) cmd.option('--rows-file <json>', `a JSON file {"<record ref>": [rows]}: the sample rows of each record after the step${none}`);
  return cmd;
}

/** Register `c4mp sim` and its subcommands. Call after registerBoardCommands in bin/cli.ts. */
export function registerSimCommands(program: Command): void {
  const sim = program
    .command('sim')
    .description(
      'Simulations (s-items): flows (ordered steps across the io, arch and storage views) and journeys (stages: a flow, ' +
        'an outside event or one step). One file each in .c4mp/projects/<repoId>/sim/s-<N>.json. Run c4mp sim <command> --help for details',
    );

  const listCmd = addRepo(sim.command('list'))
    .description('List the s-items: id, kind, title, steps or stages, person; then the files that do not parse. Read-only: writes nothing')
    .option('--kind <kind>', 'only flow or only journey')
    .option('--json', 'print one JSON object { sims, issues, notes } instead of text')
    .action((opts: Opts) => read(opts, 'sim list', () => runList(opts)));
  addExamples(listCmd, ['c4mp sim list --repo .', 'c4mp sim list --repo . --kind journey --json']);

  const showCmd = addRepo(sim.command('show <id>'))
    .description('Show one s-item: every step or stage with its targets, call ends and rows records resolved against the plan (kind, fqn, title; a code target path#name shows as code, a ref nothing names as missing). Read-only: writes nothing')
    .option('--json', JSON_TEXT)
    .action((id: string, opts: Opts) => read(opts, 'sim show', () => runShow(id, opts)));
  addExamples(showCmd, ['c4mp sim show s-1 --repo .', 'c4mp sim show s-1 --repo . --json']);

  const addCmd = addRepo(sim.command('add'))
    .description('Start a new s-item with the next id (s-<max+1>, printed), no steps or stages yet. Prints it (dry run) and writes only with --yes')
    .option('--kind <kind>', '(required) flow or journey')
    .option('--title <text>', '(required) title')
    .option('--description <text>', 'description')
    .option('--person <text>', 'who acts (free text; when it names a plan person, the page links it)')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((opts: Opts) => setExit(simWrite(opts, 'sim add', NO_AT, (repo, yes) => addSim(repo, { ...opts, yes }))));
  addExamples(addCmd, [
    'c4mp sim add --repo . --kind flow --title "Buy a product" --person customer        show the item',
    'c4mp sim add --repo . --kind flow --title "Buy a product" --person customer --yes  write it',
  ]);

  const setCmd = addRepo(sim.command('set <id>'))
    .description('Change the title, description or person of an s-item (none clears description and person). Prints the change (dry run) and writes only with --yes')
    .option('--title <text>', 'new title')
    .option('--description <text>', `new description${NONE_NOTE}`)
    .option('--person <text>', `who acts${NONE_NOTE}`)
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, opts: Opts) => setExit(simWrite(opts, 'sim set', NO_AT, (repo, yes) => setSim(repo, id, { ...opts, yes }))));
  addExamples(setCmd, ['c4mp sim set s-1 --repo . --person none --yes']);

  const removeCmd = addRepo(sim.command('remove <id>'))
    .description('Remove an s-item (its file). Refused while a journey stage names it (they are listed). Prints the change (dry run) and writes only with --yes')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, opts: Opts) => setExit(simWrite(opts, 'sim remove', NO_AT, (repo, yes) => removeSim(repo, id, yes))));
  addExamples(removeCmd, ['c4mp sim remove s-3 --repo .', 'c4mp sim remove s-3 --repo . --yes']);

  // ----- step -----
  const step = sim.command('step').description('The steps of a flow: add, set, remove or move one. Run c4mp sim step <command> --help for details');

  const stepAdd = stepOptions(addRepo(step.command('add <id>')), 'add', 'flag')
    .description('Add a step to a flow (last, or at --at). Each ref is resolved and stored as the uid of its plan element; code not in the plan yet is first added to it (--owner). Prints the step (dry run) and writes only with --yes')
    .option('--at <n>', 'the new step number (default: last)')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, opts: Opts) => setExit(simWrite(opts, 'sim step add', { value: opts.at as string | undefined, what: '--at' },
      (repo, yes, at) => editSimStep(repo, id, 'add', at, opts, yes))));
  addExamples(stepAdd, [
    'c4mp sim step add s-1 --target shop.web.product.add --state "cart: empty" --repo .',
    'c4mp sim step add s-1 --target api/src/cart.ts#addItem --call-label "POST /cart/items" --repo . --yes',
    'c4mp sim step add s-1 --target orders --view storage --rows-file rows.json --at 3 --repo . --yes',
  ]);

  const stepSet = stepOptions(addRepo(step.command('set <id> <n>')), 'set', 'value')
    .description('Change step <n> of a flow: only the named fields change; none clears an optional field. Prints the change (dry run) and writes only with --yes')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, n: string, opts: Opts) => setExit(simWrite(opts, 'sim step set', { value: n, what: 'step number' },
      (repo, yes, at) => editSimStep(repo, id, 'set', at, opts, yes))));
  addExamples(stepSet, ['c4mp sim step set s-1 2 --caption "The buyer pays." --duration none --repo . --yes', 'c4mp sim step set s-1 4 --reply none --repo .']);

  const stepRemove = addRepo(step.command('remove <id> <n>'))
    .description('Remove step <n> of a flow. Prints the change (dry run) and writes only with --yes')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, n: string, opts: Opts) => setExit(simWrite(opts, 'sim step remove', { value: n, what: 'step number' },
      (repo, yes, at) => editSimStep(repo, id, 'remove', at, opts, yes))));
  addExamples(stepRemove, ['c4mp sim step remove s-1 3 --repo . --yes']);

  const stepMove = addRepo(step.command('move <id> <n>'))
    .description('Move step <n> of a flow to position --to. Prints the change (dry run) and writes only with --yes')
    .option('--to <m>', '(required) the new step number')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, n: string, opts: Opts) => setExit(simWrite(opts, 'sim step move', { value: n, what: 'step number' },
      (repo, yes, at) => editSimStep(repo, id, 'move', at, opts, yes))));
  addExamples(stepMove, ['c4mp sim step move s-1 5 --to 2 --repo . --yes']);

  // ----- stage -----
  const stage = sim.command('stage').description('The stages of a journey: add or remove one. Run c4mp sim stage <command> --help for details');

  const stageAdd = stepOptions(
    addRepo(stage.command('add <id>'))
      .option('--flow <s-id>', 'a flow stage: the s-item of a flow')
      .option('--outside <text>', 'an outside stage: what happens outside the system (an email, a call, ...)'),
    'add', 'flag', false,
  )
    .description('Add a stage to a journey (last, or at --at): exactly one of --flow, --outside or --target (an inline step). Prints the stage (dry run) and writes only with --yes')
    .option('--name <text>', 'the stage name (default in the page: Stage N)')
    .option('--goal <text>', "the person's goal in this stage")
    .option('--from <text>', 'outside stage: who sends it (free text)')
    .option('--channel <text>', 'outside stage: how it arrives (email, phone, letter, chat, ...)')
    .option('--at <n>', 'the new stage number (default: last)')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, opts: Opts) => setExit(simWrite(opts, 'sim stage add', { value: opts.at as string | undefined, what: '--at' },
      (repo, yes, at) => editSimStage(repo, id, 'add', at, opts, yes))));
  addExamples(stageAdd, [
    'c4mp sim stage add s-2 --name Discover --outside "Spring sale email" --from "Newsletter tool" --channel email --repo .',
    'c4mp sim stage add s-2 --name Buy --flow s-1 --goal "Buy the mug" --repo . --yes',
    'c4mp sim stage add s-2 --target shop.web.login --goal "Sign in" --at 2 --repo . --yes',
  ]);

  const stageRemove = addRepo(stage.command('remove <id> <n>'))
    .description('Remove stage <n> of a journey. Prints the change (dry run) and writes only with --yes')
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((id: string, n: string, opts: Opts) => setExit(simWrite(opts, 'sim stage remove', { value: n, what: 'stage number' },
      (repo, yes, at) => editSimStage(repo, id, 'remove', at, opts, yes))));
  addExamples(stageRemove, ['c4mp sim stage remove s-2 3 --repo . --yes']);

  // ----- apply -----
  const applyCmd = addRepo(sim.command('apply <file>'))
    .description(
      'Write many s-items in ONE guarded write from a JSON file {"sims": [ ... ]}: an entry without an id is new (next ids in ' +
        'file order; "ref" names it, a stage "flowRef" points at it), an entry with an id replaces that s-item whole. ' +
        'Every ref is resolved; one bad entry refuses the whole file. Refs are stored as uids; code not in the plan yet is added to it in the same write. ' +
        'Prints the change (dry run) and writes only with --yes',
    )
    .option('--owner <name>', OWNER_TEXT)
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((file: string, opts: Opts) => setExit(runApply(file, opts)));
  addExamples(applyCmd, ['c4mp sim apply sims.json --repo .', 'c4mp sim apply sims.json --repo . --yes --json']);

  // ----- upgrade -----
  const upgradeCmd = addRepo(sim.command('upgrade'))
    .description('Store every ref of every s-item as a uid (b899): an fqn or a code path#name becomes the uid of its plan element; code not in the plan yet is first added to it. One write of the plan and the s-items. Prints the change (dry run) and writes only with --yes')
    .option('--owner <name>', OWNER_TEXT)
    .option('--yes', YES_TEXT)
    .option('--json', JSON_TEXT)
    .action((opts: Opts) => setExit(simWrite(opts, 'sim upgrade', NO_AT, (repo, yes) => upgradeSims(repo, { ...opts, yes }))));
  addExamples(upgradeCmd, ['c4mp sim upgrade --repo . --owner K', 'c4mp sim upgrade --repo . --owner K --yes']);
}
