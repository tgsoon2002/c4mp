/**
 * P9: the one way to walk a ViewNode tree. Pre-order (a node before its children, children in array order), so a
 * callback that adds children to the node it is given sees those children visited next. No early exit: a walk that
 * must stop early or skip a subtree stays hand-written.
 */
import type { ViewModel, ViewName, ViewNode } from '../types';

/**
 * Phase 28 LK-G: the nodes directly below `node` for a walk that visits every element: its subregions (notation drawn as
 * frames, not children; they have no children of their own), then its children. Just `children` when it has no subregions.
 */
export function nodesBelow(node: ViewNode): ViewNode[] {
  return node.subregions ? [...node.subregions, ...node.children] : node.children;
}

/** Call `fn` on `root` and every node below it (nodesBelow: a container's subregions too), parents first. */
export function forEachNode(root: ViewNode, fn: (n: ViewNode) => void): void {
  fn(root);
  nodesBelow(root).forEach((c) => forEachNode(c, fn));
}

/** Phase 28 LK-G: the components of subregion `subregionId` of `container`: its children whose `subregion` is that id, in child order. */
export function subregionMembers(container: ViewNode, subregionId: string): ViewNode[] {
  return container.children.filter((c) => c.subregion === subregionId);
}

/**
 * Ids of the node and everything below it (same as the viewer's `subtreeIds`). A node whose id was already seen is
 * not entered again, so a repeated id does not repeat its subtree.
 */
export function subtreeIds(node: ViewNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: ViewNode): void => {
    if (ids.has(n.id)) return;
    ids.add(n.id);
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

/** The three view trees of a page in lookup order (arch, IO, storage), the absent ones left out. */
export function viewRoots(model: ViewModel): [ViewName, ViewNode][] {
  const roots: [ViewName, ViewNode | undefined][] = [['arch', model.root], ['io', model.navView?.root], ['storage', model.storageView?.root]];
  return roots.filter((r): r is [ViewName, ViewNode] => r[1] !== undefined);
}

/**
 * Phase 25 (S4): uid -> node over the arch, IO and storage trees (forEachNode: subregions too). The first node with a uid
 * keeps it, so an arch uid wins on a clash (the attachBoard rule). attachBoard and buildViewSims use it.
 */
export function uidIndex(model: ViewModel): Map<string, { node: ViewNode; view: ViewName }> {
  const index = new Map<string, { node: ViewNode; view: ViewName }>();
  for (const [view, root] of viewRoots(model)) {
    forEachNode(root, (node) => {
      if (node.uid !== undefined && !index.has(node.uid)) index.set(node.uid, { node, view });
    });
  }
  return index;
}

/**
 * Phase 25 (S4): node.id and node.planId -> node over the same trees in the same order (arch, IO, storage), first wins;
 * `parent` = the node above it in its tree (a subregion's container), null for a root. For targets without a uid.
 */
export function idIndex(model: ViewModel): Map<string, { node: ViewNode; view: ViewName; parent: ViewNode | null }> {
  const index = new Map<string, { node: ViewNode; view: ViewName; parent: ViewNode | null }>();
  for (const [view, root] of viewRoots(model)) {
    const parentOf = new Map<ViewNode, ViewNode>();
    forEachNode(root, (node) => {
      nodesBelow(node).forEach((c) => parentOf.set(c, node));   // pre-order: set before the child is visited
      const entry = { node, view, parent: parentOf.get(node) ?? null };
      for (const key of [node.id, node.planId]) if (key !== undefined && !index.has(key)) index.set(key, entry);
    });
  }
  return index;
}
