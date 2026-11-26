import { SLOT, regionFromSlots } from '../src/view/arrange';
import { arrangeLayered, rankNodes, LayerPair } from '../src/view/arrangeLayered';

// P14-I15: layered arrangement. Ranks and slots only; the aspect cap/floor is tested in I16.

const edge = (from: number, to: number): LayerPair => ({ from, to, weight: 1 });

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  a.x < b.x + SLOT.w && b.x < a.x + SLOT.w && a.y < b.y + SLOT.h && b.y < a.y + SLOT.h;

// Crossings between adjacent ranks. pos[v] = position of v inside its rank.
function countCrossings(pairs: LayerPair[], rank: number[], pos: number[]): number {
  const adj = pairs.filter(p => rank[p.to] === rank[p.from] + 1);
  let n = 0;
  for (let i = 0; i < adj.length; i++) {
    for (let j = i + 1; j < adj.length; j++) {
      const p = adj[i];
      const q = adj[j];
      if (rank[p.from] !== rank[q.from]) continue;
      if ((pos[p.from] - pos[q.from]) * (pos[p.to] - pos[q.to]) < 0) n++;
    }
  }
  return n;
}

// Positions of the index-ordered (unsorted) layout.
function initialPositions(rank: number[]): number[] {
  const pos: number[] = [];
  const seen: Record<number, number> = {};
  rank.forEach((r, v) => {
    pos[v] = seen[r] ?? 0;
    seen[r] = pos[v] + 1;
  });
  return pos;
}

function positionsOf(order: number[][]): number[] {
  const pos: number[] = [];
  order.forEach(nodes => nodes.forEach((v, i) => { pos[v] = i; }));
  return pos;
}

describe('rankNodes', () => {
  it('ranks a chain a->b->c as 0,1,2', () => {
    expect(rankNodes(3, [edge(0, 1), edge(1, 2)]).rank).toEqual([0, 1, 2]);
  });

  it('ranks a diamond with b and c in rank 1 and d in rank 2', () => {
    const pairs = [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3)];
    expect(rankNodes(4, pairs).rank).toEqual([0, 1, 1, 2]);
  });

  it('does not throw on a cycle a->b->a and still defines every rank', () => {
    const result = rankNodes(2, [edge(0, 1), edge(1, 0)]);
    expect(result.rank).toEqual([0, 1]);
    expect(result.order).toEqual([[0], [1]]);
  });

  it('ends with fewer crossings than the index order (a->d, b->c)', () => {
    const pairs = [edge(0, 3), edge(1, 2)];
    const { rank, order } = rankNodes(4, pairs);
    const before = countCrossings(pairs, rank, initialPositions(rank));
    const after = countCrossings(pairs, rank, positionsOf(order));
    expect(before).toBe(1);
    expect(after).toBeLessThan(before);
    expect(after).toBe(0);
  });
});

describe('arrangeLayered', () => {
  it('returns null when there are no pairs', () => {
    expect(arrangeLayered(3, [])).toBeNull();
  });

  it('fork a->b, a->c: region 660x404, a centred in row 0, b and c share a row', () => {
    const result = arrangeLayered(3, [edge(0, 1), edge(0, 2)])!;
    expect(result).not.toBeNull();
    expect(regionFromSlots(result.slots)).toEqual({ w: 660, h: 404 });
    expect(result.slots[0].y).toBeLessThan(result.slots[1].y);
    expect(result.slots[1].y).toBe(result.slots[2].y);
    expect(result.slots[0].x).toBe(180);
  });

  it('fork a->b, a->c, a->d: region 960x404', () => {
    const result = arrangeLayered(4, [edge(0, 1), edge(0, 2), edge(0, 3)])!;
    expect(result).not.toBeNull();
    expect(regionFromSlots(result.slots)).toEqual({ w: 960, h: 404 });
  });

  it('chain of 3: region 360x554', () => {
    const result = arrangeLayered(3, [edge(0, 1), edge(1, 2)])!;
    expect(result).not.toBeNull();
    expect(regionFromSlots(result.slots)).toEqual({ w: 360, h: 554 });
  });

  it('is deterministic', () => {
    const pairs = [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3)];
    expect(arrangeLayered(4, pairs)).toEqual(arrangeLayered(4, pairs));
  });

  it('places every slot inside its region with no overlaps', () => {
    const cases: { count: number; pairs: LayerPair[] }[] = [
      { count: 3, pairs: [edge(0, 1), edge(0, 2)] },
      { count: 4, pairs: [edge(0, 1), edge(0, 2), edge(0, 3)] },
      { count: 3, pairs: [edge(0, 1), edge(1, 2)] },
      { count: 4, pairs: [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3)] },
      { count: 4, pairs: [edge(0, 3), edge(1, 2)] },
      { count: 2, pairs: [edge(0, 1), edge(1, 0)] },
    ];
    for (const { count, pairs } of cases) {
      const result = arrangeLayered(count, pairs)!;
      expect(result).not.toBeNull();
      const { w, h } = regionFromSlots(result.slots);
      for (const s of result.slots) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x + SLOT.w).toBeLessThanOrEqual(w);
        expect(s.y + SLOT.h).toBeLessThanOrEqual(h);
      }
      for (let i = 0; i < result.slots.length; i++) {
        for (let j = i + 1; j < result.slots.length; j++) {
          expect(overlaps(result.slots[i], result.slots[j])).toBe(false);
        }
      }
    }
  });

  it('returns only slots (no w, h, cols, rows)', () => {
    const result = arrangeLayered(3, [edge(0, 1), edge(0, 2)])!;
    expect(Object.keys(result)).toEqual(['slots']);
  });
});
