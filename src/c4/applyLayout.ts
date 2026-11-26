import * as fs from 'fs';
import { editMetadataBatch, type MetaEdit } from './editMeta';
import { localId, SYSTEM_ID_QUALIFIER, toId } from '../names';
import { log } from '../log';
import type { Plan, PlanElement } from '../types';

/**
 * `c4pm plan apply-layout`: writes the viewer's exported layout (version 2) into the `layout`
 * metadata of the matching elements of the repo's own .c4 files.
 *
 * ViewNode id -> plan element, mirroring src/view/model.ts (claim mode):
 *   1. exact plan element fqn (component nodes, and plan-only containers keyed by fqn);
 *   2. container nodes backed by a folder/manifest container carry the BARE id, matched like
 *      buildClaimModeContainers: the plan container whose localId(fqn) equals the id
 *      (ambiguous when several containers share a localId -> skipped, never guessed);
 *   3. the system node id is toId(repoName); no formal link to the plan, so a plan system
 *      element matches when toId(fqn) or toId(title) equals the id.
 * Anything else (slices `...::slice::...`, `::shared`, `::unassigned`, files, functions,
 * stale ids) is reported as skipped.
 *
 * Only .c4 files already referenced by the plan (PlanElement.source.file) are edited;
 * no file is ever created. This file writes nothing: planLayoutEdits returns the new texts and
 * the service (src/services/planFileEdits.ts applyLayoutService) writes them through runWrite.
 */

export interface LayoutNode {
  bx?: number | null;
  by?: number | null;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}
export interface LayoutFile {
  version: 2;
  /** `null` removes the element's `layout` metadata (back to auto). */
  nodes: Record<string, LayoutNode | null>;
}

export interface ApplyLayoutEdit {
  nodeId: string;
  element: string;
  value: string;
}
export interface ApplyLayoutReport {
  dryRun: boolean;
  /** Repo-relative files written (or that would be written in a dry run), with their edits. */
  files: { file: string; edits: ApplyLayoutEdit[] }[];
  applied: number;
  unchanged: number;
  skipped: { nodeId: string; reason: string }[];
  failed: { nodeId: string; reason: string }[];
}

/** Parse and validate the layout file text; throws a clear Error when unusable. */
export function parseLayoutFile(text: string): LayoutFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`layout file is not valid JSON: ${(err as Error).message}`);
  }
  const obj = data as { version?: unknown; nodes?: unknown };
  if (!obj || typeof obj !== 'object' || obj.version !== 2) {
    throw new Error(
      `unsupported layout version: ${JSON.stringify((obj as any)?.version)} (expected 2)`
    );
  }
  if (!obj.nodes || typeof obj.nodes !== 'object' || Array.isArray(obj.nodes)) {
    throw new Error('layout file has no "nodes" object');
  }
  return obj as LayoutFile;
}

export function readLayoutFile(file: string): LayoutFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`cannot read layout file: ${file}`);
  }
  return parseLayoutFile(text);
}

/**
 * Map a viewer node id to one plan element, or a reason it cannot be mapped.
 * `kind` (the node's kind, optional) keeps a container whose scan id equals the system fqn from
 * mapping to the system: an exact id match must have that kind, and the container / system
 * fallbacks run only for their own kind. Without `kind` the lookup is as before.
 */
export function mapNodeToElement(
  plan: Plan,
  rawNodeId: string,
  kind?: string
): { element: PlanElement } | { reason: string } {
  const nodeId = rawNodeId.endsWith(SYSTEM_ID_QUALIFIER) ? rawNodeId.slice(0, -SYSTEM_ID_QUALIFIER.length) : rawNodeId;
  if (nodeId !== rawNodeId) log('applyLayout', 'qualified system id mapped by bare id', { rawNodeId, nodeId });
  const exact = plan.elements.find(e => e.id === nodeId && (!kind || e.kind === kind));
  if (exact) return { element: exact };

  const containers = !kind || kind === 'container'
    ? plan.elements.filter(e => e.kind === 'container' && localId(e.id) === nodeId)
    : [];
  if (containers.length === 1) return { element: containers[0] };
  if (containers.length > 1) {
    return { reason: `ambiguous: ${containers.map(c => c.id).join(', ')} all have local id "${nodeId}"` };
  }

  const systems = !kind || kind === 'system'
    ? plan.elements.filter(e => e.kind === 'system' && (toId(e.id) === nodeId || toId(e.title) === nodeId))
    : [];
  if (systems.length === 1) return { element: systems[0] };
  if (systems.length > 1) {
    return { reason: `ambiguous: systems ${systems.map(s => s.id).join(', ')} match "${nodeId}"` };
  }
  return { reason: 'no plan element for this id (slice, file, function, or not in the .c4 plan)' };
}

