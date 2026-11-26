import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerSimCommands } from '../src/cli/sim';

// T5b (b701): every flag the AI guide names in its `c4pm sim ...` command table exists in that command's --help, every
// sim command has a row, and the Document copy equals the shipped guide (as guide-board-flags.test.ts for the board).

const program = new Command();
registerSimCommands(program);
const sim = program.commands.find((c) => c.name() === 'sim')!;

/** `list` -> its help; `step add` -> the help of `add` under `step`. */
function helpOf(name: string): string {
  let cmd: Command = sim;
  for (const part of name.split(' ')) cmd = cmd.commands.find((c) => c.name() === part)!;
  return cmd.helpInformation();
}
const COMMANDS = ['list', 'show', 'add', 'set', 'remove', 'apply', 'upgrade', 'step add', 'step set', 'step remove', 'step move', 'stage add', 'stage remove'];

const read = (p: string): string => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const flagsOf = (text: string): string[] => [...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);
const ROW = /`c4mp sim ((?:step |stage )?[a-z]+)([^`]*)`/g;

describe('ai guide: the sim command table', () => {
  const text = read('../guide/ai.md');
  const rows = text.split('\n').filter((l) => l.startsWith('| `c4mp sim '));

  it('names only flags that exist on the command of each row', () => {
    let seen = 0;
    for (const line of rows) {
      const cell = line.split(' | ')[0];
      for (const m of cell.matchAll(ROW)) {
        seen++;
        const help = helpOf(m[1]);
        for (const flag of flagsOf(m[2])) expect([m[1], flag, help.includes(flag)]).toEqual([m[1], flag, true]);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(COMMANDS.length);
  });

  it('has a row for every sim command', () => {
    const named = new Set(rows.flatMap((l) => [...l.split(' | ')[0].matchAll(ROW)].map((m) => m[1])));
    expect([...named].sort()).toEqual([...COMMANDS].sort());
  });

  // The Document folder is private: the test skips in the public tree (b963).
  (fs.existsSync(path.resolve(__dirname, '../../Document/C4MP-AI-Guide.md')) ? it : it.skip)('the Document copy is identical', () => {
    expect(read('../../Document/C4MP-AI-Guide.md')).toBe(text);
  });
});
