import { log } from '../log';

export function findCycles(edges: { from: string; to: string }[]): string[] {
  // Build adjacency list
  const graph = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.from);
    allNodes.add(edge.to);
    if (!graph.has(edge.from)) {
      graph.set(edge.from, []);
    }
    graph.get(edge.from)!.push(edge.to);
  }

  // Initialize all nodes in graph
  for (const node of Array.from(allNodes)) {
    if (!graph.has(node)) {
      graph.set(node, []);
    }
  }

  // Tarjan's algorithm for strongly connected components
  let index = 0;
  const stack: string[] = [];
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowLinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    const neighbors = graph.get(v) || [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowLinks.set(v, Math.min(lowLinks.get(v)!, lowLinks.get(w)!));
      } else if (onStack.has(w)) {
        lowLinks.set(v, Math.min(lowLinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowLinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  // Run Tarjan's algorithm on all unvisited nodes
  for (const node of Array.from(allNodes)) {
    if (!indices.has(node)) {
      strongconnect(node);
    }
  }

  // Filter cycles (SCCs with 2+ nodes) and format them
  const cycles: string[] = [];
  for (const scc of sccs) {
    if (scc.length >= 2) {
      // Sort members using plain < comparison
      const sorted = [...scc].sort();
      const key = sorted.join(' <-> ');
      cycles.push(key);
      log('cycles', 'found SCC', { members: sorted, key });
    }
  }

  // Sort the cycle keys
  cycles.sort();

  return cycles;
}
