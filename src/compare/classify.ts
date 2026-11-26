import type { Change, RawChange, Severity, ChangeType } from '../types';
import { GROWTH_FACTOR, SHRINK_FACTOR, MIN_LINE_DELTA, SEVERITY_ORDER, TYPE_ORDER } from '../constants';
import { log } from '../log';

/**
 * Check if a value grew according to the formula:
 * before > 0 AND after >= before * GROWTH_FACTOR AND after - before >= MIN_LINE_DELTA
 */
function grew(before: number | undefined, after: number | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  return before > 0 && after >= before * GROWTH_FACTOR && after - before >= MIN_LINE_DELTA;
}

/**
 * Check if a value shrank according to the formula:
 * after <= before * SHRINK_FACTOR AND before - after >= MIN_LINE_DELTA
 */
function shrank(before: number | undefined, after: number | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  return after <= before * SHRINK_FACTOR && before - after >= MIN_LINE_DELTA;
}

/**
 * Classify a raw change by assigning severity and rule based on §4 rules.
 */
function classifyOne(raw: RawChange): Change {
  const { type, kind, id, before, after, elementKind, renamedFrom } = raw;
  let severity: Severity;
  let rule: string;

  if (type === 'health') {
    if (kind === 'modified') {
      if (after !== undefined && before !== undefined) {
        if (after > before) {
          severity = 'critical';
          rule = 'health-worse';
        } else {
          severity = 'info';
          rule = 'health-better';
        }
      } else {
        severity = 'info';
        rule = 'health-changed';
      }
    } else {
      severity = 'info';
      rule = `health-${kind}`;
    }
  } else if (type === 'container') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'container-added';
    } else if (kind === 'removed') {
      severity = 'warning';
      rule = 'container-removed';
    } else {
      severity = 'info';
      rule = `container-${kind}`;
    }
  } else if (type === 'component') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'component-added';
    } else if (kind === 'removed') {
      severity = 'warning';
      rule = 'component-removed';
    } else if (kind === 'renamed') {
      severity = 'info';
      rule = 'component-renamed';
    } else if (kind === 'modified') {
      if (grew(before, after)) {
        severity = 'warning';
        rule = 'component-grew';
      } else if (shrank(before, after)) {
        severity = 'warning';
        rule = 'component-shrank';
      } else {
        severity = 'info';
        rule = 'component-changed';
      }
    } else {
      severity = 'info';
      rule = `component-${kind}`;
    }
  } else if (type === 'file') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'file-added';
    } else if (kind === 'removed') {
      severity = 'info';
      rule = 'file-removed';
    } else if (kind === 'renamed') {
      severity = 'info';
      rule = 'file-renamed';
    } else if (kind === 'modified') {
      if (grew(before, after)) {
        severity = 'warning';
        rule = 'file-grew';
      } else if (shrank(before, after)) {
        severity = 'warning';
        rule = 'file-shrank';
      } else {
        severity = 'info';
        rule = 'file-changed';
      }
    } else {
      severity = 'info';
      rule = `file-${kind}`;
    }
  } else if (type === 'element') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'element-added';
    } else if (kind === 'removed') {
      severity = 'info';
      rule = 'element-removed';
    } else if (kind === 'modified') {
      if (grew(before, after) && elementKind && (elementKind === 'function' || elementKind === 'method')) {
        severity = 'warning';
        rule = 'element-grew';
      } else {
        severity = 'info';
        rule = 'element-changed';
      }
    } else {
      severity = 'info';
      rule = `element-${kind}`;
    }
  } else if (type === 'edge') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'edge-added';
    } else if (kind === 'removed') {
      severity = 'info';
      rule = 'edge-removed';
    } else if (kind === 'modified') {
      severity = 'info';
      rule = 'edge-changed';
    } else {
      severity = 'info';
      rule = `edge-${kind}`;
    }
  } else if (type === 'cycle') {
    if (kind === 'added') {
      severity = 'warning';
      rule = 'cycle-added';
    } else if (kind === 'removed') {
      severity = 'info';
      rule = 'cycle-removed';
    } else {
      severity = 'info';
      rule = `cycle-${kind}`;
    }
  } else if (type === 'external') {
    if (kind === 'added') {
      severity = 'info';
      rule = 'external-added';
    } else if (kind === 'removed') {
      severity = 'info';
      rule = 'external-removed';
    } else {
      severity = 'info';
      rule = `external-${kind}`;
    }
  } else {
    severity = 'info';
    rule = `${type}-${kind}`;
  }

  const result: Change = {
    ...raw,
    severity,
    rule,
  };

  log('classify', 'classified', { id, rule, severity });

  return result;
}

/**
 * Sort changes by SEVERITY_ORDER, then TYPE_ORDER, then id (with plain < comparison).
 * Does not mutate the input array.
 */
export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    // Compare by severity order
    const aSeverityIdx = SEVERITY_ORDER.indexOf(a.severity);
    const bSeverityIdx = SEVERITY_ORDER.indexOf(b.severity);
    if (aSeverityIdx !== bSeverityIdx) return aSeverityIdx - bSeverityIdx;

    // Compare by type order
    const aTypeIdx = TYPE_ORDER.indexOf(a.type);
    const bTypeIdx = TYPE_ORDER.indexOf(b.type);
    if (aTypeIdx !== bTypeIdx) return aTypeIdx - bTypeIdx;

    // Compare by id with plain < comparison
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/**
 * Classify raw changes by assigning severity and rule per §4 table, then sort.
 */
export function classify(raw: RawChange[]): Change[] {
  const classified = raw.map(classifyOne);
  return sortChanges(classified);
}
