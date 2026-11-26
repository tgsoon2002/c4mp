import {
  Snapshot,
  SnapshotFile,
  ViewKind,
  ViewNode,
  ViewOrigin,
  ViewModel,
  CodeElement,
  Container,
  Plan,
  PlanElement,
  Ownership,
  ViewEdge,
  FileEdge,
  ViewFile,
  ViewRelation,
  Claim,
  TestsConfig,
} from '../types';
import { log } from '../log';
import { cmp } from '../util/text';
import { forEachNode, nodesBelow, subregionMembers } from './tree';
import { buildNav } from './navModel';
import { CONTEXT_ROOT_ID, localId, SYSTEM_ID_QUALIFIER, toId } from '../names';
import { extractClaims, resolveOwnership, isClaimModePlan, claimMatches, SPECIFICITY } from '../c4/ownership';
import { mapNodeToElement } from '../c4/applyLayout';
import { UID_KEY } from '../util/uid';
import { FOUNDATION_ROLE } from '../constants';
import { actorHolding, containerFqnOf, isOutsideElement, matchPlanComponents } from '../plan/standIn';
import { isArchBox, isMapActor } from '../plan/kinds';
import { declaredOrder, isSharedSubregion, planById, subregionOf, subregionsOf } from '../plan/layers';
import { extractPlannedCode, resolvePlannedParent, type ParentCtx, type PlannedCode } from '../plan/plannedElements';
import { readFileLines, sliceLines, componentHistoryReader } from './source';
import { testIndexOf } from '../c4/testAttach';
import { attachViewTests } from './viewTests';
import type { RunnerOf } from '../languages/testRunner';
import type { WireframeFile } from '../c4/wireframeFiles';

/**
 * Parse a plan element's `layout` metadata value `'bx,by;rx,ry,rw,rh'` (integers; `bx,by` may be
 * empty, as in `';1200,860,33178,23922'`) into ViewNode.savedLayout. Malformed -> null + a log.
 */
/** The id to use when mapping a node to its plan element: a qualified system id maps by its bare id. */
function planLookupId(n: ViewNode): string {
  return n.kind === 'system' && n.id.endsWith(SYSTEM_ID_QUALIFIER) ? n.id.slice(0, -SYSTEM_ID_QUALIFIER.length) : n.id;
}

/** Every node id in the subtrees of `nodes`. */
function collectIds(nodes: ViewNode[], into: Set<string> = new Set()): Set<string> {
  for (const root of nodes) forEachNode(root, (n) => into.add(n.id));
  return into;
}

export function parseSavedLayout(value: string, id: string): ViewNode['savedLayout'] | null {
  const m = /^\s*(?:(-?\d+)\s*,\s*(-?\d+))?\s*;\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(value);
  if (!m || Number(m[5]) <= 0 || Number(m[6]) <= 0) {
    log('view-model', 'ignored malformed layout metadata', { id, value });
    return null;
  }
  return {
    ...(m[1] !== undefined ? { bx: Number(m[1]), by: Number(m[2]) } : {}),
    rx: Number(m[3]),
    ry: Number(m[4]),
    rw: Number(m[5]),
    rh: Number(m[6]),
  };
}

/**
 * Claim mode: copy each system/container/subregion/component node's plan-element `layout` metadata (if any,
 * and parseable) onto the node. The node -> element mapping is `mapNodeToElement` from
 * c4/applyLayout.ts, the same one `c4pm plan apply-layout` writes with, so write and read cannot disagree.
 * Slices, shared/unassigned, files and functions never carry layout.
 * SR2 (b457, Q6): `only` keeps the node kinds to read; folder mode reads only subregions (keyed by their plan fqn in
 * both modes), its components never carry layout.
 */
function attachSavedLayouts(root: ViewNode, plan: Plan, only?: (kind: ViewKind) => boolean): void {
  forEachNode(root, (n) => {
    if (isArchBox(n.kind) && (!only || only(n.kind))) {
      const m = mapNodeToElement(plan, planLookupId(n), n.kind);
      const value = 'element' in m ? m.element.metadata?.layout : undefined;
      if (value !== undefined) {
        const saved = parseSavedLayout(value, n.id);
        if (saved) n.savedLayout = saved;
      }
    }
  });
}

/**
 * P14-T8: copy each system/container/subregion/component node's plan-element `uid` metadata (if a non-empty
 * string) onto `uid`. Same node -> element mapping as attachSavedLayouts (`mapNodeToElement`). Copied
 * as written; malformed values are reported by the checks, not here. Runs for any plan. In folder
 * mode a scanned component has a folder id, not a plan fqn, so `mapNodeToElement` finds nothing; the
 * plan component it stands for (`standIns`: scanned node id -> plan element, from attachPlanOnlyNodes)
 * gives its uid, so a link to that plan component resolves to the box that is drawn (P16-B17b).
 */
function attachUids(root: ViewNode, plan: Plan, standIns: Map<string, PlanElement> = new Map()): void {
  forEachNode(root, (n) => {
    if (isArchBox(n.kind) || isMapActor(n.kind)) {
      const m = mapNodeToElement(plan, planLookupId(n), n.kind);
      const el = 'element' in m ? m.element : n.kind === 'component' ? standIns.get(n.id) : undefined;
      if (el) {
        const v = el.metadata?.[UID_KEY];
        if (typeof v === 'string' && v !== '') n.uid = v;
      } else if ('reason' in m) {
        log('view-model', 'uid skipped', { id: n.id, reason: m.reason });
      }
    }
  });
}

/** P13-T2b / Decision 11: a planBlock embeds at most this many lines. */
export const PLAN_BLOCK_MAX_LINES = 200;

/**
 * P13-T2b, claim mode: copy each system/container/subregion/component node's own `.c4` element text onto
 * `planBlock`. Same node -> element mapping as attachSavedLayouts (`mapNodeToElement`); a node with no
 * element, an ambiguous id, no `endLine`, or no text in `planTexts` gets nothing. Pure: the text comes
 * from the caller (html.ts reads the files), never from disk here.
 */
function attachPlanBlocks(root: ViewNode, plan: Plan, planTexts: Map<string, string>): void {
  const splitCache = new Map<string, string[]>();
  forEachNode(root, (n) => {
    if (isArchBox(n.kind)) {
      const m = mapNodeToElement(plan, planLookupId(n), n.kind);
      if (!('element' in m)) {
        log('view-model', 'planBlock skipped', { id: n.id, reason: m.reason });
      } else {
        const { file, line, endLine } = m.element.source;
        const text = planTexts.get(file);
        if (text === undefined || endLine === undefined) {
          log('view-model', 'planBlock skipped: no text or endLine', { id: n.id, file, hasText: text !== undefined });
        } else {
          let all = splitCache.get(file);
          if (!all) {
            all = text.split(/\r?\n/);
            splitCache.set(file, all);
          }
          const last = Math.min(endLine, line + PLAN_BLOCK_MAX_LINES - 1, all.length);
          if (line < 1 || last < line) {
            log('view-model', 'planBlock skipped: range outside file', { id: n.id, file, line, endLine, fileLines: all.length });
          } else {
            n.planBlock = { file, startLine: line, endLine: last, lines: all.slice(line - 1, last) };
            log('view-model', 'planBlock', { id: n.id, file, startLine: line, endLine: last, capped: last < endLine });
          }
        }
      }
    }
  });
}

/**
 * B14, folder mode: a scanned component that stands for a plan component (attachPlanOnlyNodes) takes the plan's
 * title as `name`, its status/owner/sprint/priority/tags as `meta`, and its fqn as `planId`, so the plan's
 * words reach the map and a plan id finds the node. Runs after attachOrigins; `origin` stays 'scanned'.
 */
function attachStandInPlan(root: ViewNode, standIns: Map<string, PlanElement>): void {
  forEachNode(root, (n) => {
    const el = n.kind === 'component' ? standIns.get(n.id) : undefined;
    if (el) {
      n.name = el.title;
      n.planId = el.id;
      const meta = pickMeta(el.metadata);
      if (meta) n.meta = meta;
      log('view-model', 'stand-in plan data', { id: n.id, planId: el.id, meta });
    }
  });
}

/**
 * b908: a component node whose plan element has metadata `role 'foundation'` gets meta.role 'foundation' and usedByCount =
 * the distinct component nodes with an edge into it (`edges` = ViewModel.edges: the arrows the map draws). Same node ->
 * element mapping as attachUids (stand-ins in folder mode). Runs after attachStandInPlan, which replaces n.meta. Another
 * role value is not copied (validate.ts warns about it).
 */
function attachFoundation(root: ViewNode, plan: Plan, edges: ViewEdge[], standIns: Map<string, PlanElement> = new Map()): void {
  const kindOf = new Map<string, ViewKind>();
  forEachNode(root, (n) => { kindOf.set(n.id, n.kind); });
  const users = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.from === e.to || kindOf.get(e.from) !== 'component') continue;
    const set = users.get(e.to) ?? new Set<string>();
    set.add(e.from);
    users.set(e.to, set);
  }
  forEachNode(root, (n) => {
    if (n.kind !== 'component') return;
    const m = mapNodeToElement(plan, planLookupId(n), n.kind);
    const el = 'element' in m ? m.element : standIns.get(n.id);
    if (el?.metadata?.role !== FOUNDATION_ROLE) return;
    n.meta = { ...(n.meta ?? {}), role: FOUNDATION_ROLE };
    n.usedByCount = users.get(n.id)?.size ?? 0;
    log('view-model', 'foundation', { id: n.id, usedBy: n.usedByCount });
  });
}

const ROOT_CONTAINER_ID = '_root'; // grouper/containers.ts fallback container id
const PLAN_ROOT_LOCAL_ID = 'root_files'; // generate.ts maps _root to this fqn segment

/** P14-T5b: plan container `root_files` with technology 'Unknown' = the plan twin of scanned `_root`. */
function isUnknownPlanRoot(el: PlanElement): boolean {
  return el.kind === 'container' && localId(el.id) === PLAN_ROOT_LOCAL_ID && (el.technology ?? '').toLowerCase() === 'unknown';
}

/**
 * P14-T4a: set `origin` on every system/container/component node: 'scanned' (a snapshot container /
 * component only), 'plan' (a plan element only), or 'both'. `plan` is passed ONLY in claim mode, so a
 * folder-mode repo gets the same origins with or without a plan. Same node -> element mapping as
 * attachPlanBlocks (`mapNodeToElement`). A subregion gets its 'plan' origin when markSubregions builds it.
 */
