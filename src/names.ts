import { log } from './log';

export function toId(s: string): string {
  if (!s) {
    log('names', 'toId', { input: s, output: 'unnamed' });
    return 'unnamed';
  }

  // Step 1: insert '-' between lowercase letter/digit and uppercase letter
  let result = s.replace(/([a-z0-9])([A-Z])/g, '$1-$2');

  // Step 2: lowercase
  result = result.toLowerCase();

  // Step 3: replace every run of chars not [a-z0-9] with '-'
  result = result.replace(/[^a-z0-9]+/g, '-');

  // Step 4: trim '-' from both ends
  result = result.replace(/^-+|-+$/g, '');

  // Step 5: empty becomes 'unnamed'
  if (!result) {
    log('names', 'toId', { input: s, output: 'unnamed' });
    return 'unnamed';
  }

  log('names', 'toId', { input: s, output: result });
  return result;
}

/**
 * Last dot-segment of a fully-qualified plan element id ('phofast.api.orders' -> 'orders').
 * PlanElement ids are always fqn (parser.ts: `fqn = parent ? \`${parent}.${id}\` : id`), but
 * folder/manifest-derived ids (Container.id, folder-mode Component.id) are bare local names.
 * This is the bridge used by P6-T9 (snapshot/build.ts + view/model.ts) to match a plan element
 * against a folder-scanned container when the two naming schemes might agree by convention
 * (the .c4 author picked the same local identifier as the folder name) -- not guaranteed, just
 * the best available heuristic given the current parser's fqn scheme.
 */
export function localId(fqn: string): string {
  if (!fqn) return fqn;
  const parts = fqn.split('.');
  return parts[parts.length - 1] || fqn;
}

/**
 * P13-BUG-id-collision: node ids must be unique across the whole tree, but the system id (toId(repoName)) can equal a
 * container id (a repo whose single root container is named after its package, or after the repo). Only in that case
 * the viewer model gives the SYSTEM node's id this suffix; every non-colliding id is unchanged. An id-format value, so
 * it lives with the id helpers (b512 ARR-EN-1, row N3; was c4/applyLayout.ts): Map model, Test attach and Plan files use it.
 */
export const SYSTEM_ID_QUALIFIER = '::system';

/**
 * C1-CTX: id of the map's top node when the plan has actors (person, external): kind 'context', holding our system and
 * the actors beside it. Not a plan or scan id; on a clash it gets SYSTEM_ID_QUALIFIER, the same way the system id does.
 */
export const CONTEXT_ROOT_ID = '__c1__';

export function toDisplayName(s: string): string {
  if (!s) {
    log('names', 'toDisplayName', { input: s, output: 'Unnamed' });
    return 'Unnamed';
  }

  // Step 1: insert space between lowercase letter/digit and uppercase letter
  let result = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

  // Step 2: replace all non-alphanumeric characters (except space) with spaces
  result = result.replace(/[^a-z0-9 ]/gi, ' ');

  // Step 3: replace runs of spaces with one space
  result = result.replace(/ +/g, ' ');

  // Step 4: trim
  result = result.trim();

  // Step 5: uppercase first letter of each word (leave rest unchanged)
  result = result.split(' ').map(word => {
    if (!word) return '';
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ');

  // Step 6: empty becomes 'Unnamed'
  if (!result) {
    log('names', 'toDisplayName', { input: s, output: 'Unnamed' });
    return 'Unnamed';
  }

  log('names', 'toDisplayName', { input: s, output: result });
  return result;
}

/**
 * Sanitize an identifier for use as a C4 element ID.
 * - Replace non-[A-Za-z0-9_] with '_'
 * - '_root' → 'root_files'
 * - Leading digit → 'c_' prefix
 */
export function c4Id(s: string): string {
  if (!s) return 'unnamed';

  // Replace non-alphanumeric and underscore with '_'
  let id = s.replace(/[^A-Za-z0-9_]/g, '_');

  // '_root' → 'root_files'
  if (id === '_root') {
    id = 'root_files';
  }

  // Leading digit → 'c_' prefix
  if (/^\d/.test(id)) {
    id = 'c_' + id;
  }

  log('generate', 'c4Id', { input: s, output: id });
  return id;
}

// PS-3.16: words the parser reads as keywords at that place, so they cannot be an element id there (one list, shared by all writers).
export const RESERVED_TOP = ['specification', 'views', 'extend'];
export const RESERVED_BODY = [...RESERVED_TOP, 'technology', 'description', 'title', 'link', 'metadata'];
/** True when `id` is a keyword at that place: in a model/extend block (atTop) or in an element body. */
export const isReservedId = (id: string, atTop: boolean): boolean => (atTop ? RESERVED_TOP : RESERVED_BODY).includes(id);

/** b273: c4Id, plus a trailing `_` when the result is a body keyword (a column called `title` or `description`). */
export function c4ElementId(s: string): string {
  const id = c4Id(s);
  return isReservedId(id, false) || id === 'model' ? `${id}_` : id;
}