function layoutValue(n: LayoutNode): string {
  const num = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
    return Math.round(v);
  };
  const hasB = n.bx != null || n.by != null;
  const b = hasB ? `${num(n.bx, 'bx')},${num(n.by, 'by')}` : '';
  return `${b};${num(n.rx, 'rx')},${num(n.ry, 'ry')},${num(n.rw, 'rw')},${num(n.rh, 'rh')}`;
}

export function planLayoutEdits(
  plan: Plan,
  texts: Map<string, string>,
  layout: LayoutFile,
): { report: ApplyLayoutReport; newTexts: Map<string, string> } {
  const report: ApplyLayoutReport = { dryRun: false, files: [], applied: 0, unchanged: 0, skipped: [], failed: [] };

  const current = new Map<string, string>(texts); // repo-relative file -> text after the edits
  const edits = new Map<string, ApplyLayoutEdit[]>();

  // b721: one slot per mapped node in layout order; the edits are grouped per file and applied in one pass each.
  type Slot = { nodeId: string; failed: string } | { nodeId: string; element: string; value: string; file: string; edit: number };
  const slots: Slot[] = [];
  const perFile = new Map<string, MetaEdit[]>();
  for (const [nodeId, node] of Object.entries(layout.nodes)) {
    const mapped = mapNodeToElement(plan, nodeId);
    if ('reason' in mapped) {
      report.skipped.push({ nodeId, reason: mapped.reason });
      continue;
    }
    const el = mapped.element;
    try {
      const value = node === null ? '' : layoutValue(node);
      const file = el.source.file;
      if (!texts.has(file)) throw new Error(`plan file not loaded: ${file}`);
      const batch = perFile.get(file) ?? [];
      perFile.set(file, batch);
      slots.push({ nodeId, element: el.id, value, file, edit: batch.length });
      batch.push({ fqn: el.id, key: 'layout', value: node === null ? null : value });
    } catch (err) {
      slots.push({ nodeId, failed: (err as Error).message });
    }
  }

  const done = new Map<string, ReturnType<typeof editMetadataBatch>>();
  for (const [file, batch] of perFile) {
    const r = editMetadataBatch(texts.get(file)!, batch);
    current.set(file, r.text);
    done.set(file, r);
  }
  for (const s of slots) {
    if ('failed' in s) {
      report.failed.push({ nodeId: s.nodeId, reason: s.failed });
      continue;
    }
    const r = done.get(s.file)!;
    const error = r.errors[s.edit];
    if (error !== null) {
      report.failed.push({ nodeId: s.nodeId, reason: error });
    } else if (r.results[s.edit]) {
      report.applied++;
      if (!edits.has(s.file)) edits.set(s.file, []);
      edits.get(s.file)!.push({ nodeId: s.nodeId, element: s.element, value: s.value });
    } else {
      report.unchanged++;
    }
  }

  for (const [file, text] of current) {
    if (text === texts.get(file)) continue;
    report.files.push({ file, edits: edits.get(file) ?? [] });
  }
  return { report, newTexts: current };
}

export function formatApplyLayoutReport(r: ApplyLayoutReport): string {
  const lines: string[] = [];
  for (const f of r.files) {
    lines.push(`${r.dryRun ? 'would write' : 'wrote'} ${f.file}`);
    for (const e of f.edits) lines.push(e.value === '' ? `  ${e.element}  layout removed` : `  ${e.element}  layout '${e.value}'`);
  }
  for (const s of r.skipped) lines.push(`skipped ${s.nodeId}: ${s.reason}`);
  for (const f of r.failed) lines.push(`failed ${f.nodeId}: ${f.reason}`);
  lines.push(
    `${r.dryRun ? '(dry run) ' : ''}applied ${r.applied}, unchanged ${r.unchanged}, skipped ${r.skipped.length}, failed ${r.failed.length}`
  );
  return lines.join('\n');
}
