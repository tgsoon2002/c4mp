import type { C4pmConfig, Plan } from '../types';
import { readStorage } from '../storage/storageState';
import { checkStorage } from '../storage/checkStorage';
import type { ReaderRegistry } from '../schema/readers';
import type { UnplannedGroup } from './unplanned';
import { cmp } from '../util/text';
import { CMD_NAME } from '../constants';

/**
 * b273 (D6): the storage view's "unplanned" rules, in output order, each with a one-line fix hint.
 * unplanned-record = a record the code defines that a plan store (with a reader) does not list;
 * unplanned-store = records a reader finds that no plan store covers.
 */
export const UNPLANNED_STORAGE_RULES: { rule: string; hint: string }[] = [
  { rule: 'unplanned-record', hint: `the code has a record the store does not list: ${CMD_NAME} plan add record <name> --parent <store>` },
  { rule: 'unplanned-store', hint: `a reader finds records that no store covers: ${CMD_NAME} plan generate --view storage` },
];


export interface UnplannedStorage {
  groups: UnplannedGroup[];
  /** Plan stores whose reader failed; shown beside the groups, never dropped. */
  problems: string[];
}

/**
 * Code the storage plan lacks: the storage check findings (checkStorage over readStorage, STOR-3) whose rule is in
 * UNPLANNED_STORAGE_RULES, like `plan unplanned` is the arch findings filtered. readStorage reads the store files of the
 * config (listStoreFiles: its ignore, languages and tests).
 * A store whose reader fails is listed in `problems` and its records are not judged. A reader error on the repo scan
 * itself is thrown. Groups in the order of UNPLANNED_STORAGE_RULES, items sorted, empty groups left out.
 */
export function unplannedStorage(
  plan: Plan,
  repoRoot: string,
  config: Pick<C4pmConfig, 'ignore' | 'languages' | 'tests'>,
  registry?: ReaderRegistry,
): UnplannedStorage {
  const state = readStorage(plan, repoRoot, config, registry);
  if (state.hitsError !== undefined) throw new Error(state.hitsError);
  const findings = checkStorage(plan, state);

  const groups: UnplannedGroup[] = [];
  for (const { rule, hint } of UNPLANNED_STORAGE_RULES) {
    const list = findings
      .filter((f) => f.rule === rule)
      .map(({ id, message }) => ({ id, message }))
      .sort((a, b) => cmp(a.id, b.id) || cmp(a.message, b.message));
    if (list.length > 0) groups.push({ rule, hint, items: list });
  }
  const problems = state.stores.filter((s) => s.error).map((s) => `store ${s.element.id}: ${s.error}`);
  return { groups, problems };
}