function attachOrigins(root: ViewNode, snapshot: Snapshot, plan: Plan | null): void {
  forEachNode(root, (n) => {
    // b837: another plan system (isOutsideNode) is no code of ours: it keeps the 'plan' origin planOnlyNode gave it
    if ((n.kind === 'system' && !isOutsideNode(n)) || n.kind === 'container' || n.kind === 'component') {
      const m = plan ? mapNodeToElement(plan, planLookupId(n), n.kind) : null;
      const element = m && 'element' in m ? m.element : null;
      const planSide = element
        ? { planFile: element.source.file, planLine: element.source.line, planEndLine: element.source.endLine }
        : null;
      let origin: ViewOrigin | null = null;
      if (n.kind === 'container') {
        // P14-T5b: a merged plan root_files node stands for the scanned `_root` container too
        const scanned =
          snapshot.containers.find((c) => c.id === n.id) ??
          (element && isUnknownPlanRoot(element) ? snapshot.containers.find((c) => c.id === ROOT_CONTAINER_ID) : undefined);
        if (scanned) {
          const side: ViewOrigin = { kind: element ? 'both' : 'scanned', folder: scanned.path };
          if (scanned.manifest) side.manifest = scanned.manifest;
          // the id literal comes from grouper/containers.ts:164
          if (scanned.id === '_root') side.rule = 'no manifest folder holds these files';
          origin = { ...side, ...(planSide ?? {}) };
        } else if (planSide) origin = { kind: 'plan', ...planSide };
      } else if (n.kind === 'component') {
        // A claim component is scanned only when it owns files (buildClaimComponent fills `files` from fileOwnerMap).
        const comp = snapshot.components.find((c) => c.id === n.id);
        const scannedSide = comp && (comp.mode !== 'claim' || comp.files.length > 0);
        if (element && scannedSide && comp) origin = { kind: 'both', folder: comp.path, ...(planSide ?? {}) };
        else if (element && planSide) origin = { kind: 'plan', ...planSide };
        else if (comp) origin = { kind: 'scanned', folder: comp.path };
      } else {
        origin = { kind: element ? 'both' : 'scanned', folder: '.', ...(planSide ?? {}) };
      }
      if (origin) {
        n.origin = origin;
        log('view-model', 'origin', { id: n.id, kind: origin.kind });
      }
    }
  });
}

/**
 * P14-T44a: a plan element of the given kind (container, component, person, external) with no code yet. weight 1, no w/h (layout sizes it),
 * origin 'plan', `meta` from the plan metadata, `planOnly: true`.
 */
function planOnlyNode(kind: ViewKind, el: PlanElement): ViewNode {
  return planBox(kind, el, true);
}

/** A box drawn from a plan element alone (planOnlyNode, and the subregions of markSubregions, which are not "no code yet"). */
function planBox(kind: ViewKind, el: PlanElement, planOnly: boolean): ViewNode {
  const meta = pickMeta(el.metadata);
  return {
    id: el.id,
    kind,
    name: el.title,
    detail: el.technology ?? '',
    weight: 1,
    children: [],
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
    ...(planOnly ? { planOnly: true as const } : {}),
    origin: { kind: 'plan', planFile: el.source.file, planLine: el.source.line, planEndLine: el.source.endLine },
    ...(meta ? { meta } : {}),
  };
}

/**
 * P20-T3 + C1-CTX (K 2026-11-10), folder and claim mode: every plan element of an actor kind (person, external; see
 * plan/kinds.ts) becomes a plan-only node drawn at C1, BESIDE our system: the map root becomes a 'context' node (id
 * CONTEXT_ROOT_ID, qualified like the system id on a clash; name = the system's name) whose children are the persons, the
 * system, then the externals (plan order inside each group; C1 A1 b828). The context is a holder (kindWords `holder`): the
 * viewer never draws it, never hits it and shows no tree row for it. Relations to and from an actor survive (isLinkable).
 * An id already in the tree is skipped (logged). b328 EXT-2a: `held` = claim-mode container nodes whose plan parent is an actor (actorHolding); each
 * goes under its actor's node (under the system when that actor got no node, logged), and that actor weighs its
 * children. With no actor node the system itself is returned, unchanged (no new level). The system's id, weight and
 * children do not change; the context weighs the sum of its children.
 * b837: `ownSystem` = the plan system ours maps to (ownPlanSystem). Every other plan system is outside like an actor
 * (isOutsideElement): a plan-only 'system' node after ours, before the externals, holding its containers (`held`).
 */
function buildContextRoot(system: ViewNode, plan: Plan, held: ViewNode[] = [], ownSystem: string | null = null): ViewNode {
  const taken = collectIds([system, ...held]);
  const outside: ViewNode[] = [];
  // C1 C1 (b833): declaration order (plan.elements is sorted by id), so the tree and the outside rows follow the plan
  for (const el of [...plan.elements].sort(declaredOrder(plan))) {
    if (!isOutsideElement(el, ownSystem)) continue;
    if (taken.has(el.id)) {
      log('view-model', 'plan-only outside node skipped: id already in tree', { id: el.id, kind: el.kind });
      continue;
    }
    outside.push(planOnlyNode(el.kind as ViewKind, el));
    taken.add(el.id);
    log('view-model', 'plan-only outside node', { id: el.id, kind: el.kind });
  }
  const touched = new Set<ViewNode>();
  for (const c of held) {
    const holderId = actorHolding(plan, c.id, ownSystem);
    const holder = outside.find((a) => a.id === holderId);
    if (!holder) log('view-model', 'held container: its holder has no node, kept under the system', { id: c.id, holder: holderId });
    (holder ?? system).children.push(c);
    touched.add(holder ?? system);
  }
  for (const n of touched) {
    n.children = sortNodes(n.children);
    if (n !== system) n.weight = sumWeights(n.children);
  }
  if (outside.length === 0) return system;
  const id = taken.has(CONTEXT_ROOT_ID) || planById(plan).has(CONTEXT_ROOT_ID) ? CONTEXT_ROOT_ID + SYSTEM_ID_QUALIFIER : CONTEXT_ROOT_ID;
  // C1 A1 (b828) + b837: persons, our system, the other systems, then the externals; plan order inside each group (not
  // sortNodes). Ours stays the first system child (arrangeOutside holderSystem, camera.js openness).
  const group = (n: ViewNode): number => (n.kind === 'person' ? 0 : n.kind === 'system' ? 1 : 2);
  const children = [...outside.filter((n) => group(n) === 0), system, ...outside.filter((n) => group(n) === 1), ...outside.filter((n) => group(n) === 2)];
  log('view-model', 'context holder', { id, system: system.id, order: children.map((c) => c.id), held: held.length });
  return {
    id,
    kind: 'context',
    name: system.name,
    detail: '',
    weight: sumWeights(children),
    children,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
  };
}

/** Sum of the nodes' weights, 1 when that is 0 (a parent's weight). */
function sumWeights(nodes: ViewNode[]): number {
  return nodes.reduce((s, n) => s + n.weight, 0) || 1;
}

/**
 * P14-T44a, folder mode only (claim mode unions containers itself, see buildClaimModeContainers): a plan
 * container or component that matches no scanned node is added, so a greenfield plan shows on the map.
 * Container match: same rule as buildClaimModeContainers (exact id, else localId). Component match: exact
 * fqn, and (P14-T44c-a) a component that already stands for a scanned component is skipped, see matchPlanComponents.
 * A component goes under its plan container when that container is a node, else directly under the
 * system. Parent weights are NOT recomputed: plan-only nodes weigh 1 and do not change existing sums.
 * Existing children keep their order (the re-sort only places the new weight-1 nodes).
 * C1-CTX: `root` = the map root (the context node when the plan has actors), `system` = our system node. b328 EXT-2a:
 * a container an actor holds (actorHolding) is never matched to a scanned one; it goes under its actor's node.
 * b837: with `ownSystem`, a container of another plan system is held the same way and goes under that system's node.
 */
function attachPlanOnlyNodes(root: ViewNode, system: ViewNode, plan: Plan, components: { id: string; path: string }[], ownSystem: string | null = null): Map<string, PlanElement> {
  const taken = collectIds([root]);
  const scanned = system.children.filter((n) => n.kind === 'container');
  const containerByFqn = new Map<string, ViewNode>();
  const touched = new Set<ViewNode>([system]);
  const standIns = new Map<string, PlanElement>();   // P16-B17b: scanned component id -> the plan component it stands for

  for (const el of plan.elements) {
    if (el.kind !== 'container') continue;
    // b328 EXT-2a + b837: a container an actor or another system holds is never a scanned one; it goes under its holder's node (C1-CTX)
    const holderId = actorHolding(plan, el.id, ownSystem);
    const match = holderId !== null ? undefined : scanned.find((c) => c.id === el.id) ?? scanned.find((c) => c.id === localId(el.id));
    if (match) {
      containerByFqn.set(el.id, match);
      continue;
    }
    if (taken.has(el.id)) {
      log('view-model', 'plan-only container skipped: id already in tree', { id: el.id });
      continue;
    }
    const node = planOnlyNode('container', el);
    const holder = holderId !== null ? root.children.find((n) => n.id === holderId && isOutsideNode(n)) : undefined;
    if (holderId !== null && !holder) log('view-model', 'held container: its holder has no node, kept under the system', { id: el.id, holder: holderId });
    const parent = holder ?? system;
    taken.add(el.id);
    parent.children.push(node);
    touched.add(parent);
    containerByFqn.set(el.id, node);
    log('view-model', 'plan-only container', { id: el.id, parent: parent.id });
  }

  // P14-T44c-a: components that stand for a scanned component get no twin (see matchPlanComponents).
  const matched = matchPlanComponents(plan, components, taken, (fqn) => {
    const node = fqn ? containerByFqn.get(fqn) : undefined;
    return node && scanned.includes(node) ? node.id : null;
  });
  for (const [stand, el] of matched.standIns) {
    standIns.set(stand, el);
    log('view-model', 'plan-only component skipped: stands for scanned component', { id: el.id, scanned: stand });
  }
  for (const el of matched.unmatched) {
    const containerFqn = containerFqnOf(plan, el);   // Phase 28 S2: a component in a subregion goes to the subregion's container (markSubregions notes its subregion)
    const parent = (containerFqn ? containerByFqn.get(containerFqn) : undefined) ?? system;
    parent.children.push(planOnlyNode('component', el));
    taken.add(el.id);
    touched.add(parent);
    log('view-model', 'plan-only component', { id: el.id, parent: parent.id });
  }

  for (const n of touched) n.children = sortNodes(n.children);
  return standIns;
}

