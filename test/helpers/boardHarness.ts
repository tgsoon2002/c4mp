import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerBoardCommands } from '../../src/cli/board';
import { boardFileFor } from '../../src/board/load';
import { requireProject } from '../../src/outputs';
import { makeRepo } from './planEditHarness';
import type { CliRun } from './planEditHarness';

/** In-process runner of `c4pm board ...` (registerBoardCommands only). */
export async function runBoardCli(args: string[]): Promise<CliRun> {
  const program = new Command();
  program.exitOverride();
  registerBoardCommands(program);
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'c4pm', 'board', ...args]);
  } catch (e) {
    err.push(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { stdout: out.join('\n'), stderr: err.join('\n'), code };
}

export const PLAN_WITH_UIDS = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' { metadata { uid 'u-api' status 'in-progress' owner 'K' } }",
  "    web = container 'Web' { metadata { uid 'u-web' } }",
  '  }',
  '}',
  '',
].join('\n');

const item = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

/** Two boards, nesting, dependsOn (also across boards), a custom group, an overdue item and a dead link. */
export const START_BOARD = {
  schemaVersion: 1,
  boards: [
    { id: 'main', name: 'Main',
      groups: [{ id: 'planned', name: 'Planned', status: 'planned' }, { id: 'triage', name: 'Needs triage' }],
      items: [
        item('b1', { kind: 'feature', owner: 'K', links: ['u-api', 'u-gone'], due: '2020-01-01' }),
        item('b2', { parent: 'b1', dependsOn: ['b3'], links: ['u-api'] }),
        item('b3', { parent: 'b1' }),
        item('b4', { group: 'triage' }),
        item('b5'),
      ] },
    { id: 'other', name: 'Other', items: [item('b6', { dependsOn: ['b5'], links: ['u-web'] })] },
  ],
};

export interface BoardRepo { root: string; file: string; text: () => string }

/** Tmp repo with a plan (uids u-api, u-web) and, unless `board` is null, `board/board.json`. */
export function makeBoardRepo(prefix: string, board: unknown = START_BOARD): BoardRepo {
  const repo = makeRepo(prefix, { 'a.c4': PLAN_WITH_UIDS });
  const file = boardFileFor(requireProject(repo.root));
  if (board !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(board, null, 2) + '\n');
  }
  return { root: repo.root, file, text: () => fs.readFileSync(file, 'utf8') };
}
