import type { PlanFinding } from '../types';
import { cmp } from '../util/text';
import { CMD_NAME } from '../constants';

/**
 * The check rules that mean "code the plan does not own (yet)", in output order, each with a one-line fix hint.
 * Folder mode reports `unplanned-code`; claim mode reports the others (src/c4/check.ts). T26-11 (Phase 26 0.2b):
 * `test-only-code` is listed too: it is unclaimed code that only tests reach (D10 gave it its own rule instead of
 * `unassigned-code`/`shared-auto`), so leaving it out would drop unowned code from this list.
 */
export const UNPLANNED_RULES: { rule: string; hint: string }[] = [
  { rule: 'unplanned-code', hint: `no component claims the file: ${CMD_NAME} plan link <component> <path>` },
  { rule: 'unassigned-code', hint: `no component claims the function: ${CMD_NAME} plan link <component> <file>#<function>` },
  { rule: 'shared-auto', hint: `unclaimed but used by several components: ${CMD_NAME} plan link <component> <file>#<function> to give it one owner` },
  { rule: 'component-claim-conflict', hint: `several components claim it: narrow one of the links (${CMD_NAME} check names the winner)` },
  { rule: 'split-file', hint: 'the functions of one file belong to different components: fine if intended, else link the whole file to one' },
  { rule: 'test-only-code', hint: `unclaimed and used only by tests: delete it if dead, else wire it in and claim it: ${CMD_NAME} plan link <component> <file>#<function>` },
];

export interface UnplannedGroup {
  rule: string;
  hint: string;
  items: { id: string; message: string }[];
}


/**
 * Keep only the findings of the unplanned-code rules, grouped by rule in the fixed order of UNPLANNED_RULES,
 * items sorted by id then message, empty groups left out. Pure: the scan and checkPlan stay in the CLI.
 */
export function groupUnplanned(findings: PlanFinding[]): UnplannedGroup[] {
  const groups: UnplannedGroup[] = [];
  for (const { rule, hint } of UNPLANNED_RULES) {
    const items = findings
      .filter(f => f.rule === rule)
      .map(f => ({ id: f.id, message: f.message }))
      .sort((a, b) => cmp(a.id, b.id) || cmp(a.message, b.message));
    if (items.length > 0) groups.push({ rule, hint, items });
  }
  return groups;
}
