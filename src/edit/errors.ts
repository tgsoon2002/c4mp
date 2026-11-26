/** Phase 32 (ED-1): the error codes of the edit engine. Callers (the ED-2 service) map them to messages / exit codes. */
export type EditErrorCode =
  | 'not-found'     // no element of that name in the file
  | 'ambiguous'     // the name matches more than one element (candidates `"<start>-<end>"`)
  | 'invalid'       // a bad line, range or argument
  | 'parse-worse'   // the edit adds parse errors (D6)
  | 'changed';      // the file changed on disk since it was read

/** An edit failure with a stable code; `candidates` lists the choices for 'ambiguous'. */
export class EditError extends Error {
  readonly code: EditErrorCode;
  readonly candidates?: string[];

  constructor(code: EditErrorCode, message: string, candidates?: string[]) {
    super(message);
    this.name = 'EditError';
    this.code = code;
    if (candidates) this.candidates = candidates;
    Object.setPrototypeOf(this, EditError.prototype);
  }
}
