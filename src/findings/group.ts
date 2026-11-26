import type { PlanFinding } from '../types';
import type { FindingRow } from './types';

/** The file part of a `file#name` id, or null for ids of another form (element fqn, board id, ...). */
export function fileOfId(id: string): string | null {
  const i = id.indexOf('#');
  return i > 0 ? id.slice(0, i) : null;
}

function rowOf(findings: PlanFinding[], key: string): FindingRow {
  const first = findings[0];
  return {
    severity: first.severity,
    rule: first.rule,
    key,
    ids: findings.map((f) => f.id),
    count: findings.length,
    message: findings.length === 1 ? first.message : `${findings.length} ${first.rule} findings in ${key}`,
    findings,
  };
}

/**
 * One row per (severity, rule, file) for `file#name` ids; every other finding is its own row.
 * Rows keep the order of their first finding.
 */
export function groupFindings(findings: PlanFinding[]): FindingRow[] {
  const groups: { key: string; items: PlanFinding[] }[] = [];
  const byGroup = new Map<string, { key: string; items: PlanFinding[] }>();
  for (const f of findings) {
    const file = fileOfId(f.id);
    if (file === null) { groups.push({ key: f.id, items: [f] }); continue; }
    const g = `${f.severity}\u0000${f.rule}\u0000${file}`;
    let grp = byGroup.get(g);
    if (!grp) { grp = { key: file, items: [] }; byGroup.set(g, grp); groups.push(grp); }
    grp.items.push(f);
  }
  return groups.map((g) => rowOf(g.items, g.key));
}

/** No grouping: one row per finding. */
export function ungrouped(findings: PlanFinding[]): FindingRow[] {
  return findings.map((f) => rowOf([f], fileOfId(f.id) ?? f.id));
}
