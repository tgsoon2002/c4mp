import type {
  PlanFinding, SimCall, SimDepth, SimItem, SimStep, ViewModel, ViewName, ViewNode, ViewSim, ViewSimAt, ViewSimCall, ViewSimDepth,
  ViewSimLane, ViewSimRows, ViewSimStage, ViewSimStep, ViewSimTarget,
} from '../types';
import { ENTRY_KINDS } from '../plan/kinds';
import { forEachNode, idIndex, nodesBelow, uidIndex } from './tree';

/**
 * Phase 25 (S4): the s-items of the page (`ViewModel.sims`), every step resolved on the server in the three view trees
 * (Document/Roadmap/Phase25/UI_TASKS.md B1, rules 1-7). Pure: reads the model and the input, mutates neither. The s-item
 * resolver comes in as `keysOf` (page build passes the engine's resolveSimTarget), so this file never imports src/sim.
 */

/** What a stored ref (uid, fqn or path#name) names: the plan uid (null for a code hit) and the node ids to try, in order. */
export interface SimRefKeys { uid: string | null; ids: string[] }

/** Input of buildViewSims: the s-items, the check findings, the repo-relative file of an s-id, the ref resolver (null = resolves to nothing). */
export interface ViewSimsInput { items: SimItem[]; findings: PlanFinding[]; fileOf: (id: string) => string; keysOf: (ref: string) => SimRefKeys | null }

const OUTSIDE_LANE = 'outside';
const PERSON_LANE = 'person';   // the person lane when the s-item's person is free text (or absent)
const VIEW_ORDER: ViewName[] = ['io', 'arch', 'storage'];

/** b853: the flow depths, C4 levels top to bottom; every step has `at[d]` and every s-item `depth[d]` for each. */
export const SIM_DEPTHS: SimDepth[] = ['context', 'container', 'component', 'code'];
const CONTEXT_KINDS = new Set<string>(['system', 'context', 'person', 'external']);   // the Context depth's boxes
const GROUP_KINDS = new Set<string>(['shared', 'unassigned']);   // system-level code groups: container boxes at depth (Q7)

interface Hit { node: ViewNode; view: ViewName }

/** Built once per page: the indexes and the arch facts every s-item shares. */
interface Ctx {
  input: ViewSimsInput;
  byUid: Map<string, Hit>;                  // uidIndex: the B1 order (arch, IO, storage), first wins
  byId: Map<string, Hit>;                   // idIndex: same order
  perView: Map<ViewName, { byUid: Map<string, ViewNode>; byId: Map<string, ViewNode> }>;   // one tree each: the preferred tree is asked first
  parent: Map<ViewNode, ViewNode | null>;   // every node of the three trees -> the node above it (null for a root)
  archRank: Map<ViewNode, number>;          // arch container -> its pre-order index among the arch containers (arch order: the order of lanes no step uses)
  hitOf: WeakMap<ViewSimTarget, Hit>;       // b853: every resolved target -> its hit (stepBody fills it), for the boxes per depth
  laneNode: Map<string, ViewNode>;          // b853: lane id -> the arch node laneOf made it from (a fallback lane has none)
}

/** The lanes one s-item uses, as laneOf gives them (rank = arch order); rankLanes orders them by first use at the end. */
type LaneSet = Map<string, ViewSimLane>;

/** A step before push numbers it and adds its arrow and its depths. */
type StepBody = Omit<ViewSimStep, 'i' | 'n' | 'call' | 'at'>;

/**
 * The page's s-items in input order. A journey plays its flow stages inline (the named flow's steps, numbered on in the
 * one list); a flow stage that names a missing s-item, a journey or itself adds no steps (sim-stage-missing reports it).
 */
