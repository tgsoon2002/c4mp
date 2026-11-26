import { buildViewModel } from '../view/model';
import type { ViewModel } from '../types';
import type { QueryContext } from './context';
import { closestItems, lookupElement } from '../util/lookup';
import type { LookupItem, LookupTier } from '../util/lookup';
import { collectItems } from './showElement';

/** One element a query can name: id/uid/title/level of a system, container or component node. */
export interface ElementMatch {
  id: string;
  uid?: string;
  title: string;
  level: string;
}

export interface ElementResolution {
  matches: ElementMatch[];
  tier: LookupTier | null;
}

const models = new WeakMap<QueryContext, ViewModel>();

/**
 * The view model of ctx (pure: no layout, no render, no disk write), built once per context.
 * The summary line is '' because only `ViewModel.summary` uses it (proved in test/query-elements.test.ts).
 */
export function getModel(ctx: QueryContext): ViewModel {
  let model = models.get(ctx);
  if (!model) {
    model = buildViewModel(ctx.snapshot, '', ctx.plan ?? undefined);
    models.set(ctx, model);
  }
  return model;
}

function lookupItems(ctx: QueryContext): LookupItem[] {
  return collectItems(getModel(ctx).root).map((c) => c.item);
}

function toMatch(item: LookupItem): ElementMatch {
  return { id: item.id, ...(item.uid !== undefined ? { uid: item.uid } : {}), title: item.title, level: item.level };
}

/** Find elements by uid, id, fqn, local id or title (precedence is `lookupElement`'s). */
export function resolveElementId(ctx: QueryContext, input: string): ElementResolution {
  const result = lookupElement(input, lookupItems(ctx));
  return { matches: result.matches.map(toMatch), tier: result.tier };
}

/** Suggestions for an input that matched nothing (`closestItems`). */
export function closestIds(ctx: QueryContext, input: string, n = 5): ElementMatch[] {
  return closestItems(input, lookupItems(ctx), n).map(toMatch);
}
