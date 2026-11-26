import { Change, DiffEndpoint, SnapshotDiff } from '../types';
import { CMD_NAME } from '../constants';

/**
 * Format endpoint label: commit7 (date) or no-git (date)
 */
export function endpointLabel(e: DiffEndpoint): string {
  const date = (e.commitDate ?? e.createdAt).slice(0, 10);
  const commit = e.commit ? e.commit.slice(0, 7) : 'no-git';
  return `${commit} (${date})`;
}

/**
 * Format a single change as a one-line description
 */
export function describe(c: Change): string {
  const { type, kind, id, renamedFrom, before, after, elementKind, rule } = c;

  // Helper: ratio = (after / before).toFixed(1)
  const ratio = before && after ? (after / before).toFixed(1) : '0';

  // Determine element kind name for element type
  // For type 'element', use elementKind if present, else 'element'
  let kindName = elementKind ?? 'element';

  // Template patterns by rule
  switch (rule) {
    case 'health-worse':
      return `${id} increased: ${before} → ${after}`;
    case 'health-better':
      return `${id} decreased: ${before} → ${after}`;

    case 'container-added':
      return `container added: ${id}`;
    case 'container-removed':
      return `container removed: ${id}`;

    case 'component-added':
      return `component added: ${id} (${after} lines)`;
    case 'component-removed':
      return `component removed: ${id} (${before} lines)`;
    case 'component-renamed':
      return `component renamed: ${renamedFrom} → ${id}`;
    case 'component-grew':
      return `component grew: ${id} ${before} → ${after} lines (x${ratio})`;
    case 'component-shrank':
      return `component shrank: ${id} ${before} → ${after} lines`;
    case 'component-changed':
      return `component changed: ${id} ${before} → ${after} lines`;

    case 'file-added':
      return `file added: ${id} (${after} lines)`;
    case 'file-removed':
      return `file removed: ${id} (${before} lines)`;
    case 'file-renamed':
      return `file renamed: ${renamedFrom} → ${id}`;
    case 'file-grew':
      return `file grew: ${id} ${before} → ${after} lines (x${ratio})`;
    case 'file-shrank':
      return `file shrank: ${id} ${before} → ${after} lines`;
    case 'file-changed':
      return `file changed: ${id} ${before} → ${after} lines`;

    case 'element-added':
      return `${kindName} added: ${id} (${after} lines)`;
    case 'element-removed':
      return `${kindName} removed: ${id} (${before} lines)`;
    case 'element-grew':
      return `${kindName} grew: ${id} ${before} → ${after} lines (x${ratio})`;
    case 'element-changed':
      return `${kindName} changed: ${id} ${before} → ${after} lines`;

    case 'edge-added':
      return `dependency added: ${id}`;
    case 'edge-removed':
      return `dependency removed: ${id}`;
    case 'edge-changed':
      return `dependency changed: ${id} weight ${before} → ${after}`;

    case 'cycle-added':
      return `cycle added: ${id}`;
    case 'cycle-removed':
      return `cycle removed: ${id}`;

    case 'external-added':
      return `package added: ${id}`;
    case 'external-removed':
      return `package removed: ${id}`;

    default:
      return `${rule}: ${id}`;
  }
}

/**
 * Format diff as plain text report
 */
export function formatText(diff: SnapshotDiff): string {
  const { from, to, summary, changes } = diff;

  // Header line: c4pm diff · {repoName} · {from label} → {to label}
  const headerLine = `${CMD_NAME} diff · ${from.repoName} · ${endpointLabel(from)} → ${endpointLabel(to)}`;

  // Calculate line delta
  const lineDelta = summary.linesAfter - summary.linesBefore;
  const lineDeltaStr = lineDelta >= 0 ? `(+${lineDelta})` : `(${lineDelta})`;

  // Summary line with counts
  const summaryLine =
    `Summary: components +${summary.componentsAdded} -${summary.componentsRemoved} renamed ${summary.componentsRenamed} changed ${summary.componentsModified} | ` +
    `files +${summary.filesAdded} -${summary.filesRemoved} renamed ${summary.filesRenamed} changed ${summary.filesModified} | ` +
    `functions +${summary.elementsAdded} -${summary.elementsRemoved} changed ${summary.elementsModified} | ` +
    `dependencies +${summary.edgesAdded} -${summary.edgesRemoved} | ` +
    `cycles +${summary.cyclesAdded} -${summary.cyclesRemoved} | ` +
    `lines ${summary.linesBefore} → ${summary.linesAfter} ${lineDeltaStr}`;

  // Group changes by severity
  const grouped: Record<string, Change[]> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const change of changes) {
    grouped[change.severity].push(change);
  }

  // Build severity sections
  const sections: string[] = [];

  for (const severity of ['critical', 'warning', 'info']) {
    const severityChanges = grouped[severity];
    const count = severityChanges.length;
    sections.push(`${severity.toUpperCase()} (${count})`);

    if (count > 0) {
      for (const change of severityChanges) {
        sections.push(`  ${describe(change)}`);
      }
    }
  }

  // Combine all parts
  return [headerLine, summaryLine, '', ...sections].join('\n');
}

/**
 * Format diff as markdown report
 */
export function formatMarkdown(diff: SnapshotDiff): string {
  const { from, to, summary, changes } = diff;

  // Calculate line delta
  const lineDelta = summary.linesAfter - summary.linesBefore;
  const lineDeltaStr = lineDelta >= 0 ? `(+${lineDelta})` : `(${lineDelta})`;

  // Group changes by severity
  const grouped: Record<string, Change[]> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const change of changes) {
    grouped[change.severity].push(change);
  }

  // Build markdown
  const lines: string[] = [];

  lines.push(`# Snapshot diff: ${from.repoName}`);
  lines.push('');
  lines.push(`From **${endpointLabel(from)}** to **${endpointLabel(to)}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| | added | removed | renamed | changed |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| components | ${summary.componentsAdded} | ${summary.componentsRemoved} | ${summary.componentsRenamed} | ${summary.componentsModified} |`);
  lines.push(`| files | ${summary.filesAdded} | ${summary.filesRemoved} | ${summary.filesRenamed} | ${summary.filesModified} |`);
  lines.push(`| functions | ${summary.elementsAdded} | ${summary.elementsRemoved} | – | ${summary.elementsModified} |`);
  lines.push(`| dependencies | ${summary.edgesAdded} | ${summary.edgesRemoved} | – | – |`);
  lines.push(`| cycles | ${summary.cyclesAdded} | ${summary.cyclesRemoved} | – | – |`);
  lines.push('');
  lines.push(`Lines: ${summary.linesBefore} → ${summary.linesAfter} ${lineDeltaStr}`);
  lines.push('');

  // Severity sections
  for (const severity of ['critical', 'warning', 'info']) {
    const severityChanges = grouped[severity];
    const count = severityChanges.length;
    const titleCase = severity.charAt(0).toUpperCase() + severity.slice(1);

    lines.push(`## ${titleCase} (${count})`);
    lines.push('');

    if (count > 0) {
      for (const change of severityChanges) {
        lines.push(`- ${describe(change)}`);
      }
    } else {
      lines.push('None.');
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
