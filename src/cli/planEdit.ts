/**
 * P18-T10: registers the plan-editing commands (Phase 18 part A). Each task T11..T16 appends one
 * `registerX(program, deps)` line below. bin/cli.ts calls this once.
 */
import type { Command } from 'commander';
import type { PlanEditDeps } from './common';
import { registerTreeCommand } from './treeCmd';
import { registerUnplannedCommand } from './unplannedCmd';
import { registerAddCommand } from './addCmd';
import { registerSetCommand } from './setCmd';
import { registerLinkCommand, registerUnlinkCommand } from './linkCmd';
import { registerRelateCommand } from './relateCmd';
import { registerWireframeCommand } from './wireframeCmd';

export function registerPlanEditCommands(program: Command, deps: PlanEditDeps): void {
  registerTreeCommand(program, deps);
  registerUnplannedCommand(program, deps);
  registerAddCommand(program, deps);
  registerSetCommand(program, deps);
  registerLinkCommand(program, deps);
  registerUnlinkCommand(program, deps);
  registerRelateCommand(program, deps);
  registerWireframeCommand(program, deps);
}