export function buildViewSims(model: ViewModel, input: ViewSimsInput): ViewSim[] {
  const parent = new Map<ViewNode, ViewNode | null>();
  const perView: Ctx['perView'] = new Map();
  const roots: [ViewName, ViewNode | undefined][] = [['arch', model.root], ['io', model.navView?.root], ['storage', model.storageView?.root]];
  for (const [view, root] of roots) {
    if (!root) continue;
    parent.set(root, null);
    const byUid = new Map<string, ViewNode>();
    const byId = new Map<string, ViewNode>();
    forEachNode(root, (n) => {
      nodesBelow(n).forEach((c) => parent.set(c, n));
      if (n.uid !== undefined && !byUid.has(n.uid)) byUid.set(n.uid, n);
      for (const key of [n.id, n.planId]) if (key !== undefined && !byId.has(key)) byId.set(key, n);
    });
    perView.set(view, { byUid, byId });
  }
  const archRank = new Map<ViewNode, number>();
  forEachNode(model.root, (n) => { if (n.kind === 'container') archRank.set(n, archRank.size); });
  const ctx: Ctx = { input, byUid: uidIndex(model), byId: idIndex(model), perView, parent, archRank, hitOf: new WeakMap(), laneNode: new Map() };
  const byId = new Map(input.items.map((it) => [it.id, it]));
  const sims = input.items.map((item) => buildSim(ctx, item, byId));
  applyFindings(sims, input.findings);
  return sims;
}

/** One s-item: person, flat steps (with their calls), stages of a journey, lanes and views. */
function buildSim(ctx: Ctx, item: SimItem, byId: Map<string, SimItem>): ViewSim {
  const lanes: LaneSet = new Map();
  const personHit = item.person !== undefined ? personNode(ctx, item.person) : null;
  const personLane: ViewSimLane = personHit
    ? actorLane(personHit)
    : { id: PERSON_LANE, name: item.person ?? 'Person', sub: 'person', kind: 'person', rank: 0 };
  if (item.person !== undefined) lanes.set(personLane.id, personLane);
  // b853: the lanes each depth uses, filled like `lanes` (the person first when the s-item names one)
  const depthSets = new Map<SimDepth, LaneSet>(SIM_DEPTHS.map((d) => [d, new Map(item.person !== undefined ? [[personLane.id, personLane]] : [])]));

  const steps: ViewSimStep[] = [];
  const push = (step: StepBody, raw: SimCall | undefined): void => {
    const prev = steps[steps.length - 1] ?? null;
    const s = { i: steps.length, n: steps.length + 1, ...step, call: null } as ViewSimStep;
    s.call = buildCall(ctx, s, raw, prev, personLane, lanes);
    s.at = Object.fromEntries(SIM_DEPTHS.map((d) => [d, stepAt(ctx, s, raw, prev, personLane, d, depthSets.get(d)!, lanes)])) as Record<SimDepth, ViewSimAt>;
    steps.push(s);
  };

  const stages: ViewSimStage[] = [];
  if (item.kind === 'journey') {
    (item.stages ?? []).forEach((sg, k) => {
      const first = steps.length;
      const goal = sg.goal !== undefined ? { goal: sg.goal } : {};
      let kind: ViewSimStage['kind'];
      let flow: string | undefined;
      if ('flow' in sg) {
        kind = 'flow';
        flow = sg.flow;
        const f = byId.get(sg.flow);
        if (f && f.kind === 'flow' && f.id !== item.id) {
          (f.steps ?? []).forEach((st, j) => push({ ...stepBody(ctx, st, lanes, k), flow: f.id, inFlow: j + 1, ...goal }, st.call));
        }
      } else if ('outside' in sg) {
        kind = 'outside';
        push({
          view: 'outside', targets: [], outside: { text: sg.outside, from: sg.from ?? null, channel: sg.channel ?? null }, stage: k, ...goal,
          ...copyText(sg),
        }, undefined);
      } else {
        kind = 'step';
        push({ ...stepBody(ctx, sg, lanes, k), ...goal }, sg.call);
      }
      const stage: ViewSimStage = { kind, name: sg.name ?? `Stage ${k + 1}`, firstStep: first, stepCount: steps.length - first };
      if (sg.goal !== undefined) stage.goal = sg.goal;
      if (flow !== undefined) stage.flow = flow;
      stages.push(stage);
    });
  } else {
    for (const st of item.steps ?? []) push(stepBody(ctx, st, lanes, 0), st.call);
  }

  if (steps.some((s) => s.view === 'outside')) {
    const channels = [...new Set(steps.map((s) => s.outside?.channel).filter((c): c is string => !!c))];
    const outside: ViewSimLane = { id: OUTSIDE_LANE, name: 'Outside', sub: channels.length ? `not modelled · ${channels.join(', ')}` : 'not modelled', kind: 'outside', rank: 1 };
    lanes.set(OUTSIDE_LANE, outside);
    depthSets.forEach((set) => set.set(OUTSIDE_LANE, outside));
  }

  return {
    id: item.id, kind: item.kind, title: item.title,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.person !== undefined ? { person: { text: item.person, nodeId: personHit ? personHit.node.id : null } } : {}),
    file: ctx.input.fileOf(item.id),
    steps,
    ...(item.kind === 'journey' ? { stages } : {}),
    lanes: rankLanes(lanes, steps),   // B1: person, outside, containers then externals in first-use order
    depth: Object.fromEntries(SIM_DEPTHS.map((d): [SimDepth, ViewSimDepth] => [d, { groups: groupsOf(steps, d), lanes: depthLanes(steps, depthSets.get(d)!, d) }])) as Record<SimDepth, ViewSimDepth>,
    views: VIEW_ORDER.filter((v) => steps.some((s) => s.view === v)),
  };
}

