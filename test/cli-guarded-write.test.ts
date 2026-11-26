import { runGuardedWrite } from '../src/cli/common';
import type { GuardedOutcome } from '../src/cli/common';

// T5a (b699): the generic guarded-write printer, with a fake operation (no board, no files).

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  jest.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  jest.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m)); });
});
afterEach(() => jest.restoreAllMocks());

const done = (changed = true, minted?: unknown[]): GuardedOutcome => ({ result: { lines: ['change one', 'change two'], minted }, file: 'x/board.json', changed, written: false });

describe('runGuardedWrite', () => {
  test('dry run prints the lines and the hint, passes yes=false', () => {
    let seen: [string, boolean] | undefined;
    const code = runGuardedWrite({ repo: '.' }, 'cmd', (repo, yes) => { seen = [repo, yes]; return done(); });
    expect(code).toBe(0);
    expect(seen?.[1]).toBe(false);
    expect(out).toEqual(['change one', 'change two', 'dry run: nothing written. Add --yes to apply.']);
  });

  test('--yes prints the lines and the written file', () => {
    const code = runGuardedWrite({ repo: '.', yes: true }, 'cmd', () => done());
    expect(code).toBe(0);
    expect(out[out.length - 1]).toBe('written: x/board.json');
  });

  test('nothing changed prints one line', () => {
    expect(runGuardedWrite({ repo: '.' }, 'cmd', () => done(false))).toBe(0);
    expect(out).toEqual(['nothing to change']);
  });

  test('--json prints one object, minted only when the result has it', () => {
    runGuardedWrite({ repo: '.', json: true }, 'cmd', () => done());
    const plain = JSON.parse(out.join('\n'));
    expect(plain).toEqual({ ok: true, command: 'cmd', dryRun: true, written: false, file: 'x/board.json', changes: ['change one', 'change two'], error: null });
    out = [];
    runGuardedWrite({ repo: '.', json: true }, 'cmd', () => done(true, [{ id: 'b1' }]));
    expect(JSON.parse(out.join('\n')).minted).toEqual([{ id: 'b1' }]);
  });

  test('a refusal and a thrown error become one failure (exit 1, code from the message)', () => {
    expect(runGuardedWrite({ repo: '.' }, 'cmd', () => ({ error: "no item 'b9'", reasons: ['r1'] }))).toBe(1);
    expect(err).toEqual(["error: not-found: no item 'b9'\n  - r1"]);
    err = [];
    expect(runGuardedWrite({ repo: '.', json: true }, 'cmd', () => { throw new Error('rolled back: bad\nline two'); })).toBe(1);
    const j = JSON.parse(out.join('\n'));
    expect(j.error).toEqual({ code: 'rolled-back', message: 'rolled back: bad', reasons: ['line two'] });
    expect(j.ok).toBe(false);
  });
});
