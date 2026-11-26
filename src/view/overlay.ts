import type { ViewModel, ViewNode, DriftMark, SnapshotDiff, PlanFinding } from '../types';
import { formatText } from '../compare/report';
import { log } from '../log';

const TAG = 'overlay';

/**
 * Apply drift marks from a SnapshotDiff to the ViewModel.
 * Maps each Change onto the node with the same id (element ids are `${file}#${name}`).
 * Sets drift marks: 'added' | 'grew' | 'shrank' | 'changed' | 'renamed'.
 * Removed items go to drift.removed.
 * Sets drift.from, drift.summary from the diff.
 * Pure; mutates and returns the model.
 */
export function applyDrift(
  model: ViewModel,
  diff: SnapshotDiff,
  fromLabel: string
): ViewModel {
  // Build id → node map by walking the tree once
  const nodeById = new Map<string, ViewNode>();

  function walk(node: ViewNode) {
    nodeById.set(node.id, node);
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(model.root);

  // Parse Summary line from formatted diff
  const text = formatText(diff);
  const lines = text.split('\n');
  const summaryLine = lines.find(l => l.startsWith('Summary: ')) ?? '';
  const summary = summaryLine.replace(/^Summary: /, '');

  // Initialize drift object
  model.drift = {
    from: fromLabel,
    summary,
    removed: [],
  };

  // Apply changes
  for (const change of diff.changes) {
    // Only care about component/file/element types
    if (!['component', 'file', 'element'].includes(change.type)) {
      continue;
    }

    const { kind, id, rule, before } = change;

    if (kind === 'removed') {
      // Add to removed list
      model.drift.removed.push({
        kind: change.type,
        id,
        lines: before ?? 0,
      });
      log(TAG, `removed ${change.type}`, { id, lines: before });
    } else {
      // Try to find the node
      const node = nodeById.get(id);
      if (!node) {
        // Node not in v2 model (only applies to removed changes, but just in case)
        continue;
      }

      // Determine drift mark
      let mark: DriftMark;
      if (kind === 'renamed') {
        mark = 'renamed';
      } else if (kind === 'added') {
        mark = 'added';
      } else if (kind === 'modified') {
        // Check rule for grew/shrank pattern
        if (rule.includes('-grew')) {
          mark = 'grew';
        } else if (rule.includes('-shrank')) {
          mark = 'shrank';
        } else {
          mark = 'changed';
        }
      } else {
        // Unknown kind, skip
        continue;
      }

      // Apply mark
      node.drift = mark;
      log(TAG, `drift · ${id}`, { mark });
    }
  }

  return model;
}

// Node kinds a finding can route directly onto by self-id-equality. 'file' is the original
// (pre-P6-T10) routable kind. 'function'/'method'/'class' are added for P6-T10: check.ts's
// claim-mode rules (component-claim-conflict, shared-auto, unassigned-code) key their findings as
// `${file}#${name}` — the exact id scheme view/model.ts's buildFileElements uses for individual
// code-element nodes (kind 'function'/'method'/'class'), including the ones reused as children of
// the claim-mode 'slice'/'shared'/'unassigned' container nodes (see model.ts's buildSliceNodes /
// buildSharedUnassignedNodes). The 'slice'/'shared'/'unassigned' container kinds themselves are
// deliberately NOT in this set: their own ids (`${componentId}::slice::${file}`,
// `${systemId}::shared`, `${systemId}::unassigned`) never equal any id check.ts's rules produce, so
// adding them would be dead code. See the P6-T10 handback discussion for the full trace.
const ROUTABLE_KINDS = new Set(['file', 'function', 'method', 'class']);

/**
 * Apply plan findings to the ViewModel.
 * Findings whose id equals a routable node's id (file, or a function/method/class code-element
 * node — see ROUTABLE_KINDS) → that node's findings array.
 * All others (including split-file's bare file id with no single owning node in claim mode, and a
 * file/folder-level component-claim-conflict with fn === null) → planFindings array. That fallthrough
 * is intentional, not a gap: a split file legitimately has multiple slice nodes (one per owner), so
 * there's no single node it belongs on.
 * Pure; mutates and returns the model.
 */
export function applyFindings(
  model: ViewModel,
  findings: PlanFinding[]
): ViewModel {
  // Build id → node map and also collect routable node ids
  const nodeById = new Map<string, ViewNode>();
  const routableNodeIds = new Set<string>();

  function walk(node: ViewNode) {
    nodeById.set(node.id, node);
    if (ROUTABLE_KINDS.has(node.kind)) {
      routableNodeIds.add(node.id);
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(model.root);

  // Initialize planFindings if not already done
  if (!model.planFindings) {
    model.planFindings = [];
  }

  // Apply findings
  for (const finding of findings) {
    if (routableNodeIds.has(finding.id)) {
      // Routable node finding (file, or a function/method/class code element)
      const node = nodeById.get(finding.id);
      if (node) {
        if (!node.findings) {
          node.findings = [];
        }
        node.findings.push({
          severity: finding.severity,
          rule: finding.rule,
          message: finding.message,
        });
        log(TAG, `finding on node · ${finding.id}`, { rule: finding.rule, kind: node.kind });
      }
    } else {
      // Plan element finding
      model.planFindings.push({
        severity: finding.severity,
        rule: finding.rule,
        message: finding.message,
      });
      log(TAG, `planFinding · ${finding.id}`, { rule: finding.rule });
    }
  }

  return model;
}