/**
 * Phase 28 LK-G (S7-S9; K 2026-11-04): plan subregions are notation on their container, not a level. For every container
 * node that stands for a plan container with subregions (plan kind `subregion`, b456; subregionsOf: declaration order, first = top), `container.subregions`
 * gets one `subregion` node per subregion (id = subregion fqn, the plan title and technology, metadata pills, origin 'plan', no
 * children, weight = its components' sum), and every component child whose plan element sits in a subregion (subregionOf)
 * gets `subregion` = that subregion's id. The children stay where they are (C2 -> C3 as without subregions), so ids, edges,
 * relations and the camera levels do not change; layoutTree groups the children by subregion and the viewer draws one
 * labelled frame per subregion around its components. Components with no subregion get none (L7: laid out below the frames).
 * b454: a subregion with metadata `shared 'true'` (isSharedSubregion) gets `sharedColumn: true` (side column, arrangeStack).
 * A container without subregions is left untouched. A component node's plan element: the plan component it stands for
 * (folder mode, standIns), else the node id read as an fqn (claim mode and plan-only components).
 */
function markSubregions(root: ViewNode, plan: Plan, standIns: Map<string, PlanElement> = new Map()): void {
  const byId = planById(plan);
  forEachNode(root, (container) => {   // C1-CTX: every container node (our system's, and those an external holds)
    if (container.kind !== 'container') return;
    const m = mapNodeToElement(plan, container.id, 'container');
    if (!('element' in m)) return;
    const subregions = subregionsOf(plan, m.element.id);
    if (subregions.length === 0) return;
    const frames = subregions.map((el) => (isSharedSubregion(el) ? { ...planBox('subregion', el, false), sharedColumn: true as const } : planBox('subregion', el, false)));
    const known = new Set(subregions.map((el) => el.id));
    for (const child of container.children) {
      const el = child.kind === 'component' ? standIns.get(child.id) ?? byId.get(child.id) : undefined;
      const subregion = el && el.kind === 'component' ? subregionOf(plan, el) : null;
      if (subregion && known.has(subregion.id)) child.subregion = subregion.id;
    }
    for (const f of frames) f.weight = subregionMembers(container, f.id).reduce((s, n) => s + n.weight, 0) || 1;
    container.subregions = frames;
    log('view-model', 'subregions marked', {
      id: container.id,
      subregions: frames.map((f) => `${f.id}:${subregionMembers(container, f.id).length}`),
      loose: container.children.filter((c) => c.subregion === undefined).length,
      shared: frames.filter((f) => f.sharedColumn).map((f) => f.id),
    });
  });
}

/**
 * P14-L4-4-i: planned code (function/class/method/type elements of the plan) attaches `planned` and
 * `builtState` to the real scanned node with the same file and name (`${link.path}#${link.name}`), in
 * folder and claim mode. Runs after the plan-only nodes exist, so they count as parents.
 * Returns the planned elements that got no real node (L4-4-ii adds ghost nodes for them), plus how many
 * of them found no parent on the map at all (logged by resolvePlannedParent).
 */
function buildPlannedElements(
  plan: Plan,
  root: ViewNode,
  snapshot: Snapshot,
): { unattached: PlannedCode[]; noParent: number; parentIds: Map<string, string> } {
  const planned = extractPlannedCode(plan);
  if (planned.length === 0) return { unattached: [], noParent: 0, parentIds: new Map() };

  const nodeById = new Map<string, ViewNode>();
  const nodeIds = new Set<string>();
  const fileNodeIds = new Set<string>();
  forEachNode(root, (n) => {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
    if (n.kind === 'component') nodeIds.add(n.id);
    if (n.kind === 'file') fileNodeIds.add(n.id);
  });

  const linkPathsByFqn = new Map<string, string[]>();
  for (const el of plan.elements) {
    if (el.kind === 'component') linkPathsByFqn.set(el.id, el.links.map((l) => l.path));
  }
  const ctx: ParentCtx = {
    nodeIds,
    fileNodeIds,
    components: snapshot.components.map((c) => ({ id: c.id, path: c.path })),
    parentLinkPaths: (fqn) => linkPathsByFqn.get(fqn) ?? [],
  };

  const unattached: PlannedCode[] = [];
  const parentIds = new Map<string, string>();   // P14-L4-4-ii: plan fqn -> parent node id (ghost nodes hang there)
  let noParent = 0;
  for (const p of planned) {
    const parent = resolvePlannedParent(p, ctx);
    if (parent) parentIds.set(p.element.id, parent.parentId);
    else noParent++;
    const link = p.link;
    const node = link && link.name !== null ? nodeById.get(`${link.path}#${link.name}`) : undefined;
    if (!node || p.status === undefined) {
      unattached.push(p);
      continue;
    }
    node.planned = {
      status: p.status,
      ...(p.signature !== undefined ? { signature: p.signature } : {}),
      ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
      source: p.element.source,
    };
    node.builtState = node.stub ? 'stub' : 'built';
  }
  log('view-model', 'planned code', { total: planned.length, unattached: unattached.length, noParent });
  return { unattached, noParent, parentIds };
}

/**
 * P14-L4-4-ii: a planned code element that no scanned node matches gets a ghost ViewNode (id = plan fqn,
 * kind = element kind, weight 1, builtState 'planned', origin 'plan', callsAvailable false, no file/line).
 * It is appended under the parent that resolvePlannedParent chose (one parent per ghost, so the model stays
 * a tree). An element whose link names an existing node gets no ghost (L4-4-i annotated that node). An
 * element with no parent gets no ghost (counted as noParent in buildPlannedElements). Ghosts are never parents.
 */
function attachGhostNodes(root: ViewNode, planned: { unattached: PlannedCode[]; parentIds: Map<string, string> }): void {
  const nodeById = new Map<string, ViewNode>();   // first match wins, as in buildPlannedElements
  forEachNode(root, (n) => {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  });

  const touched = new Set<ViewNode>();
  let ghosts = 0;
  for (const p of planned.unattached) {
    const parentId = planned.parentIds.get(p.element.id);
    if (parentId === undefined) continue;
    const link = p.link;
    if (link && link.name !== null && nodeById.has(`${link.path}#${link.name}`)) continue;
    const parent = nodeById.get(parentId);
    if (!parent) {
      log('view-model', 'planned ghost parent missing', { fqn: p.element.id, parentId });
      continue;
    }
    parent.children.push(ghostNode(p));
    touched.add(parent);
    ghosts++;
  }
  for (const n of touched) n.children = sortNodes(n.children);
  log('view-model', 'planned ghost nodes', { ghosts });
}

function ghostNode(p: PlannedCode): ViewNode {
  const el = p.element;
  return {
    id: el.id,
    kind: p.kind as ViewKind,
    name: p.name,
    detail: 'planned · ' + (p.signature ?? p.kind),
    weight: 1,
    children: [],
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
    builtState: 'planned',
    origin: { kind: 'plan', planFile: el.source.file, planLine: el.source.line, planEndLine: el.source.endLine },
    ...(p.status !== undefined
      ? {
          planned: {
            status: p.status,
            ...(p.signature !== undefined ? { signature: p.signature } : {}),
            ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
            source: el.source,
          },
        }
      : {}),
  };
}

/** P13-T2d / Decision 11: embedded plan file text limits (per file, and across all plan files). */
export const PLAN_FILE_MAX_LINES = 400;
export const PLAN_FILES_MAX_TOTAL = 2000;

/**
 * P13-T2c / Decision 8: the four plan-metadata keys the panel shows as pills (same four keys
 * snapshot/build.ts copies onto Component.meta). Only keys that exist with a non-empty value are
 * copied; returns undefined when none exist (so folder mode / bare elements get no `meta` at all).
 */
