import { Change, FailOn, PlanFinding, Severity, SnapshotDiff } from '../types';
import { handlerExtensions } from '../languages';
import { LANGUAGE_IDS } from '../languages/registry';
import { C4_EXTENSION, CMD_NAME } from '../constants';
import { describe, endpointLabel } from '../compare/report';

/**
 * Check if severity is at or above the minimum threshold.
 * failOn 'none' always returns false.
 */
export function severityAtLeast(s: Severity, min: FailOn): boolean {
  if (min === 'none') return false;
  if (min === 'critical') return s === 'critical';
  if (min === 'warning') return s === 'critical' || s === 'warning';
  return false;
}

/**
 * Determine exit code based on whether any severities meet the failOn threshold.
 */
export function exitCodeFor(severities: Severity[], failOn: FailOn): 0 | 1 {
  for (const s of severities) {
    if (severityAtLeast(s, failOn)) {
      return 1;
    }
  }
  return 0;
}

/**
 * Escape special characters for GitHub annotations.
 * %  → %25
 * \r → %0D
 * \n → %0A
 */
function escapeGithubMessage(msg: string): string {
  return msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Every extension a scanned language's handler reads, and .c4. */
const FILE_EXTENSIONS = [...handlerExtensions(LANGUAGE_IDS), C4_EXTENSION];

/**
 * Check if a finding id is a file path: it ends in a language or .c4 extension.
 */
export function isFilePath(id: string): boolean {
  return FILE_EXTENSIONS.some(ext => id.endsWith(ext));
}

/**
 * Format diff as GitHub output: annotations + markdown.
 */
export function formatGithubDiff(diff: SnapshotDiff): string {
  const { from, to, summary, changes } = diff;

  // Calculate line delta
  const lineDelta = summary.linesAfter - summary.linesBefore;
  const lineDeltaStr = lineDelta >= 0 ? `(+${lineDelta})` : `(${lineDelta})`;

  // Build annotations (first, no annotations for info)
  const annotations: string[] = [];
  const grouped: Record<string, Change[]> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const change of changes) {
    grouped[change.severity].push(change);
  }

  for (const change of grouped.critical) {
    const desc = describe(change);
    const msg = escapeGithubMessage(desc);
    annotations.push(`::error title=${CMD_NAME}::${msg}`);
  }

  for (const change of grouped.warning) {
    const desc = describe(change);
    const msg = escapeGithubMessage(desc);
    annotations.push(`::warning title=${CMD_NAME}::${msg}`);
  }

  // Build markdown
  const lines: string[] = [];

  // Add annotations first
  if (annotations.length > 0) {
    lines.push(...annotations);
    lines.push('');
  }

  // Markdown header
  lines.push(`### ${CMD_NAME} drift: ${from.repoName}`);
  lines.push(`${endpointLabel(from)} → ${endpointLabel(to)}`);
  lines.push('');

  // Summary line (same format as formatText)
  const summaryLine =
    `Summary: components +${summary.componentsAdded} -${summary.componentsRemoved} renamed ${summary.componentsRenamed} changed ${summary.componentsModified} | ` +
    `files +${summary.filesAdded} -${summary.filesRemoved} renamed ${summary.filesRenamed} changed ${summary.filesModified} | ` +
    `functions +${summary.elementsAdded} -${summary.elementsRemoved} changed ${summary.elementsModified} | ` +
    `dependencies +${summary.edgesAdded} -${summary.edgesRemoved} | ` +
    `cycles +${summary.cyclesAdded} -${summary.cyclesRemoved} | ` +
    `lines ${summary.linesBefore} → ${summary.linesAfter} ${lineDeltaStr}`;

  lines.push(summaryLine);
  lines.push('');

  // Severity sections
  for (const severity of ['critical', 'warning', 'info']) {
    const severityChanges = grouped[severity];
    const count = severityChanges.length;

    if (severity === 'info') {
      // Info is collapsed to a count
      if (count > 0) {
        lines.push(`**${count} info changes**`);
      }
    } else {
      if (count > 0) {
        lines.push(`**${severity.toUpperCase()} (${count})**`);
        for (const change of severityChanges) {
          const desc = describe(change);
          lines.push(`- ${desc}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format findings as GitHub output: annotations + markdown.
 */
export function formatGithubFindings(findings: PlanFinding[], repoName: string): string {
  // Build annotations
  const annotations: string[] = [];
  const grouped: Record<string, PlanFinding[]> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const finding of findings) {
    grouped[finding.severity].push(finding);
  }

  for (const finding of grouped.critical) {
    const msg = escapeGithubMessage(finding.message);
    if (isFilePath(finding.id)) {
      annotations.push(`::error file=${finding.id},title=${CMD_NAME} ${finding.rule}::${msg}`);
    } else {
      annotations.push(`::error title=${CMD_NAME} ${finding.rule}::${msg}`);
    }
  }

  for (const finding of grouped.warning) {
    const msg = escapeGithubMessage(finding.message);
    if (isFilePath(finding.id)) {
      annotations.push(`::warning file=${finding.id},title=${CMD_NAME} ${finding.rule}::${msg}`);
    } else {
      annotations.push(`::warning title=${CMD_NAME} ${finding.rule}::${msg}`);
    }
  }

  // Build markdown
  const lines: string[] = [];

  // Add annotations first
  if (annotations.length > 0) {
    lines.push(...annotations);
    lines.push('');
  }

  // Markdown header
  lines.push(`### ${CMD_NAME} check: ${repoName}`);
  lines.push('');

  // Severity sections
  for (const severity of ['critical', 'warning', 'info']) {
    const severityFindings = grouped[severity];
    const count = severityFindings.length;

    if (severity === 'info') {
      // Info is collapsed to a count
      if (count > 0) {
        lines.push(`**${count} info findings**`);
      }
    } else {
      if (count > 0) {
        lines.push(`**${severity.toUpperCase()} (${count})**`);
        for (const finding of severityFindings) {
          lines.push(`- ${finding.message}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
