import type { Plan, PlanElement, PlanLink } from '../types';
import { log } from '../log';

// Plan element kinds that describe code (nested under a component). Single source for check and model.
export const PLANNED_CODE_KINDS = ['function', 'class', 'method', 'type'];

export interface PlannedCode {
  element: PlanElement;
  kind: string;
  name: string;                  // element.title: the code name
  status: string | undefined;    // element.metadata.status, no default
  signature?: string;            // element.metadata.signature
  purpose?: string;              // element.metadata.purpose
  link?: PlanLink;               // first link that names a function/class/type
  parentComponent: string;       // fqn of the nearest ancestor whose kind is not a code kind
}

/** Planned code elements of a plan, sorted by fqn. Pure: no I/O. */
export function extractPlannedCode(plan: Plan): PlannedCode[] {
  const byId = new Map<string, PlanElement>();
  for (const el of plan.elements) byId.set(el.id, el);

  const out: PlannedCode[] = [];
  for (const el of plan.elements) {
    if (!PLANNED_CODE_KINDS.includes(el.kind)) continue;
    out.push({
      element: el,
      kind: el.kind,
      name: el.title,
      status: el.metadata.status,
      signature: el.metadata.signature,
      purpose: el.metadata.purpose,
      link: el.links.find(l => l.name !== null),
      parentComponent: nearestComponent(el, byId),
    });
  }
  return out.sort((a, b) => (a.element.id < b.element.id ? -1 : a.element.id > b.element.id ? 1 : 0));
}

/** What the map offers as parents for planned code. Built by the caller from the model. */
export interface ParentCtx {
  nodeIds: Set<string>;          // component-level node ids in the model (claim-mode and plan-only carry the plan fqn; folder-mode carry folder ids)
  fileNodeIds: Set<string>;      // file node ids in the model (repo-relative paths)
  components: { id: string; path: string }[];   // path: repo-relative dir; '' means the repo root
  parentLinkPaths: (parentComponent: string) => string[];   // PlanLink.path values of the parent plan component
}

export type PlannedParentVia = 'fqn' | 'file' | 'folder' | 'parent-link';

/**
 * Where a planned element hangs on the map. First match wins:
 * fqn of the parent node, then the linked file node, then the longest folder prefix of the link,
 * then the same prefix test on the parent component's links. Pure: no I/O.
 */
export function resolvePlannedParent(
  p: PlannedCode,
  ctx: ParentCtx,
): { parentId: string; via: PlannedParentVia } | null {
  const decide = (parentId: string, via: PlannedParentVia) => {
    log('planned', 'parent', { fqn: p.element.id, parentId, via });
    return { parentId, via };
  };

  if (ctx.nodeIds.has(p.parentComponent)) return decide(p.parentComponent, 'fqn');
  if (p.link && ctx.fileNodeIds.has(p.link.path)) return decide(p.link.path, 'file');
  if (p.link) {
    const folder = longestContaining(p.link.path, ctx.components);
    if (folder) return decide(folder.id, 'folder');
  }
  for (const linkPath of ctx.parentLinkPaths(p.parentComponent)) {
    const folder = longestContaining(linkPath, ctx.components);
    if (folder) return decide(folder.id, 'parent-link');
  }
  log('planned', 'parent none', { fqn: p.element.id, parentComponent: p.parentComponent });
  return null;
}

function longestContaining(
  filePath: string,
  components: { id: string; path: string }[],
): { id: string; path: string } | undefined {
  let best: { id: string; path: string } | undefined;
  for (const c of components) {
    if (!isUnderDir(filePath, c.path)) continue;
    if (!best || c.path.length > best.path.length) best = c;
  }
  return best;
}

// Path prefix on '/' boundaries: 'api/services' contains 'api/services/x.ts' but not 'api/services2/x.ts'.
function isUnderDir(filePath: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '');
  if (d === '') return true;
  const f = filePath.replace(/\/+$/, '');
  return f === d || f.startsWith(d + '/');
}

function nearestComponent(el: PlanElement, byId: Map<string, PlanElement>): string {
  let parentId = el.parent;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent) return parentId;
    if (!PLANNED_CODE_KINDS.includes(parent.kind)) return parent.id;
    parentId = parent.parent;
  }
  return '';
}
