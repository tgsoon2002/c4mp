/** P15-T1a: the error codes the query layer reports. Callers map these to messages / exit codes. */
export type QueryErrorCode =
  | 'no-anchor'
  | 'scan-failed'
  | 'not-found'
  | 'ambiguous'
  | 'out-of-repo'
  | 'invalid';

/** A query failure with a stable code; `candidates` lists the choices for 'ambiguous' / 'not-found'. */
export class QueryError extends Error {
  readonly code: QueryErrorCode;
  readonly candidates?: string[];

  constructor(code: QueryErrorCode, message: string, candidates?: string[]) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    if (candidates) this.candidates = candidates;
    Object.setPrototypeOf(this, QueryError.prototype);
  }
}
