import { COMPONENT_ROLES, PERSON_SHAPES, PLAN_STATUSES, PLAN_PRIORITIES } from '../constants';
import type { PlanElement, PlanFinding } from '../types';
import { log } from '../log';
import { UID_RE } from '../util/uid';
import { splitTagsRaw, isValidTag } from '../tags';
import { isSharedSubregion } from '../plan/layers';
import { parseViewport, VIEWPORT_MIN, VIEWPORT_MAX } from '../plan/ioWords';

/**
 * b304 (S9): the text after `<title>: ` that starts every invalid-metadata message below, one per message. planTx builds its
 * title-edit pattern from this list, so a new rule adds its head here (validate.test.ts checks every message against it).
 */
export const INVALID_META_HEADS: readonly string[] = [
  'unknown status', 'unknown priority', "sprint '", 'done but', "uid '", "tag '", 'shared is only', "shared '", "viewport '",
  'shape is only', "shape '", 'role is only', "role '",
];

export function validateMetadata(elements: PlanElement[]): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const kindOf = new Map(elements.map((e) => [e.id, e.kind] as const));

  // Only validate elements with non-empty metadata
  for (const element of elements) {
    // subregion-misplaced (b456: was layer-misplaced; old acks still match, findings/ack.ts): a subregion sits directly in a
    // container and links no code (it claims nothing; link its components)
    if (element.kind === 'subregion') {
      const parentKind = element.parent === null ? null : kindOf.get(element.parent) ?? null;
      if (parentKind !== 'container') {
        findings.push({
          severity: 'warning',
          rule: 'subregion-misplaced',
          id: element.id,
          message: `${element.title}: a subregion goes directly in a container, not in ${parentKind === null ? 'the model root' : `a ${parentKind}`}`,
        });
      }
      if (element.links.length > 0) {
        findings.push({
          severity: 'warning',
          rule: 'subregion-misplaced',
          id: element.id,
          message: `${element.title}: a subregion has no link (it claims no code); link its components`,
        });
      }
    }

    if (!element.metadata || Object.keys(element.metadata).length === 0) {
      log('validate', `element has no metadata, skipping ${element.id}`);
      continue;
    }

    log('validate', `validating metadata for ${element.id}`);

    // Rule 1: status not in PLAN_STATUSES
    const status = element.metadata.status;
    if (status !== undefined) {
      if (!PLAN_STATUSES.includes(status)) {
        log('validate', `invalid status for ${element.id}: ${status}`);
        findings.push({
          severity: 'warning',
          rule: 'invalid-metadata',
          id: element.id,
          message: `${element.title}: unknown status '${status}' (use planned, in-progress, done, abandoned)`,
        });
      }
    }

    // Rule 2: priority not in PLAN_PRIORITIES
    const priority = element.metadata.priority;
    if (priority !== undefined) {
      if (!PLAN_PRIORITIES.includes(priority)) {
        log('validate', `invalid priority for ${element.id}: ${priority}`);
        findings.push({
          severity: 'warning',
          rule: 'invalid-metadata',
          id: element.id,
          message: `${element.title}: unknown priority '${priority}' (use high, medium, low)`,
        });
      }
    }

    // Rule 3: sprint not /^S\d+$/
    const sprint = element.metadata.sprint;
    if (sprint !== undefined) {
      if (!/^S\d+$/.test(sprint)) {
        log('validate', `invalid sprint for ${element.id}: ${sprint}`);
        findings.push({
          severity: 'warning',
          rule: 'invalid-metadata',
          id: element.id,
          message: `${element.title}: sprint '${sprint}' should look like S15`,
        });
      }
    }

    // Rule 4: status done with no owner
    if (status === 'done') {
      const owner = element.metadata.owner;
      if (!owner || owner.trim() === '') {
        log('validate', `done status without owner for ${element.id}`);
        findings.push({
          severity: 'warning',
          rule: 'invalid-metadata',
          id: element.id,
          message: `${element.title}: done but has no owner`,
        });
      }
    }

    // Rule 5: uid present but not a UUID (a missing uid is never a finding)
    const uid = element.metadata.uid;
    if (uid !== undefined && !UID_RE.test(uid)) {
      log('validate', `invalid uid for ${element.id}: ${uid}`);
      findings.push({
        severity: 'warning',
        rule: 'invalid-metadata',
        id: element.id,
        message: `${element.title}: uid '${uid}' is not a UUID`,
      });
    }

    // Rule 6: a tag that is not lower-case letters, digits and dashes (a missing `tags` key is never a finding)
    for (const tag of splitTagsRaw(element.metadata.tags)) {
      if (!isValidTag(tag)) {
        log('validate', `invalid tag for ${element.id}: ${tag}`);
        findings.push({
          severity: 'warning',
          rule: 'invalid-metadata',
          id: element.id,
          message: `${element.title}: tag '${tag}' should be lower-case letters, digits and dashes`,
        });
      }
    }

    // Rule 7 (b454): `shared` only on a subregion, and only 'true' (a missing key is never a finding)
    const shared = element.metadata.shared;
    if (shared !== undefined && !isSharedSubregion(element)) {
      log('validate', `invalid shared for ${element.id} (${element.kind}): ${shared}`);
      findings.push({
        severity: 'warning',
        rule: 'invalid-metadata',
        id: element.id,
        message: element.kind !== 'subregion'
          ? `${element.title}: shared is only for a subregion, not a ${element.kind}`
          : `${element.title}: shared '${shared}' should be 'true'`,
      });
    }

    // Rule 8 (b304, H9): viewport present but not <W>x<H> in range, read by parseViewport (a missing key is never a finding)
    const viewport = element.metadata.viewport;
    if (viewport !== undefined && parseViewport(viewport) === null) {
      log('validate', `invalid viewport for ${element.id}: ${viewport}`);
      findings.push({
        severity: 'warning',
        rule: 'invalid-metadata',
        id: element.id,
        message: `${element.title}: viewport '${viewport}' should be <W>x<H>, whole numbers ${VIEWPORT_MIN} to ${VIEWPORT_MAX}`,
      });
    }

    // Rule 9 (C1 C2, b834): `shape` only on a person, and only person or robot (a missing key is never a finding)
    const shape = element.metadata.shape;
    if (shape !== undefined && (element.kind !== 'person' || !PERSON_SHAPES.includes(shape))) {
      log('validate', `invalid shape for ${element.id} (${element.kind}): ${shape}`);
      findings.push({
        severity: 'warning',
        rule: 'invalid-metadata',
        id: element.id,
        message: element.kind !== 'person'
          ? `${element.title}: shape is only for a person, not a ${element.kind}`
          : `${element.title}: shape '${shape}' should be ${PERSON_SHAPES.join(' or ')}`,
      });
    }

    // Rule 10 (b908): `role` only on a component, and only a COMPONENT_ROLES value (a missing key is never a finding)
    const role = element.metadata.role;
    if (role !== undefined && (element.kind !== 'component' || !COMPONENT_ROLES.includes(role))) {
      log('validate', `invalid role for ${element.id} (${element.kind}): ${role}`);
      findings.push({
        severity: 'warning',
        rule: 'invalid-metadata',
        id: element.id,
        message: element.kind !== 'component'
          ? `${element.title}: role is only for a component, not a ${element.kind}`
          : `${element.title}: role '${role}' should be ${COMPONENT_ROLES.join(' or ')}`,
      });
    }
  }

  // Cross-element pass: one uid used by 2+ elements
  const byUid = new Map<string, PlanElement[]>();
  for (const element of elements) {
    const uid = element.metadata?.uid;
    if (!uid) continue;
    const group = byUid.get(uid);
    if (group) group.push(element);
    else byUid.set(uid, [element]);
  }
  for (const [uid, group] of byUid) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    log('validate', `duplicate uid ${uid} used by ${sorted.map((e) => e.id).join(', ')}`);
    findings.push({
      severity: 'warning',
      rule: 'duplicate-uid',
      id: sorted[0].id,
      message: `uid ${uid} is used by ${sorted
        .map((e) => `${e.id} (${e.source.file}:${e.source.line})`)
        .join(', ')}`,
    });
  }

  log('validate', `done: ${findings.length} findings`);
  return findings;
}
