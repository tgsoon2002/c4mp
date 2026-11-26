export interface FindCyclesOptions {
  /** Stop after this many cycles (default 100). */
  maxCycles?: number;
  /** Stop after this many edge visits (default 200000). */
  maxSteps?: number;
}

export interface FindCyclesResult {
  cycles: string[][];
  /** True when the search stopped at `maxCycles` or `maxSteps`: more cycles may exist. */
  truncated: boolean;
}

export const DEFAULT_MAX_CYCLES = 100;
export const DEFAULT_MAX_STEPS = 200000;

/**
 * Elementary cycles of a directed graph, each reported once, as the ids in walk order starting from the
 * smallest id (plain string comparison). A self edge `a -> a` is a cycle of length 1. Edges that name a node
 * not in `nodes` are ignored. Pure and generic (no board types): nesting (`parent`) and `dependsOn` both use it.
 * The number of elementary cycles can explode (a complete graph of 12 nodes has millions), so the search is
 * capped: it stops at `maxCycles` cycles or `maxSteps` edge visits and then reports `truncated: true`.
 * Within the caps the result is exact.
 */
export function findCycles(nodes: string[], edges: [string, string][], opts: FindCyclesOptions = {}): FindCyclesResult {
  const maxCycles = opts.maxCycles ?? DEFAULT_MAX_CYCLES;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const sorted = [...new Set(nodes)].sort();
  const known = new Set(sorted);
  const next = new Map<string, string[]>();
  for (const id of sorted) next.set(id, []);
  for (const [from, to] of edges) {
    if (!known.has(from) || !known.has(to)) continue;
    const list = next.get(from)!;
    if (!list.includes(to)) list.push(to);
  }
  for (const list of next.values()) list.sort();

  // Every cycle lies inside one strongly connected component, so the search below only walks inside the
  // component of its start node: a long chain (no cycle) costs nothing instead of O(n^2) edge visits.
  const comp = componentsOf(sorted, next)!;   // no tick: this pass is linear, O(nodes + edges)

  const cycles: string[][] = [];
  let steps = 0;
  let truncated = false;
  for (const start of sorted) {
    if (truncated) break;
    const mine = comp.get(start)!;
    if (mine.size === 1 && !next.get(start)!.includes(start)) continue;   // alone and no self edge: on no cycle
    // Iterative depth-first walk (no recursion: a chain or ring of 20000 items must not overflow the call stack).
    // `frames[k]` = position in the successor list of `path[k]`.
    const path: string[] = [start];
    const frames: number[] = [0];
    const onPath = new Set<string>([start]);
    while (path.length > 0 && !truncated) {
      const k = path.length - 1;
      const succ = next.get(path[k])!;
      if (frames[k] >= succ.length) {
        onPath.delete(path[k]);
        path.pop();
        frames.pop();
        continue;
      }
      const to = succ[frames[k]++];
      if (++steps > maxSteps) { truncated = true; break; }
      if (to === start) {
        if (cycles.length >= maxCycles) { truncated = true; break; }
        cycles.push([...path]);
        continue;
      }
      if (to < start || onPath.has(to) || !mine.has(to)) continue;   // smaller ids belong to a cycle found from their own start
      path.push(to);
      frames.push(0);
      onPath.add(to);
    }
    // `start` is finished: no later start may use it. Split its component again without it, so the nodes
    // that were only on cycles through `start` become trivial and later starts skip them (a 20000 ring
    // costs one walk, not 20000).
    if (!truncated && mine.size > 1) {
      const rest = new Set(mine);
      rest.delete(start);
      const split = componentsOf([...rest].sort(), next, rest, () => ++steps <= maxSteps);
      if (split === null) truncated = true;
      else for (const [node, members] of split) comp.set(node, members);
    }
  }
  return { cycles, truncated };
}

/**
 * Strongly connected components (iterative Tarjan, no recursion). Returns, for each node, the Set of the nodes
 * of its component (the same Set object for all members).
 */
function componentsOf(
  nodes: string[], next: Map<string, string[]>, allowed: Set<string> | null = null, tick: () => boolean = () => true,
): Map<string, Set<string>> | null {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, Set<string>>();
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: string; pos: number }[] = [{ node: root, pos: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const succ = next.get(top.node)!;
      if (top.pos < succ.length) {
        const to = succ[top.pos++];
        if (allowed !== null && !allowed.has(to)) continue;
        if (!tick()) return null;   // edge budget used up
        if (!index.has(to)) {
          index.set(to, counter); low.set(to, counter); counter++;
          stack.push(to); onStack.add(to);
          work.push({ node: to, pos: 0 });
        } else if (onStack.has(to)) {
          low.set(top.node, Math.min(low.get(top.node)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === index.get(top.node)) {
        const members = new Set<string>();
        let m: string;
        do {
          m = stack.pop()!;
          onStack.delete(m);
          members.add(m);
        } while (m !== top.node);
        for (const x of members) result.set(x, members);
      }
    }
  }
  return result;
}