/**
 * B1 lane order (b751 follow-up): the lanes in the order the path first reaches them, the usual sequence-diagram rule.
 * Person lanes rank 0, Outside 1, then the container lanes by first use in play order (per step: the call's from lane,
 * its to lane, then the targets' lanes), then the externals the same way. A lane no step uses goes after the used lanes
 * of its kind, in arch order (the rank laneOf gave it). Ranks come out dense: containers 2.., externals after them.
 */
function rankLanes(lanes: LaneSet, steps: ViewSimStep[]): ViewSimLane[] {
  return orderLanes(lanes, steps.flatMap((s) => [s.call?.fromLane, s.call?.toLane, ...s.targets.map((t) => t.lane)]));
}

/**
 * The lanes in rankLanes' order: person 0, outside 1, then every box lane (container, and at a depth system / component /
 * code / record) by first use in `seen`, then externals the same way; ranks dense from 2. An unused lane goes last of its
 * group by its own rank (arch order).
 */
function orderLanes(lanes: LaneSet, seen: (string | null | undefined)[]): ViewSimLane[] {
  const firstUse = new Map<string, number>();
  for (const id of seen) if (id && !firstUse.has(id)) firstUse.set(id, firstUse.size);
  const use = (l: ViewSimLane): number => firstUse.get(l.id) ?? Number.MAX_SAFE_INTEGER;
  const sorted = (keep: (l: ViewSimLane) => boolean): ViewSimLane[] =>
    [...lanes.values()].filter(keep).sort((a, b) => use(a) - use(b) || a.rank - b.rank);
  const fixed = new Set<ViewSimLane['kind']>(['person', 'outside', 'external']);
  const boxes = sorted((l) => !fixed.has(l.kind)).map((l, k) => ({ ...l, rank: 2 + k }));
  const externals = sorted((l) => l.kind === 'external').map((l, k) => ({ ...l, rank: 2 + boxes.length + k }));
  return [...sorted((l) => l.kind === 'person'), ...sorted((l) => l.kind === 'outside'), ...boxes, ...externals];
}

