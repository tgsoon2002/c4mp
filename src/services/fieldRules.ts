/**
 * P18-T13: value rules of the plan-editing commands (add, set), one place. status and priority use the same constants
 * as validate.ts; the sprint rule is validate.ts rule 3 (`/^S\d+$/`, not exported there).
 */
import { COMPONENT_ROLES, PERSON_SHAPES,PLAN_PRIORITIES, PLAN_STATUSES } from '../constants';

export const SPRINT_RE = /^S\d+$/;

/** Why `value` is not allowed for `key`, or null when it is. Empty values and line breaks are refused for every key. */
export function checkFieldValue(key: string, value: string): string | null {
  if (value.length === 0) return `${key} must not be empty`;
  if (/[\r\n]/.test(value)) return `${key} must not contain line breaks`;
  if (key === 'status' && !PLAN_STATUSES.includes(value)) return `status '${value}' is not allowed (use ${PLAN_STATUSES.join(', ')})`;
  if (key === 'priority' && !PLAN_PRIORITIES.includes(value)) return `priority '${value}' is not allowed (use ${PLAN_PRIORITIES.join(', ')})`;
  if (key === 'sprint' && !SPRINT_RE.test(value)) return `sprint '${value}' should look like S15`;
  if (key === 'shape' && !PERSON_SHAPES.includes(value)) return `shape '${value}' is not allowed (use ${PERSON_SHAPES.join(', ')})`;
  if (key === 'role' && !COMPONENT_ROLES.includes(value)) return `role '${value}' is not allowed (use ${COMPONENT_ROLES.join(', ')})`;
  return null;
}

/** D8: `done` needs an owner (validate.ts warns about it, and the gate refuses new warnings). */
export function doneNeedsOwner(status: string | undefined, owner: string | undefined): string | null {
  return status === 'done' && (owner === undefined || owner.trim() === '') ? "status 'done' needs an owner (add owner=<name>)" : null;
}