function pickMeta(metadata: Record<string, string> | undefined): ViewNode['meta'] | undefined {
  if (!metadata) return undefined;
  const meta: NonNullable<ViewNode['meta']> = {};
  if (metadata.status) meta.status = metadata.status;
  if (metadata.owner) meta.owner = metadata.owner;
  if (metadata.sprint) meta.sprint = metadata.sprint;
  if (metadata.priority) meta.priority = metadata.priority;
  if (metadata.tags) meta.tags = metadata.tags;
  if (metadata.shape) meta.shape = metadata.shape;   // C1 C2 (b834): a person's head (render.js shapePath)
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * P13-T2c, claim mode: system and container nodes get `meta` from their plan element's metadata
 * (component nodes get theirs from Component.meta at construction). Same node -> element mapping as
 * attachSavedLayouts, so an ambiguous / missing element simply yields no meta.
 */
function attachContainerMeta(root: ViewNode, plan: Plan): void {
  forEachNode(root, (n) => {
    if (n.kind === 'system' || n.kind === 'container') {
      const m = mapNodeToElement(plan, planLookupId(n), n.kind);
      if (!('element' in m)) {
        log('view-model', 'meta skipped', { id: n.id, reason: m.reason });
      } else {
        const meta = pickMeta(m.element.metadata);
        if (meta) {
          n.meta = meta;
          log('view-model', 'meta', { id: n.id, meta });
        }
      }
    }
  });
}

/**
 * P13-T2c: ViewNode.claims for a claim-mode component. ownedCount = functions this component owns
 * (Ownership.owner) that the claim matches; a function matched by several claims of the same
 * component is counted once, under its most specific claim (first in file order on a tie), so the
 * counts sum to the component's owned-function total.
 */
function buildClaimEntries(componentId: string, claims: Claim[], ownership: Ownership | null): NonNullable<ViewNode['claims']> {
  const counts = new Array<number>(claims.length).fill(0);
  if (ownership) {
    for (const [key, ownerId] of Object.entries(ownership.owner)) {
      if (ownerId !== componentId) continue;
      const hash = key.indexOf('#');
      const file = key.slice(0, hash);
      const name = key.slice(hash + 1);
      let best = -1;
      claims.forEach((c, i) => {
        if (!claimMatches(c, file, name)) return;
        if (best === -1 || SPECIFICITY[c.kind] > SPECIFICITY[claims[best].kind]) best = i;
      });
      if (best === -1) {
        log('view-model', 'owned function matches none of its component claims', { componentId, key });
      } else {
        counts[best]++;
      }
    }
  } else {
    log('view-model', 'claims without ownership: ownedCount 0', { componentId });
  }
  const entries = claims.map((c, i) => ({ ...c, ownedCount: counts[i] }));
  log('view-model', 'claim entries', { componentId, counts });
  return entries;
}

/**
 * P13-T2c / Decision 9: every OwnershipConflict naming `componentId` as a loser, as
 * {path, fn, lostTo}. Empty array when it never lost (caller omits the field).
 */
function buildLostClaims(componentId: string, ownership: Ownership | null): NonNullable<ViewNode['lostClaims']> {
  if (!ownership) return [];
  const lost = ownership.conflicts
    .filter((c) => c.losers.includes(componentId))
    .map((c) => ({ path: c.file, fn: c.fn, lostTo: c.winner }));
  if (lost.length > 0) log('view-model', 'lost claims', { componentId, count: lost.length });
  return lost;
}

/**
 * C1 A3 (b830): the title of the plan element our system maps to, by the same mapping as its uid, meta and saved layout
 * (mapNodeToElement: the system id, or the id of the element's title). null when no element maps (none, or ambiguous) or
 * its title is empty: the caller keeps the repo name.
 */
function planSystemTitle(plan: Plan, systemId: string): string | null {
  const m = mapNodeToElement(plan, systemId, 'system');
  const title = 'element' in m ? m.element.title.trim() : '';
  log('view-model', 'system title', title ? { id: systemId, title } : { id: systemId, kept: 'repo name', reason: 'reason' in m ? m.reason : 'empty title' });
  return title || null;
}

/**
 * b837: the fqn of the plan system our system is, by the same mapping as planSystemTitle (mapNodeToElement: the system id, or
 * the id of the element's title); null when none maps (none, or ambiguous). Every other plan system is outside at C1
 * (isOutsideElement); with null no plan system is outside (the map as before b837).
 */
function ownPlanSystem(plan: Plan, systemId: string): string | null {
  const m = mapNodeToElement(plan, systemId, 'system');
  if ('element' in m) return m.element.id;
  if (plan.elements.filter((e) => e.kind === 'system').length > 1) log('view-model', 'own plan system unknown: no other system is drawn', { id: systemId, reason: m.reason });
  return null;
}

/**
 * Phase 26 (T26-10): with `tests`, the page shows the tests of each c-item (needs a snapshot built with calls of the test files).
 * W6 (b302): `wireframes` = the loaded wireframe files by screen fqn, passed to buildNav (the caller loads them).
 */
export interface BuildViewModelOptions {
  tests?: { config: TestsConfig | undefined; runnerOf: RunnerOf };
  wireframes?: ReadonlyMap<string, WireframeFile>;
  /**
   * C1 A3 (b830): true = the system node and `ViewModel.title` take the title of the plan element the system maps to
   * (planSystemTitle), the repo name when none maps. The page passes it (html.ts buildPageModel); the queries do not
   * (query/elements.ts getModel), so the CLI and MCP outputs keep the repo name as the system title.
   */
  planTitle?: boolean;
}

export function buildViewModel(
  snapshot: Snapshot,
  summaryLine: string,
  plan?: Plan,
  planTexts?: Map<string, string>,
  opts: BuildViewModelOptions = {}
): ViewModel {
  // Build git subtitle or fallback to createdAt date (date only: YYYY-MM-DD)
  const subtitle = snapshot.meta.git
    ? `${snapshot.meta.git.commit.substring(0, 7)} · ${snapshot.meta.git.date.slice(0, 10)}`
    : `no git · ${snapshot.meta.createdAt.slice(0, 10)}`;

  // Absolute repo root, for P7-T3's capability reads (source lines / git history). Already
  // absolute -- see SnapshotMeta.repoPath's own doc comment -- so no new buildViewModel param
  // is needed; every call site already produces this via buildSnapshot.
  const repoRoot = snapshot.meta.repoPath;
  // Phase 29 T5: one `git log --follow` per distinct component source file in this build (many components share one).
  const historyOf = componentHistoryReader(repoRoot);

  // Build the element and file nodes
  const fileNodeMap = new Map<string, ViewNode>();
  const elementNodeMap = new Map<string, ViewNode>();

  // First pass: create element nodes for each file. Phase 26 (D8, D15): a role-test file gets no box (no file, slice or
  // element node); its cases hang on the c-items they test (ViewNode.tests) and it stays in the Files tab.
  for (const file of snapshot.files) {
    if (file.role === 'test') continue;
    const fileElements = buildFileElements(file, fileNodeMap, elementNodeMap, repoRoot);
    const fileNode: ViewNode = {
      id: file.file,
      kind: 'file',
      name: file.file.split('/').pop() || file.file,
      detail: formatLineCount(file.lineCount),
      weight: file.lineCount || 1,
      children: fileElements,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      file: file.file,
      callsAvailable: false,
      ...(file.fileOnly ? { fileOnly: true as const } : {}), // P14-T29a
    };
    fileNodeMap.set(file.file, fileNode);
    log('view-model', 'file node', { id: fileNode.id, weight: fileNode.weight, children: fileElements.length });
  }

  // Claim-mode detection (P6-T8's rule, reused via c4/ownership.ts's isClaimModePlan so this file,
  // snapshot/build.ts, and check.ts can never disagree): only a plan with >=1 genuine function-level
  // claim counts. Gating the plan-aware rendering below (container overlay, zero-file rendering,
  // slice/shared/unassigned) on this exact flag -- not on "a plan exists" -- is a deliberate P6-T9
  // deviation from the roadmap doc's literal wording for bug-report item (b), which describes the
  // container title/tech overlay as unconditional on any plan. It can't be: PhoFast's
  // architecture.c4 declares containers (phofast.web/api/db) under a plan with no function-level
  // claims, and PhoFast's single real container is folder/manifest-scanned with an unrelated id
  // ('phofast', from its root package.json) -- none of the plan's container fqns match it or its
  // localId. Applying the overlay/synthesis unconditionally would inject three new empty,
  // plan-only container nodes into PhoFast's rendering, which breaks this task's explicit
  // "folder-mode / plan without function-claims stays byte-identical" regression requirement. Gating
  // on claim-mode keeps that requirement intact while still satisfying every claim-mode test case.
  // P14-T44a: the claim-mode gate above still holds for the overlay/synthesis. Folder mode now adds
  // planOnly nodes for unmatched plan elements (attachPlanOnlyNodes, below), so a plan without
  // function-claims no longer renders byte-identical: it adds only planOnly nodes (see the guard test
  // in test/view-model-unit.test.ts).
  const claimMode = !!plan && isClaimModePlan(plan);
  const ownership: Ownership | null =
    claimMode && plan ? resolveOwnership(extractClaims(plan), snapshot.files, snapshot.fileEdges) : null;

  // Build component nodes
  const componentNodeMap = new Map<string, ViewNode>();
  for (const component of snapshot.components) {
    const children =
      component.mode === 'claim' && ownership
        ? buildSliceNodes(component.id, ownership, elementNodeMap, snapshot.files)
        : sortNodes(component.files.map((f) => fileNodeMap.get(f)).filter(Boolean) as ViewNode[]);
    const compWeight = children.reduce((s, n) => s + n.weight, 0) || 1;
    // claims/source/history are claim-mode only (same `component.mode === 'claim'` gate used for
    // `children` above, mirroring Phase 6's established mode-gating pattern) -- folder-mode
    // components have no .c4 source, so these fields stay undefined for them.
    const isClaimModeComponent = component.mode === 'claim';
    const lostClaims = isClaimModeComponent ? buildLostClaims(component.id, ownership) : [];
    const compMeta = isClaimModeComponent ? pickMeta(component.meta) : undefined;
    // P14-T38b: subtitle lists every distinct link path in plan order, joined with ' + ' (shows all links,
    // no count). component.path stays the first claim's path because model.ts origin lookups read it.
    const claimPaths = (isClaimModeComponent && component.claims ? component.claims : [])
      .map((c) => c.path)
      .filter((p, i, all) => all.indexOf(p) === i);
    const componentNode: ViewNode = {
      id: component.id,
      kind: 'component',
      name: component.name,
      detail: claimPaths.length > 0 ? claimPaths.join(' + ') : component.path,
      weight: compWeight,
      children,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      callsAvailable: false,
      ...(isClaimModeComponent && component.claims
        ? { claims: buildClaimEntries(component.id, component.claims, ownership) }
        : {}),
      ...(lostClaims.length > 0 ? { lostClaims } : {}),
      ...(isClaimModeComponent && compMeta ? { meta: compMeta } : {}),
      ...(isClaimModeComponent && component.source ? { source: component.source } : {}),
      ...(isClaimModeComponent && component.source
        ? { history: historyOf(component.source) }
        : {}),
    };
    componentNodeMap.set(component.id, componentNode);
    log('view-model', 'component node', { id: componentNode.id, weight: componentNode.weight, children: children.length });
  }

  // Build container nodes. Claim mode additionally unions in any plan container element that has
  // no folder/manifest counterpart (the "plan declares containers, repo has zero files" case) --
  // see buildClaimModeContainers for the id-matching rule.
  // b837: the plan system ours maps to; every other plan system is outside at C1 (its containers are held, not ours)
  const ownSystem = plan ? ownPlanSystem(plan, snapshot.system.id) : null;
  const containerNodeMap: Map<string, ViewNode> =
    claimMode && plan
      ? buildClaimModeContainers(snapshot, plan, componentNodeMap, ownSystem)
      : buildFolderModeContainers(snapshot, componentNodeMap);

  // Claim mode: shared/unassigned render as top-level siblings of the containers, under the system
  // (same sibling pattern as containers) -- per Ownership.shared / Ownership.unassigned.
  const extraSystemChildren: ViewNode[] = ownership
    ? buildSharedUnassignedNodes(snapshot.system.id, ownership, elementNodeMap, snapshot.files)
    : [];

  // Build the system node. b328 EXT-2a: claim-mode containers an actor (b837: or another plan system) holds go under it (buildContextRoot).
  const held = claimMode && plan ? Array.from(containerNodeMap.values()).filter((n) => actorHolding(plan, n.id, ownSystem) !== null) : [];
  const allChildren = [...Array.from(containerNodeMap.values()).filter((n) => !held.includes(n)), ...extraSystemChildren];
  const systemWeight = allChildren.reduce((s, n) => s + n.weight, 0) || 1;
  const childIds = collectIds([...allChildren, ...held]);
  const systemId = childIds.has(snapshot.system.id) ? snapshot.system.id + SYSTEM_ID_QUALIFIER : snapshot.system.id;
  if (systemId !== snapshot.system.id) {
    log('view-model', 'system id collides with a descendant id; qualified', { id: snapshot.system.id, systemId });
  }
  // C1 A3 (b830): the page names the system after its plan element (opts.planTitle); the repo name when none maps, and for the queries
  const systemName = (opts.planTitle && plan ? planSystemTitle(plan, snapshot.system.id) : null) ?? snapshot.system.name;
  const systemNode: ViewNode = {
    id: systemId,
    kind: 'system',
    name: systemName,
    detail: '',
    weight: systemWeight,
    children: sortNodes(allChildren),
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
  };
  log('view-model', 'system node', { weight: systemNode.weight, children: allChildren.length });
  // P20-T3 + C1-CTX: person/external beside the system (a 'context' root), before the edges and relations below are built
  const rootNode = plan ? buildContextRoot(systemNode, plan, held, ownSystem) : systemNode;
  if (claimMode && plan) markSubregions(rootNode, plan); // Phase 28 LK-G: before the edges and relations (a relation may name a subregion)

  const nav = plan ? buildNav(plan, opts.wireframes) : null; // P20-T4 (b126); W6 (b302): wireframes
  const model: ViewModel = {
    schemaVersion: 1,
    title: systemName,   // the header; C1 A3 (b830): the system's name (snapshot.system.name is the repo name, snapshot/build.ts)
    subtitle: subtitle,
    summary: summaryLine,
    repoPath: snapshot.meta.repoPath,
    root: rootNode,
    edges: finalizeEdges(snapshot.componentEdges, plan ?? null, rootNode), // P14-T35 (Q3): plan relations in folder mode too
    drift: null,
    planFindings: [],
    files: buildViewFiles(
      snapshot.files,
      plan,
      ownership,
      extraSystemChildren.find((n) => n.kind === 'shared')?.id ?? null,
      planTexts
    ),
    ...(plan ? { relations: buildRelations(plan, rootNode) } : {}), // P13-T2d
    ...(nav ? { nav } : {}), // P20-T4 (b126)
  };

  // P14-T44a: plan-only nodes exist only after `model` is built, so edges and relations are redone here (EXT-1: plan-only
  // containers/components are linkable). Folder mode: plan ids (generate-c4: c4pm.c4pm.mcp) differ from scan ids
  // (c4pm/mcp), so relations name the scanned node through the stand-in map (empty when no component stands in).
  const standIns =
    !claimMode && plan ? attachPlanOnlyNodes(rootNode, systemNode, plan, snapshot.components.map((c) => ({ id: c.id, path: c.path })), ownSystem) : undefined;
  if (plan && standIns) {
    markSubregions(rootNode, plan, standIns); // Phase 28 LK-G: folder mode, after the plan-only components exist
    const alias = new Map([...standIns].map(([scannedId, el]) => [el.id, scannedId] as const));
    model.edges = finalizeEdges(snapshot.componentEdges, plan, rootNode, alias);
    model.relations = buildRelations(plan, rootNode, alias);
  }
  if (plan) attachGhostNodes(rootNode, buildPlannedElements(plan, rootNode, snapshot)); // P14-L4-4-i: planned info on real code nodes; P14-L4-4-ii: ghosts for the rest
  if (ownership) attachUsedBy(systemNode, ownership); // P13-T2d
  if (ownership) attachImportedBy(systemNode, snapshot, ownership); // P14-T6b
  if (claimMode && plan) attachContainerMeta(rootNode, plan); // P13-T2c
  if (claimMode && plan) attachSavedLayouts(rootNode, plan); // P10-T3
  else if (plan) attachSavedLayouts(rootNode, plan, (k) => k === 'subregion'); // SR2 (b457, Q6): folder mode, a subregion's saved frame
  if (claimMode && plan && planTexts) attachPlanBlocks(rootNode, plan, planTexts); // P13-T2b
  attachOrigins(rootNode, snapshot, claimMode && plan ? plan : null); // P14-T4a
  if (plan) attachUids(rootNode, plan, standIns); // P14-T8 (any plan, not only claim mode); P16-B17b stand-ins
  if (standIns) attachStandInPlan(rootNode, standIns); // B14: folder mode, the plan's title/status/id on the scanned node
  if (plan) attachFoundation(rootNode, plan, model.edges, standIns); // b908
  if (opts.tests) {
    // Phase 26 (T26-10): the snapshot must carry the calls of the role-test files (runSnapshot collectCalls 'tests').
    const ix = testIndexOf({ snapshot, plan: plan ?? null, ownership, tests: opts.tests.config });
    const table = attachViewTests(rootNode, ix, opts.tests.runnerOf, plan ?? null);   // T26-12: plan = tests to write
    if (table) model.tests = table;
  }
  // b896: file -> file imports inside one box, a list apart from model.edges (role-test files have no box)
  const inner = buildInnerFileEdges(rootNode, snapshot.fileEdges);
  if (inner.length) model.fileEdges = inner;

  return model;
}

/**
 * P13-T2a: the Files tab's flat list. Source files first-class from the snapshot, plus the plan's
 * `.c4` files (kind 'plan', flag 'c4', no owners); sorted by path (plain compare).
 *  - Folder mode (ownership null): owners = [SnapshotFile.componentId] ('unassigned', a test file in no component: none),
 *    no flag.
 *  - Claim mode: owners come from the already-resolved Ownership.owner (`${file}#${name}` keys; no
 *    second resolution). 'shared-auto' maps to the Shared node id, 'unassigned' contributes no owner.
 *    flag: 'split' = more than one distinct real owner; 'unassigned' = nothing but unassigned
 *    functions (or no functions at all); 'shared' = no real owner and some shared function; 'test-only' = nothing
 *    but test-only functions (Phase 26). A test file carries role 'test' and no flag.
 */
function buildViewFiles(
  files: SnapshotFile[],
  plan: Plan | undefined,
  ownership: Ownership | null,
  sharedNodeId: string | null,
  planTexts?: Map<string, string>
): ViewFile[] {
  const byFile = new Map<string, string[]>();
  // Phase 26 (0.2b): files with test-only code, and files with unassigned code that is not test-only.
  const testOnly = new Set(ownership?.testOnly ?? []);
  const testOnlyFiles = new Set<string>();
  const unassignedFiles = new Set<string>();
  if (ownership) {
    for (const [key, ownerId] of Object.entries(ownership.owner)) {
      const file = key.slice(0, key.indexOf('#'));
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(ownerId);
      if (ownerId === 'unassigned') (testOnly.has(key) ? testOnlyFiles : unassignedFiles).add(file);
    }
  }

  const out: ViewFile[] = [];
  for (const f of files) {
    if (!ownership) {
      out.push({ path: f.file, kind: 'source', owners: f.componentId === 'unassigned' ? [] : [f.componentId], ...(f.role ? { role: f.role } : {}), ...(f.fileOnly ? { fileOnly: true as const } : {}) });
      continue;
    }
    const owners: string[] = [];
    let realOwners = 0;
    let hasShared = false;
    for (const ownerId of byFile.get(f.file) ?? []) {
      if (ownerId === 'unassigned') continue;
      if (ownerId === 'shared-auto') {
        hasShared = true;
        if (sharedNodeId && !owners.includes(sharedNodeId)) owners.push(sharedNodeId);
        continue;
      }
      if (!owners.includes(ownerId)) {
        owners.push(ownerId);
        realOwners++;
      }
    }
    // P14-T29a: a zero-function file owned through a file/folder claim (Ownership.fileOwner) is a real owner.
    const fileOwnerId = ownership.fileOwner?.[f.file];
    if (fileOwnerId && !owners.includes(fileOwnerId)) {
      owners.push(fileOwnerId);
      realOwners++;
    }
    // Phase 26: a role-test file neither gives nor takes ownership, so it is never flagged split/shared/unassigned.
    // A file whose only code is test-only (used by tests alone) gets its own flag, not 'unassigned' (0.2b).
    const onlyTestOnly = testOnlyFiles.has(f.file) && !unassignedFiles.has(f.file);
    const flag: ViewFile['flag'] = f.role === 'test' ? undefined
      : realOwners > 1 ? 'split' : realOwners === 0 ? (hasShared ? 'shared' : onlyTestOnly ? 'test-only' : 'unassigned') : undefined;
    out.push({
      path: f.file,
      kind: 'source',
      owners,
      ...(flag ? { flag } : {}),
      ...(f.role ? { role: f.role } : {}),
      ...(f.elements.length === 0 ? { noFunctions: true as const } : {}), // P14-T6b
      ...(f.fileOnly ? { fileOnly: true as const } : {}), // P14-T29a
    });
  }
  for (const p of plan?.files ?? []) out.push({ path: p, kind: 'plan', owners: [], flag: 'c4' });

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // P13-T2d / Decision 11: embed plan file text, <= PLAN_FILE_MAX_LINES each and <= PLAN_FILES_MAX_TOTAL
  // overall (consumed in path order); a cut file reports how many lines it lost in `truncated`.
  if (planTexts) {
    let budget = PLAN_FILES_MAX_TOTAL;
    for (const f of out) {
      if (f.kind !== 'plan') continue;
      const text = planTexts.get(f.path);
      if (text === undefined) {
        log('view-model', 'plan file text missing', { path: f.path });
        continue;
      }
      const all = text.split(/\r?\n/);
      if (all.length > 0 && all[all.length - 1] === '') all.pop(); // trailing newline is not a line
      const keep = Math.max(0, Math.min(all.length, PLAN_FILE_MAX_LINES, budget));
      budget -= keep;
      f.lines = all.slice(0, keep);
      if (keep < all.length) f.truncated = all.length - keep;
      log('view-model', 'plan file lines', { path: f.path, total: all.length, kept: keep, budgetLeft: budget });
    }
  }

  log('view-model', 'files list', {
    total: out.length,
    plan: out.filter((x) => x.kind === 'plan').length,
    split: out.filter((x) => x.flag === 'split').length,
    shared: out.filter((x) => x.flag === 'shared').length,
    unassigned: out.filter((x) => x.flag === 'unassigned').length,
    testOnly: out.filter((x) => x.flag === 'test-only').length,
    tests: out.filter((x) => x.role === 'test').length,
  });
  return out;
}

/**
 * Relation endpoint -> node id, shared by finalizeEdges and buildRelations so they cannot disagree:
 * exact id first (claim-mode nodes are keyed by the plan element's fqn), else localId(endpoint).
 */
function makeEndpointResolver(
  linkable: Set<string>,
  containerIds: Set<string> = new Set(),
  alias: Map<string, string> = new Map(),
  planOnlyIds: Set<string> = new Set(),
  actorIds: Set<string> = new Set()
): (ep: string) => string | null {
  // A plan-only node is the last resort: a plan container with no exact scanned twin may still stand for a scanned
  // container by the normalised match, and that match wins (EXT-1 keeps code-backed relations unchanged).
  const exact = (id: string): boolean => linkable.has(id) && !planOnlyIds.has(id);
  // C1 D1 (b835): a person or external matches only by its exact id. The local-id fallback never lands on one (an IO control
  // 'shop.web.login.google' is not the external 'google').
  const local = (ep: string): string | null => {
    const id = localId(ep);
    if (id === ep || !actorIds.has(id)) return id;
    log('view-model', 'endpoint local id names an actor; not resolved by it', { endpoint: ep, actor: id });
    return null;
  };
  return (ep) => {
    const stood = alias.get(ep);   // folder mode: a plan component's fqn names the scanned node that stands for it
    if (stood !== undefined && linkable.has(stood)) return stood;
    if (exact(ep)) return ep;
    const loc = local(ep);
    if (loc !== null && exact(loc)) return loc;
    // P14-T35: normalised match for CONTAINER nodes only (plan 'api_getway' == folder 'api-getway'), and
    // only when exactly one container matches; an ambiguous match is not resolved (logged).
    const want = toId(localId(ep));
    const hits = [...containerIds].filter((id) => toId(id) === want);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      log('view-model', 'endpoint ambiguous after normalisation; not resolved', { endpoint: ep, hits });
      return null;
    }
    if (linkable.has(ep)) return ep;
    if (loc !== null && linkable.has(loc)) return loc;
    return null;
  };
}