/** b853: the lanes of depth `d`, in rankLanes' order over the steps' `at[d]` (per step: from, to, then the boxes). */
function depthLanes(steps: ViewSimStep[], set: LaneSet, d: SimDepth): ViewSimLane[] {
  return orderLanes(set, steps.flatMap((s) => [s.at[d].from, s.at[d].to, ...s.at[d].boxes]));
}

/** b853: the flow steps at depth `d`: consecutive steps of one stage with the same non-null key make one group. */
function groupsOf(steps: ViewSimStep[], d: SimDepth): number[][] {
  const groups: number[][] = [];
  steps.forEach((s, k) => {
    const prev = steps[k - 1];
    const key = s.at[d].key;
    if (prev && key !== null && key === prev.at[d].key && s.stage === prev.stage) groups[groups.length - 1].push(s.i);
    else groups.push([s.i]);
  });
  return groups;
}

/** state / caption / durationSec when present. */
function copyText(src: { state?: string; caption?: string; durationSec?: number }): Pick<ViewSimStep, 'state' | 'caption' | 'durationSec'> {
  const out: Pick<ViewSimStep, 'state' | 'caption' | 'durationSec'> = {};
  if (src.state !== undefined) out.state = src.state;
  if (src.caption !== undefined) out.caption = src.caption;
  if (src.durationSec !== undefined) out.durationSec = src.durationSec;
  return out;
}

/** A stored step without its number and call: targets (rule 2-4), rows (rule 5), missing refs, texts. */
function stepBody(ctx: Ctx, st: SimStep, lanes: LaneSet, stage: number): StepBody {
  const missing: string[] = [];
  const targets = st.target.map((ref) => {
    const t = resolveTarget(ctx, ref, st.view, lanes);
    if (t.missing) missing.push(ref);
    if (t.hit) ctx.hitOf.set(t.target, t.hit);
    return t.target;
  });
  const body: StepBody = { view: st.view, targets, stage, ...copyText(st) };
  if (st.rows) {
    body.rows = Object.entries(st.rows).map(([ref, rows]): ViewSimRows => {
      const keys = ctx.input.keysOf(ref);
      const hit = keys ? find(ctx, keys, 'storage', (h) => h.view === 'storage' && h.node.kind === 'record') : null;
      if (!hit) {
        missing.push(ref);
        return { ref, recordId: null, name: ref, pk: [], rows: rows.map((r) => ({ ...r })) };
      }
      const pk = hit.node.children.filter((c) => c.kind === 'field' && c.storage?.pk).map((c) => c.name);
      return { ref, recordId: hit.node.id, name: hit.node.name, pk, rows: rows.map((r) => ({ ...r })) };
    });
  }
  if (missing.length) body.missing = missing;
  return body;
}

/**
 * Rule 2: the node `keys` names. First in the `prefer` tree (the step's own view, so an IO step on an app container lights
 * the IO node, not the arch one): its uid, then each id. Then the B1 order: the uid in uidIndex, then each id in idIndex
 * (arch, IO, storage, first wins). `accept` filters the hits.
 */
function find(ctx: Ctx, keys: SimRefKeys, prefer: ViewName | null, accept: (h: Hit) => boolean = () => true): Hit | null {
  const own = prefer ? ctx.perView.get(prefer) : undefined;
  if (own && prefer) {
    const node = (keys.uid !== null ? own.byUid.get(keys.uid) : undefined) ?? keys.ids.map((id) => own.byId.get(id)).find((n) => n !== undefined);
    if (node && accept({ node, view: prefer })) return { node, view: prefer };
  }
  const uidHit = keys.uid !== null ? ctx.byUid.get(keys.uid) : undefined;
  if (uidHit && accept(uidHit)) return uidHit;
  for (const id of keys.ids) {
    const h = ctx.byId.get(id);
    if (h && accept(h)) return h;
  }
  return null;
}

