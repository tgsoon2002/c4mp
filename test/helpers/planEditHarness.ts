import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { registerPlanEditCommands } from '../../src/cli/planEdit';
import { registerMoveCommands } from '../../src/cli/moveCmd';
import { planMoveService } from '../../src/services/planMove';
import { requireProject } from '../../src/outputs';

/** In-process runner of the plan-edit commands: stdout, stderr and exit code of one `c4pm <args>` call. */
export interface CliRun { stdout: string; stderr: string; code: number }

export async function runPlanCli(args: string[]): Promise<CliRun> {
  const program = new Command();
  program.exitOverride();
  const buildCliConfig = (opts: Record<string, unknown>) => ({
    ...(opts.lang ? { languages: String(opts.lang).split(',') } : {}),
    ...(opts.ignore ? { ignore: String(opts.ignore).split(',') } : {}),
  });
  registerPlanEditCommands(program, { buildCliConfig });
  registerMoveCommands(program, { buildCliConfig, planMove: planMoveService });   // as bin/cli.ts
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'c4pm', ...args]);
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

/** Tmp repo with `.git` and the given plan files written into the project plan folder. */
export function makeRepo(prefix: string, plans: Record<string, string>): { root: string; planDir: string; files: Record<string, string> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(root, '.git'));
  const planDir = requireProject(root).planDir;
  fs.mkdirSync(planDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(plans)) {
    files[name] = path.join(planDir, name);
    fs.writeFileSync(files[name], text);
  }
  return { root, planDir, files };
}

/** Write a repo file (creating folders) and return the link text that points at it from the plan folder. */
export function writeSource(root: string, planDir: string, rel: string, text: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return path.relative(planDir, abs).split(path.sep).join('/');
}

/** Every file under `dir` as `relative:size` (directories as `relative:d`), for before/after listings. */
export function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      out.push(`${path.relative(dir, p)}:${n.isFile() ? fs.statSync(p).size : 'd'}`);
      if (n.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
