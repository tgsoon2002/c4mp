/**
 * b252: the `c4mp plan` group (c-items, plan/*.c4), the way `c4mp board` groups b-items.
 * Every plan command is defined ONCE, through registerPlanCommand: it lands under `plan` and also as a hidden
 * top-level alias with the old name, which prints one stderr note and then runs the very same command (none with noAlias).
 */
import { Command } from 'commander';

export interface PlanCommandSpec {
  /** Name under `plan`. */
  name: string;
  /** Positional arguments, as in `.arguments()`, e.g. '<kind> <name>'. */
  args?: string;
  /** Old top-level name when it differs from `name` (generate-c4, element). */
  old?: string;
  /** Old arguments when they differ from `args` (element <target> is plan show [target]). */
  oldArgs?: string;
  /** Run when `plan` is called with no subcommand (`c4mp plan --repo .`). */
  isDefault?: boolean;
  /** b456: a new command with no old top-level name: no hidden alias (plan upgrade). */
  noAlias?: true;
}

/** The `plan` command of `program`, created on first use so every file can register into it. */
export function planGroup(program: Command): Command {
  return (
    program.commands.find(c => c.name() === 'plan') ??
    program
      .command('plan')
      .description(
        'The plan: containers, components and planned code in the .c4 files. ' +
          'Show it, edit it, link it to code and draw it. ' +
          'Run c4mp plan <command> --help for details. Without a command it runs plan show',
      )
  );
}

/**
 * Register one plan command. `build` adds description, options, action and examples to the fresh command and is
 * called once per name (new and old), so the two can never differ. The old name is hidden from --help.
 */
export function registerPlanCommand(program: Command, spec: PlanCommandSpec, build: (cmd: Command) => Command): void {
  const group = planGroup(program);
  const make = (parent: Command, name: string, args: string | undefined, opts: { isDefault?: boolean; hidden?: boolean }): Command => {
    const cmd = parent.command(name, opts);
    if (args) cmd.arguments(args);
    return build(cmd);
  };
  make(group, spec.name, spec.args, { isDefault: spec.isDefault });
  if (spec.noAlias) return;
  const old = make(program, spec.old ?? spec.name, spec.oldArgs ?? spec.args, { hidden: true });
  old.hook('preAction', () => console.error(`note: 'c4mp ${old.name()}' is now 'c4mp plan ${spec.name}'`));
}
