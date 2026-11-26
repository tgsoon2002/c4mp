import type { ComponentEdge, PlanElement } from '../types';
import { layerIndex } from '../plan/layers';
import type { LayerIndex, LayerPlace } from '../plan/layers';
import { layersBetween, shortId } from '../c4/layerRoute';
import type { QueryContext } from './context';
import { closestIds, resolveElementId } from './elements';
import type { ElementMatch } from './elements';
import { callersOf } from './calls';
import { ownerOf } from './owner';
import { QueryError } from './errors';
import { CMD_NAME } from '../constants';

/**
 * b469: `c4pm plan path <from> <to>`: the layer-by-layer route from an entry component to a target (component or
 * function), read from the plan's subregion order (layerIndex) and the code arrows (snapshot.componentEdges; for a
 * function target, the traced callers). Read-only. Suggestions are ready-made `plan add` commands with the literal
 * placeholder `<name>`: the tool never guesses a name.
 */

/** One non-shared layer between `from` and `to`. */
export interface PathLayerRow {
  layer: string;
  layerTitle: string;
  rank: number;
  /**
   * Components of this layer that already call the target; weight = imports (component target) or calling functions
   * (function target), via = those functions (function target only). First: one the previous route step already calls.
   */
  callers: { component: string; weight: number; via: string[] }[];
  /** No component of this layer calls the target. */
  missing: boolean;
  /** missing only: components of this layer to put a new function in (those with arrows further down first). */
  candidates: string[];
}

export interface PathSuggestion { layer: string; parent: string | null; command: string; note: string }

export interface PathEnd {
  id: string;
  title: string;
  /** Its subregion (fqn) and its title, rank 0 = top; null when it is in none. */
  layer: string | null;
  layerTitle: string | null;
  rank: number | null;
  /** to only: the function the user named (the component is its owner). */
  function?: { file: string; name: string };
}

export type PathDirection = 'down' | 'same' | 'up' | 'shared' | 'unlayered' | 'other-container';

export interface PlanPathResult {
  from: PathEnd;
  to: PathEnd;
  /** The container of the stack (null for unlayered / other-container) and its number of subregions. */
  container: string | null;
  layers: number;
  direction: PathDirection;
  /** One line for every direction but down: why there is no route to plan. */
  note: string | null;
  /** Non-shared layers strictly between, top to bottom (down only). */
  between: PathLayerRow[];
  /** Component ids: from, one step per layer between (a caller, or `(planned-fn needed in <layer>)`), to. [] unless down. */
  route: string[];
  suggestions: PathSuggestion[];
}

const describe = (m: ElementMatch): string => `${m.id} | ${m.title} | ${m.level}`;

/** One component, by uid, id, fqn, local id or title (the deps rules): not-found / ambiguous / invalid as QueryError. */
function resolveComponent(ctx: QueryContext, input: string): ElementMatch {
  const res = resolveElementId(ctx, input);
  if (res.matches.length === 0 || res.tier === null) {
    throw new QueryError('not-found', `no element matches "${input}"`, closestIds(ctx, input, 5).map(describe));
  }
  if (res.matches.length > 1) {
    throw new QueryError('ambiguous', `"${input}" matches ${res.matches.length} elements`, res.matches.map(describe));
  }
  const m = res.matches[0];
  if (m.level !== 'component') throw new QueryError('invalid', `"${m.id}" is a ${m.level}; plan path works on components and functions`);
  return m;
}

/** `to`: a component, or a function (`path#name`, or a name found in one file, as `callers`) whose owner component is used. */
function resolveTarget(ctx: QueryContext, input: string): { component: ElementMatch; fn?: { file: string; name: string } } {
  if (!input.includes('#')) {
    const res = resolveElementId(ctx, input);
    if (res.matches.length > 0 && res.tier !== null) return { component: resolveComponent(ctx, input) };
  }
  let target: { file: string; name: string };
  try {
    target = callersOf(ctx, input).target;
  } catch (err) {
    if (input.includes('#') || !(err instanceof QueryError) || err.code !== 'not-found') throw err;
    return { component: resolveComponent(ctx, input) };   // neither: the element error, with its suggestions
  }
  const owner = ownerOf(ctx, target.file, target.name);
  if (owner.kind !== 'component') {
    throw new QueryError('invalid', `${target.file}#${target.name} belongs to no plan component (${owner.title}); link it first (${CMD_NAME} plan link)`);
  }
  return { component: { id: owner.id, title: owner.title, level: 'component' }, fn: { file: target.file, name: target.name } };
}

function endOf(m: ElementMatch, place: LayerPlace | null): PathEnd {
  return { id: m.id, title: m.title, layer: place?.layer.id ?? null, layerTitle: place?.layer.title ?? null, rank: place?.rank ?? null };
}

const byWeightThenId = (a: { id: string; w: number }, b: { id: string; w: number }): number =>
  b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Components placed in one layer, sorted by id. */
function membersOf(elements: PlanElement[], idx: LayerIndex, layerId: string): string[] {
  return elements.filter((e) => e.kind === 'component' && idx.place(e.id)?.layer.id === layerId).map((e) => e.id).sort();
}