/**
 * b837: a node outside our system at C1, the view side of isOutsideElement: a person or external (isMapActor), or another plan
 * system (a plan-only 'system' node, made by buildContextRoot; our system node is never plan-only). Its subtree is someone
 * else's: never a stand-in for our code, resolved by exact id, and its relations carry their labels (C1 D1).
 */
function isOutsideNode(n: ViewNode): boolean {
  return isMapActor(n.kind) || (n.kind === 'system' && n.planOnly === true);
}

/**
 * b328 EXT-2a: forEachNode without the subtrees of actor nodes. What an external holds is never a stand-in for our code:
 * no normalised match picks its containers, and its plan-only nodes resolve exactly (they are no last resort).
 * b837: the subtree of another plan system is skipped the same way (isOutsideNode).
 */
function forEachOutsideActors(root: ViewNode, fn: (n: ViewNode) => void): void {
  fn(root);
  if (!isOutsideNode(root)) nodesBelow(root).forEach((c) => forEachOutsideActors(c, fn));
}

/** Ids of every container node in the tree outside the actors (the only nodes the normalised endpoint match may pick). */
function collectContainerIds(root: ViewNode): Set<string> {
  const ids = new Set<string>();
  forEachOutsideActors(root, (n) => {
    if (n.kind === 'container' && !n.planOnly) ids.add(n.id);
  });
  return ids;
}

