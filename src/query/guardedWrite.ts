/**
 * T5b (b701): the ONE JSON object of a guarded write (board and sim writes; `--json` of the CLI and, from T6b, the MCP
 * write tools), so the CLI and MCP texts are byte-identical by construction. Pure: no file, no console.
 * Lives in the Query layer (L3) so both entry points (src/cli, src/mcp) reach it without an L4 -> L4 import, and with
 * no import of src/services (services import query: a same-layer cycle otherwise). The outcome shape is structural:
 * BoardOpOutcome and SimOpOutcome (services) fit it.
 */

/** What a guarded write hands back: refused (`error`, `reasons`), or done / dry run (`result.lines`, the file relative to the repo, whether anything changed, whether it was written). Same shape as BoardOpOutcome and SimOpOutcome. */
export type GuardedOutcome =
  | { error: string; reasons: string[] }
  | { result: { lines: string[]; minted?: unknown[] }; file: string; changed: boolean; written: boolean };

/** The code of a refusal, from its message: `no ...` = not-found, `rolled back ...` = rolled-back, else invalid. */
export type FailureCode = 'invalid' | 'not-found' | 'rolled-back';

export function failureCode(message: string): FailureCode {
  if (message.startsWith('no ')) return 'not-found';
  if (message.startsWith('rolled back')) return 'rolled-back';
  return 'invalid';
}

/** `{ok, command, dryRun, written, file, changes, minted?, error}` (done / dry run) or `{ok, command, dryRun, written, error}` (refused). */
export type GuardedWriteJson =
  | { ok: true; command: string; dryRun: boolean; written: boolean; file: string; changes: string[]; minted?: unknown[]; error: null }
  | { ok: false; command: string; dryRun: boolean; written: false; error: { code: FailureCode; message: string; reasons: string[] } };

/** The JSON object of one guarded write (key order fixed: it is printed with JSON.stringify). `yes` = the write was asked for. */
export function guardedWriteJson(command: string, outcome: GuardedOutcome, yes: boolean): GuardedWriteJson {
  if ('error' in outcome) {
    return { ok: false, command, dryRun: !yes, written: false, error: { code: failureCode(outcome.error), message: outcome.error, reasons: outcome.reasons } };
  }
  const { result } = outcome;
  return {
    ok: true, command, dryRun: !yes, written: outcome.written, file: outcome.file, changes: result.lines,
    ...(result.minted ? { minted: result.minted } : {}), error: null,
  };
}

/**
 * b768: a throw inside a guarded write (changed since read, rolled back, an unreadable file) as its refusal: the first
 * line of the message is the message, later non-empty lines (trimmed) the reasons. The CLI's emitThrown and the MCP
 * write tools both use it, so they report a throw as the same object.
 */
export function thrownOutcome(err: unknown): { error: string; reasons: string[] } {
  if (!(err instanceof Error)) return { error: String(err), reasons: [] };
  const [message, ...rest] = err.message.split('\n');
  return { error: message, reasons: rest.map((l) => l.trim()).filter(Boolean) };
}