/** The node and every node above it in its tree, nearest first (the root last). */
function ancestry(ctx: Ctx, node: ViewNode): ViewNode[] {
  const chain: ViewNode[] = [];
  for (let n: ViewNode | null | undefined = node; n; n = ctx.parent.get(n)) chain.push(n);
  return chain;
}

/** Rules 1-4: one step target. `missing` = the ref resolves to nothing (keysOf null); a plan hit with no node is not missing. */
function resolveTarget(ctx: Ctx, ref: string, stepView: ViewName, lanes: LaneSet): { target: ViewSimTarget; missing: boolean; hit: Hit | null } {
  const keys = ctx.input.keysOf(ref);
  const hit = keys ? find(ctx, keys, stepView) : null;   // the step's own tree first (an IO step on an app lights the IO node)
  if (!hit) {
    return { target: { ref, uid: keys?.uid ?? null, nodeId: null, view: stepView, name: ref, kind: '', entryId: null, lane: null }, missing: keys === null, hit: null };
  }
  const lane = laneOf(ctx, hit);
  if (lane && !lanes.has(lane.id)) lanes.set(lane.id, lane);
  return {
    target: {
      ref, uid: keys?.uid ?? hit.node.uid ?? null, nodeId: hit.node.id, view: hit.view, name: displayName(ctx, hit), kind: hit.node.kind,
      entryId: entryOf(ctx, hit), lane: lane ? lane.id : null,
    },
    missing: false,
    hit,
  };
}

/** A person or external node as its own lane. */
function actorLane(hit: Hit): ViewSimLane {
  const person = hit.node.kind === 'person';
  return { id: hit.node.id, name: hit.node.name, sub: person ? 'person' : 'external system', kind: person ? 'person' : 'external', rank: person ? 0 : 50 };
}

/** QF3: the arch person node `text` names, or null (free text, or not a person). */
function personNode(ctx: Ctx, text: string): Hit | null {
  const keys = ctx.input.keysOf(text);
  return keys ? find(ctx, keys, 'arch', (h) => h.view === 'arch' && h.node.kind === 'person') : null;
}

/**
 * Rule 3: the lane a node runs in. Arch: its nearest container (or person / external) at or above it. IO / storage: its
 * group / zone (the child of the tree root above it) -> the arch node with that uid, else with that id or planId, else
 * (a group / zone with no uid) with the uid its id resolves to through the plan (`keysOf`: a merged scanned container
 * like `web` carries the plan uid of `shop.web` but neither its id nor a planId) -> its lane; no arch match = a lane of
 * the group / zone itself. Null when unknown (a root, an arch node above every container).
 */
function laneOf(ctx: Ctx, hit: Hit): ViewSimLane | null {
  const chain = ancestry(ctx, hit.node);
  if (hit.view === 'arch') {
    const n = chain.find((c) => c.kind === 'container' || c.kind === 'person' || c.kind === 'external');
    if (!n) return null;
    ctx.laneNode.set(n.id, n);
    return n.kind !== 'container' ? actorLane({ node: n, view: 'arch' }) : containerLane(ctx, n);
  }
  if (chain.length < 2) return null;
  const top = chain[chain.length - 2];
  const inArch = (h: Hit): boolean => h.view === 'arch';
  let arch = find(ctx, { uid: top.uid ?? null, ids: [top.id] }, 'arch', inArch);
  if (!arch && top.uid === undefined) {
    const uid = ctx.input.keysOf(top.id)?.uid ?? null;
    if (uid !== null) arch = find(ctx, { uid, ids: [] }, 'arch', inArch);
  }
  const archLane = arch ? laneOf(ctx, arch) : null;
  return archLane ?? { id: top.id, name: top.name, sub: 'container', kind: 'container', rank: 2 + ctx.archRank.size };
}

/** The lane of an arch container (laneOf's form): rank = 2 + its arch order. */
function containerLane(ctx: Ctx, n: ViewNode): ViewSimLane {
  return { id: n.id, name: n.name, sub: n.detail ? `container · ${n.detail}` : 'container', kind: 'container', rank: 2 + (ctx.archRank.get(n) ?? 0) };
}