/**
 * Can a relation end at this node? By kind only: containers, subregions, components and actors (person, external), whether
 * scanned or plan-only (a greenfield plan has no code yet, EXT-1). The normalised container match
 * (collectContainerIds) still skips plan-only containers, so scanned-code behaviour is unchanged.
 * b837: another plan system too (isOutsideNode); our own system node stays not linkable, as before.
 */
function isLinkable(n: ViewNode): boolean {
  return n.kind === 'component' || n.kind === 'container' || n.kind === 'subregion' || isOutsideNode(n);
}

/**
 * Ids of every plan-only container/component in the tree outside the actors (they resolve after the scanned ones, see
 * makeEndpointResolver; what an actor holds resolves exactly, b328 EXT-2a).
 */
function collectPlanOnlyIds(root: ViewNode): Set<string> {
  const ids = new Set<string>();
  forEachOutsideActors(root, (n) => {
    if (n.planOnly && (n.kind === 'container' || n.kind === 'component')) ids.add(n.id);
  });
  return ids;
}

/**
 * C1 D1 (b835): the person and external nodes (`actors`) and every id at or under one (`outside`: an external that holds
 * containers, b328, holds them outside the system too). The resolver lands on an actor only by its exact id; finalizeEdges
 * carries the plan labels of the relations with an outside end.
 * b837: `actors` holds every outside node (isOutsideNode), so another plan system and what it holds count the same way.
 */
function collectOutsideIds(root: ViewNode): { actors: Set<string>; outside: Set<string> } {
  const actors = new Set<string>();
  const outside = new Set<string>();
  forEachNode(root, (n) => {
    if (!isOutsideNode(n)) return;
    actors.add(n.id);
    forEachNode(n, (m) => outside.add(m.id));
  });
  return { actors, outside };
}

/** Ids of every node in the tree a relation can link (isLinkable). */
function collectLinkable(root: ViewNode): Set<string> {
  const linkable = new Set<string>();
  forEachNode(root, (n) => {
    if (isLinkable(n)) linkable.add(n.id);
  });
  return linkable;
}

/**
 * P13-T2d / Decision 6: ViewModel.relations. Every plan relation (all modes, file order, no dedupe, no
 * self-filter beyond resolution) whose two endpoints resolve via makeEndpointResolver. Unresolved ones
 * are dropped and logged.
 */
function buildRelations(plan: Plan, root: ViewNode, alias?: Map<string, string>): ViewRelation[] {
  // C1 D1 (b835): an actor only by its exact id, as on the arrows (finalizeEdges)
  const resolve = makeEndpointResolver(collectLinkable(root), collectContainerIds(root), alias, collectPlanOnlyIds(root), collectOutsideIds(root).actors);
  const out: ViewRelation[] = [];
  for (const rel of plan.relations) {
    const from = resolve(rel.from);
    const to = resolve(rel.to);
    if (!from || !to) {
      log('view-model', 'relation dropped (unresolved endpoint)', { from: rel.from, to: rel.to, file: rel.source.file, line: rel.source.line });
      continue;
    }
    out.push({ from, to, label: rel.label, file: rel.source.file, line: rel.source.line });
  }
  log('view-model', 'relations', { declared: plan.relations.length, kept: out.length });
  return out;
}

/**
 * P13-T2d: set `usedBy` on each child of the 'shared' node from SharedCode.users (claim mode). Users
 * are elementIds; each is resolved like a relation endpoint, falling back to the raw id (logged) so no
 * user is silently lost.
 */
function attachUsedBy(root: ViewNode, ownership: Ownership): void {
  const sharedNode = root.children.find((c) => c.kind === 'shared');
  if (!sharedNode) return;
  const resolve = makeEndpointResolver(collectLinkable(root));
  const usersByFn = new Map(ownership.shared.map((s) => [s.fn, s.users] as const));
  for (const child of sharedNode.children) {
    const users = usersByFn.get(child.id) ?? [];
    child.usedBy = users.map((u) => {
      const id = resolve(u);
      if (!id) log('view-model', 'usedBy user matches no node; kept raw', { fn: child.id, user: u });
      return id ?? u;
    });
    log('view-model', 'usedBy', { fn: child.id, usedBy: child.usedBy });
  }
}

/**
 * Final edge list for the browser (P9-T9a).
 *  1. Any plan (claim or folder mode, P14-T35): plan.relations are merged in. An endpoint resolves to a node id by the same
 *     order buildClaimModeContainers uses: exact id (claim-mode component nodes are keyed by the plan
 *     element's fqn, which is what a relation's from/to carries), else localId(endpoint). A relation
 *     with an endpoint that resolves to no component/container node, or that resolves to itself, is
 *     skipped (logged). Weight rule: if a scanned edge with the same from/to exists, the plan relation
 *     adds 1 to its weight (sum); a plan-only edge gets weight 1; repeated identical plan relations
 *     count once.
 *  2. Any edge (scanned or plan) whose from/to is not the id of a node in the final tree is dropped and
 *     logged, so the viewer never receives a dangling edge.
 */
function finalizeEdges(scanned: ViewEdge[], claimPlan: Plan | null, root: ViewNode, alias?: Map<string, string>): ViewEdge[] {
  const nodeIds = new Set<string>();
  const linkable = new Set<string>();
  forEachNode(root, (n) => {
    nodeIds.add(n.id);
    if (isLinkable(n)) linkable.add(n.id);
  });

  const edges: ViewEdge[] = scanned.map((e) => ({ ...e }));
  if (claimPlan) {
    const { actors, outside } = collectOutsideIds(root);
    const resolve = makeEndpointResolver(linkable, collectContainerIds(root), alias, collectPlanOnlyIds(root), actors);
    const seenPlan = new Set<string>();
    const labelsOf = new Map<ViewEdge, string[]>();   // C1 D1 (b835): an edge with an outside end -> its relations' labels
    for (const rel of claimPlan.relations) {
      const from = resolve(rel.from);
      const to = resolve(rel.to);
      if (!from || !to || from === to) {
        log('view-model', 'plan relation skipped (unresolved or self)', { from: rel.from, to: rel.to });
        continue;
      }
      const key = `${from}\u0000${to}`;
      let edge = edges.find((e) => e.from === from && e.to === to);
      if (!seenPlan.has(key)) {
        seenPlan.add(key);
        if (edge) edge.weight += 1;
        else edges.push((edge = { from, to, weight: 1 }));
      }
      // C1 D1 (b835): a relation with a person or external (or what one holds) at either end carries its plan label; every
      // distinct label of the pair is kept, in plan order. Relations inside the system stay unlabelled (C2/C3 unchanged, Q3).
      if (edge && rel.label && (outside.has(from) || outside.has(to))) {
        const labels = labelsOf.get(edge) ?? [];
        if (!labels.includes(rel.label)) labels.push(rel.label);
        labelsOf.set(edge, labels);
      }
    }
    for (const [edge, labels] of labelsOf) {
      edge.label = labels[0];
      edge.labelled = true;
      if (labels.length > 1) edge.labels = labels;
    }
    if (labelsOf.size) log('view-model', 'actor edge labels', { edges: labelsOf.size });
  }

  return edges.filter((e) => {
    const ok = nodeIds.has(e.from) && nodeIds.has(e.to);
    if (!ok) log('view-model', 'dropped dangling edge', { from: e.from, to: e.to, weight: e.weight });
    return ok;
  });
}

/**
 * b896 (K 2026-11-19): the imports file -> file that stay inside one box. For each node, its file/slice
 * children map file path -> child id (a file split into slices of two components gives one entry per parent); a fileEdge
 * whose two files are both in one parent's map becomes `{ from: idA, to: idB, weight: 1 }`. Self imports are skipped;
 * duplicates are kept once; sorted by from, then to. Kept apart from model.edges (component arrows, layout, queries).
 */
