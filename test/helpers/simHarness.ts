import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerSimCommands } from '../../src/cli/sim';
import { simFileFor } from '../../src/sim/load';
import { requireProject } from '../../src/outputs';
import { makeRepo, writeSource } from './planEditHarness';
import type { CliRun } from './planEditHarness';

/** In-process runner of `c4pm sim ...` (registerSimCommands only), as runBoardCli. */
export async function runSimCli(args: string[]): Promise<CliRun> {
  const program = new Command();
  program.exitOverride();
  registerSimCommands(program);
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'c4pm', 'sim', ...args]);
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

/** A small shop plan: a person, a screen with a control, a component with a planned function, a store with records. */
export const SIM_PLAN = `model {
  customer = person 'Customer' {
    metadata { uid 'u-person' }
  }
  shop = system 'Shop' {
    web = container 'Shop web' {
      metadata { uid 'u-web' }
      products = screen 'Products' {
        metadata { uid 'u-products' }
        add = control 'Add to cart button' {
          metadata { uid 'u-add' }
        }
      }
      login = screen 'Login' {
        metadata { uid 'u-login' }
      }
    }
    api = container 'Shop api' {
      metadata { uid 'u-api' }
      cart = component 'Cart service' {
        link ../../../../src/cart.ts
        metadata {
          uid 'u-cartsvc'
          owner 'K'
        }
        addItem = function 'addItem' {
          metadata {
            status 'planned'
            signature 'addItem(id: string): void'
          }
        }
      }
      db = store 'Shop db' {
        orders = record 'orders' {
          metadata { uid 'u-orders' }
        }
      }
    }
  }
}
`;

/** Code the plan does not name: a code target `src/cart.ts#total`. */
export const SIM_CODE = { 'src/cart.ts': 'export function addItem(id: string): void {}\nexport function total(): number { return 0; }\n' };

export interface SimRepo { root: string; file: (id: string) => string; read: (id: string) => Record<string, unknown> }

/** Tmp repo with SIM_PLAN, SIM_CODE and one `sim/<id>.json` per entry of `sims` (`schemaVersion: 1` and the id added; a string is written as is). */
export function makeSimRepo(prefix: string, sims: Record<string, Record<string, unknown> | string> = {}): SimRepo {
  const { root, planDir } = makeRepo(prefix, { 'shop.c4': SIM_PLAN });
  for (const [rel, text] of Object.entries(SIM_CODE)) writeSource(root, planDir, rel, text);
  const project = requireProject(root);
  const file = (id: string): string => simFileFor(project, id);
  for (const [id, body] of Object.entries(sims)) {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), typeof body === 'string' ? body : JSON.stringify({ schemaVersion: 1, id, ...body }, null, 2) + '\n');
  }
  return { root, file, read: (id) => JSON.parse(fs.readFileSync(file(id), 'utf8')) as Record<string, unknown> };
}