/** Rule 4: io only: the entry (screen | command | route | tool) at or above the node; null elsewhere. */
function entryOf(ctx: Ctx, hit: Hit): string | null {
  if (hit.view !== 'io') return null;
  return ancestry(ctx, hit.node).find((n) => ENTRY_KINDS.has(n.kind))?.id ?? null;
}

/** Function / method: 'Component.name'; control: 'Screen › Control' without a trailing ' button'; else the node name. */
function displayName(ctx: Ctx, hit: Hit): string {
  const { node } = hit;
  const above = ancestry(ctx, node).slice(1);
  if (node.kind === 'function' || node.kind === 'method') {
    const owner = above.find((n) => n.kind === 'component');
    return owner ? `${owner.name}.${node.name}` : node.name;
  }
  if ((node.kind as string) === 'control') {
    const name = node.name.replace(/ button$/, '');
    const entry = above.find((n) => ENTRY_KINDS.has(n.kind));
    return entry ? `${entry.name} › ${name}` : name;
  }
  return node.name;
}

/**
 * Rule 6 (QF1): the arrow of a step. The file's `call` when present (ends resolved in the arch tree; an end that resolves
 * to nothing goes to `missing` and falls back to the derived end); derived otherwise: from = the lane of the previous
 * step's last target (step 1: the person), to = the lane of this step's first target, reply = (to is the person).
 * Outside steps: outside -> person. Every lane it uses joins `lanes`.
 */
function buildCall(ctx: Ctx, step: ViewSimStep, raw: SimCall | undefined, prev: ViewSimStep | null, person: ViewSimLane, lanes: LaneSet): ViewSimCall {
  const use = (lane: ViewSimLane): string => {
    if (!lanes.has(lane.id)) lanes.set(lane.id, lane);
    return lane.id;
  };
  if (step.view === 'outside') return { from: OUTSIDE_LANE, to: use(person), fromLane: OUTSIDE_LANE, toLane: person.id, label: '', reply: false };
  const lastLane = (s: ViewSimStep): string | null => [...s.targets].reverse().find((t) => t.lane)?.lane ?? s.call?.toLane ?? null;
  const derivedFrom = (): string => (prev && lastLane(prev)) || use(person);   // lazy: the person lane joins only when an arrow uses it
  const derivedTo = (): string => step.targets.find((t) => t.lane)?.lane ?? derivedFrom();
  const end = (ref: string | undefined, derived: () => string): { id: string; lane: string } => {
    const keys = ref === undefined ? null : ctx.input.keysOf(ref);
    if (ref !== undefined && keys === null) (step.missing ??= []).push(ref);
    const found = archHit(ctx, keys);
    const lane = found ? laneOf(ctx, found) : null;
    if (!found) {
      const d = derived();
      return { id: d, lane: d };
    }
    return { id: found.node.id, lane: lane ? use(lane) : derived() };
  };
  const from = end(raw?.from, derivedFrom);
  const to = end(raw?.to, derivedTo);
  return { from: from.id, to: to.id, fromLane: from.lane, toLane: to.lane, label: raw?.label ?? '', reply: raw?.reply ?? to.lane === person.id };
}

/** The arch node a call end names: buildCall's rule, only the arch tree is asked; null = not found. */
function archHit(ctx: Ctx, keys: SimRefKeys | null): Hit | null {
  return keys ? find(ctx, keys, 'arch', (h) => h.view === 'arch') : null;
}

/**
 * b853: the box a resolved target shows at depth `d`, as a lane (b853 spec section 1, box rules); null = no box there.
 * `lane` = the target's lane (laneOf). An io / storage target rolls up through the arch node of its lane; a fallback lane
 * (no arch node) is its own box from Context to Component. Shared / Unassigned count as container boxes (Q7).
 */