export function buildInnerFileEdges(root: ViewNode, fileEdges: FileEdge[]): ViewEdge[] {
  const byKey = new Map<string, ViewEdge>();
  forEachNode(root, (parent) => {
    const idOf = new Map<string, string>();
    for (const child of parent.children) {
      if ((child.kind === 'file' || child.kind === 'slice') && child.file) idOf.set(child.file, child.id);
    }
    if (idOf.size < 2) return;
    for (const e of fileEdges) {
      if (e.from === e.to) continue;
      const from = idOf.get(e.from);
      const to = idOf.get(e.to);
      if (!from || !to) continue;
      const key = `${from}\u0000${to}`;
      if (!byKey.has(key)) byKey.set(key, { from, to, weight: 1 });
    }
  });
  const edges = [...byKey.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  log('view-model', 'inner file edges', { count: edges.length });
  return edges;
}

/**
 * Today's folder-mode container-node construction, unchanged from before P6-T9: one node per
 * Snapshot.containers entry, name/detail from the folder/manifest Container record.
 */
function buildFolderModeContainers(
  snapshot: Snapshot,
  componentNodeMap: Map<string, ViewNode>
): Map<string, ViewNode> {
  const containerNodeMap = new Map<string, ViewNode>();
  for (const container of snapshot.containers) {
    const containerComps = snapshot.components
      .filter((c) => c.containerId === container.id)
      .map((c) => componentNodeMap.get(c.id))
      .filter(Boolean) as ViewNode[];
    const containerWeight = containerComps.reduce((s, n) => s + n.weight, 0) || 1;
    const detail = containerComps.length === 0 ? 'no parsed code' : container.tech;
    const containerNode: ViewNode = {
      id: container.id,
      kind: 'container',
      name: container.name,
      detail: detail,
      weight: containerWeight,
      children: sortNodes(containerComps),
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      callsAvailable: false,
    };
    containerNodeMap.set(container.id, containerNode);
    log('view-model', 'container node', { id: containerNode.id, weight: containerNode.weight, children: containerComps.length });
  }
  return containerNodeMap;
}

/**
 * Phase 34 F1 (b933): the plan container a scanned (manifest) container stands for, else null. It is the one container
 * element (not held by an actor, b837) that links the scanned folder (`link .../WebService/`, or a path inside it) or has
 * a component with a link inside it. Several plan containers match, or none: null (the caller keeps the scanned box).
 * A scanned container at the repo root ('.') never matches: every link is inside it.
 */
function planContainerOfFound(plan: Plan, found: Container, ownSystem: string | null): string | null {
  const dir = found.path.replace(/\/+$/, '');
  if (dir === '' || dir === '.') return null;
  const inside = (p: string): boolean => {
    const path = p.replace(/\/+$/, '');
    return path === dir || path.startsWith(dir + '/');
  };
  const matches = new Set<string>();
  for (const el of plan.elements) {
    if (el.kind !== 'container' && el.kind !== 'component') continue;
    if (!el.links.some((l) => inside(l.path))) continue;
    const containerId = el.kind === 'container' ? el.id : containerFqnOf(plan, el);
    if (containerId === null || actorHolding(plan, containerId, ownSystem) !== null) continue;
    if (plan.elements.some((e) => e.id === containerId && e.kind === 'container')) matches.add(containerId);
  }
  return matches.size === 1 ? Array.from(matches)[0] : null;
}

/**
 * Claim-mode container-node construction (P6-T9, bug-report items a/b): unions snapshot.containers
 * (folder/manifest-scanned) with the plan's own `container` elements, so:
 *   - a container that exists on both sides gets the plan's title/technology instead of the
 *     folder/manifest name/tech (item b) -- matched by exact id, else by the plan element's
 *     localId (PlanElement ids are fqn; Container.id is bare -- see names.ts's `localId` doc)
 *   - a container the plan declares but that has no folder/manifest counterpart (e.g. the repo has
 *     zero files, so findContainers never ran against real subdirectories) still gets a node,
 *     sourced purely from the plan (item a) -- keyed by its own fqn so claim-mode components whose
 *     containerId fell back to that same fqn (see snapshot/build.ts's resolveContainerId) attach to
 *     the right node
 */
function buildClaimModeContainers(
  snapshot: Snapshot,
  plan: Plan,
  componentNodeMap: Map<string, ViewNode>,
  ownSystem: string | null = null
): Map<string, ViewNode> {
  interface Slot {
    container?: Container;
    planEl?: PlanElement;
  }
  const slots = new Map<string, Slot>();

  for (const container of snapshot.containers) {
    slots.set(container.id, { container });
  }

  for (const el of plan.elements) {
    if (el.kind !== 'container') continue;
    // b328 EXT-2a: a container an actor holds is never matched to a scanned one (no id, localId or root merge); its own
    // slot, keyed by its fqn. buildViewModel moves its node under the actor (buildContextRoot). b837: or another plan system.
    if (actorHolding(plan, el.id, ownSystem) !== null) {
      if (slots.has(el.id)) log('view-model', 'held container skipped: id already a scanned container', { id: el.id });
      else slots.set(el.id, { planEl: el });
      continue;
    }
    const lid = localId(el.id);
    const key = slots.has(el.id) ? el.id : slots.has(lid) ? lid : el.id;
    // P14-T5b: plan `root_files` (technology 'Unknown', born from generate-c4's _root mapping) and
    // the scanned `_root` fallback are the same box. Merged node keeps the PLAN id; `_root` stays
    // the snapshot container id.
    const rootSlot = slots.get(ROOT_CONTAINER_ID);
    if (
      key === el.id &&
      !slots.has(key) &&
      isUnknownPlanRoot(el) &&
      rootSlot &&
      !rootSlot.planEl
    ) {
      slots.delete(ROOT_CONTAINER_ID);
      slots.set(el.id, { container: rootSlot.container, planEl: el });
      log('view-model', 'root merged', { planId: el.id, scannedId: ROOT_CONTAINER_ID });
      continue;
    }
    const existing = slots.get(key);
    slots.set(key, { container: existing?.container, planEl: el });
  }

  // Phase 34 F1 (b933): a scanned container no plan container matched by id is the box of the plan container that links its
  // folder or claims code in it (the plan container keeps its own id, title and uid); drawn once, not twice.
  for (const [id, slot] of Array.from(slots)) {
    if (slot.planEl || !slot.container) continue;
    const target = planContainerOfFound(plan, slot.container, ownSystem);
    if (target === null || !slots.has(target)) continue;
    slots.delete(id);
    log('view-model', 'scanned container merged into plan container', { scannedId: id, planId: target });
  }

  const containerNodeMap = new Map<string, ViewNode>();
  for (const [id, slot] of slots) {
    const containerComps = snapshot.components
      .filter((c) => c.containerId === id || (slot.container !== undefined && c.containerId === slot.container.id))
      .map((c) => componentNodeMap.get(c.id))
      .filter(Boolean) as ViewNode[];
    // Phase 34 F1: a scanned container with no parsed code that no plan element stands for is not drawn.
    if (!slot.planEl && containerComps.length === 0) {
      log('view-model', 'empty scanned container not drawn', { id });
      continue;
    }
    const containerWeight = containerComps.reduce((s, n) => s + n.weight, 0) || 1;
    const name = slot.planEl?.title ?? slot.container?.name ?? id;
    const detail =
      slot.planEl?.technology ??
      (slot.container ? (containerComps.length === 0 ? 'no parsed code' : slot.container.tech) : 'Unknown');
    const containerNode: ViewNode = {
      id,
      kind: 'container',
      name,
      detail,
      weight: containerWeight,
      children: sortNodes(containerComps),
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      callsAvailable: false,
    };
    containerNodeMap.set(id, containerNode);
    log('view-model', 'container node (claim-mode)', { id, weight: containerWeight, children: containerComps.length });
  }
  return containerNodeMap;
}

/**
 * One 'slice' node per file a claim-mode component owns >=1 element in (per Ownership.owner),
 * named by that file. Children are the file's actual element nodes (already built in the first
 * pass, same `${file}#${name}` id scheme Ownership.owner uses) filtered down to the ones this
 * component owns, so weight/detail/line info stay correct and consistent with folder-mode's file
 * nodes -- only the grouping (by owner instead of by every element in the file) differs.
 */
function buildSliceNodes(
  componentId: string,
  ownership: Ownership,
  elementNodeMap: Map<string, ViewNode>,
  files: SnapshotFile[] = []
): ViewNode[] {
  // Phase 26 (D8): a role-test file is never a slice, even when a claim covers it (its cases are ViewNode.tests).
  const testFiles = new Set(files.filter((f) => f.role === 'test').map((f) => f.file));
  const ownedByFile = new Map<string, string[]>();
  for (const [key, ownerId] of Object.entries(ownership.owner)) {
    if (ownerId !== componentId) continue;
    const file = key.slice(0, key.indexOf('#'));
    if (testFiles.has(file)) continue;
    if (!ownedByFile.has(file)) ownedByFile.set(file, []);
    ownedByFile.get(file)!.push(key);
  }

  const slices: ViewNode[] = [];
  for (const [file, keys] of ownedByFile) {
    const ownedNodes = sortNodes(
      dropMethodsOfClasses(keys.map((k) => elementNodeMap.get(k)).filter(Boolean) as ViewNode[], elementNodeMap)
    );
    const weight = ownedNodes.reduce((s, n) => s + n.weight, 0) || 1;
    slices.push({
      id: `${componentId}::slice::${file}`,
      kind: 'slice',
      name: file.split('/').pop() || file,
      detail: `${ownedNodes.length} owned element${ownedNodes.length === 1 ? '' : 's'} · ${file}`,
      weight,
      children: ownedNodes,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      file,
      callsAvailable: false,
      origin: { kind: 'scanned', folder: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.' },
    });
  }

  // P14-T29a: zero-function files this component owns via a file/folder claim (Ownership.fileOwner).
  // They have no element nodes, so the slice has no children. fileOwner values are the same ids as
  // Ownership.owner values, so they compare to componentId directly (as the loop above does).
  // A zero-function file with NO owner stays out of the architecture tree (it is not a function);
  // it is listed in the Files tab with flag 'unassigned' (buildViewFiles).
  // The file-only flag/detail follow SnapshotFile.fileOnly: a parsed file that merely has no functions
  // (e.g. a .js file with only top-level code) gets a plain slice, not the 'file-only (no parser)' one.
  const fileByPath = new Map(files.map((f) => [f.file, f] as const));
  for (const [file, ownerId] of Object.entries(ownership.fileOwner ?? {})) {
    if (ownerId !== componentId || testFiles.has(file)) continue;
    const sf = fileByPath.get(file);
    const isFileOnly = !!sf?.fileOnly;
    slices.push({
      id: `${componentId}::slice::${file}`,
      kind: 'slice',
      name: file.split('/').pop() || file,
      detail: (isFileOnly ? 'file-only (no parser) · ' : 'no functions · ') + file,
      weight: sf?.lineCount || 1,
      children: [],
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      file,
      callsAvailable: false,
      origin: { kind: 'scanned', folder: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.' },
      ...(isFileOnly ? { fileOnly: true as const } : {}),
    });
  }
  return sortNodes(slices);
}

/**
 * 'shared'/'unassigned' top-level sibling nodes under the system (same sibling pattern as
 * containers), one each, per Ownership.shared / Ownership.unassigned. Children reuse the actual
 * element nodes built in the first pass.
 */
function buildSharedUnassignedNodes(
  systemId: string,
  ownership: Ownership,
  elementNodeMap: Map<string, ViewNode>,
  files: SnapshotFile[]
): ViewNode[] {
  const sharedChildren = sortNodes(
    dropMethodsOfClasses(
      ownership.shared.map((s) => elementNodeMap.get(s.fn)).filter(Boolean) as ViewNode[],
      elementNodeMap
    )
  );
  const unassignedChildren = sortNodes(
    dropMethodsOfClasses(
      ownership.unassigned.map((id) => elementNodeMap.get(id)).filter(Boolean) as ViewNode[],
      elementNodeMap
    )
  );

  const sharedNode: ViewNode = {
    id: `${systemId}::shared`,
    kind: 'shared',
    name: 'Shared',
    detail: `${ownership.shared.length} shared function${ownership.shared.length === 1 ? '' : 's'}`,
    weight: sharedChildren.reduce((s, n) => s + n.weight, 0) || 1,
    children: sharedChildren,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
    origin: { kind: 'synthetic', rule: 'no claim covers it and a claimed file imports it' },
  };
  const unassignedNode: ViewNode = {
    id: `${systemId}::unassigned`,
    kind: 'unassigned',
    name: 'Unassigned',
    detail: `${ownership.unassigned.length} unassigned function${ownership.unassigned.length === 1 ? '' : 's'}`,
    weight: unassignedChildren.reduce((s, n) => s + n.weight, 0) || 1,
    children: unassignedChildren,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    callsAvailable: false,
    origin: { kind: 'synthetic', rule: 'no claim covers it and no claimed file imports it' },
  };
  const zeroFunctionFiles = filesWithoutFunctions(files, ownership.fileOwner);
  // P14-T6b: origins (files grouped by folder) for both nodes; emptyFiles + detail only on Unassigned.
  sharedNode.origins = groupFilesByFolder(sharedChildren.map((n) => n.file));
  unassignedNode.origins = groupFilesByFolder([...unassignedChildren.map((n) => n.file), ...zeroFunctionFiles]);
  if (zeroFunctionFiles.length > 0) {
    unassignedNode.emptyFiles = zeroFunctionFiles;
    unassignedNode.detail =
      `${ownership.unassigned.length} unassigned function${ownership.unassigned.length === 1 ? '' : 's'}, ` +
      `${zeroFunctionFiles.length} file${zeroFunctionFiles.length === 1 ? '' : 's'} without functions`;
  }
  const out: ViewNode[] = [];
  if (sharedChildren.length > 0) out.push(sharedNode);
  if (unassignedChildren.length > 0 || zeroFunctionFiles.length > 0) out.push(unassignedNode);
  log('view-model', 'shared/unassigned nodes', {
    shared: sharedChildren.length,
    unassigned: unassignedChildren.length,
    zeroFunctionFiles: zeroFunctionFiles.length,
    kept: out.map((n) => n.kind),
  });
  return out;
}

/** P14-T6b: distinct files grouped by folder ('.' = repo root); folders and files sorted. */
function groupFilesByFolder(paths: (string | undefined)[]): { folder: string; files: string[] }[] {
  const byFolder = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!p) continue;
    const i = p.lastIndexOf('/');
    const folder = i < 0 ? '.' : p.slice(0, i);
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder)!.add(p);
  }
  return Array.from(byFolder.keys())
    .sort(cmp)
    .map((folder) => ({ folder, files: Array.from(byFolder.get(folder)!).sort(cmp) }));
}