/** The callers of the target per component: function target = traced calls grouped by owner; component target = arrows. */
function callersByComponent(ctx: QueryContext, edges: ComponentEdge[], to: string, fn: { file: string; name: string } | undefined): Map<string, { weight: number; via: string[] }> {
  const out = new Map<string, { weight: number; via: string[] }>();
  if (fn) {
    for (const c of callersOf(ctx, `${fn.file}#${fn.name}`).callers) {
      const owner = ownerOf(ctx, c.file, c.name);
      if (owner.kind !== 'component') continue;
      const row = out.get(owner.id) ?? { weight: 0, via: [] };
      row.weight++;
      row.via.push(`${c.file}#${c.name}`);
      out.set(owner.id, row);
    }
    return out;
  }
  for (const e of edges) if (e.to === to && e.from !== to) out.set(e.from, { weight: e.weight, via: [] });
  return out;
}

/** The route from `from` to `to` through the plan's layers. See the file comment. */
export function planPath(ctx: QueryContext, fromInput: string, toInput: string): PlanPathResult {
  const fromMatch = resolveComponent(ctx, fromInput);
  const target = resolveTarget(ctx, toInput);
  const idx = ctx.plan ? layerIndex(ctx.plan) : null;
  const a = idx?.place(fromMatch.id) ?? null;
  const b = idx?.place(target.component.id) ?? null;
  const from = endOf(fromMatch, a);
  const to: PathEnd = { ...endOf(target.component, b), ...(target.fn ? { function: target.fn } : {}) };
  const result = (direction: PathDirection, note: string | null, rest: Partial<PlanPathResult> = {}): PlanPathResult => ({
    from, to, container: null, layers: 0, direction, note, between: [], route: [], suggestions: [], ...rest,
  });

  if (!idx || !a || !b) {
    const which = !a ? from.id : to.id;
    return result('unlayered', `${which} is in no subregion of its container (or the plan has none): no layers to route through`);
  }
  if (a.container !== b.container) {
    return result('other-container', `${from.id} and ${to.id} are in two containers (${a.container}, ${b.container}): layers route inside one container`);
  }
  const container = a.container;
  const stack = idx.stacks.get(container) ?? [];
  const base = { container, layers: stack.length };
  const s = (id: string): string => shortId(container, id);
  if (a.layer.id === b.layer.id) return result('same', `both are in ${a.layer.title}: no layer between`, base);
  if (b.shared) return result('shared', `${s(to.id)} is in the shared subregion ${b.layer.title}: callable from every layer`, base);
  if (b.rank < a.rank) {
    return result('up', `the target is in ${b.layer.title}, a layer above ${a.layer.title}: call down, or move the code into a lower or shared layer`, base);
  }

  const edges = ctx.snapshot.componentEdges;
  const calls = callersByComponent(ctx, edges, to.id, target.fn);
  const usesOf = (id: string): Set<string> => new Set(edges.filter((e) => e.from === id).map((e) => e.to));
  const elements = ctx.plan!.elements;
  const between: PathLayerRow[] = [];
  const route = [from.id];
  const suggestions: PathSuggestion[] = [];
  let prevUses = usesOf(from.id);   // the route keeps to arrows that exist: a caller the last step already calls comes first
  for (const step of layersBetween(idx, edges, from.id, to.id)) {
    const members = membersOf(elements, idx, step.layer.id);
    const callers = members.filter((m) => calls.has(m)).map((m) => ({ component: m, ...calls.get(m)! }))
      .sort((x, y) => Number(prevUses.has(y.component)) - Number(prevUses.has(x.component)) ||
        byWeightThenId({ id: x.component, w: x.weight }, { id: y.component, w: y.weight }));
    let candidates: string[] = [];
    if (callers.length === 0) {
      // Components that already reach further down (a layer below this one, down to the target's) come first, by weight.
      const isBelow = (id: string): boolean => {
        const p = idx.place(id);
        return !!p && p.container === container && p.rank > step.rank && p.rank <= b.rank && !p.shared;
      };
      const reach = members.map((m) => ({ id: m, w: edges.filter((e) => e.from === m && isBelow(e.to)).reduce((n, e) => n + e.weight, 0) }));
      candidates = reach.some((r) => r.w > 0) ? reach.filter((r) => r.w > 0).sort(byWeightThenId).map((r) => r.id) : members;
      const what = target.fn ? `${target.fn.name} (${target.fn.file})` : s(to.id);
      suggestions.push(candidates.length > 0
        ? {
          layer: step.layer.id, parent: candidates[0],
          command: `${CMD_NAME} plan add planned-fn <name> --parent ${candidates[0]} --signature "<name>(...)"`,
          note: `a function in ${step.layer.title} that calls ${what}` + (candidates.length > 1 ? `; or put it in ${candidates.slice(1).map(s).join(', ')}` : ''),
        }
        : {
          layer: step.layer.id, parent: null,
          command: `${CMD_NAME} plan add component <name> --parent ${step.layer.id}`,
          note: `no component in ${step.layer.title} yet: plan one, then a planned-fn in it that calls ${what}`,
        });
    }
    between.push({ layer: step.layer.id, layerTitle: step.layer.title, rank: step.rank, callers, missing: callers.length === 0, candidates });
    route.push(callers.length > 0 ? callers[0].component : `(planned-fn needed in ${step.layer.title})`);
    if (callers.length > 0) prevUses = usesOf(callers[0].component);
  }
  route.push(to.id);
  return result('down', null, { ...base, between, route, suggestions });
}