function boxAt(ctx: Ctx, hit: Hit, lane: ViewSimLane | null, d: SimDepth): ViewSimLane | null {
  const arch = hit.view === 'arch';
  const box = (node: ViewNode, view: ViewName = 'arch'): ViewSimLane => boxLane(ctx, { node, view });
  const container = (): ViewSimLane | null => {
    if (lane || !arch) return lane;
    const group = ancestry(ctx, hit.node).find((n) => GROUP_KINDS.has(n.kind));
    return group ? box(group) : null;
  };
  if (d === 'context') {
    const base = arch ? hit.node : lane ? ctx.laneNode.get(lane.id) : undefined;
    if (!base) return lane;
    const top = ancestry(ctx, base).find((n) => CONTEXT_KINDS.has(n.kind));
    return top ? box(top) : null;
  }
  if (d === 'container') return container();
  if (d === 'component') {
    const component = arch ? ancestry(ctx, hit.node).find((n) => n.kind === 'component') : undefined;
    return component ? box(component) : container();   // a screen or a table has no component: its container
  }
  if (hit.view === 'io') return lane;   // code: an io step shows its lane; its key tells the nodes apart (codeKey)
  if (hit.view === 'storage') return box(ancestry(ctx, hit.node).find((n) => n.kind === 'record') ?? hit.node, 'storage');   // its table
  return box(hit.node);
}

/** b853: the lane of a box node; its kind follows the node kind (b853 spec section 1, lanes per depth). */
function boxLane(ctx: Ctx, hit: Hit): ViewSimLane {
  const { node } = hit;
  const kind = node.kind as string;
  if (kind === 'person' || kind === 'external') return actorLane(hit);
  if (kind === 'container' && hit.view === 'arch') return containerLane(ctx, node);
  const lane = (k: ViewSimLane['kind'], sub: string): ViewSimLane => ({ id: node.id, name: displayName(ctx, hit), sub, kind: k, rank: 2 + ctx.archRank.size });
  if (kind === 'container') return lane('container', 'container');   // an IO group or storage zone, like a fallback lane
  if (kind === 'system' || kind === 'context') return lane('system', 'system');
  if (kind === 'component' || kind === 'subregion') return lane('component', 'component');
  if (GROUP_KINDS.has(kind)) return lane('container', node.name);
  if (kind === 'record' || kind === 'store') return lane('record', node.word ?? 'record');
  return lane('code', kind);
}

/**
 * b853: what a target adds to the merge key at Code: its node id in every view (K 2026-11-17), so a screen step and a
 * control step on that screen stay two steps and Code is one group per step, like today's page.
 */
function codeKey(t: ViewSimTarget, box: string): string {
  return t.nodeId ?? box;
}

/**
 * b853: one step at depth `d` (b853 spec section 1, call ends per depth). Boxes: the targets' boxes in order, once each.
 * Arrow: an explicit end the arch tree finds -> its box at `d`; else buildCall's derivation on the boxes of `d` (from = the
 * previous step's last box, else its `to`, else the person; to = the first box, else from). Code + storage step: an explicit
 * `to` in the first target's container becomes that target's table. Key: the sorted boxes (Code: codeKey), null = never
 * merges. The lanes it uses join `set`, the s-item's own lane object where one exists (so Container = sim.lanes).
 */
