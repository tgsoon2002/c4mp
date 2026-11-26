import type { ViewEdge, ViewNode } from '../types';

// P14-I14: lift component-level edges to the children of their lowest common ancestor.
// Pure: no I/O, no log. Used by the layered arrangement (P14-I15/I16) to order siblings.

export interface SiblingPair { from: number; to: number; weight: number; }   // child indexes in parent.children

// Every node id -> its ancestor chain from root down to the node itself (inclusive).
// Duplicate ids (known LTS issue, P14-I12/I13): the first node seen in tree order wins.
function pathsOf(root: ViewNode): Map<string, ViewNode[]> {
  const paths = new Map<string, ViewNode[]>();
  const walk = (node: ViewNode, trail: ViewNode[]): void => {
    const path = [...trail, node];
    if (!paths.has(node.id)) paths.set(node.id, path);
    for (const child of node.children) walk(child, path);
  };
  walk(root, []);
  return paths;
}

export function siblingEdges(root: ViewNode, edges: ViewEdge[]): Map<ViewNode, SiblingPair[]> {
  const paths = pathsOf(root);
  const acc = new Map<ViewNode, Map<string, SiblingPair>>();
  for (const edge of edges) {
    const pa = paths.get(edge.from);
    const pb = paths.get(edge.to);
    if (!pa || !pb) continue;                           // unknown endpoint: drop
    let shared = 0;                                     // number of common ancestors (root is always one)
    while (shared < pa.length && shared < pb.length && pa[shared] === pb[shared]) shared++;
    if (shared === pa.length || shared === pb.length) continue;   // same node, or one is an ancestor of the other
    const parent = pa[shared - 1];                      // lowest common ancestor
    const from = parent.children.indexOf(pa[shared]);
    const to = parent.children.indexOf(pb[shared]);
    let pairs = acc.get(parent);
    if (!pairs) {
      pairs = new Map<string, SiblingPair>();
      acc.set(parent, pairs);
    }
    const key = `${from}>${to}`;
    const hit = pairs.get(key);
    if (hit) hit.weight += edge.weight;
    else pairs.set(key, { from, to, weight: edge.weight });
  }
  const out = new Map<ViewNode, SiblingPair[]>();
  for (const [parent, pairs] of acc) {
    out.set(parent, [...pairs.values()].sort((a, b) => a.from - b.from || a.to - b.to));
  }
  return out;
}
