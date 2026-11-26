import type { Plan, PlanElement, PlanTest } from '../types';
import { TEST_NAME_SEP } from '../languages/typescript/tests';

// Phase 26 (T26-13, Document/Roadmap/Phase26/ATTACH-DESIGN.md B.5, B.8): test blocks of the plan (D16) and their match
// to detected test cases. Pure: no I/O. A test block is an accessory of its parent element (D15): it has no uid and is
// keyed by parent fqn + name.

/** Leaf of a test case name: the text after the last ` › ` (the whole name when it has none). */
export function leafOf(name: string): string {
  const i = name.lastIndexOf(TEST_NAME_SEP);
  return i < 0 ? name : name.slice(i + TEST_NAME_SEP.length);
}

/**
 * A9: the detected case a planned test names. Exact, case-sensitive, trimmed: (1) the full chain equals the planned
 * name; else (2) the leaf equals it and no other candidate has that leaf. null when nothing (or more than one) matches.
 */
export function matchPlannedTest<C extends { name: string }>(t: Pick<PlanTest, 'name'>, candidates: C[]): C | null {
  const want = t.name.trim();
  const full = candidates.find(c => c.name.trim() === want);
  if (full) return full;
  const leaves = candidates.filter(c => leafOf(c.name).trim() === want);
  return leaves.length === 1 ? leaves[0] : null;
}

/** Test blocks of `el` and of its plan descendants (fqn prefix), each with its parent fqn, in plan order. */
export function plannedTestsUnder(plan: Plan, el: PlanElement): { parent: string; test: PlanTest }[] {
  return plan.elements
    .filter(e => e.id === el.id || e.id.startsWith(el.id + '.'))
    .flatMap(e => (e.tests ?? []).map(test => ({ parent: e.id, test })));
}

/** A test block named by the gate and by `plan remove --test`: parent fqn + test name. */
export interface TestBlockKey { parent: string; name: string }

/**
 * A8: test blocks of `before` with no block of the same name under the same parent in `after`. The parent fqn goes
 * through `mapFqn` first (plan move / rename), so blocks that travel with their element are not lost. Blocks of an
 * element in `skipParents` (an allowed element removal) are not counted. Each block counts once (names may repeat).
 */
export function lostTestBlocks(
  before: Plan,
  after: Plan,
  opts: { mapFqn?: (fqn: string) => string; skipParents?: Set<string> } = {},
): TestBlockKey[] {
  const left = new Map<string, number>();
  const key = (parent: string, name: string): string => `${parent}\0${name}`;
  for (const e of after.elements) for (const t of e.tests ?? []) left.set(key(e.id, t.name), (left.get(key(e.id, t.name)) ?? 0) + 1);
  const lost: TestBlockKey[] = [];
  for (const e of before.elements) {
    if (opts.skipParents?.has(e.id)) continue;
    const parent = opts.mapFqn ? opts.mapFqn(e.id) : e.id;
    for (const t of e.tests ?? []) {
      const n = left.get(key(parent, t.name)) ?? 0;
      if (n > 0) left.set(key(parent, t.name), n - 1);
      else lost.push({ parent: e.id, name: t.name });
    }
  }
  return lost;
}
