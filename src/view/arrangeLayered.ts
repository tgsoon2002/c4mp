import { Arrangement, HEAD, PAD, SLOT, Slot, SlotSize } from './arrange';

// P14-I15: layered arrangement. Positions follow edge direction. Slots only: no W/H, no aspect rule
// (regionFromSlots sizes the region; layoutTree applies the aspect cap/floor, P14-I16).

export interface LayerPair { from: number; to: number; weight: number }

// Ranks and per-rank node order. order[r] lists the node indices of rank r, left to right.
export function rankNodes(count: number, pairs: LayerPair[]): { rank: number[]; order: number[][] } {
  const out: number[][] = Array.from({ length: count }, () => []);
  for (const p of pairs) out[p.from].push(p.to);

  // Cycle breaking: DFS in index order. An edge into a node still on the stack closes a cycle and is ignored.
  const state: number[] = new Array(count).fill(0); // 0 new, 1 on stack, 2 done
  const dagOut: number[][] = Array.from({ length: count }, () => []);
  const dagIn: number[][] = Array.from({ length: count }, () => []);
  const post: number[] = [];
  const visit = (v: number): void => {
    state[v] = 1;
    for (const w of out[v]) {
      if (state[w] === 1) continue;
      dagOut[v].push(w);
      dagIn[w].push(v);
      if (state[w] === 0) visit(w);
    }
    state[v] = 2;
    post.push(v);
  };
  for (let v = 0; v < count; v++) if (state[v] === 0) visit(v);

  // Rank = longest path from a source (rank 0). Reverse post-order is a topological order of the DAG.
  const rank: number[] = new Array(count).fill(0);
  for (let i = post.length - 1; i >= 0; i--) {
    const v = post[i];
    for (const w of dagOut[v]) rank[w] = Math.max(rank[w], rank[v] + 1);
  }

  const maxRank = count === 0 ? -1 : Math.max(...rank);
  const order: number[][] = [];
  for (let r = 0; r <= maxRank; r++) {
    order.push(indicesWithRank(rank, r));
  }

  // Ordering: 4 down+up sweeps. Each node is sorted by the mean position of its neighbours in the adjacent rank
  // (its own position when it has none). Ties by index.
  const pos: number[] = new Array(count).fill(0);
  const refreshPos = (): void => order.forEach(nodes => nodes.forEach((v, i) => { pos[v] = i; }));
  refreshPos();
  const sortRank = (r: number, adjacentRank: number, linked: number[][]): void => {
    const keyOf = (v: number): number => {
      const nb = linked[v].filter(u => rank[u] === adjacentRank);
      if (nb.length === 0) return pos[v];
      return nb.reduce((sum, u) => sum + pos[u], 0) / nb.length;
    };
    const keyed = order[r].map(v => ({ v, key: keyOf(v) }));
    keyed.sort((a, b) => a.key - b.key || a.v - b.v);
    order[r] = keyed.map(k => k.v);
    refreshPos();
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let r = 1; r <= maxRank; r++) sortRank(r, r - 1, dagIn);
    for (let r = maxRank - 1; r >= 0; r--) sortRank(r, r + 1, dagOut);
  }

  return { rank, order };
}

function indicesWithRank(rank: number[], r: number): number[] {
  const nodes: number[] = [];
  rank.forEach((rv, v) => { if (rv === r) nodes.push(v); });
  return nodes;
}

// Returns null only when there are no pairs. slots[i] is the slot of node i.
export function arrangeLayered(count: number, pairs: LayerPair[], slot: SlotSize = SLOT): Arrangement | null {
  if (pairs.length === 0) return null;
  const { order } = rankNodes(count, pairs);
  const maxRowCount = Math.max(...order.map(nodes => nodes.length));
  const slots: Slot[] = new Array(count);
  order.forEach((nodes, row) => {
    nodes.forEach((v, col) => {
      slots[v] = {
        x: PAD + col * slot.w + ((maxRowCount - nodes.length) * slot.w) / 2,
        y: HEAD + PAD + row * slot.h,
      };
    });
  });
  return { slots };
}
