import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerBoardCommands } from '../src/cli/board';

// P16-B44: every flag the guides name for `board add` / `board set` exists in that command's --help, and the
// Document copies equal the shipped copies.

const board = new Command();
registerBoardCommands(board);
const boardCmd = board.commands.find((c) => c.name() === 'board')!;
const helpOf = (name: string): string => boardCmd.commands.find((c) => c.name() === name)!.helpInformation();
const HELP: Record<string, string> = { add: helpOf('add'), set: helpOf('set') };

const read = (p: string): string => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const flagsOf = (text: string): string[] => [...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);

describe('guides name only flags that exist', () => {
  const guides: [string, string][] = [['board guide', read('../guide/board.md')], ['ai guide', read('../guide/ai.md')]];

  it.each(guides)('%s: flags in the `board add` / `board set` table rows are in that command help', (_n, text) => {
    let rows = 0;
    for (const line of text.split('\n')) {
      const m = /^\| `c4mp board (add|set) ([^`]*)`/.exec(line) ?? /^\| `board (add|set) ([^`]*)`/.exec(line);
      if (!m) continue;
      rows++;
      for (const flag of flagsOf(m[2])) expect(HELP[m[1]]).toContain(flag);
    }
    expect(rows).toBeGreaterThanOrEqual(3);
  });

  it('board guide: every row of the flag table names a flag of the commands it lists', () => {
    const text = guides[0][1];
    const flagRows = text.split('\n').filter((l) => /^\| `--[a-z-]+/.test(l));
    expect(flagRows.length).toBeGreaterThanOrEqual(8);
    for (const line of flagRows) {
      const cells = line.split('|').map((c) => c.trim());
      const flag = flagsOf(cells[1])[0];
      const commands = cells[2].split(',').map((c) => c.trim());
      for (const c of commands) expect(HELP[c]).toContain(flag);
    }
  });

  it('the new flags exist on add, and on set (with --add-doc only on set)', () => {
    for (const f of ['--description', '--description-file', '--doc', '--outcome', '--size', '--sprint', '--priority', '--tags']) {
      expect(HELP.add).toContain(f);
      expect(HELP.set).toContain(f);
    }
    expect(HELP.set).toContain('--add-doc');
    expect(HELP.add).not.toContain('--add-doc');
    for (const f of ['--append-description', '--append-description-file', '--prepend-description', '--prepend-description-file',   // b440
      '--add-tag', '--remove-tag', '--add-depends', '--remove-depends', '--remove-doc']) {   // b441
      expect(HELP.set).toContain(f);
      expect(HELP.add).not.toContain(f);
    }
  });
});

describe('guide copies', () => {
  // The Document folder is private: the test skips in the public tree (b963).
  (fs.existsSync(path.join(__dirname, '../../Document/C4MP-Board-Guide.md')) ? it : it.skip)('Project/guide/board.md and ai.md equal their Document files', () => {
    expect(read('../guide/board.md')).toBe(read('../../Document/C4MP-Board-Guide.md'));
    expect(read('../guide/ai.md')).toBe(read('../../Document/C4MP-AI-Guide.md'));
  });
});