function stepAt(ctx: Ctx, step: ViewSimStep, raw: SimCall | undefined, prev: ViewSimStep | null, person: ViewSimLane, d: SimDepth, set: LaneSet, lanes: LaneSet): ViewSimAt {
  const add = (lane: ViewSimLane): string => {
    if (!set.has(lane.id)) set.set(lane.id, lanes.get(lane.id) ?? lane);
    return lane.id;
  };
  if (step.view === 'outside') return { boxes: [], from: OUTSIDE_LANE, to: add(person), key: null };
  const boxed = (s: ViewSimStep): { t: ViewSimTarget; box: ViewSimLane }[] => s.targets.flatMap((t) => {
    const hit = ctx.hitOf.get(t);
    const box = hit ? boxAt(ctx, hit, t.lane === null ? null : lanes.get(t.lane) ?? null, d) : null;
    return box ? [{ t, box }] : [];
  });
  const own = boxed(step);
  const boxes = [...new Set(own.map((b) => add(b.box)))];
  const derivedFrom = (): string => {
    const last = prev ? boxed(prev).pop() : undefined;
    if (last) return add(last.box);
    return prev ? prev.at[d].to : add(person);
  };
  const derivedTo = (): string => (own.length ? own[0].box.id : derivedFrom());
  const end = (ref: string | undefined, at: SimDepth): ViewSimLane | null => {   // an explicit end the arch tree finds: its box at `at`
    const found = ref === undefined ? null : archHit(ctx, ctx.input.keysOf(ref));
    return found ? boxAt(ctx, found, laneOf(ctx, found), at) : null;
  };
  const fromBox = end(raw?.from, d);
  const from = fromBox ? add(fromBox) : derivedFrom();
  // "storage steps show their tables": at Code an explicit `to` in the first target's container becomes that target's table
  const toTable = d === 'code' && step.view === 'storage' && own.length > 0 && end(raw?.to, 'container')?.id === own[0].t.lane;
  const toBox = toTable ? own[0].box : end(raw?.to, d);
  const to = toBox ? add(toBox) : derivedTo();
  const parts = d === 'code' ? own.map((b) => codeKey(b.t, b.box.id)) : boxes;
  return { boxes, from, to, key: parts.length ? [...new Set(parts)].sort().join(' + ') : null };
}

/**
 * Rule 7: check findings onto steps. Pair ids `s-1:7-8` (sim-step-unverified / sim-step-unconnected) mark step n 8 of that
 * flow; `s-1:3` (sim-target-missing) adds the refs of step 3 the message names to `missing`. A journey's inline copies of a
 * flow take that flow's findings (by `inFlow`). A journey's own findings use `s-2:stage-N` (T7): stage N = every step with
 * `stage === N - 1` (an inline stage target missing). `sim-stage-missing` is not mapped: it is only about a flow stage that
 * names no s-item, a journey or itself, and such a stage plays no steps (stepCount 0), so there is no step to carry it.
 */
function applyFindings(sims: ViewSim[], findings: PlanFinding[]): void {
  const RULES = new Set(['sim-step-unverified', 'sim-step-unconnected', 'sim-target-missing']);
  for (const f of findings) {
    if (!RULES.has(f.rule)) continue;
    const step = /^(s-\d+):(\d+)(?:-(\d+))?$/.exec(f.id);   // flow: step N, or the pair N-M (its second step)
    const stage = /^(s-\d+):stage-(\d+)$/.exec(f.id);       // journey: stage N (1-based)
    const owner = (step ?? stage)?.[1];
    if (owner === undefined) continue;
    const at = step ? Number(step[3] ?? step[2]) : Number(stage![2]);
    for (const sim of sims) {
      for (const s of sim.steps) {
        const hit = step
          ? (s.flow !== undefined ? s.flow === owner && s.inFlow === at : sim.kind === 'flow' && sim.id === owner && s.n === at)
          : sim.kind === 'journey' && sim.id === owner && s.stage === at - 1;
        if (!hit) continue;
        if (f.rule === 'sim-step-unverified') s.unverified = f.message;
        else if (f.rule === 'sim-step-unconnected') s.unconnected = f.message;
        else {
          const refs = [...s.targets.map((t) => t.ref), ...(s.rows ?? []).map((r) => r.ref)];
          for (const ref of refs) if (f.message.includes(ref) && !(s.missing ?? []).includes(ref)) (s.missing ??= []).push(ref);
        }
      }
    }
  }
}