/** P14-T6b: file-level importers of each shared child, with their real (claimed) owners. Differs from usedBy. */
function attachImportedBy(root: ViewNode, snapshot: Snapshot, ownership: Ownership): void {
  const sharedNode = root.children.find((c) => c.kind === 'shared');
  if (!sharedNode) return;
  // Phase 26: role-test files are no importers here (a test never makes its component a user).
  const elementsByFile = new Map(snapshot.files.filter((f) => f.role !== 'test').map((f) => [f.file, f.elements] as const));
  for (const child of sharedNode.children) {
    if (!child.file) continue;
    const seen = new Set<string>();
    const entries: { file: string; owner: string }[] = [];
    for (const edge of snapshot.fileEdges) {
      if (edge.to !== child.file) continue;
      for (const el of elementsByFile.get(edge.from) ?? []) {
        const o = ownership.owner[`${edge.from}#${el.name}`];
        if (!o || o === 'shared-auto' || o === 'unassigned') continue;
        const k = `${edge.from}\u0000${o}`;
        if (seen.has(k)) continue;
        seen.add(k);
        entries.push({ file: edge.from, owner: o });
      }
    }
    entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    child.importedBy = entries;
    log('view-model', 'importedBy', { fn: child.id, importedBy: entries.length });
  }
}

/**
 * P14-T6a: sorted paths of files with no parsed functions that have no owner. P14-T29b: a file with
 * an owner in fileOwner (a file/folder claim, T28a1) is a real owner, so it is dropped here.
 */
function filesWithoutFunctions(files: SnapshotFile[], fileOwner?: Record<string, string>): string[] {
  return files
    .filter((f) => f.elements.length === 0 && !fileOwner?.[f.file] && f.role !== 'test')   // Phase 26: a test helper or setup file is no unassigned code
    .map((f) => f.file)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build element nodes for a file, handling class methods.
 * Returns sorted children for the file.
 */
function buildFileElements(
  file: SnapshotFile,
  fileNodeMap: Map<string, ViewNode>,
  elementNodeMap: Map<string, ViewNode>,
  repoRoot: string,
): ViewNode[] {
  // Read the file once for all its code snippets (b585: a read per function kept one copy
  // of the file alive per function, memory quadratic in the file size).
  const lines = file.elements.length > 0 ? readFileLines(repoRoot, file.file) : null;
  const elementsByName = new Map<string, CodeElement>();
  for (const elem of file.elements) {
    elementsByName.set(elem.name, elem);
  }

  // First, create nodes for all elements
  const allElementNodes: ViewNode[] = [];
  for (const elem of file.elements) {
    const isMethod = elem.name.includes('.');
    const isClassElement = elementsByName.has(elem.name.split('.')[0]);

    if (isMethod && isClassElement) {
      // This is a method; we'll handle it in the class node
      continue;
    }

    const elementNode: ViewNode = {
      id: `${file.file}#${elem.name}`,
      kind: elem.kind === 'class' ? 'class' : elem.kind,
      name: elem.kind === 'class' ? elem.name : elem.name.split('.').pop() || elem.name,
      detail: `${elem.kind} · ${formatLineCount(elem.lineCount)}${elem.stub ? ` · stub: ${elem.stub}` : ''}`,
      weight: elem.lineCount || 1,
      children: [],
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      file: file.file,
      line: elem.startLine,
      endLine: elem.endLine,
      callsAvailable: false,
      ...(elem.stub && { stub: elem.stub }),
      // 'class' nodes are a grouping container (their methods carry the actual code); only
      // function-kind top-level elements get a `code` snippet here.
      ...(elem.kind !== 'class' ? { code: sliceLines(lines, elem.startLine, elem.endLine) } : {}),
    };

    // If this is a class, add its methods as children
    if (elem.kind === 'class') {
      const classMethods: ViewNode[] = [];
      for (const potentialMethod of file.elements) {
        if (potentialMethod.name.startsWith(elem.name + '.')) {
          const methodName = potentialMethod.name.substring(elem.name.length + 1);
          const methodNode: ViewNode = {
            id: `${file.file}#${potentialMethod.name}`,
            kind: 'method',
            name: methodName,
            detail: `method · ${formatLineCount(potentialMethod.lineCount)}${potentialMethod.stub ? ` · stub: ${potentialMethod.stub}` : ''}`,
            weight: potentialMethod.lineCount || 1,
            children: [],
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            file: file.file,
            line: potentialMethod.startLine,
            endLine: potentialMethod.endLine,
            callsAvailable: false,
            code: sliceLines(lines, potentialMethod.startLine, potentialMethod.endLine),
            ...(potentialMethod.stub && { stub: potentialMethod.stub }),
          };
          classMethods.push(methodNode);
          elementNodeMap.set(methodNode.id, methodNode);
        }
      }
      elementNode.children = sortNodes(classMethods);
    }

    allElementNodes.push(elementNode);
    elementNodeMap.set(elementNode.id, elementNode);
  }

  return sortNodes(allElementNodes);
}

/**
 * Sort nodes by weight descending, then by id using plain < comparison.
 * b436: file boxes (kind 'file' or 'slice') are the exception: they come first, in folder order (filePathOrder), so the
 * automatic arrangement (row-major grid) keeps the files of one folder next to each other. Any other node (container,
 * component, function, a planned ghost under a component, ...) keeps weight order, after the file boxes. A list with
 * no file box sorts as before b436. Saved layouts are applied later, by layoutTree, and are not changed.
 */
function sortNodes(nodes: ViewNode[]): ViewNode[] {
  const isFileBox = (n: ViewNode): boolean => (n.kind === 'file' || n.kind === 'slice') && n.file !== undefined;
  const files = nodes.filter(isFileBox).sort((a, b) => filePathOrder(a.file!, b.file!) || cmp(a.id, b.id));
  const rest = nodes.filter((n) => !isFileBox(n)).sort((a, b) => b.weight - a.weight || cmp(a.id, b.id));
  return [...files, ...rest];
}

/**
 * b436: order of two repo-relative file paths ('/'-separated): by folder, one path segment at a time (ordinal, cmp),
 * a folder's own files before its subfolders (root files first), then by file name (ordinal). Same result on every machine.
 */
function filePathOrder(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  const da = pa.length - 1;   // folder depth (number of folder segments)
  const db = pb.length - 1;
  for (let i = 0; i < Math.min(da, db); i++) {
    const c = cmp(pa[i], pb[i]);
    if (c !== 0) return c;
  }
  return da - db || cmp(pa[da], pb[db]);
}

/**
 * P14-I5d-i: drop the nodes that are children of a class node, so a method is listed only under
 * its class (never also under a slice, Shared or Unassigned). Order of the rest is unchanged.
 */
function dropMethodsOfClasses(nodes: ViewNode[], elementNodeMap: Map<string, ViewNode>): ViewNode[] {
  const nested = new Set<ViewNode>();
  for (const node of elementNodeMap.values()) {
    if (node.kind === 'class') {
      for (const child of node.children) nested.add(child);
    }
  }
  return nodes.filter((n) => !nested.has(n));
}

/**
 * Format line count with singular/plural: "1 line" or "N lines"
 */
function formatLineCount(count: number): string {
  return count === 1 ? '1 line' : `${count} lines`;
}
