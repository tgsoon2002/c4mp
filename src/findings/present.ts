import type { PlanFinding, Severity } from '../types';
import { applyAcks } from './ack';
import { fileOfId, groupFindings, ungrouped } from './group';
import type { HiddenGroup, PresentOptions, Presented } from './types';

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const ORDER: Severity[] = ['critical', 'warning', 'info'];

function hiddenGroups(findings: PlanFinding[]): HiddenGroup[] {
  const map = new Map<string, { g: HiddenGroup; files: Set<string> }>();
  for (const f of findings) {
    const k = `${f.severity}\u0000${f.rule}`;
    let e = map.get(k);
    if (!e) { e = { g: { severity: f.severity, rule: f.rule, count: 0, files: 0 }, files: new Set() }; map.set(k, e); }
    e.g.count++;
    e.files.add(fileOfId(f.id) ?? f.id);
  }
  return [...map.values()].map((e) => ({ ...e.g, files: e.files.size }));
}

function hiddenSummary(hidden: HiddenGroup[]): string[] {
  return ORDER.flatMap((sev) => {
    const g = hidden.filter((h) => h.severity === sev);
    if (g.length === 0) return [];
    const total = g.reduce((n, h) => n + h.count, 0);
    return [`${total} ${sev} hidden: ${g.map((h) => `${h.rule} ${h.count} in ${h.files} ${h.files === 1 ? 'file' : 'files'}`).join(', ')}`];
  });
}

/**
 * Order: raw -> stale acks (on the raw findings) -> ack filter -> severity filter -> group.
 * Pure; the raw findings are not changed.
 */
export function present(raw: PlanFinding[], o: PresentOptions = {}): Presented {
  const { kept, acknowledged, stale } = applyAcks(raw, o.acks ?? []);
  const min = RANK[o.minSeverity ?? 'info'];
  const visible = (f: PlanFinding): boolean => RANK[f.severity] >= min && (o.showInfo !== false || f.severity !== 'info');
  const hidden = hiddenGroups(kept.filter((f) => !visible(f)));
  const summary = hiddenSummary(hidden);
  if (acknowledged.length > 0) summary.push(`${acknowledged.length} acknowledged`);
  for (const a of stale) summary.push(`stale ack: ${a.rule} ${a.id ?? a.glob} matches nothing`);
  const shownFindings = kept.filter(visible);
  return {
    shown: o.group === false ? ungrouped(shownFindings) : groupFindings(shownFindings),
    hidden,
    acknowledged: acknowledged.length,
    staleAcks: stale,
    summary,
  };
}
