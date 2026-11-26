// b500: moved from src/query/ to Foundation helpers; pure (names.ts and a type only), used by Query, Plan editing,
// Board editing and the board CLI.
import { localId } from '../names';
import { levenshtein } from './text';

import type { LookupItem } from '../types';

/** b484: the type is Foundation's (src/types.ts); re-exported for the callers that import it here. */
export type { LookupItem };

export type LookupTier = 'uid' | 'id' | 'fqn' | 'localId' | 'title';

export interface LookupResult {
  matches: LookupItem[];
  tier: LookupTier | null;
}

export interface LookupOptions {
  /** Return the union of tiers 2-5 (used by `remove`). A uid match still returns only the uid item. */
  all?: boolean;
}

export type PickResult =
  | { ok: true; item: LookupItem }
  | { ok: false; reason: 'none' | 'ambiguous'; matches: LookupItem[] };

interface Tier {
  tier: LookupTier;
  matches: (item: LookupItem, query: string) => boolean;
}

// Order matters: the first tier with a match wins (unless `all` is set).
const TIERS: Tier[] = [
  { tier: 'uid', matches: (item, q) => item.uid === q },
  { tier: 'id', matches: (item, q) => item.id === q },
  { tier: 'fqn', matches: (item, q) => item.fqn === q },
  { tier: 'localId', matches: (item, q) => localId(item.fqn ?? item.id) === q },
  { tier: 'title', matches: (item, q) => item.title.toLowerCase() === q.toLowerCase() },
];

function byId(a: LookupItem, b: LookupItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Find elements by uid, id, fqn, local id or title.
 * Default: the first tier with at least one match wins and returns all its matches.
 * `all: true`: a uid match still wins alone; otherwise the de-duplicated union of tiers 2-5.
 */
export function lookupElement(query: string, items: LookupItem[], opts: LookupOptions = {}): LookupResult {
  if (!query || !query.trim()) return { matches: [], tier: null };

  const uidTier = TIERS[0];
  const uidHits = items.filter((item) => uidTier.matches(item, query));
  if (uidHits.length > 0) return { matches: uidHits.sort(byId), tier: 'uid' };

  if (!opts.all) {
    for (const t of TIERS) {
      const hits = items.filter((item) => t.matches(item, query));
      if (hits.length > 0) return { matches: hits.sort(byId), tier: t.tier };
    }
    return { matches: [], tier: null };
  }

  const picked = new Set<number>();
  let best: LookupTier | null = null;
  TIERS.forEach((t, tierIndex) => {
    if (tierIndex === 0) return;
    items.forEach((item, i) => {
      if (!t.matches(item, query)) return;
      if (best === null) best = t.tier;
      picked.add(i);
    });
  });
  const matches = [...picked].map((i) => items[i]).sort(byId);
  return { matches, tier: matches.length > 0 ? best : null };
}

/** ok only when exactly one match. */
export function pickOne(result: LookupResult): PickResult {
  if (result.matches.length === 1) return { ok: true, item: result.matches[0] };
  return {
    ok: false,
    reason: result.matches.length === 0 ? 'none' : 'ambiguous',
    matches: result.matches,
  };
}

/**
 * Suggestions for a query that matched nothing: items whose id or title contains the query
 * (sorted by id), then the rest by Levenshtein distance from the query to `id` (ties by id).
 */
export function closestItems(query: string, items: LookupItem[], n = 5): LookupItem[] {
  const q = query.toLowerCase();
  const contains: LookupItem[] = [];
  const rest: { item: LookupItem; dist: number }[] = [];
  for (const item of items) {
    if (item.id.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)) {
      contains.push(item);
    } else {
      rest.push({ item, dist: levenshtein(query, item.id) });
    }
  }
  contains.sort(byId);
  rest.sort((a, b) => a.dist - b.dist || byId(a.item, b.item));
  return [...contains, ...rest.map((r) => r.item)].slice(0, n);
}
