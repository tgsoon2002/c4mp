import { randomUUID } from 'crypto';
import { log } from '../log';

/**
 * The uid vocabulary of plan elements (b512 ARR-EN-1, row N2): the metadata key, its shape, and how a new one is made.
 * Foundation: moved here from c4/ids.ts (which keeps backfillUids) so Checks, Plan generation, Map model and the
 * Services use it without importing Plan files.
 */

/** Metadata key that holds an element's stable uid. */
export const UID_KEY = 'uid';

/** Shape of a uid (lowercase UUID, any version). */
export const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Make a new random uid. */
export function newUid(): string {
  const uid = randomUUID();
  log('ids', 'new uid', { uid });
  return uid;
}
